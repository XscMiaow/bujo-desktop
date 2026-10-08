'use strict';

/**
 * AI 聊天面板 + 设置弹窗。
 *
 * 渲染层拿不到 API Key：设置只显示「是否已配置」，请求整体交给主进程。
 * 回答可以通过「写入笔记」按子弹笔记符号写进当前文件或今天的日记。
 */

const ChatToNote = window.ChatToNote;
const JournalDate = window.JournalDate;

const chatEls = {
  panel: document.getElementById('chat-panel'),
  toggle: document.getElementById('chat-toggle'),
  close: document.getElementById('chat-close'),
  settingsBtn: document.getElementById('chat-settings'),
  settingsOpenBtn: document.getElementById('settings-open'),
  status: document.getElementById('chat-status'),
  messages: document.getElementById('chat-messages'),
  empty: document.getElementById('chat-empty'),
  form: document.getElementById('chat-form'),
  input: document.getElementById('chat-input'),
  send: document.getElementById('chat-send'),
  cancel: document.getElementById('chat-cancel'),
  target: document.getElementById('chat-target'),
  modal: document.getElementById('settings-modal'),
  modalClose: document.getElementById('settings-close'),
  saveBtn: document.getElementById('settings-save'),
  clearKeyBtn: document.getElementById('settings-clear-key'),
  status2: document.getElementById('settings-status'),
  provider: document.getElementById('setting-provider'),
  baseUrl: document.getElementById('setting-base-url'),
  model: document.getElementById('setting-model'),
  apiKey: document.getElementById('setting-api-key'),
  keyHint: document.getElementById('setting-key-hint'),
  systemPrompt: document.getElementById('setting-system-prompt'),
  storageHint: document.getElementById('setting-storage-hint')
};

const CHAT_OPEN_KEY = 'bujo.chat.open';
const HISTORY_LIMIT = 12; // 只带最近若干轮，避免请求过大

const chatState = {
  messages: [], // { role: 'user' | 'assistant', content, error?, question? }
  history: [], // 发给模型的消息（不含出错与被取消的）
  settings: null,
  requestId: null,
  streaming: false,
  pendingRender: false
};

/* ---------------- 面板开关 ---------------- */

function setChatOpen(open) {
  chatEls.panel.hidden = !open;
  chatEls.toggle.classList.toggle('active', open);
  try {
    localStorage.setItem(CHAT_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* 忽略存储不可用 */
  }
  if (open) chatEls.input.focus();
}

/* ---------------- 消息渲染 ---------------- */

function renderChatMessage(message) {
  const li = document.createElement('li');
  li.className = `chat-msg ${message.role === 'user' ? 'from-user' : 'from-ai'}${message.error ? ' is-error' : ''}`;

  const role = document.createElement('div');
  role.className = 'chat-role';
  role.textContent = message.role === 'user' ? '你' : 'AI';

  const body = document.createElement('div');
  body.className = 'chat-body';
  if (message.role === 'user') {
    body.textContent = message.content;
  } else if (message.error) {
    body.textContent = message.content;
  } else {
    body.innerHTML = window.marked.parse(message.content || '');
  }

  li.append(role, body);

  if (message.role === 'assistant' && !message.error) {
    const tools = document.createElement('div');
    tools.className = 'chat-tools';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn tiny';
    saveBtn.dataset.action = 'save';
    saveBtn.textContent = '写入笔记';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn tiny';
    copyBtn.dataset.action = 'copy';
    copyBtn.textContent = '复制';

    const note = document.createElement('span');
    note.className = 'chat-note-status';

    tools.append(saveBtn, copyBtn, note);
    li.append(tools);
  }

  message.element = li;
  return li;
}

function appendMessage(message) {
  chatState.messages.push(message);
  chatEls.messages.append(renderChatMessage(message));
  chatEls.empty.hidden = true;
  scrollChatToBottom();
  return message;
}

function scrollChatToBottom() {
  chatEls.messages.scrollTop = chatEls.messages.scrollHeight;
}

/** 流式过程中增量刷新，用 rAF 合并同一帧内的多次更新 */
function scheduleAssistantRender(message) {
  if (chatState.pendingRender) return;
  chatState.pendingRender = true;
  requestAnimationFrame(() => {
    chatState.pendingRender = false;
    if (!message.element) return;
    const body = message.element.querySelector('.chat-body');
    if (!body) return;
    body.innerHTML = window.marked.parse(message.content || '');
    scrollChatToBottom();
  });
}

/* ---------------- 发送与流式接收 ---------------- */

function setStreaming(streaming) {
  chatState.streaming = streaming;
  chatEls.send.disabled = streaming;
  chatEls.cancel.hidden = !streaming;
  chatEls.send.textContent = streaming ? '生成中…' : '发送';
}

function updateChatStatus() {
  const settings = chatState.settings;
  if (!settings) {
    chatEls.status.textContent = '';
    return;
  }
  chatEls.status.textContent = settings.hasApiKey ? settings.model : '未配置密钥';
  chatEls.status.classList.toggle('warn', !settings.hasApiKey);
}

async function sendMessage(text) {
  const question = text.trim();
  if (!question || chatState.streaming) return;

  if (!chatState.settings || !chatState.settings.hasApiKey) {
    appendMessage({ role: 'assistant', content: '还没有配置 API Key，点右上角 ⚙ 填一个再聊。', error: true });
    openSettings();
    return;
  }

  chatEls.input.value = '';
  appendMessage({ role: 'user', content: question });
  const assistant = appendMessage({ role: 'assistant', content: '' });

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  chatState.requestId = requestId;
  setStreaming(true);

  const history = chatState.history.slice(-HISTORY_LIMIT);
  const result = await window.bujo.sendChat({
    requestId,
    messages: [...history, { role: 'user', content: question }]
  });

  setStreaming(false);
  chatState.requestId = null;

  if (result && result.ok) {
    assistant.content = result.content;
    assistant.question = question;
    history.push({ role: 'user', content: question }, { role: 'assistant', content: result.content });
    chatState.history = history;
  } else if (result && result.aborted) {
    assistant.error = true;
    assistant.content = assistant.content ? `${assistant.content}\n\n（已停止）` : '（已停止）';
  } else {
    assistant.error = true;
    assistant.content = (result && result.error) || '请求失败';
  }

  // 重新画这一条（去掉工具条 / 显示错误样式）
  if (assistant.element) {
    const fresh = renderChatMessage({ ...assistant, element: null });
    assistant.element.replaceWith(fresh);
    assistant.element = fresh;
  }
  scrollChatToBottom();
}

/* ---------------- 写入笔记 ---------------- */

async function writeMessageToNote(message, button) {
  const note = button.parentElement.querySelector('.chat-note-status');
  const target = chatEls.target.value;
  const block = ChatToNote.toNoteBlock({ question: message.question, answer: message.content, at: new Date() });

  const current = window.BujoApp.currentFile();
  const payload = target === 'current' ? { filePath: current && current.path, markdown: block } : { target: 'daily', markdown: block };

  if (target === 'current' && !payload.filePath) {
    note.textContent = '先打开一篇笔记';
    note.classList.add('warn');
    return;
  }

  button.disabled = true;
  const result = await window.bujo.appendNote(payload);
  button.disabled = false;

  note.classList.toggle('warn', !result.ok);
  if (!result.ok) {
    note.textContent = result.error;
    return;
  }

  note.textContent = `已写入 ${result.name}${result.created ? '（新建）' : ''}`;
  window.BujoApp.refreshJournals();

  // 写进的正好是当前打开的笔记时，立刻刷新正文
  const opened = window.BujoApp.currentFile();
  if (opened && opened.path.toLowerCase() === result.path.toLowerCase()) await window.BujoApp.reload();
}

/* ---------------- 设置 ---------------- */

function fillSettingsForm() {
  const settings = chatState.settings || {};
  chatEls.provider.innerHTML = (settings.presets || [])
    .map((preset) => `<option value="${preset.id}">${preset.label}</option>`)
    .join('');
  chatEls.provider.value = settings.provider || 'openai';
  chatEls.baseUrl.value = settings.baseUrl || '';
  chatEls.model.value = settings.model || '';
  chatEls.systemPrompt.value = settings.systemPrompt || '';
  chatEls.apiKey.value = '';
  chatEls.apiKey.placeholder = settings.hasApiKey ? '已保存（留空则不改动）' : 'sk-...';
  chatEls.keyHint.textContent = settings.hasApiKey
    ? `当前密钥末四位：…${settings.apiKeyHint || '****'}（输入新值可替换）`
    : '密钥只保存在主进程，界面与应用日志都不会显示它';
  chatEls.storageHint.textContent = settings.encryptionAvailable
    ? '密钥用系统钥匙串加密后保存在用户目录，不进项目、不进版本库。'
    : '当前系统不支持加密存储（safeStorage 不可用），密钥会以明文保存在用户目录的 settings.json。';
  chatEls.storageHint.classList.toggle('warn', !settings.encryptionAvailable);
  chatEls.status2.textContent = '';
}

async function openSettings() {
  chatState.settings = await window.bujo.getSettings();
  fillSettingsForm();
  chatEls.modal.hidden = false;
  chatEls.apiKey.focus();
}

function closeSettings() {
  chatEls.modal.hidden = true;
  chatEls.apiKey.value = ''; // 不把密钥留在 DOM 里
}

async function saveSettings() {
  const patch = {
    provider: chatEls.provider.value,
    baseUrl: chatEls.baseUrl.value,
    model: chatEls.model.value,
    systemPrompt: chatEls.systemPrompt.value
  };
  if (chatEls.apiKey.value.trim()) patch.apiKey = chatEls.apiKey.value;

  const result = await window.bujo.saveSettings(patch);
  if (!result || !result.ok) {
    chatEls.status2.textContent = (result && result.error) || '保存失败';
    chatEls.status2.classList.add('warn');
    return;
  }

  chatState.settings = result.settings;
  chatEls.apiKey.value = '';
  chatEls.status2.textContent = '已保存';
  chatEls.status2.classList.remove('warn');
  fillSettingsForm();
  updateChatStatus();
}

/* ---------------- 事件绑定 ---------------- */

chatEls.toggle.addEventListener('click', () => setChatOpen(chatEls.panel.hidden));
chatEls.close.addEventListener('click', () => setChatOpen(false));
chatEls.settingsBtn.addEventListener('click', openSettings);
chatEls.settingsOpenBtn.addEventListener('click', openSettings);
chatEls.modalClose.addEventListener('click', closeSettings);
chatEls.saveBtn.addEventListener('click', saveSettings);
chatEls.clearKeyBtn.addEventListener('click', async () => {
  const result = await window.bujo.clearApiKey();
  if (result && result.ok) {
    chatState.settings = result.settings;
    fillSettingsForm();
    updateChatStatus();
    chatEls.status2.textContent = '已清除密钥';
  }
});

// 预设切换：自动带上该服务商的地址与常用模型
chatEls.provider.addEventListener('change', () => {
  const preset = (chatState.settings?.presets || []).find((item) => item.id === chatEls.provider.value);
  if (!preset) return;
  if (preset.baseUrl) chatEls.baseUrl.value = preset.baseUrl;
  if (preset.model) chatEls.model.value = preset.model;
});

chatEls.form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendMessage(chatEls.input.value);
});

chatEls.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage(chatEls.input.value);
  }
});

chatEls.cancel.addEventListener('click', async () => {
  if (chatState.requestId) await window.bujo.cancelChat(chatState.requestId);
});

chatEls.messages.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const li = button.closest('.chat-msg');
  const message = chatState.messages.find((item) => item.element === li);
  if (!message) return;

  if (button.dataset.action === 'copy') {
    try {
      await navigator.clipboard.writeText(message.content);
      const note = button.parentElement.querySelector('.chat-note-status');
      note.textContent = '已复制';
    } catch {
      /* 剪贴板不可用就忽略 */
    }
    return;
  }

  if (button.dataset.action === 'save') await writeMessageToNote(message, button);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !chatEls.modal.hidden) closeSettings();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    setChatOpen(chatEls.panel.hidden);
  }
});

/* ---------------- 启动 ---------------- */

window.bujo.onChatDelta(({ requestId, text }) => {
  if (requestId !== chatState.requestId) return;
  const assistant = chatState.messages[chatState.messages.length - 1];
  if (!assistant || assistant.role !== 'assistant') return;
  assistant.content = (assistant.content || '') + text;
  scheduleAssistantRender(assistant);
});

(async function initChat() {
  chatState.settings = await window.bujo.getSettings();
  updateChatStatus();
  try {
    if (localStorage.getItem(CHAT_OPEN_KEY) === '1') setChatOpen(true);
  } catch {
    /* 忽略 */
  }
})();

/** 自检入口：走完「发消息 → 流式接收 → 写入笔记」整条链路 */
window.__bujoSmokeTestChat = async (expectText) => {
  // 自检刚写过设置，先重新读一次（模拟用户保存完就开聊）
  chatState.settings = await window.bujo.getSettings();
  updateChatStatus();

  setChatOpen(true);
  chatEls.input.value = '帮我列出今天的重点';
  chatEls.form.requestSubmit();

  const deadline = Date.now() + 8000;
  while (chatState.streaming && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const assistant = chatState.messages.filter((m) => m.role === 'assistant').pop();
  const streamed = Boolean(assistant && assistant.content && assistant.content.includes(expectText));
  const bubbles = chatEls.messages.querySelectorAll('.chat-msg').length;

  let noteResult = null;
  const saveButton = assistant && assistant.element && assistant.element.querySelector('button[data-action="save"]');
  if (saveButton) {
    saveButton.click();
    const noteDeadline = Date.now() + 4000;
    let status = '';
    while (Date.now() < noteDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (assistant.element.querySelector('.chat-note-status') || {}).textContent || '';
      if (status) break;
    }
    noteResult = status;
  }

  return {
    ok: streamed && bubbles === 2 && Boolean(noteResult) && !noteResult.includes('失败'),
    configured: Boolean(chatState.settings && chatState.settings.hasApiKey),
    streamed,
    bubbles,
    answer: assistant && assistant.content,
    noteStatus: noteResult,
    target: chatEls.target.value,
    currentNote: window.BujoApp.currentFile() && window.BujoApp.currentFile().name
  };
};
