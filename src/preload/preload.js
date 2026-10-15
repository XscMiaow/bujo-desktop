'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 渲染层唯一的能力入口。渲染层没有 Node 权限，
 * 只能通过这里声明的几个方法读写笔记文件。
 */
contextBridge.exposeInMainWorld('bujo', {
  /** 弹出系统文件选择框，返回 { ok, file } 或 null（用户取消） */
  openFileDialog: () => ipcRenderer.invoke('file:open-dialog'),

  /** 读取指定 .md 文件，返回 { ok, file } 或 { ok:false, error } */
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),

  /** 在系统文件管理器中定位该文件 */
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),

  /** 用系统浏览器打开链接 */
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  /** 启动参数里带的 .md 路径（没有则为 null） */
  getInitialFile: () => ipcRenderer.invoke('app:initial-file'),

  /** 当前是不是悬浮小窗模式 */
  isFloatingMode: () => ipcRenderer.invoke('window:floating-state'),

  /** 主窗口 ⇄ 悬浮小窗切换：返回 { ok, floating } */
  toggleFloating: () => ipcRenderer.invoke('window:toggle-floating'),

  /** 悬浮窗内：折叠成一条窄条 / 展开成完整悬浮窗 */
  setFloatingCollapsed: (collapsed) => ipcRenderer.invoke('floating:set-collapsed', collapsed),

  /** 订阅悬浮窗折叠状态变化（主进程驱动窗口尺寸，页面驱动布局） */
  onFloatingCollapsed: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('floating:collapsed-state', listener);
    return () => ipcRenderer.removeListener('floating:collapsed-state', listener);
  },

  /** 日记目录里的文件列表，最新在前：{ ok, dir, files } */
  listJournals: () => ipcRenderer.invoke('journal:list'),

  /**
   * 确保某类年度/月度记录存在（不存在才按模板建），返回与 getTodayJournal 同构的 { ok, path, name, created, content }。
   * kind: 'daily'（今天的每日记录）/ 'monthly'（可选 month: '2026-10'，缺省当前月）/ 'future'（可选 year: '2026'，缺省当前年）
   */
  ensureJournal: (options) => ipcRenderer.invoke('journal:ensure', options),

  /** 拖拽进来的 File 对象 → 真实磁盘路径（Electron 32+ 只暴露在 preload 里） */
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  /* ---------------- 设置 ---------------- */

  /** 读设置：只有 baseUrl/model/systemPrompt 等信息，**不含 API Key** */
  getSettings: () => ipcRenderer.invoke('settings:get'),

  /** 保存设置；patch.apiKey 为空字符串表示不改动密钥 */
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),

  /** 界面主题列表：styles/ 文件夹里的 每个 .css（除 base.css 布局基底）→ [{ id, label }] */
  listThemes: () => ipcRenderer.invoke('themes:list'),

  /** 界面语言列表：locales/ 文件夹里的 每个 .js（除 i18n.js 助手）→ [{ id, label }] */
  listLocales: () => ipcRenderer.invoke('locales:list'),

  /** 插件列表：plugins/ 文件夹里带插件清单的子文件夹 → { plugins, errors } */
  listPlugins: () => ipcRenderer.invoke('plugins:list'),

  /** 清除已保存的 API Key */
  clearApiKey: () => ipcRenderer.invoke('settings:clear-key'),

  /* ---------------- AI 聊天（密钥与请求都在主进程） ---------------- */

  /** 发一次聊天；返回 { ok, content } 或 { ok:false, error } */
  sendChat: (request) => ipcRenderer.invoke('chat:send', request),

  /** 订阅流式增量，返回取消订阅函数 */
  onChatDelta: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('chat:delta', listener);
    return () => ipcRenderer.removeListener('chat:delta', listener);
  },

  /** 取消某次请求 */
  cancelChat: (requestId) => ipcRenderer.invoke('chat:cancel', requestId),

  /* ---------------- 写入笔记 ---------------- */

  /**
   * 今天的日记文件：{ ok, path, name, created, exists, content }
   * 传 { create: false } 只读（不存在就 exists:false），不会顺手把文件建出来
   */
  getTodayJournal: (options) => ipcRenderer.invoke('note:today', options),

  /**
   * 写入笔记：{ filePath } 或 { target: 'daily' }，再带上要写的内容：
   *   { header, lines, edit, dedupe } → 整合写入（改已有条目 + 跳过重复后再追加）
   *   { markdown }                    → 直接追加一段 Markdown
   */
  appendNote: (payload) => ipcRenderer.invoke('note:append', payload),

  /**
   * 手工改一条条目的标记：mark 为 ' '（待办）/ 'x'（完成）/ '-'（划去，原文保留）。
   * line 是条目在文件里的行号，text 是它的正文（行号失效时按内容找回）。
   */
  setBulletMark: (target) => ipcRenderer.invoke('note:set-mark', target),

  /**
   * 迁移 / 推迟一条条目（跟 setBulletMark 归入同一套行号+内容校验）。payload：
   *   { filePath, line, text, destination }，destination 为
   *   'tomorrow'（推迟到明天，原文标 [<]）/'nextMonth'（迁移到下月月度记录，标 [>]）/'future'（迁移到未来记录，标 [>]）
   */
  moveBullet: (target) => ipcRenderer.invoke('note:move', target)
});
