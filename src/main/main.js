'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { readMarkdownFile, MARKDOWN_EXTENSIONS } = require('./file-service');
const { listJournals, ensureDailyJournal } = require('./journal-service');
const { appendToNote, isInsideDirectory } = require('./note-service');
const { SettingsService } = require('./settings-service');
const { streamChat } = require('./chat-service');

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
      nodeIntegration: false
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
    const { requestId, messages } = payload;
    const config = getSettings().getForRequest();
    const controller = new AbortController();
    if (requestId) activeChats.set(requestId, controller);

    const history = Array.isArray(messages) ? messages : [];
    const request = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      temperature: config.temperature,
      signal: controller.signal,
      messages: config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }, ...history] : history,
      onDelta: (text) => {
        if (requestId && !event.sender.isDestroyed()) event.sender.send('chat:delta', { requestId, text });
      }
    };

    try {
      const result = await streamChat(request);
      return { ...result, requestId };
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

  ipcMain.handle('note:today', async () => {
    try {
      const journal = await ensureDailyJournal(journalsDir());
      rememberWritable(journal.path);
      return { ok: true, ...journal };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('note:append', async (_event, payload = {}) => {
    const { filePath, markdown, target } = payload;
    try {
      let resolved = filePath;

      if (target === 'daily') {
        // ensureDailyJournal 会先按模板把今天的日志建好
        const journal = await ensureDailyJournal(journalsDir());
        rememberWritable(journal.path);
        resolved = journal.path;
      }

      resolved = assertWritableTarget(resolved);
      const result = await appendToNote(resolved, markdown, { createIfMissing: target === 'daily' });
      return { ok: true, ...result };
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
 */
function startMockModelServer(replyText) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      if (!request.url.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        const characters = Array.from(replyText);
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
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

/**
 * 抓一帧画面。隐藏窗口不会主动重画，capturePage 可能拿到旧帧，
 * 所以先 invalidate() 强制重绘再截，最多试几次。
 */
async function captureFrame(win, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    win.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 180));
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
 * 设置保存 → 流式对话 → 「写入笔记」按子弹笔记格式落盘。
 * 结束时还原原来的设置文件，不会弄丢你自己的 API Key。
 */
async function runChatSmokeTest(win) {
  const fs = require('node:fs');
  const settingsFile = getSettings().filePath;
  const originalSettings = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;
  const replyText = '## 今日重点\n- [ ] 先写周报\n- 再整理一下收件箱';
  const notePath = path.join(os.tmpdir(), `bujo-smoke-chat-${Date.now()}.md`);
  fs.writeFileSync(notePath, '# 自检临时笔记\n\n## 笔记\n', 'utf8');

  const mock = await startMockModelServer(replyText);
  try {
    const saved = getSettings().save({ baseUrl: mock.baseUrl, model: 'mock-model', provider: 'custom', apiKey: 'sk-smoke-test' });
    if (!saved.ok) throw new Error(saved.error);

    // 先打开临时笔记，让「写入笔记」的目标就是它
    await win.webContents.executeJavaScript(`window.BujoApp.loadFile(${JSON.stringify(notePath)})`);
    const report = await win.webContents.executeJavaScript(`window.__bujoSmokeTestChat(${JSON.stringify(replyText)})`);

    const written = fs.readFileSync(notePath, 'utf8');
    report.noteFile = {
      hasTask: written.includes('- [ ] 先写周报'),
      hasNote: written.includes('- 再整理一下收件箱'),
      hasStamp: written.includes('**AI 记录 ·'),
      keptOriginal: written.startsWith('# 自检临时笔记')
    };
    report.ok = Boolean(report.ok) && Object.values(report.noteFile).every(Boolean);

    const chatFrame = await captureFrame(win);
    if (chatFrame) {
      const chatShot = path.join(screenshotsDir, 'chat-panel.png');
      fs.mkdirSync(path.dirname(chatShot), { recursive: true });
      fs.writeFileSync(chatShot, chatFrame.toPNG());
      report.screenshot = chatShot;
      // 光有 DOM 不够：数一下右侧面板区域真的画出了文字
      report.pixels = inspectChatPanelPixels(chatFrame);
      report.ok = report.ok && report.pixels.bright > 60;
    } else {
      report.ok = false;
    }

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
