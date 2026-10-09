'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { readMarkdownFile, MARKDOWN_EXTENSIONS } = require('./file-service');
const { listJournals, ensureDailyJournal } = require('./journal-service');
const { appendToNote, readNote, integrateNoteFile, isInsideDirectory } = require('./note-service');
const { SettingsService, DEFAULT_SETTINGS, LEGACY_SYSTEM_PROMPTS } = require('./settings-service');
const { streamChat } = require('./chat-service');
const { buildSystemPrompt } = require('../shared/ai-reply.js');
const { buildNoteContext } = require('../shared/note-context.js');
const { dailyFileName } = require('../shared/journal-date.js');

const isSmokeTest = process.argv.includes('--smoke-test');
let mainWindow = null;

/** 自检截图输出目录 */
const screenshotsDir = path.join(__dirname, '..', '..', 'screenshots');

/** 日记目录：默认项目根下的 journals/，可用环境变量 BUJO_JOURNALS 指定 */
function journalsDir() {
  return process.env.BUJO_JOURNALS || path.join(app.getAppPath(), 'journals');
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
    const filePath = path.join(journalsDir(), dailyFileName(new Date()));
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
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

  // ---------------- 设置（API Key 只在主进程，不进渲染层） ----------------

  ipcMain.handle('settings:get', () => getSettings().getPublic());

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
      const filePath = path.join(dir, dailyFileName(new Date()));

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

  // 渲染层需要它来决定打开哪一个 .md（启动参数里的文件）
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

/** 无界面自检：真的走一遍 preload → IPC → 解析 → 渲染，并截图留证 */
async function runSmokeTest(win) {
  const fs = require('node:fs');
  // 允许 `npm run smoke -- journals/2026-10-07.md` 指定要自检的文件
  const sample = initialMarkdownArg() || path.join(__dirname, '..', '..', 'samples', 'Bullet-Journal.md');
  const shot = path.join(screenshotsDir, 'main-window.png');
  const script = `window.__bujoSmokeTest(${JSON.stringify(sample)})`;
  try {
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
    const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
    const reviewPath = path.join(screenshotsDir, 'chat-panel.html');
    const html = [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<title>聊天面板与设置复核</title>',
      `<style>${css}</style>`,
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
      hasIntegrationRules: ['改：', '完成：', '删：', '同一件事不要重复'].every((rule) => sentSystem.includes(rule)),
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
    const dailyFile = path.join(journalsDir(), dailyFileName(new Date()));
    const existedBefore = fs.existsSync(dailyFile);
    const daily = await win.webContents.executeJavaScript('window.bujo.getTodayJournal({ create: false })');
    report.dailyLookup = {
      ok: Boolean(daily && daily.ok),
      hasName: Boolean(daily && daily.name === dailyFileName(new Date())),
      existsMatchesDisk: Boolean(daily && daily.exists) === existedBefore,
      didNotCreateFile: fs.existsSync(dailyFile) === existedBefore,
      readContentWhenExists: !existedBefore || (typeof daily.content === 'string' && daily.content.length > 0)
    };
    report.ok = report.ok && Object.values(report.dailyLookup).every(Boolean);

    // 把真实 DOM + 真实样式表拼成复核页：截图可能落后于 DOM，这张页不会
    const parts = await win.webContents.executeJavaScript('window.__bujoChatReviewHtml()');
    report.reviewPage = writeChatReviewPage(fs, parts);

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

app.whenReady().then(() => {
  registerIpcHandlers();
  const win = createWindow();

  if (isSmokeTest) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => runSmokeTest(win), 300);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
