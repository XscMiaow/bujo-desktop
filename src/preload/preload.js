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

  /** 日记目录里的文件列表，最新在前：{ ok, dir, files } */
  listJournals: () => ipcRenderer.invoke('journal:list'),

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

  /** 今天的日记文件（不存在则按模板新建） */
  getTodayJournal: () => ipcRenderer.invoke('note:today'),

  /** 追加内容到笔记：{ filePath } 或 { target: 'daily' } */
  appendNote: (payload) => ipcRenderer.invoke('note:append', payload)
});
