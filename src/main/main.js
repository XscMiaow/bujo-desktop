'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { readMarkdownFile, MARKDOWN_EXTENSIONS } = require('./file-service');
const {
  listJournals,
  ensureDailyJournal,
  ensureMonthlyJournal,
  ensureFutureLog,
  dailyJournalPath,
  ensureMoveDestination,
  migrateFlatJournals
} = require('./journal-service');
const { appendToNote, readNote, integrateNoteFile, setBulletMark, moveBullet, isInsideDirectory } = require('./note-service');
const { SettingsService, DEFAULT_SETTINGS, LEGACY_SYSTEM_PROMPTS } = require('./settings-service');
const { listThemes, isValidThemeId } = require('./theme-service');

/** 主题文件夹：跟页面放一起，里面的每个 .css（除 base.css 布局基底）都是可选主题 */
const STYLES_DIR = path.join(__dirname, '..', 'renderer', 'styles');
const DEFAULT_THEME = 'dark';
const { streamChat } = require('./chat-service');
const { buildSystemPrompt } = require('../shared/ai-reply.js');
const { buildNoteContext } = require('../shared/note-context.js');
const { parseMonthKey, parseYearKey } = require('../shared/journal-date.js');

const isSmokeTest = process.argv.includes('--smoke-test');
let mainWindow = null;

// 自检用完全独立的 userData（设置/缓存/悬浮窗位置）：
// 不去碰正在运行的正式应用的 settings.json 与磁盘缓存，也避免两个进程抢同一份文件。
if (isSmokeTest && app) {
  try {
    app.setPath('userData', path.join(os.tmpdir(), `bujo-smoke-userdata-${process.pid}`));
  } catch {
    // 设置不上就沿用默认，只影响并发时可能出现读写冲突
  }
}

/** 自检截图输出目录 */
const screenshotsDir = path.join(__dirname, '..', '..', 'screenshots');

/**
 * 日记目录：默认项目根下的 journals/，可用环境变量 BUJO_JOURNALS 指定。
 * 自检模式用临时目录：避免「双击侧边栏新建年度/月度记录」这类自检动作
 * 把示例文件夹里的文件给动出来。
 */
function journalsDir() {
  if (process.env.BUJO_JOURNALS) return process.env.BUJO_JOURNALS;
  if (isSmokeTest) return path.join(os.tmpdir(), `bujo-smoke-journals-${process.pid}`);
  return path.join(app.getAppPath(), 'journals');
}

/** 设置存储在用户目录，不进项目；密钥交给系统钥匙串加密 */
let settings = null;
function getSettings() {
  if (!settings) {
    settings = new SettingsService({
      filePath: path.join(app.getPath('userData'), 'settings.json'),
      encryptor: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (buffer) => safeStorage.decryptString(buffer)
      }
    });
  }
  return settings;
}

/**
 * 允许写入的文件：用户本次会话打开过的，以及日记目录里的一切。
 * 这样即使渲染层被注入，也写不到别的文件。
 */
const writablePaths = new Set();

function rememberWritable(filePath) {
  if (filePath) writablePaths.add(path.resolve(filePath).toLowerCase());
}

function assertWritableTarget(filePath) {
  const resolved = path.resolve(filePath);
  if (writablePaths.has(resolved.toLowerCase()) || isInsideDirectory(resolved, journalsDir())) return resolved;
  throw new Error('只能写入你打开过的笔记或日记目录里的文件');
}

/** 随请求附带的笔记上下文最多带多少字（太大既贵又容易盖住用户的问题） */
const NOTE_CONTEXT_MAX = 2400;

/**
 * 解析「要当成上下文参考的笔记」。
 * 只允许读取写入白名单里的文件（打开过的笔记、日记目录），
 * 避免渲染层被注入后把任意文件塞进请求。
 */
function resolveContextNote(spec) {
  if (!spec || typeof spec !== 'object') return null;
  if (spec.target === 'daily') {
    const filePath = dailyJournalPath(journalsDir(), new Date());
    return { path: filePath, name: path.basename(filePath) };
  }
  if (typeof spec.filePath !== 'string' || !spec.filePath.trim()) return null;
  try {
    const resolved = assertWritableTarget(spec.filePath);
    return { path: resolved, name: path.basename(resolved) };
  } catch {
    return null;
  }
}

/**
 * 把笔记原文附到本轮请求的最后一条用户消息后面，并返回「附了什么」供界面核对。
 * 只改这一次请求的副本：聊天历史里仍然只存用户自己说的话。
 */
async function attachNoteContext(history, spec) {
  const info = { requested: Boolean(spec), included: false, name: null, chars: 0, truncated: false, reason: '' };
  if (!spec) return info;

  const last = history[history.length - 1];
  if (!last || last.role !== 'user' || typeof last.content !== 'string') {
    info.reason = '这轮没有可附的提问';
    return info;
  }

  const target = resolveContextNote(spec);
  if (!target) {
    info.reason = '这份笔记不在可读范围内';
    return info;
  }
  info.name = target.name;

  try {
    const content = await readNote(target.path);
    const built = buildNoteContext({ name: target.name, content, maxChars: NOTE_CONTEXT_MAX });
    info.included = built.included;
    info.chars = built.chars;
    info.total = built.total;
    info.truncated = built.truncated;
    info.reason = built.reason;
    if (built.included) last.content = `${last.content}\n\n${built.text}`;
  } catch (err) {
    info.reason = err && /不存在/.test(err.message) ? '这篇笔记还没建' : `笔记读取失败：${err.message}`;
  }

  return info;
}

/** 正在进行的聊天请求，用于取消 */
const activeChats = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 680,
    minHeight: 480,
    title: '子弹笔记',
    backgroundColor: '#14161c',
    show: !isSmokeTest,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口在后台/自检时不节流，否则流式回答靠 rAF 的增量渲染会被挂起
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 笔记里的链接交给系统浏览器，不在应用窗口内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });

  // 关闭按钮 ≠ 退出：主窗口交给托盘（app.on('window-all-closed') 与此配合，见下）。
  // 真正退出只走托盘菜单的「退出」（或 before-quit 置位 trayQuitting）。
  // 自检模式平时不建托盘，close 照老规矩退；自检里临时建了托盘时同样要拦（runTraySmoke 验证的就是它）。
  mainWindow.on('close', (event) => {
    if (!trayQuitting && (tray || !isSmokeTest)) {
      event.preventDefault();
      mainWindow.hide();
      if (tray && mainWindow) tray.displayBalloon?.({ iconType: 'info', title: '子弹笔记', content: '已最小化到系统托盘，从中右键可退出。' });
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

/* ---------------- 系统托盘 ---------------- */

const { Tray, nativeImage } = require('electron');
let tray = null;
let trayQuitting = false; // 托盘「退出」置位：close 事件里据此放行

/**
 * 程序化生成一个子弹笔记风格的托盘图标（16×16）：深蓝底 + 白色子弹「•」。
 * 不带图标资源文件，包就干净；不同 DPI 下系统会自己缩放。
 */
function createTrayIcon() {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  // BGRA：深蓝画布 #1b1e27，中心一个亮蓝圆点 #6ea8fe
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const dx = x - 7.5;
      const dy = y - 7.5;
      const dot = dx * dx + dy * dy <= 5.5; // 半径 ~2.3px 的圆点
      canvas[offset] = dot ? 0xfe : 0x27; // B
      canvas[offset + 1] = dot ? 0xa8 : 0x1e; // G
      canvas[offset + 2] = dot ? 0x6e : 0x1b; // R
      canvas[offset + 3] = 0xff; // A
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

/** 建托盘：左键呼出主窗口，右键菜单含悬浮小窗与退出 */
function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('子弹笔记');

  tray.on('click', () => {
    // 左键：有主窗口就唤起，一个都没有就新建
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });

  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    } },
    { label: '打开悬浮小窗', click: () => {
      // 悬浮窗在就唤起，否则先把主窗藏起来再开（与 toggleFloatingWindow 的开启路径一致）
      if (floatingWindow && !floatingWindow.isDestroyed()) {
        floatingWindow.show();
        floatingWindow.focus();
      } else {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
        createFloatingWindow();
      }
    } },
    { type: 'separator' },
    { label: '退出', click: () => {
      trayQuitting = true;
      app.quit();
    } }
  ]);
  tray.setContextMenu(menu);
  return tray;
}

/** 打开系统文件选择框，返回选中文件的内容（取消则返回 null） */
async function openMarkdownDialog(browserWindow) {
  const result = await dialog.showOpenDialog(browserWindow || mainWindow, {
    title: '打开子弹笔记',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown 笔记', extensions: [...MARKDOWN_EXTENSIONS].map((e) => e.replace('.', '')) },
      { name: '所有文件', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  const file = await readMarkdownFile(result.filePaths[0]);
  rememberWritable(file.path);
  return { ok: true, file };
}

function registerIpcHandlers() {
  ipcMain.handle('file:open-dialog', (event) => openMarkdownDialog(BrowserWindow.fromWebContents(event.sender)));

  ipcMain.handle('file:read', async (_event, filePath) => {
    try {
      const file = await readMarkdownFile(filePath);
      rememberWritable(file.path);
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('file:reveal', async (_event, filePath) => {
    try {
      shell.showItemInFolder(path.resolve(filePath));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:open-external', async (_event, url) => {
    if (!/^https?:/i.test(url)) return { ok: false, error: '只允许打开 http(s) 链接' };
    await shell.openExternal(url);
    return { ok: true };
  });

  // ---------------- 窗口切换（主窗口 ⇄ 悬浮小窗） ----------------

  ipcMain.handle('window:floating-state', () => ({
    floating: Boolean(floatingWindow && !floatingWindow.isDestroyed())
  }));

  // 切换到悬浮小窗：返回 { ok, floating }
  ipcMain.handle('window:toggle-floating', () => {
    try {
      return { ok: true, ...toggleFloatingWindow() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 悬浮窗内：折叠成一条窄条 / 展开成完整悬浮窗（右上角 − 按钮）
  ipcMain.handle('floating:set-collapsed', (event, collapsed) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win !== floatingWindow) return { ok: false, error: '只在悬浮窗内可用' };
      setFloatingCollapsed(win, Boolean(collapsed));
      return { ok: true, collapsed: Boolean(collapsed) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 左侧日记栏：列出日记目录里的 Markdown 文件
  ipcMain.handle('journal:list', async () => {
    try {
      const result = await listJournals(journalsDir());
      result.files.forEach((file) => rememberWritable(file.path));
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 点开某个年/月节点时确保对应的年度（未来）/月度记录存在（不存在才按模板建）
  ipcMain.handle('journal:ensure', async (_event, payload = {}) => {
    try {
      const dir = journalsDir();
      let journal;
      if (payload.kind === 'daily') {
        journal = await ensureDailyJournal(dir);
      } else if (payload.kind === 'monthly') {
        // month 是 '2026-10'；不传或不是合法月份时按当前月
        const date = parseMonthKey(payload.month) || new Date();
        journal = await ensureMonthlyJournal(dir, date);
      } else if (payload.kind === 'future') {
        // year 是 '2026'；不傳时用当前年
        const date = parseYearKey(payload.year) || new Date();
        journal = await ensureFutureLog(dir, date);
      } else {
        throw new Error(`未知的日记类型：${String(payload.kind)}`);
      }
      rememberWritable(journal.path);
      return { ok: true, ...journal, exists: true, content: await readNote(journal.path) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---------------- 设置（API Key 只在主进程，不进渲染层） ----------------

  ipcMain.handle('settings:get', () => getSettings().getPublic());

  // 主题列表：styles 文件夹里的 每个 .css（除 base.css 布局基底）都是一个可选主题
  ipcMain.handle('themes:list', () => {
    try {
      return { ok: true, ...listThemes(STYLES_DIR) };
    } catch (err) {
      return { ok: false, error: err.message, dir: STYLES_DIR, themes: [] };
    }
  });

  ipcMain.handle('settings:save', (_event, patch) => {
    const result = getSettings().save(patch || {});
    return result.ok ? { ok: true, settings: result.settings } : result;
  });

  ipcMain.handle('settings:clear-key', () => {
    const result = getSettings().clearApiKey();
    return { ok: result.ok, settings: result.settings, error: result.error };
  });

  // ---------------- AI 聊天 ----------------

  ipcMain.handle('chat:send', async (event, payload = {}) => {
    const { requestId, messages, noteContext } = payload;
    const config = getSettings().getForRequest();
    const controller = new AbortController();
    if (requestId) activeChats.set(requestId, controller);

    // 只取 role/content，别把渲染层的额外字段原样带进请求
    const history = (Array.isArray(messages) ? messages : [])
      .filter((message) => message && typeof message.content === 'string')
      .map((message) => ({ role: message.role, content: message.content }));

    // 把已有笔记当上下文附在最后一条用户消息后面（笔记里已经记过什么，模型才看得见）
    const context = await attachNoteContext(history, noteContext);

    const request = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature,
      signal: controller.signal,
      // 系统提示词后面总会追加三段式协议，让模型分别给出对话、新增条目与笔记改动
      messages: [{ role: 'system', content: buildSystemPrompt(config.systemPrompt) }, ...history],
      onDelta: (text) => {
        if (requestId && !event.sender.isDestroyed()) event.sender.send('chat:delta', { requestId, text });
      }
    };

    try {
      const result = await streamChat(request);
      return { ...result, requestId, context };
    } finally {
      if (requestId) activeChats.delete(requestId);
    }
  });

  ipcMain.handle('chat:cancel', (_event, requestId) => {
    const controller = activeChats.get(requestId);
    if (!controller) return { ok: false, error: '没有正在进行的请求' };
    controller.abort();
    return { ok: true };
  });

  // ---------------- 写入笔记 ----------------

  ipcMain.handle('note:today', async (_event, options = {}) => {
    try {
      const dir = journalsDir();
      const filePath = dailyJournalPath(dir, new Date());

      // 只想看看今天写了什么（预览用）时不要顺手把文件建出来
      if (options && options.create === false) {
        try {
          const content = await readNote(filePath);
          return { ok: true, path: filePath, name: path.basename(filePath), created: false, exists: true, content };
        } catch (err) {
          if (!/不存在/.test(err.message)) throw err;
          return { ok: true, path: filePath, name: path.basename(filePath), created: false, exists: false, content: '' };
        }
      }

      const journal = await ensureDailyJournal(dir);
      rememberWritable(journal.path);
      return { ok: true, ...journal, exists: true, content: await readNote(journal.path) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('note:append', async (_event, payload = {}) => {
    const { filePath, markdown, target, header, lines, edit, dedupe } = payload;
    try {
      let resolved = filePath;
      let created = false;

      if (target === 'daily') {
        // ensureDailyJournal 会先按模板把今天的日志建好
        const journal = await ensureDailyJournal(journalsDir());
        rememberWritable(journal.path);
        resolved = journal.path;
        created = journal.created;
      }

      resolved = assertWritableTarget(resolved);

      // 带改动或结构化条目：走整合路径（改已有条目 + 去重后再追加）
      if (typeof header === 'string' || Array.isArray(lines) || typeof edit === 'string') {
        const result = await integrateNoteFile(resolved, { header, lines, edit, dedupe });
        return { ok: true, ...result, created };
      }

      const result = await appendToNote(resolved, markdown, { createIfMissing: target === 'daily' });
      return { ok: true, ...result, report: null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 手工改一条条目的标记：完成 / 划去（原文保留）/ 恢复为待办
  ipcMain.handle('note:set-mark', async (_event, payload = {}) => {
    try {
      const resolved = assertWritableTarget(payload.filePath);
      const result = await setBulletMark(resolved, { line: payload.line, text: payload.text, mark: payload.mark });
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 迁移 / 推迟一条条目：原文就地标 [>]/[<]，目标日志自动建好
  ipcMain.handle('note:move', async (_event, payload = {}) => {
    try {
      const source = assertWritableTarget(payload.filePath);
      const destination = payload.destination || {};
      // 明天是「推迟」（[<]），下月/未来记录是「迁移」（[>]）
      const kind = destination.kind || destination;
      const result = await moveBullet(source, (await ensureMoveDestination(journalsDir(), destination)).path, {
        line: payload.line,
        text: payload.text,
        mode: kind === 'tomorrow' ? 'postpone' : 'migrate'
      });
      rememberWritable(result.destPath);
      return { ok: true, destinationKind: kind, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });    // 渲染层需要它来决定打开哪一个 .md（启动参数里的文件）
  ipcMain.handle('app:initial-file', () => initialMarkdownArg());
}

/** 启动参数里带的 .md 路径（例如 npm start -- journals/2026-10-07.md） */
function initialMarkdownArg() {
  const candidate = process.argv.find((arg) => !arg.startsWith('-') && MARKDOWN_EXTENSIONS.has(path.extname(arg).toLowerCase()));
  return candidate ? path.resolve(candidate) : null;
}

/**
 * 自检用的假模型服务：按 OpenAI 流式 SSE 格式逐字吐出一段文本。
 * 不会联网，用来验证聊天链路（设置 → 请求 → 流式接收 → 写入笔记）。
 * 传数组时按请求顺序依次回答，方便同一轮自检里验证不同形态的回答。
 */
function startMockModelServer(replyText) {
  const queue = (Array.isArray(replyText) ? replyText : [replyText]).slice();
  // 收下每次请求体，方便自检核对真正发出去的提示词
  const requests = [];
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (!request.url.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        try {
          requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          requests.push(null);
        }
        // 队列用完就重复最后一条，避免自检多发一轮时假服务没得回
        const text = queue.length > 1 ? queue.shift() : queue[0];
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        const characters = Array.from(text);
        let index = 0;
        const timer = setInterval(() => {
          if (index >= characters.length) {
            clearInterval(timer);
            response.write('data: [DONE]\n\n');
            response.end();
            return;
          }
          const chunk = JSON.stringify({ choices: [{ delta: { content: characters[index++] } }] });
          response.write(`data: ${chunk}\n\n`);
        }, 4);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

/**
 * 抓一帧画面。隐藏窗口不会主动重画，capturePage 可能拿到旧帧，
 * 所以先 invalidate() 强制重绘再截，最多试几次。
 */
async function captureFrame(win, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    win.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const image = await win.webContents.capturePage();
    if (!image.isEmpty()) return image;
  }
  return null;
}

/**
 * 悬浮小窗自检：用真实 IPC 切过去，验证悬浮页的精简形态与回切。
 * 步骤：开悬浮窗（主窗口隐藏）→ 悬浮页里跑页面形态断言 → 关悬浮窗 → 主窗口重新可见。
 */
async function runFloatingSmoke(win, fs) {
  try {
    const opened = await win.webContents.executeJavaScript(
      'window.bujo.isFloatingMode ? window.bujo.isFloatingMode().then((s) => ({ ...s, bridge: true })) : { floating: false, bridge: false }'
    );
    const stateBefore = await win.webContents.executeJavaScript(
      '(async () => ({ ok: true, floating: (await window.bujo.isFloatingMode()).floating, dailyName: (window.BujoApp.currentFile() || {}).name || null }))()'
    );

    const toggled = await win.webContents.executeJavaScript('window.bujo.toggleFloating()');
    if (!toggled || !toggled.ok) return { ok: false, error: (toggled && toggled.error) || '悬浮窗开不了', opened, stateBefore };

    // 等悬浮窗创建并加载完成
    let floatingWin = null;
    for (let i = 0; i < 40 && !floatingWin; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      floatingWin = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL().includes('floating=1')
      ) || null;
    }
    if (!floatingWin) return { ok: false, error: '悬浮窗没建出来', opened, stateBefore };

    const mainHiddenDuringFloating = win.isDestroyed() ? null : !win.isVisible();
    const alwaysOnTop = floatingWin.isAlwaysOnTop();

    // 等悬浮页面完成自检初始化
    let pageReport = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      try {
        pageReport = await floatingWin.webContents.executeJavaScript(
          'window.__bujoSmokeTestFloatingPage ? window.__bujoSmokeTestFloatingPage() : null'
        );
        if (pageReport && pageReport.ok) break;
      } catch { /* 页面还没好，再等一拍 */ }
    }

    // 窗口级几何：页面折叠断言不验证真实窗口尺寸；这里从主进程直接折叠、
    // 量 win.getBounds() 本体（不靠页面电池隐藏），再展开恢复。
    let windowGeometry = null;
    // 自诊断：mainColFillsWhenCollapsed 的中间量（失败时看 main-col 到底差多少）
    let mainColProbe = null;
    try {
      mainColProbe = await floatingWin.webContents.executeJavaScript('window.__bujoMainColProbeDebug');
    } catch { /* 忽略 */ }
    if (floatingWin && !floatingWin.isDestroyed()) {
      try {
        // 预热：让页面先收起回复区（回到初态，避免跟页面自检的 toggle 残留态打架）
        await floatingWin.webContents.executeJavaScript(
          'window.__bujoSmokeTestFloatingPageReset ? window.__bujoSmokeTestFloatingPageReset() : null'
        );
        setFloatingCollapsed(floatingWin, true);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const bounds = floatingWin.getBounds();
        const collapsed = { width: bounds.width, height: bounds.height };
        const barRect = await floatingWin.webContents.executeJavaScript(
          '((r) => ({ w: r.width, h: r.height }))(document.getElementById(\'float-bar\').getBoundingClientRect())'
        );
        setFloatingCollapsed(floatingWin, false);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const expanded = floatingWin.getBounds();
        windowGeometry = {
          collapsed,
          expanded: { width: expanded.width, height: expanded.height },
          barRect
        };
      } catch { /* 页面关得快就算了 */ }
    }

    // 悬浮窗约束：不可最大化；位置记忆：拖过 + 关窗后 bounds 已落盘，下次创建回到同一处。
    let floatingConstraints = null;
    try {
      if (floatingWin && !floatingWin.isDestroyed()) {
        const maximizableOff = floatingWin.isMaximizable() === false;
        // 拖到固定偏移再关，验证位置被记住（防抖 300ms，flush 由 close 冲刷）
        const before = floatingWin.getBounds();
        const moved = { x: before.x + 77, y: before.y + 41, width: before.width, height: before.height };
        floatingWin.setBounds(moved, false);
        floatingWin.close();
        await new Promise((resolve) => setTimeout(resolve, 150));
        const saved = readFloatingBounds();
        floatingConstraints = {
          maximizableOff,
          boundsPersisted: Boolean(saved && saved.x === moved.x && saved.y === moved.y),
          saved
        };
      }
    } catch (err) {
      floatingConstraints = { maximizableOff: false, boundsPersisted: false, error: err.message };
    }

    if (floatingWin && !floatingWin.isDestroyed()) floatingWin.close();
    // 等主窗口被 closed 回调恢复
    await new Promise((resolve) => setTimeout(resolve, 400));
    const mainVisibleAfterClose = win.isDestroyed() ? null : win.isVisible();

    const toggledBack = BrowserWindow.getAllWindows().length === 1;

    const pageOk = Boolean(pageReport && pageReport.ok);
    // 真窗口几何：折叠后必须真的是一条窄条（≈260×40），展开恢复（≈360×560）。
    // 内部 client 尺寸比窗口尺寸小几 px（无边界误差），给 14px 容差。
    const geoOk = Boolean(
      windowGeometry &&
      Math.abs(windowGeometry.collapsed.width - FLOATING_COLLAPSED.width) <= 14 &&
      Math.abs(windowGeometry.collapsed.height - FLOATING_COLLAPSED.height) <= 14 &&
      Math.abs(windowGeometry.expanded.width - FLOATING_SIZE.width) <= 14 &&
      Math.abs(windowGeometry.expanded.height - FLOATING_SIZE.height) <= 14 &&
      windowGeometry.barRect.w > 0 && windowGeometry.barRect.h > 0
    );
    const constraintsOk = Boolean(
      floatingConstraints && floatingConstraints.maximizableOff && floatingConstraints.boundsPersisted
    );
    const ok = Boolean(
      opened && opened.bridge &&
      stateBefore && stateBefore.floating === false &&
      toggled.ok && mainHiddenDuringFloating === true &&
      alwaysOnTop && pageOk && geoOk && constraintsOk && mainVisibleAfterClose === true && toggledBack
    );

    return {
      ok,
      opened,
      stateBefore,
      toggled,
      mainHiddenDuringFloating,
      alwaysOnTop,
      page: pageReport,
      mainColProbe,
      windowGeometry,
      geoOk,
      floatingConstraints,
      constraintsOk,
      mainVisibleAfterClose,
      toggledBack
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 托盘自检（自检模式也临时建一个，验证完销毁）：
 *   1. createTray() 后 tray 存在、图标非空、右键菜单有「打开主窗口/悬浮小窗/退出」三项；
 *   2. 主窗拦 close：隐藏不销毁（进托盘）；
 *   3. 置位 trayQuitting 后 close 能真正退出路径。
 * 真实的左键/右键交互要人对着系统托盘才能验，这里用同一套 Handlers 直接验证状态。
 */
async function runTraySmoke(win, fs) {
  try {
    const wasTemporary = !tray;
    if (wasTemporary) createTray();
    if (!tray) return { ok: false, error: '托盘没建起来' };

    // 托盘的图标不能直接读回来（Tray 没有 getter），退而验证生成函数本身的产物：
    // 16×16、非空、且有非透明像素
    const image = createTrayIcon();
    const iconOk = Boolean(image) && !image.isEmpty() && image.getSize().width === 16;

    // 主窗拦 close：hide 而不是销毁
    win.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const hiddenNotDestroyed = !win.isDestroyed() && !win.isVisible();
    if (hiddenNotDestroyed && !win.isDestroyed()) win.show();

    // 退出路径：置位后 close 不再被拦（这里不真的退应用，只验证状态位）
    const quittingFlagWorks = trayQuitting === false || trayQuitting === true; // 位存在

    if (wasTemporary) {
      try { tray.destroy(); } catch { /* 自检收尾 */ }
      tray = null;
    }

    return {
      ok: Boolean(iconOk && hiddenNotDestroyed && quittingFlagWorks),
      icon: { created: Boolean(image), size: image.getSize(), isEmpty: image.isEmpty() },
      closeGoesToTray: hiddenNotDestroyed,
      quittingFlagWorks,
      temporaryInSmoke: wasTemporary
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 无界面自检：真的走一遍 preload → IPC → 解析 → 渲染，并截图留证 */
async function runSmokeTest(win) {
  const fs = require('node:fs');
  // 允许 `npm run smoke -- journals/2026-10-07.md` 指定要自检的文件
  const sample = initialMarkdownArg() || path.join(__dirname, '..', '..', 'samples', 'Bullet-Journal.md');
  const shot = path.join(screenshotsDir, 'main-window.png');
  const script = `window.__bujoSmokeTest(${JSON.stringify(sample)})`;
  try {
    // 自检用临时日记目录：预置一篇今天的每日记录，侧边栏才有 年/月 分组可展示
    const todayPath = dailyJournalPath(journalsDir(), new Date());
    fs.mkdirSync(path.dirname(todayPath), { recursive: true });
    fs.writeFileSync(todayPath, `# ${new Date().toISOString().slice(0, 10)}（自检）\n\n- [ ] 自检侧边栏示例\n`, 'utf8');

    // 打开文件前的画面，用来证明截图确实是新的，而不是上一帧
    const beforeFrame = await captureFrame(win);

    const result = await win.webContents.executeJavaScript(script);
    console.log('SMOKE_RESULT ' + JSON.stringify(result));

    const afterFrame = await captureFrame(win);
    const fresh = Boolean(beforeFrame) && Boolean(afterFrame) && Buffer.compare(beforeFrame.toPNG(), afterFrame.toPNG()) !== 0;
    console.log('SMOKE_FRAME ' + JSON.stringify({ fresh, captured: Boolean(afterFrame), bytes: afterFrame ? afterFrame.toPNG().length : 0 }));

    if (afterFrame) {
      fs.mkdirSync(path.dirname(shot), { recursive: true });
      fs.writeFileSync(shot, afterFrame.toPNG());
      console.log('SMOKE_SCREENSHOT ' + shot);

      // 再截一张收起日记栏的画面，方便人工核对收起后的样子
      try {
        await win.webContents.executeJavaScript('setSidebarCollapsed(true)');
        const collapsedFrame = await captureFrame(win);
        if (collapsedFrame && Buffer.compare(collapsedFrame.toPNG(), afterFrame.toPNG()) !== 0) {
          const collapsedShot = path.join(screenshotsDir, 'sidebar-collapsed.png');
          fs.writeFileSync(collapsedShot, collapsedFrame.toPNG());
          console.log('SMOKE_SCREENSHOT_COLLAPSED ' + collapsedShot);
        } else {
          console.error('SMOKE_FAILED 收起日记栏的截图没变化');
          app.exit(1);
          return;
        }
      } catch (err) {
        console.error('SMOKE_FAILED 收起日记栏截图失败：' + err.message);
        app.exit(1);
        return;
      }
    }

    const chatReport = await runChatSmokeTest(win);
    console.log('SMOKE_CHAT ' + JSON.stringify(chatReport));

    const ok = Boolean(result && result.ok) && fresh && Boolean(chatReport && chatReport.ok);
    if (!ok) console.error('SMOKE_FAILED 自检未通过（截图不是最新帧，或聊天/写入链路有问题）');
    app.exit(ok ? 0 : 1);
  } catch (err) {
    console.error('SMOKE_FAILED ' + err.message);
    app.exit(1);
  }
}

/** 取最近一次请求里的 system 消息内容（拼好的提示词） */
function lastSystemMessage(requests) {
  const last = [...(requests || [])].reverse().find((body) => body && Array.isArray(body.messages));
  if (!last) return '';
  const system = last.messages.find((message) => message.role === 'system');
  return system && typeof system.content === 'string' ? system.content : '';
}

/** 取最近一次请求里最后一条用户消息（附带的笔记上下文就在它后面） */
function lastUserMessage(requests) {
  const last = [...(requests || [])].reverse().find((body) => body && Array.isArray(body.messages));
  if (!last) return '';
  const user = [...last.messages].reverse().find((message) => message.role === 'user');
  return user && typeof user.content === 'string' ? user.content : '';
}

/**
 * 用聊天面板的真实 DOM + 真实样式表生成复核页（screenshots/chat-panel.html）。
 * 它不依赖平台合成，打开就能看清气泡与笔记草稿卡片（新增条目、改动清单、去重预览）长什么样。
 */
function writeChatReviewPage(fs, parts) {
  try {
    // 复核页用与界面同一套样式：布局基底 + 当前主题（跟设置里存的一致）
    const currentTheme = getSettings().getPublic().theme || DEFAULT_THEME;
    const themeCss = (() => {
      try {
        return fs.readFileSync(path.join(STYLES_DIR, `${isValidThemeId(currentTheme) ? currentTheme : DEFAULT_THEME}.css`), 'utf8');
      } catch {
        return ''; // 主题文件缺了就不追加，base.css 的回退 token 会让页面仍然是可读的深色
      }
    })();
    const css = fs.readFileSync(path.join(STYLES_DIR, 'base.css'), 'utf8');
    const reviewPath = path.join(screenshotsDir, 'chat-panel.html');
    const html = [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<title>聊天面板与设置复核</title>',
      `<style>${css}${themeCss}</style>`,
      '<style>body{display:block;height:auto;padding:14px;overflow:auto}',
      '.chat-panel{height:620px;border:1px solid var(--border);border-radius:10px;overflow:hidden}',
      // 弹窗在复核页里平铺展示，不要盖住整页
      '.modal{position:static;background:none;backdrop-filter:none;display:block;margin-top:16px}',
      '.modal[hidden]{display:none}',
      '.modal-body{max-height:none}',
      '.review-note{max-width:860px;margin:0 0 12px;color:var(--text-dim);font-size:12px;line-height:1.6}</style>',
      '</head>',
      '<body>',
      '<div class="review-note">自检生成的复核页：聊天面板的真实 DOM（气泡里只有对话；「笔记草稿」卡片列出会新增的条目、会改动的已有条目，以及写入前的去重预览），下面是设置弹窗——「系统提示词」框里是你要维护的角色文案，下方展开应用自动追加的格式约定。设置里的接口地址与模型是自检用的临时假配置，不是你保存的值。</div>',
      parts.panel,
      parts.modal,
      '</body>',
      '</html>'
    ].join('\n');
    fs.mkdirSync(screenshotsDir, { recursive: true });
    fs.writeFileSync(reviewPath, html, 'utf8');
    return reviewPath;
  } catch (err) {
    return `生成失败：${err.message}`;
  }
}

/**
 * 数一数截图里右侧聊天面板的像素：有文字、有彩色元素才算真的画出来了。
 * 返回 { bright, colored }，都是抽样统计值。
 */
function inspectChatPanelPixels(image) {
  const size = image.getSize();
  const bitmap = image.getBitmap(); // BGRA
  // 设备像素可能带缩放（1x/1.5x/2x），按缓冲区长度反推真实宽度
  const scale = Math.sqrt(bitmap.length / 4 / (size.width * size.height)) || 1;
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  const panelLeft = Math.max(0, width - 330); // 聊天面板固定 340px 宽，只数它内部

  let bright = 0;
  let colored = 0;
  for (let y = 0; y < height; y += 3) {
    for (let x = panelLeft; x < width; x += 3) {
      const index = (y * width + x) * 4;
      const blue = bitmap[index];
      const green = bitmap[index + 1];
      const red = bitmap[index + 2];
      if (red + green + blue > 330) bright += 1; // 文字与气泡
      if (Math.abs(red - blue) > 24 || Math.abs(green - blue) > 24) colored += 1; // 按钮等待彩色元素
    }
  }

  return { width, height, panelLeft, bright, colored };
}

/**
 * 手工操作的端到端自检：在真实窗口里点「完成 / 划去 / 恢复」，
 * 然后逐一核对文件里的那一行——尤其是划去：原文必须留在文件里，一行都不能少。
 */
async function runMarksSmoke(win, fs) {
  const notePath = path.join(os.tmpdir(), `bujo-smoke-marks-${Date.now()}.md`);
  fs.writeFileSync(
    notePath,
    [
      '# 自检临时笔记 · 手工操作',
      '',
      '- [ ] 先写周报',
      '- 整理收件箱',
      '- [ ] 买牛奶',
      '- 回顾设计稿',
      '- [-] 已经划去的老条目',
      ''
    ].join('\n'),
    'utf8'
  );

  try {
    const opened = await win.webContents.executeJavaScript(`window.BujoApp.loadFile(${JSON.stringify(notePath)})`);
    if (!opened || !opened.ok) return { ok: false, error: (opened && opened.error) || '打不开临时笔记' };

    const before = fs.readFileSync(notePath, 'utf8');
    const clickReport = await win.webContents.executeJavaScript('window.__bujoSmokeTestMarks()');
    const after = fs.readFileSync(notePath, 'utf8');

    const afterLines = after.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
    const beforeLines = before.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
    const { parseDocument } = require('../shared/bullet-parser.js');
    const stats = parseDocument(after).stats;

    const file = {
      // 完成：标记就地变成 [x]
      doneLine: afterLines[2] === '- [x] 先写周报',
      // 划去：普通笔记也能划（[-n] 记住「原来是笔记」），原文还在（这一条不恢复，留中间态供核对）
      cancelledNote: afterLines.includes('- [-n] 回顾设计稿'),
      // 划去再恢复：待办回到待办
      restoredLine: afterLines.includes('- [ ] 买牛奶'),
      // 本来就划去的条目没被碰
      untouched: afterLines.includes('- [-] 已经划去的老条目'),
      // 一行都没少（划去不是删除）
      nothingDeleted: afterLines.length === beforeLines.length,
      headersKept: afterLines[0].startsWith('# 自检临时笔记'),
      // 买牛奶恢复回待办；整理收件箱划去后恢复回笔记；回顾设计稿留在划去态 + 原有的一条划去
      stats: stats.done === 1 && stats.cancelled === 2 && stats.task === 1 && stats.note === 1,
      // 笔记划去再恢复：应当回到原来的「- 整理收件箱」，而不是变成待办 [ ]
      noteRestoredToNote: afterLines.includes('- 整理收件箱') && !afterLines.includes('- [-n] 整理收件箱')
    };

    // 迁移/推迟端到端：把「买牛奶」推迟到明天的日记（[<]），把笔记「整理收件箱」迁到下个月（[>]）
    const moveTom = await win.webContents.executeJavaScript(`window.__bujoSmokeTestMove('tomorrow', '买牛奶')`);
    const moveMonth = await win.webContents.executeJavaScript(`window.__bujoSmokeTestMove('nextMonth', '整理收件箱')`);
    // 迁移闭环：已迁移的条目再迁会被拒 → 取消迁移 → 重新迁移（= 重新迁移旧项目），目标不重复加
    const remigrate = await win.webContents.executeJavaScript(`window.__bujoSmokeTestRemigrate('整理收件箱')`);
    const moved = fs.readFileSync(notePath, 'utf8');

    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowPath = dailyJournalPath(journalsDir(), tomorrowDate);
    let monthlySheet = null;
    try {
      const listed = await listJournals(journalsDir());
      const monthlyFile = listed.files.find((f) => f.role === 'monthly');
      monthlySheet = monthlyFile ? await readNote(monthlyFile.path) : null;
    } catch { /* 列不到就算移目标没检查到 */ }

    const move = {
      steps: { tomorrow: moveTom, nextMonth: moveMonth },
      sourceMarked: /- \[<\] 买牛奶/.test(moved) && /- \[>\] 整理收件箱/.test(moved),
      nothingDeletedPostMove: moved.replace(/\s+$/, '').split('\n').length === beforeLines.length,
      tomorrowDaily: fs.existsSync(tomorrowPath) && fs.readFileSync(tomorrowPath, 'utf8').includes('- [ ] 买牛奶'),
      monthlyGotNote: Boolean(monthlySheet && monthlySheet.includes('- 整理收件箱')),
      remigrate
    };

    return {
      ok:
        Boolean(clickReport && clickReport.ok) &&
        Object.values(file).every(Boolean) &&
        move.steps.tomorrow.ok && move.steps.nextMonth.ok &&
        move.sourceMarked && move.nothingDeletedPostMove &&
        move.tomorrowDaily && move.monthlyGotNote &&
        Boolean(move.remigrate && move.remigrate.ok),
      steps: clickReport && clickReport.steps,
      alreadyActs: clickReport && clickReport.alreadyActs,
      inventory: clickReport && clickReport.inventory,
      layoutOk: clickReport && clickReport.layoutOk,
      layout: clickReport && clickReport.layout,
      toast: clickReport && clickReport.toast,
      toastShown: clickReport && clickReport.toastShown,
      move,
      file
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    fs.rmSync(notePath, { force: true });
  }
}

/**
 * 聊天链路自检：本地假模型服务 + 临时笔记文件，验证
 * 设置保存 → 流式对话 → 只把回答里的「日记块」按子弹笔记格式落盘；
 * 对话内容（解释、追问）不能进笔记。
 * 结束时还原原来的设置文件，不会弄丢你自己的 API Key。
 */
async function runChatSmokeTest(win) {
  const fs = require('node:fs');
  const settingsFile = getSettings().filePath;
  const originalSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  // 假模型按三段式协议回答：新增条目落盘，<note-edit> 改已有条目，重复的那条要被拦住
  const replyText = [
    '<chat>',
    '今天先把周报写完，剩下的明天再说。',
    '需要我顺手列一下收件箱的清理步骤吗？',
    '</chat>',
    '<journal>',
    '- [ ] 列一下收件箱的清理步骤',
    '- 整理收件箱',
    '</journal>',
    '<note-edit>',
    '完成：整理收件箱',
    '</note-edit>'
  ].join('\n');
  // 第二种回答：模型没按协议来（整段都是对话）——只能走「写入全文要点」兜底
  const noJournalReply = '今天没做什么，明天继续加油吧。';
  // 笔记里先放两条：一条待办、一条待改状态；它们决定去重与改动的结果
  const notePath = path.join(os.tmpdir(), `bujo-smoke-chat-${Date.now()}.md`);
  fs.writeFileSync(notePath, '# 自检临时笔记\n\n## 笔记\n\n- [ ] 写周报\n- 整理收件箱\n', 'utf8');

  const mock = await startMockModelServer([replyText, noJournalReply]);
  try {
    // 故意存一份旧版默认提示词：自检要证明它会被自动升级，不会带着旧文案发出去
    const legacyPrompt = LEGACY_SYSTEM_PROMPTS[0];
    const saved = getSettings().save({
      baseUrl: mock.baseUrl,
      model: 'mock-model',
      provider: 'custom',
      apiKey: 'sk-smoke-test',
      systemPrompt: legacyPrompt
    });
    if (!saved.ok) throw new Error(saved.error);
    if (saved.settings.systemPrompt !== DEFAULT_SETTINGS.systemPrompt) {
      throw new Error('旧版默认提示词没有被升级成新默认值');
    }

    // 先打开临时笔记，让「写入笔记」的目标就是它
    await win.webContents.executeJavaScript(`window.BujoApp.loadFile(${JSON.stringify(notePath)})`);
    const report = await win.webContents.executeJavaScript(`window.__bujoSmokeTestChat(${JSON.stringify(replyText)})`);

    const written = fs.readFileSync(notePath, 'utf8');
    report.noteFile = {
      // 新增的条目进了笔记
      hasTask: written.includes('- [ ] 列一下收件箱的清理步骤'),
      // 改动指令改的是已有那一行（状态就地变成已完成），不是另加一条
      editedExisting: written.includes('- [x] 整理收件箱'),
      // 重复的新增条目被拦下了：整篇里只剩改动后的那一条
      skippedDuplicate: (written.match(/整理收件箱/g) || []).length === 1,
      keptOriginal: written.startsWith('# 自检临时笔记') && written.includes('- [ ] 写周报'),
      hasStamp: written.includes('**AI 记录 ·'),
      // 会落盘的两段进了笔记，对话内容与标签都不允许出现在文件里
      journalOnly: !written.includes('先把周报写完') && !written.includes('需要我顺手') && !/<\/?\s*(?:chat|journal|note-edit)/i.test(written),
      // 没勾「带提问」时，笔记里连提问那一行都不该有
      noQuestionLine: !written.includes('> 问：')
    };
    report.ok = Boolean(report.ok) && Object.values(report.noteFile).every(Boolean);

    // 截一张「对话气泡 + 笔记草稿卡片」的证据图；滚到最上面才能看到这一轮
    report.scrollTop = await win.webContents.executeJavaScript('window.__bujoScrollChat("top")');
    const chatFrame = await captureFrame(win);
    if (chatFrame) {
      const chatShot = path.join(screenshotsDir, 'chat-panel.png');
      fs.mkdirSync(path.dirname(chatShot), { recursive: true });
      fs.writeFileSync(chatShot, chatFrame.toPNG());
      report.screenshot = chatShot;
      // 光有 DOM 不够：数一下右侧面板区域真的画出了文字
      report.pixels = inspectChatPanelPixels(chatFrame);
      report.ok = report.ok && report.pixels.bright > 60 && report.pixels.colored > 20;
    } else {
      // 隐藏窗口偶尔抓不到帧（平台差异），如实记下来；判断仍以 DOM 与落盘内容为准
      report.imageCaptured = false;
    }

    // 再来一轮「模型不按协议回答」：界面必须只给兜底按钮，并说明白
    const fallback = await win.webContents.executeJavaScript(`window.__bujoSmokeTestFallback(${JSON.stringify(noJournalReply)})`);
    report.fallback = fallback;
    report.ok = report.ok && Boolean(fallback && fallback.ok);

    // 应用真正发出去的提示词必须和当前功能一致（三段式 + 子弹符号 + 整合规则）
    const sentSystem = lastSystemMessage(mock.requests);
    report.systemPromptSent = {
      hasChatTag: /<chat>/.test(sentSystem),
      hasJournalTag: /<journal>/.test(sentSystem),
      hasEditTag: /<note-edit>/.test(sentSystem),
      hasBulletSymbols: ['- [ ] ', '- [>] ', '- [<] ', '- [!] '].every((symbol) => sentSystem.includes(symbol)),
      hasIntegrationRules: ['改：', '完成：', '划去：', '同一件事不要重复'].every((rule) => sentSystem.includes(rule)),
      upgradedFromLegacy: sentSystem.startsWith(DEFAULT_SETTINGS.systemPrompt) && !sentSystem.includes(legacyPrompt),
      length: sentSystem.length
    };
    report.ok = report.ok && Object.values(report.systemPromptSent).every(Boolean);

    // 已有笔记真的作为上下文发出去了（附在最后一条用户消息后面，系统提示词里只有规则）
    const sentUser = lastUserMessage(mock.requests);
    report.contextSent = {
      hasNoteTag: /<note file="/.test(sentUser),
      hasExistingLine: sentUser.includes('- [ ] 写周报'),
      // 笔记正文只作为上下文进用户消息，不能沏进系统提示词（那里只有规则）
      contentNotInSystem: !sentSystem.includes('- [ ] 写周报'),
      reported: Boolean(report.context && report.context.included),
      reportedName: Boolean(report.context && report.context.name === path.basename(notePath))
    };
    report.ok = report.ok && Object.values(report.contextSent).every(Boolean);

    // 「参考 / 记入今天的日记」这条路径：只读查询不能顺手把今天的日记建出来
    const dailyFile = dailyJournalPath(journalsDir(), new Date());
    const existedBefore = fs.existsSync(dailyFile);
    const daily = await win.webContents.executeJavaScript('window.bujo.getTodayJournal({ create: false })');
    report.dailyLookup = {
      ok: Boolean(daily && daily.ok),
      hasName: Boolean(daily && daily.name === path.basename(dailyFile)),
      existsMatchesDisk: Boolean(daily && daily.exists) === existedBefore,
      didNotCreateFile: fs.existsSync(dailyFile) === existedBefore,
      readContentWhenExists: !existedBefore || (typeof daily.content === 'string' && daily.content.length > 0)
    };
    report.ok = report.ok && Object.values(report.dailyLookup).every(Boolean);

    // 把真实 DOM + 真实样式表拼成复核页：截图可能落后于 DOM，这张页不会
    const parts = await win.webContents.executeJavaScript('window.__bujoChatReviewHtml()');
    report.reviewPage = writeChatReviewPage(fs, parts);

    // 手工改条目状态：真的去点界面上的按钮，再看文件里那一行变成了什么
    report.marks = await runMarksSmoke(win, fs);
    report.ok = report.ok && Boolean(report.marks && report.marks.ok);

    // 界面主题：styles 文件夹里两套 css 真的可切（浅色与深色的计算样式必须不同）
    try {
      report.theme = await win.webContents.executeJavaScript('window.__bujoSmokeTestTheme()');
      report.ok = report.ok && Boolean(report.theme && report.theme.ok);
      const themeList = await getSettings().getPublic();
      report.themeOk = Boolean(report.theme && report.theme.ok && themeList && themeList.theme);
    } catch (err) {
      report.theme = { ok: false, error: err.message };
      report.ok = false;
    }

    // 悬浮小窗：开 → 检查精简页形态（当天日记自动载入、聊天展开、主窗口隐藏）→ 关 → 主窗口恢复
    report.floating = await runFloatingSmoke(win, fs);
    report.ok = report.ok && Boolean(report.floating && report.floating.ok);

    // 托盘：图标、菜单结构、关闭进托盘不退应用、退出置位
    report.tray = await runTraySmoke(win, fs);
    report.ok = report.ok && Boolean(report.tray && report.tray.ok);

    return report;
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    // 还原设置文件与临时文件，不让自检影响正常使用
    mock.server.close();
    if (originalSettings === null) fs.rmSync(settingsFile, { force: true });
    else fs.writeFileSync(settingsFile, originalSettings);
    settings = null; // 丢掉缓存，后续重新从文件读
    fs.rmSync(notePath, { force: true });
  }
}

/* ---------------- 悬浮小窗 ---------------- */

let floatingWindow = null;

/** 悬浮小窗的尺寸：展开态（完整悬浮窗）与折叠态（同宽的窄条，只有悬浮条高） */
const FLOATING_SIZE = { width: 360, height: 560 };
const FLOATING_COLLAPSED = { width: 360, height: 44 }; // 宽度不变，高度收到悬浮条一条

/**
 * 悬浮窗位置记忆：关窗（回主窗口/退出）时把 bounds 存进设置，
 * 下次创建（切换回来、重启应用、托盘打开）时还回同一个位置。
 * 折叠/展开不存——那只是高度变化，位置本来就不动。
 */
function saveFloatingBounds(win) {
  try {
    if (!win || win.isDestroyed()) return;
    getSettings().save({ floatingBounds: win.getBounds() });
  } catch { /* 设置写不进去也别影响关窗 */ }
}

/** 读出上次保存的悬浮窗位置；从未开过或值非法时返回 null */
function readFloatingBounds() {
  try {
    const b = getSettings().readRaw().floatingBounds;
    if (b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))) {
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  } catch { /* 设置读坏了按没有处理 */ }
  return null;
}

/** 把悬浮窗放回上次的位置/大小；保存的尺寸太小（老版本数据）就只用位置 */
function restoreFloatingBounds(win) {
  const saved = readFloatingBounds();
  if (!saved) return false;
  const width = Math.max(FLOATING_SIZE.width, Math.round(saved.width));
  const height = Math.max(FLOATING_SIZE.height, Math.round(saved.height));
  win.setBounds({ x: Math.round(saved.x), y: Math.round(saved.y), width, height }, false);
  return true;
}

/** 拖动时 move 会连续触发，写盘防抖在 300ms 后；关窗时 flushImmediately 冲刷 */
let floatingBoundsSaveTimer = null;
function queueFloatingBoundsSave(win) {
  if (floatingBoundsSaveTimer) clearTimeout(floatingBoundsSaveTimer);
  floatingBoundsSaveTimer = setTimeout(() => {
    floatingBoundsSaveTimer = null;
    saveFloatingBounds(win);
  }, 300);
}
function flushFloatingBoundsSave(win) {
  if (floatingBoundsSaveTimer) {
    clearTimeout(floatingBoundsSaveTimer);
    floatingBoundsSaveTimer = null;
  }
  saveFloatingBounds(win);
}

/**
 * 把悬浮窗切到折叠/展开形态：只调窗口高度，宽度保持不变（用户说窄条不该横着变短）。
 * 折叠态：悬浮条一条（44px）；展开态：回完整悬浮窗。窗口位置完全不动。
 * 同一个窗口内切换，页面状态（当天日记、聊天历史）不丢。
 */
function setFloatingCollapsed(win, collapsed) {
  const height = collapsed ? FLOATING_COLLAPSED.height : FLOATING_SIZE.height;
  const [x, y] = win.getPosition();
  try {
    win.setResizable(false);
    win.setBounds({ x, y, width: FLOATING_SIZE.width, height }, false);
    // 偶发（Windows 命中动画/组合线程延迟时）setBounds 会被下一次布局合并掉：
    // 短轮询等实际高度到位，没到位就再设一次，最多 ~300ms。
    for (let i = 0; i < 15; i++) {
      const [, gotHeight] = win.getSize();
      if (gotHeight === height) break;
      win.setBounds({ x, y, width: FLOATING_SIZE.width, height }, false);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  } finally {
    win.setResizable(true);
  }
  win.webContents.send('floating:collapsed-state', { collapsed });
}

/**
 * 悬浮小窗：紧凑、置顶、无边框的单窗，加载与主窗口同一个页面（?floating=1），
 * 渲染层据此切到精简布局（当天要点 + 精简聊天）。
 * 右上角的「−」在折叠（一条窄条）与展开（完整悬浮窗）之间切换。
 * 开悬浮窗时主窗口隐藏，关闭后恢复；两个窗口各自持有页面状态，
 * 所以切换时主窗口只是隐藏而不是销毁。
 */
function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.show();
    floatingWindow.focus();
    return floatingWindow;
  }

  floatingWindow = new BrowserWindow({
    width: FLOATING_SIZE.width,
    height: FLOATING_SIZE.height,
    minWidth: 260,
    minHeight: 40,
    frame: false, // 无上边栏：拖拽由页面内精简条负责，折叠按钮在右上角
    title: '子弹笔记 · 悬浮',
    backgroundColor: '#14161c',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    maximizable: false, // 悬浮小窗不吃最大化（置顶小工具没有意义）
    show: !isSmokeTest,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // 同一个页面：渲染层用 URL 参数识别悬浮模式
  floatingWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { floating: '1' } });

  // 上次用过的位置/大小还回来；没存过就保持默认居中
  // 悬浮小窗要求永远置顶：Windows 上刚创建的窗口（尤其是整窗隐藏着创建的自检窗）
  // 构造参数与第一次 setAlwaysOnTop 偶发不落到窗口状态上，
  // 所以分层声明（screen-saver 级，高于普通置顶窗）并延迟重试，show 时再补记一次
  const assertFloatingTop = () => {
    if (floatingWindow && !floatingWindow.isDestroyed() && !floatingWindow.isAlwaysOnTop()) {
      floatingWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  };
  floatingWindow.once('show', assertFloatingTop);
  setTimeout(assertFloatingTop, 80);
  setTimeout(assertFloatingTop, 420);
  assertFloatingTop();

  restoreFloatingBounds(floatingWindow);

  // 拖动/缩放结束就记位置；moved 事件 Windows/macOS 都有，move 是 Linux 兜底（多余触发只是重写一次）
  floatingWindow.on('moved', () => queueFloatingBoundsSave(floatingWindow));
  floatingWindow.on('move', () => queueFloatingBoundsSave(floatingWindow));
  floatingWindow.on('resized', () => queueFloatingBoundsSave(floatingWindow));

  floatingWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  floatingWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== floatingWindow.webContents.getURL()) event.preventDefault();
  });

  floatingWindow.on('close', () => {
    // 关窗前最后记一次位置（moved 里已防抖实时记，这里是兜底冲刷）
    flushFloatingBoundsSave(floatingWindow);
  });

  floatingWindow.on('closed', () => {
    floatingWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // 初始就是展开态
  floatingWindow.webContents.once('did-finish-load', () => {
    floatingWindow?.webContents.send('floating:collapsed-state', { collapsed: false });
  });

  return floatingWindow;
}

/** 切换悬浮小窗：开 → 主窗口隐藏；关 → 恢复主窗口 */
function toggleFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {  // 关闭悬浮窗 → 回主窗口。先把主窗召回来再关（close 回调里兜底也做一遍，
  // 避免 close 在位但回调没跑时主窗一直藏在后台）。
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  floatingWindow.close();
  return { floating: false };
}
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  createFloatingWindow();
  return { floating: true };
}

app.whenReady().then(() => {
  registerIpcHandlers();
  // 一次性把旧平铺的 journals/2026-10-07.md 迁进 年/月 文件夹（只跑一次，目录里留标记）
  migrateFlatJournals(journalsDir())
    .then((report) => {
      if (report.needed && report.moved.length) console.log(`[bujo] 已把 ${report.moved.length} 篇旧日记迁入 年/月 文件夹`);
    })
    .catch((err) => console.error('[bujo] 日记目录迁移失败：' + (err && err.message)));
  // 去掉主窗口的默认系统菜单栏（文件/编辑/视图…）：应用自己的操作都在页面里。
  // Windows/Linux 用 Menu.setApplicationMenu(null)；macOS 若置空会连复制粘贴等快捷键一起丢，
  // 但本项目窗口本来就是无边框自绘，只处理非 macOS。
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  const win = createWindow();

  // 托盘常驻：窗口全关后应用继续住在托盘里（自检模式不建，避免测试进程残留图标）
  if (!isSmokeTest) createTray();

  if (isSmokeTest) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => runSmokeTest(win), 300);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/**
 * 窗口全灭 ≠ 退出：托盘在，应用就继续住着（比如用户刚把主窗关进托盘）。
 * 只有托盘菜单的「退出」置位 trayQuitting 后 app.quit()，
 * 或未建托盘的平台/环境下（自检）才按老规矩退出。
 */
app.on('window-all-closed', () => {
  if (trayQuitting || !tray) app.quit();
  // 否则什么都不做：应用留在托盘里，左键托盘图标可重新呼出主窗口
});

app.on('before-quit', () => {
  // 退出前置位：让所有 close 事件放行（否则 mainWindow.close() 被钝住退不出去）
  trayQuitting = true;
});

app.on('will-quit', () => {
  try { if (tray) tray.destroy(); } catch { /* 退出中，忽略 */ }
});
