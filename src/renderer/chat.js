'use strict';

/**
 * AI 聊天面板 + 设置弹窗。
 *
 * 渲染层拿不到 API Key：设置只显示「是否已配置」，请求整体交给主进程。
 * 回答可以通过「写入笔记」按子弹笔记符号写进当前文件或今天的日记。
 */

const ChatToNote = window.ChatToNote;
const AiReply = window.AiReply;
const JournalDate = window.JournalDate;
const NoteEdit = window.NoteEdit;
const ChatI18n = window.I18n;

const chatEls = {
  panel: document.getElementById('chat-panel'),
  toggle: document.getElementById('chat-toggle'),
  close: document.getElementById('chat-close'),
  newChat: document.getElementById('chat-new'),
  clearScreen: document.getElementById('chat-clear-screen'),
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
  context: document.getElementById('chat-context'),
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
  protocol: document.getElementById('setting-protocol'),
  protocolText: document.getElementById('setting-protocol-text'),
  storageHint: document.getElementById('setting-storage-hint')
};

const CHAT_OPEN_KEY = 'bujo.chat.open';
const CHAT_CONTEXT_KEY = 'bujo.chat.context';
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

/** 给悬浮窗初始化用的：聊天面板默认展开（不写偏好存储，用户的选择不被覆盖） */
window.BujoChat = {
  setOpen: setChatOpen,
  /** 悬浮窗读聊天状态用（只读，不改 DOM）：最近的消息数组快照 */
  peekMessages: () => chatState.messages.slice(),
  /** 悬浮窗读聊天状态用（只读）：是否正在生成回复 */
  peekStreaming: () => chatState.streaming
};

/* ---------------- 消息渲染 ---------------- */

/** 解析一条回答（带缓存，流式时只在内容变化时重解析） */
/** 草稿指纹：新增条目与改动内容，用来判断卡片要不要重建 */
function draftKey(parsed) {
  return `${parsed.journal}|${parsed.edit}`;
}

/**
 * 等待态：发出请求后还没收到任何回复内容。
 * 此时气泡与草稿卡都应显示「等待中」，而不是提前跳出一张空的「没有要写入」卡片。
 */
function isPendingMessage(message) {
  return Boolean(message.pending) && !(message.content || '').trim();
}

function parsedReply(message) {
  const content = message.content || '';
  if (message.parsedSource !== content) {
    message.parsedSource = content;
    message.parsed = AiReply.splitReply(content);
  }
  return message.parsed;
}

function markdown(text) {
  return window.marked.parse(text || '');
}

/** 解析一条回答里的「笔记改动」指令（带缓存，流式时只在内容变化时重解析） */
function parsedEdits(message) {
  const parsed = parsedReply(message);
  if (message.editsSource !== parsed.edit) {
    message.editsSource = parsed.edit;
    message.parsedEdits = NoteEdit.parseEditBlock(parsed.edit);
  }
  return message.parsedEdits;
}

/**
 * 笔记草稿的渲染：让卡片看起来就像写进笔记后的样子——
 * 列表项不加默认圆点，而是用子弹笔记的符号（☐ 待办 / ☑ 已完成 / • 要点）。
 */
function renderJournalDraft(text) {
  const holder = document.createElement('div');
  holder.innerHTML = markdown(text);

  holder.querySelectorAll('li').forEach((li) => {
    let glyph = '•';

    // marked 会把「- [ ] 事项」渲染成带勾选框的任务项，换成子弹笔记的符号
    const box = li.querySelector('input[type="checkbox"]');
    if (box) {
      glyph = box.checked ? '☑' : '☐';
      box.remove();
    }

    const first = li.firstChild;
    if (first && first.nodeType === Node.TEXT_NODE) {
      const glyphs = { x: '☑', X: '☑', '>': '»', '<': '‹', '!': '!', '-': '✗' };
      const stripped = first.textContent
        .replace(/^\s+/, '')
        .replace(/^\[([ xX><!*-])\]\s?/, (match, mark) => {
          if (mark !== ' ') glyph = glyphs[mark] || glyph;
          return '';
        });
      first.textContent = stripped.replace(/^\s+/, '');
    }

    li.insertBefore(document.createTextNode(`${glyph} `), li.firstChild);
  });

  return holder.innerHTML;
}

/** 现在会写到哪儿（写入按钮所在卡片上显示的提示）；文案走 i18n */
function targetLabel() {
  return chatEls.target.value === 'daily' ? ChatI18n.t('chat.target.dailyStatus') : ChatI18n.t('chat.target.currentStatus');
}

/** 改动指令 → 界面上显示的动词（划去不删原文）；文案走 i18n，未知 kind 原样展示 */
function editLabel(kind) {
  const translated = ChatI18n.t(`chat.edit.${kind}`);
  return translated === `chat.edit.${kind}` ? kind : translated;
}

/**
 * 把改动指令列成一份可读的清单：
 *   完成  整理收件箱
 *   改写  周三交周报 → 周五交周报
 * 没看懂的指令也列出来（标成已忽略），而不是静静丢掉。
 */
function renderEditList(message) {
  const { edits, ignored } = parsedEdits(message);
  const list = document.createElement('div');
  list.className = 'chat-edit-list';

  edits.forEach((edit) => {
    const row = document.createElement('div');
    row.className = `chat-edit-row is-${edit.kind}`;
    if (edit.kind === 'cancel') row.title = ChatI18n.t('chat.edit.cancelTitle');

    const op = document.createElement('span');
    op.className = 'chat-edit-op';
    op.textContent = editLabel(edit.kind);

    const old = document.createElement('span');
    old.className = 'chat-edit-old';
    old.textContent = edit.target;

    row.append(op, old);
    if (edit.kind === 'replace') {
      const arrow = document.createElement('span');
      arrow.className = 'chat-edit-arrow';
      arrow.textContent = '→';
      const next = document.createElement('span');
      next.className = 'chat-edit-new';
      next.textContent = edit.next;
      row.append(arrow, next);
    }
    list.append(row);
  });

  ignored.forEach((line) => {
    const row = document.createElement('div');
    row.className = 'chat-edit-row is-ignored';
    row.textContent = ChatI18n.t('chat.edit.ignoredRow', { line });
    list.append(row);
  });

  return list;
}

/** 卡片头上的「新增 N 条 · 改动 M 处」 */
function draftBadge(adds, edits) {
  const bits = [];
  if (adds) bits.push(ChatI18n.t('chat.badge.adds', { n: adds }));
  if (edits) bits.push(ChatI18n.t('chat.badge.edits', { n: edits }));
  return bits.join(' · ');
}

/** 记入/参考两个下拉框选的是哪一篇 */
function selectedTarget() {
  return chatEls.target.value === 'daily' ? 'daily' : 'current';
}

function selectionLabel(target) {
  return ChatI18n.t(target === 'daily' ? 'chat.target.daily' : 'chat.target.current');
}

/**
 * 笔记草稿卡片：AI 单独的 <journal>（要新增的条目）与 <note-edit>（对已有条目的改动）。
 * 只有这张卡片里的内容会写进笔记，聊天气泡里的解释与追问不会落盘。
 */
function renderJournalCard(message) {
  const parsed = parsedReply(message);
  const { edits, ignored } = parsedEdits(message);
  const adds = parsed.journal ? ChatToNote.toNoteLines({ journal: parsed.journal, answer: '' }).length : 0;
  const isFallback = !parsed.hasJournal && !parsed.hasEdit && !message.error;
  const isPending = isPendingMessage(message);

  const card = document.createElement('div');
  card.className = 'chat-journal';
  // 草稿指纹：新增条目或改动写下来时才重建卡片（否则会冲掉卡片上的勾选状态）
  message.renderedJournal = draftKey(parsed);
  card.dataset.draft = message.renderedJournal;

  const head = document.createElement('div');
  head.className = 'chat-journal-head';

  const title = document.createElement('span');
  title.className = 'chat-journal-title';
  title.textContent = '笔记草稿';

  const badge = document.createElement('span');
  badge.className = 'chat-journal-badge';
  badge.textContent = draftBadge(adds, edits.length);
  badge.hidden = !badge.textContent;

  const target = document.createElement('span');
  target.className = 'chat-journal-target';
  target.textContent = targetLabel();

  head.append(title, badge, target);

  const body = document.createElement('div');
  body.className = 'chat-journal-body';

  const hint = document.createElement('div');
  hint.className = 'chat-journal-hint';

  const preview = document.createElement('div');
  preview.className = 'chat-journal-preview';

  const tools = document.createElement('div');
  tools.className = 'chat-journal-tools';

  const status = document.createElement('span');
  status.className = 'chat-note-status';

  const parts = [head, body];
  if (edits.length || ignored.length) parts.push(renderEditList(message));

  if (adds) body.innerHTML = renderJournalDraft(parsed.journal);

  if (isPending) {
    // 还在等 AI 回复：占位卡片说明状态，绝不提前判「没有要写的内容」
    card.classList.add('is-empty', 'is-pending');
    hint.textContent = ChatI18n.t('chat.hint.waiting');
  } else if (isFallback) {
    // 模型没按协议回答：只能用兜底按钮，而且在卡片上说明白
    card.classList.add('is-empty', 'is-fallback');
    hint.textContent = ChatI18n.t('chat.hint.fallback');

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn tiny';
    saveBtn.dataset.action = 'save-full';
    saveBtn.textContent = ChatI18n.t('chat.save.full');
    tools.append(saveBtn);
  } else if (adds || edits.length) {
    if (!parsed.journalComplete && adds) hint.textContent = ChatI18n.t('chat.hint.generating');

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn tiny primary';
    saveBtn.dataset.action = 'save-note';
    saveBtn.textContent = adds ? ChatI18n.t('chat.save.note') : ChatI18n.t('chat.save.edits');
    tools.append(saveBtn);

    const opt = document.createElement('label');
    opt.className = 'chat-journal-opt';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.role = 'with-question';
    opt.append(box, document.createTextNode(ChatI18n.t('chat.withQuestion')));
    tools.append(opt);
  } else {
    // 两段都是空的：这轮真的没有什么要写进笔记的
    card.classList.add('is-empty');
    hint.textContent = parsed.edit.trim()
      ? ChatI18n.t('chat.hint.editsIgnored')
      : ChatI18n.t('chat.hint.nothingToWrite');
  }

  // 等待态还没有草稿可复制，暂时干出「复制草稿」按钮
  if (!isPending) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn tiny';
    copyBtn.dataset.action = 'copy-draft';
    copyBtn.textContent = ChatI18n.t('chat.copyDraft');
    tools.append(copyBtn);
  }
  tools.append(status);
  parts.push(hint, preview, tools);
  card.append(...parts);

  if (adds || edits.length) refreshCardPreview(message);
  return card;
}

/**
 * 写入前的预览：拿目标笔记的现有内容跑一遍整合规则，
 * 提前把「会新增几条 / 会改几处 / 哪几条与已有条目重复被跳过」算出来。
 * 真正落盘时主进程会重新读文件再算一次（那里才是权威结果）。
 */
async function refreshCardPreview(message) {
  const parsed = parsedReply(message);
  const { edits } = parsedEdits(message);
  const lines = ChatToNote.toNoteLines({ journal: parsed.journal, answer: '' });

  // 流式还没结束就先别算：数字会一直跳；生成完再算一次
  const complete = Boolean(message.error) || (parsed.journalComplete && (!parsed.hasEdit || parsed.editComplete));
  if (!complete) return;

  const token = (message.previewToken || 0) + 1;
  message.previewToken = token;

  let text = '';
  try {
    const snapshot = await noteSnapshot();
    // 期间目标又被改了 / 卡片被重建了：这次结果作废
    if (message.previewToken !== token || !message.element) return;
    const { report } = NoteEdit.integrate(snapshot.text, { edits, lines, dedupe: true });
    text = describePreview(report, snapshot);
  } catch (err) {
    if (message.previewToken !== token || !message.element) return;
    text = ChatI18n.t('chat.preview.error', { error: err && err.message ? err.message : err });
  }

  const preview = message.element && message.element.querySelector('.chat-journal-preview');
  if (preview) preview.textContent = text;
}

function describePreview(report, snapshot) {
  const bits = [];
  if (report.added.length) bits.push(ChatI18n.t('chat.preview.adds', { n: report.added.length }));
  if (report.merged.length) bits.push(ChatI18n.t('chat.preview.merged', { n: report.merged.length }));
  if (report.edits.applied.length) bits.push(ChatI18n.t('chat.preview.edits', { n: report.edits.applied.length }));
  if ((report.edits.unchanged || []).length) bits.push(ChatI18n.t('chat.preview.unchanged', { n: report.edits.unchanged.length }));
  if (report.duplicates.length) bits.push(ChatI18n.t('chat.preview.dropped', { n: report.duplicates.length }));
  if (report.edits.skipped.length) bits.push(ChatI18n.t('chat.preview.skipped', { n: report.edits.skipped.length }));

  const where = selectionLabel(snapshot.target);
  if (!bits.length) return ChatI18n.t('chat.preview.notChanged', { target: where });
  const duplicate = report.duplicates.length ? ChatI18n.t('chat.preview.duplicateNote') : '';
  return ChatI18n.t('chat.preview.line', { target: where, bits: bits.join(' · '), duplicate });
}

/** 目标笔记的现有内容（写入预览与「参考」都靠它） */
async function noteSnapshot() {
  const target = selectedTarget();
  if (target === 'daily') {
    const today = await window.bujo.getTodayJournal({ create: false });
    if (!today || !today.ok) return { target, text: '', name: '', exists: false, error: today && today.error };
    return { target, text: today.content || '', name: today.name, exists: Boolean(today.exists) };
  }
  const current = window.BujoApp.currentFile();
  return { target, text: current ? current.content || '' : '', name: current ? current.name : '', exists: Boolean(current) };
}

/** 发给主进程的「参考哪一篇笔记」；拿不到目标就不附带 */
function contextRequest() {
  const mode = chatEls.context.value;
  if (mode === 'none') return null;
  if (mode === 'daily') return { target: 'daily' };
  const current = window.BujoApp.currentFile();
  return current ? { target: 'current', filePath: current.path } : null;
}

function renderChatMessage(message) {
  const li = document.createElement('li');
  li.className = `chat-msg ${message.role === 'user' ? 'from-user' : 'from-ai'}${message.error ? ' is-error' : ''}${isPendingMessage(message) ? ' is-pending' : ''}`;

  const role = document.createElement('div');
  role.className = 'chat-role';
  role.textContent = message.role === 'user' ? '你' : 'AI';

  const body = document.createElement('div');
  body.className = 'chat-body';
  if (isPendingMessage(message)) {
    // 等待 AI 回复：先给个「正在思考…」的占位，收到内容后立刻被替换
    body.innerHTML = `<p class="chat-waiting"><span class="chat-waiting-dot"></span>${ChatI18n.t('chat.thinking')}</p>`;
  } else if (message.role === 'user') {
    body.textContent = message.content;
  } else if (message.error) {
    body.textContent = message.content;
  } else {
    // 气泡里只放对话内容，日记块单独成卡片
    const parsed = parsedReply(message);
    body.innerHTML = parsed.chat
      ? markdown(parsed.chat)
      : '<p class="chat-body-dim">（这条回答只有日记内容）</p>';
  }

  li.append(role, body);

  if (message.role === 'assistant' && !message.error) {
    li.append(renderJournalCard(message));

    // 等待态没有可复制的内容，先不给工具条
    if (!isPendingMessage(message)) {
      const tools = document.createElement('div');
      tools.className = 'chat-tools';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn tiny';
      copyBtn.dataset.action = 'copy';
      copyBtn.textContent = '复制对话';

      tools.append(copyBtn);
      li.append(tools);
    }
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

/**
 * 开一段新对话：AI 忘掉之前的聊天上下文，从零开始。
 * 记录气泡（messages）可以保留供回看；正在生成中的回复不能中途丢上下文，禁用。
 * @param {object} [options]
 * @param {boolean} [options.clearScreen=false] true 时连气泡记录也一起清掉（清屏）
 */
function resetConversation({ clearScreen = false } = {}) {
  if (chatState.streaming) return;
  chatState.history = [];
  if (clearScreen) {
    chatState.messages.forEach((message) => {
      if (message.element) message.element.remove();
    });
    chatState.messages = [];
  }
  chatEls.empty.hidden = chatState.messages.length > 0;
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
    // 收到内容后不再是等待态。等待痕迹要看 DOM（li 上的 is-pending），
    // 不能用 isPendingMessage() 判断：delta 处理器已把 message.pending 置 false，
    // 首个增量时它恒为 false，等状样式与工具条的恢复就永远不会发生。
    const wasPending = message.element.classList.contains('is-pending');
    message.pending = false;
    message.element.classList.remove('is-pending');
    const parsed = parsedReply(message);

    const body = message.element.querySelector('.chat-body');
    if (body) {
      body.innerHTML = parsed.chat
        ? markdown(parsed.chat)
        : '<p class="chat-body-dim">（这条回答只有日记内容）</p>';
    }

    // 首个增量到了：把等待占位换成真实的草稿卡（或兜底卡的说明），并补上工具条
    const card = message.element.querySelector('.chat-journal');
    if (card && (wasPending || message.renderedJournal !== draftKey(parsed))) {
      card.replaceWith(renderJournalCard(message));
    }
    if (wasPending && !message.element.querySelector('.chat-tools')) {
      const tools = document.createElement('div');
      tools.className = 'chat-tools';
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn tiny';
      copyBtn.dataset.action = 'copy';
      copyBtn.textContent = '复制对话';
      tools.append(copyBtn);
      message.element.querySelector('.chat-journal').after(tools);
    }

    scrollChatToBottom();
  });
}

/* ---------------- 发送与流式接收 ---------------- */

function setStreaming(streaming) {
  chatState.streaming = streaming;
  chatEls.send.disabled = streaming;
  chatEls.cancel.hidden = !streaming;
  chatEls.send.textContent = streaming ? '生成中…' : '发送';
  // 悬浮窗：悬浮条上的「⌕」按钮随生成开始/结束锁定/解锁
  if (typeof window.__bujoOnChatStreamingChanged === 'function') {
    try { window.__bujoOnChatStreamingChanged(); } catch { /* 页面助手不可用就忽略 */ }
  }
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
  // pending：AI 回复前先显示「正在思考…」与等待中的草稿卡，不提前跳出空卡片
  const assistant = appendMessage({ role: 'assistant', content: '', pending: true });
  // 悬浮窗：向 AI 发送后自动展开回复区（用户主动发送即是想看回复）
  if (typeof window.__bujoOnChatSend === 'function') {
    try { window.__bujoOnChatSend(); } catch { /* 页面助手不可用就忽略 */ }
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  chatState.requestId = requestId;
  setStreaming(true);

  const history = chatState.history.slice(-HISTORY_LIMIT);
  const result = await window.bujo.sendChat({
    requestId,
    messages: [...history, { role: 'user', content: question }],
    // 把已有笔记交给主进程附在提问后面，AI 才知道哪些事已经记过了
    noteContext: contextRequest()
  });

  setStreaming(false);
  chatState.requestId = null;

  if (result && result.ok) {
    assistant.content = result.content;
    assistant.question = question;
    assistant.context = result.context || null;
    history.push({ role: 'user', content: question }, { role: 'assistant', content: result.content });
    chatState.history = history;
  } else if (result && result.aborted) {
    assistant.error = true;
    // 只留已经收到的对话部分，别把 <chat>/<journal> 标签露给用户
    const partial = parsedReply(assistant).chat;
    assistant.content = partial ? `${partial}\n\n（已停止）` : '（已停止）';
  } else {
    assistant.error = true;
    assistant.content = (result && result.error) || '请求失败';
  }
  // 无论结果是什么，等待态到此结束
  assistant.pending = false;

  // 重新画这一条（去掉工具条 / 显示错误样式）
  if (assistant.element) {
    const fresh = renderChatMessage({ ...assistant, element: null });
    assistant.element.replaceWith(fresh);
    assistant.element = fresh;
  }
  scrollChatToBottom();
}

/* ---------------- 写入笔记 ---------------- */

/**
 * 写入笔记：新增条目 + 对已有条目的改动一起交给主进程，
 * 由它重新读文件、按同一套规则整合（改已有条目、跳过重复）后再落盘。
 * 只有模型没按协议回答时，才由用户点「写入全文要点」走兜底路径。
 */
async function writeMessageToNote(message, button) {
  const parsed = parsedReply(message);
  const full = button.dataset.action === 'save-full';
  const card = button.closest('.chat-journal');
  const note = card.querySelector('.chat-note-status');
  const withQuestion = Boolean(card.querySelector('input[data-role="with-question"]')?.checked);
  const target = selectedTarget();

  const lines = full
    ? ChatToNote.toNoteLines({ journal: '', answer: parsed.chat || message.content || '' })
    : ChatToNote.toNoteLines({ journal: parsed.journal, answer: '' });

  const payload = target === 'daily' ? { target: 'daily' } : { filePath: window.BujoApp.currentFile() && window.BujoApp.currentFile().path };
  if (target === 'current' && !payload.filePath) {
    note.textContent = ChatI18n.t('chat.needOpenNote');
    note.classList.add('warn');
    return;
  }

  payload.lines = lines;
  // 没有新增条目时就不留一个孤零零的时间戳
  payload.header = lines.length ? ChatToNote.toNoteHeader({ question: withQuestion ? message.question : '', at: new Date() }) : '';
  payload.edit = full ? '' : parsed.edit;
  payload.dedupe = true;

  button.disabled = true;
  const result = await window.bujo.appendNote(payload);
  button.disabled = false;

  note.classList.toggle('warn', !result.ok);
  if (!result.ok) {
    note.textContent = result.error;
    return;
  }

  note.textContent = describeWriteResult(result);
  window.BujoApp.refreshJournals();

  // 写进的正好是当前打开的笔记时，立刻刷新正文
  const opened = window.BujoApp.currentFile();
  if (opened && result.path && opened.path.toLowerCase() === result.path.toLowerCase()) await window.BujoApp.reload();
}

/** 写入结果 → 一句人看得懂的话（新增 / 并入 / 改动 / 跳过重复各几条） */
function describeWriteResult(result) {
  const report = result.report || {};
  if (!result.changed) return ChatI18n.t('chat.write.nothingNew');

  const bits = [ChatI18n.t('chat.write.adds', { n: (report.added || []).length })];
  if ((report.merged || []).length) bits.push(ChatI18n.t('chat.write.merged', { n: report.merged.length }));
  if ((report.edits || {}).applied && report.edits.applied.length) bits.push(ChatI18n.t('chat.write.edits', { n: report.edits.applied.length }));
  if ((report.duplicates || []).length) bits.push(ChatI18n.t('chat.write.duplicates', { n: report.duplicates.length }));
  return ChatI18n.t('chat.write.line', { name: result.name, created: result.created ? ChatI18n.t('chat.write.created') : '', bits: bits.join(' · ') });
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
  // 把应用真正会拼上去的格式约定原样展示出来，设置里看到的就是实际发出的要求
  chatEls.protocolText.textContent = AiReply.PROTOCOL_PROMPT;
  chatEls.apiKey.value = '';
  chatEls.apiKey.placeholder = settings.hasApiKey ? ChatI18n.t('settings.keyHint.saved') : 'sk-...';
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
    chatEls.status2.textContent = (result && result.error) || ChatI18n.t('settings.saveFailed');
    chatEls.status2.classList.add('warn');
    return;
  }

  chatState.settings = result.settings;
  chatEls.apiKey.value = '';
  chatEls.status2.textContent = ChatI18n.t('settings.saved');
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

/**
 * 页面里凡是 id 为 chat-new / chat-clear-screen 的按钮都接到同一套重置逻辑。
 * 主窗口在聊天头里各放一个；悬浮窗的按钮由 renderer.js 生成在悬浮条上，
 * 两个页面共用 chat.js，Events 按 id 再查一次就都能绑上。
 */
document.querySelectorAll('#chat-new, #float-bar #chat-new').forEach((button) => {
  button.addEventListener('click', () => resetConversation());
});
document.querySelectorAll('#chat-clear-screen, #float-bar #chat-clear-screen').forEach((button) => {
  button.addEventListener('click', () => resetConversation({ clearScreen: true }));
});

// 「记入」改了之后，已经画出来的笔记草稿也要跟着显示新目标，预览重算
chatEls.target.addEventListener('change', () => {
  document.querySelectorAll('.chat-journal-target').forEach((el) => {
    el.textContent = targetLabel();
  });
  chatState.messages.forEach((message) => {
    if (message.role === 'assistant' && message.element) refreshCardPreview(message);
  });
});

// 「参考」改了之后记住选择（下次开面板还是它）
chatEls.context.addEventListener('change', () => {
  try {
    localStorage.setItem(CHAT_CONTEXT_KEY, chatEls.context.value);
  } catch {
    /* 忽略存储不可用 */
  }
});

chatEls.messages.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const li = button.closest('.chat-msg');
  const message = chatState.messages.find((item) => item.element === li);
  if (!message) return;

  if (button.dataset.action === 'copy' || button.dataset.action === 'copy-draft') {
    const parsed = parsedReply(message);
    const draft = button.dataset.action === 'copy-draft';
    // 复制草稿＝复制会写进笔记的内容（新增条目 + 改动指令）
    const draftText = [parsed.journal, parsed.edit].filter((part) => part && part.trim()).join('\n\n');
    const text = draft ? draftText || parsed.chat : parsed.chat || message.content;
    try {
      await navigator.clipboard.writeText(text);
      const note = li.querySelector('.chat-note-status');
      if (note) note.textContent = draft ? '已复制笔记草稿' : '已复制对话';
    } catch {
      /* 剪贴板不可用就忽略 */
    }
    return;
  }

  if (button.dataset.action === 'save-note' || button.dataset.action === 'save-full') {
    await writeMessageToNote(message, button);
  }
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
  assistant.pending = false;
  scheduleAssistantRender(assistant);
  // 悬浮窗：AI 开口了才算「有最新回复」，这里首次触发弹出通知
  if (typeof window.__bujoOnChatActivity === 'function') window.__bujoOnChatActivity({ from: 'delta' });
});

(async function initChat() {
  chatState.settings = await window.bujo.getSettings();
  updateChatStatus();
  try {
    const remembered = localStorage.getItem(CHAT_CONTEXT_KEY);
    if (remembered && [...chatEls.context.options].some((option) => option.value === remembered)) {
      chatEls.context.value = remembered;
    }
    if (localStorage.getItem(CHAT_OPEN_KEY) === '1') setChatOpen(true);
  } catch {
    /* 忽略 */
  }
})();

/** 取一行能扛住 Markdown 渲染的探针文本（去掉列表符号、标题号） */
function probeLine(text) {
  const line = String(text || '')
    .split('\n')
    .map((item) => item.replace(/^[#>\-*+\s]+/, '').replace(/[*`]/g, '').trim())
    .find((item) => item.length >= 2);
  return line || '';
}

/** 自检入口：走完「发消息 → 流式接收 → 只把日记块写入笔记」整条链路 */
window.__bujoSmokeTestChat = async (expectReply) => {
  const expected = AiReply.splitReply(expectReply);
  const chatProbe = probeLine(expected.chat);
  const journalProbe = probeLine([...expected.journal.split('\n')].reverse().join('\n'));

  // 自检刚写过设置，先重新读一次（模拟用户保存完就开聊）
  chatState.settings = await window.bujo.getSettings();
  updateChatStatus();

  // 目标固定：写进当前打开的临时笔记，并把这篇笔记作为参考发给模型
  chatEls.target.value = 'current';
  chatEls.context.value = 'current';

  setChatOpen(true);
  chatEls.input.value = '帮我列出今天的重点';

  // 等待态检查不能靠提交后轮询（mock 模型可能快到首个 delta 在下一拍就到），
  // 改成同步检查：requestSubmit 同步触发 sendMessage，等待 UI 在它让出事件循环前就已画好
  let pendingObserved = false;
  let cardStateDuringPending = '';
  const liBeforeSend = () => chatEls.messages.querySelectorAll('.chat-msg').length;
  const bubbleCountBefore = liBeforeSend();
  chatEls.form.requestSubmit();

  // sendMessage 同步走到第一个 await 之前已把等待 UI 画好（appendMessage 是同步的），
  // 这里紧接着同步检查 DOM，不存在时序窗口
  if (chatEls.messages.querySelectorAll('.chat-msg').length === bubbleCountBefore + 2) {
    const waitBubble = chatEls.messages.querySelector('.chat-msg.is-pending .chat-waiting');
    const pendingCard = chatEls.messages.querySelector('.chat-journal.is-pending .chat-journal-hint');
    if (waitBubble) pendingObserved = true;
    if (pendingCard) {
      cardStateDuringPending = (pendingCard.textContent || '').trim();
      // 占位卡绝不能提前报「没有要写的内容」
      if (/没有需要写进笔记的内容/.test(cardStateDuringPending)) pendingObserved = false;
    }
  }

  const deadline = Date.now() + 8000;
  while (chatState.streaming && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const assistant = chatState.messages.filter((m) => m.role === 'assistant').pop();
  const parsed = assistant ? parsedReply(assistant) : { chat: '', journal: '', hasJournal: false };
  const { edits: editOps, ignored: ignoredOps } = assistant ? parsedEdits(assistant) : { edits: [], ignored: [] };
  const bubbleBody = assistant && assistant.element && assistant.element.querySelector('.chat-body');
  const card = assistant && assistant.element && assistant.element.querySelector('.chat-journal');
  const cardBody = card && card.querySelector('.chat-journal-body');
  const editRows = card ? card.querySelectorAll('.chat-edit-row').length : 0;
  const bubbles = chatEls.messages.querySelectorAll('.chat-msg').length;

  // 写入前的去重预览是异步算出来的：等它出来，才证明「点按钮之前就知道会跳过重复」
  const previewEl = card && card.querySelector('.chat-journal-preview');
  const previewDeadline = Date.now() + 4000;
  let previewText = '';
  while (previewEl && Date.now() < previewDeadline) {
    previewText = previewEl.textContent || '';
    if (previewText) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  // 卡片真被排版出来了（DOM 存在不等于看得见）
  const cardBox = card ? card.getBoundingClientRect() : null;
  const journalCardLaidOut = Boolean(cardBox) && cardBox.width > 120 && cardBox.height > 40 && cardBox.right <= window.innerWidth + 1 && cardBox.left >= 0;

  const streamed = Boolean(assistant) && parsed.journal === expected.journal && parsed.journal.length > 0;
  // 气泡里只应有对话，日记块的内容不能跑进气泡
  const bubbleOnlyChat = Boolean(bubbleBody) && bubbleBody.textContent.includes(chatProbe) && !bubbleBody.textContent.includes(journalProbe);
  const journalDraftShown = Boolean(cardBody) && cardBody.textContent.includes(journalProbe);
  // 草稿里的待办用子弹笔记符号（☐）而不是 Markdown 勾选框
  const draftUsesBulletGlyph = Boolean(cardBody) && cardBody.textContent.includes('☐') && !cardBody.querySelector('input[type="checkbox"]') && !cardBody.textContent.includes('[ ]');
  // 改动指令列在卡片上（改 / 完成 / 删）
  const editsShown = editRows > 0 && editRows === editOps.length + ignoredOps.length;
  // 预览里就写明了会有几条重复不再写（真正落盘时主进程还会再算一次）
  const dedupePreviewed = /跳过重复 1 条/.test(previewText);
  // 已有笔记真的附带在请求里了
  const contextSent = Boolean(assistant && assistant.context && assistant.context.included);

  let noteResult = null;
  const saveButton = card && card.querySelector('button[data-action="save-note"]');
  if (saveButton) {
    saveButton.click();
    const noteDeadline = Date.now() + 4000;
    let status = '';
    while (Date.now() < noteDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = (card.querySelector('.chat-note-status') || {}).textContent || '';
      if (status) break;
    }
    noteResult = status;
  }

  // 落盘结果里要能看出：改了已有条目、跳过了重复
  const summaryReported = /跳过重复 1/.test(noteResult || '') && /改动 1/.test(noteResult || '');

  return {
    ok:
      streamed &&
      bubbles === 2 &&
      bubbleOnlyChat &&
      journalDraftShown &&
      draftUsesBulletGlyph &&
      journalCardLaidOut &&
      editsShown &&
      dedupePreviewed &&
      contextSent &&
      pendingObserved &&
      summaryReported &&
      Boolean(noteResult) &&
      !noteResult.includes('失败'),
    configured: Boolean(chatState.settings && chatState.settings.hasApiKey),
    streamed,
    bubbles,
    bubbleOnlyChat,
    journalDraftShown,
    draftUsesBulletGlyph,
    journalCardLaidOut,
    editsShown,
    editOps: editOps.map((edit) => `${edit.kind}: ${edit.target}${edit.next ? ` => ${edit.next}` : ''}`),
    pendingObserved,
    cardStateDuringPending,
    dedupePreviewed,
    preview: previewText,
    context: assistant && assistant.context,
    journalCardBox: cardBox ? { w: Math.round(cardBox.width), h: Math.round(cardBox.height) } : null,
    chat: parsed.chat,
    journal: parsed.journal,
    edit: parsed.edit,
    noteStatus: noteResult,
    target: chatEls.target.value,
    currentNote: window.BujoApp.currentFile() && window.BujoApp.currentFile().name
  };
};

/**
 * 自检用：交出聊天面板与设置弹窗的真实 DOM（去掉 hidden），
 * 主进程把它们和 styles/base.css（加上当前主题 css）拼成复核页，能直接打开看实际排版与提示词。
 */
window.__bujoChatReviewHtml = async () => {
  // 把设置表单填好，才能看到「系统提示词」和自动追加的格式约定
  await openSettings();
  const panel = chatEls.panel.cloneNode(true);
  panel.hidden = false;
  panel.removeAttribute('hidden');
  const modal = chatEls.modal.cloneNode(true);
  modal.hidden = false;
  modal.removeAttribute('hidden');
  copyFormValues(chatEls.modal, modal); // clone 不会带上 input/textarea 的当前值
  const review = { panel: panel.outerHTML, modal: modal.outerHTML };
  closeSettings();
  return review;
};

/** 把表单里的当前值写进克隆出来的节点，让复核页显示的就是界面上的值 */
function copyFormValues(source, clone) {
  const originals = source.querySelectorAll('input, textarea, select');
  const copies = clone.querySelectorAll('input, textarea, select');
  originals.forEach((el, index) => {
    const copy = copies[index];
    if (!copy) return;
    if (el.tagName === 'TEXTAREA') {
      copy.textContent = el.value;
    } else if (el.tagName === 'SELECT') {
      const option = [...copy.options].find((item) => item.value === el.value);
      if (option) option.setAttribute('selected', 'selected');
    } else {
      copy.setAttribute('value', el.value);
    }
  });
};

/** 自检用：把消息列表滚到最上面 / 最下面，方便分别截图 */
window.__bujoScrollChat = (where) => {
  chatEls.messages.scrollTop = where === 'top' ? 0 : chatEls.messages.scrollHeight;
  return chatEls.messages.scrollTop;
};

/**
 * 自检入口 2：模型不按协议回答（没有日记块）时，
 * 不能默默把整段对话当日记写进去，而要给明确的「写入全文要点」兜底按钮。
 */
window.__bujoSmokeTestFallback = async (expectReply) => {
  chatEls.input.value = '再说两句';
  chatEls.form.requestSubmit();

  const deadline = Date.now() + 8000;
  while (chatState.streaming && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const assistant = chatState.messages.filter((m) => m.role === 'assistant').pop();
  const parsed = assistant ? parsedReply(assistant) : { chat: '', journal: '', hasJournal: false };
  const card = assistant && assistant.element && assistant.element.querySelector('.chat-journal');
  const hint = card && card.querySelector('.chat-journal-hint');
  const cardBox = card ? card.getBoundingClientRect() : null;
  const actions = card ? Array.from(card.querySelectorAll('button[data-action]')).map((b) => b.dataset.action) : [];

  return {
    ok:
      parsed.chat.includes(expectReply) &&
      !parsed.hasJournal &&
      !parsed.hasEdit &&
      actions.includes('save-full') &&
      !actions.includes('save-note') &&
      Boolean(hint) &&
      hint.textContent.includes('新增条目') &&
      hint.textContent.includes('全文要点') &&
      Boolean(cardBox) &&
      cardBox.height > 20,
    chat: parsed.chat,
    hasJournal: parsed.hasJournal,
    actions,
    hint: hint ? hint.textContent : '',
    // 面板里每一条到底画成了什么，便于人工核对
    bubbles: Array.from(chatEls.messages.querySelectorAll('.chat-msg')).map((li) => ({
      role: li.classList.contains('from-user') ? 'user' : 'ai',
      body: ((li.querySelector('.chat-body') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 40),
      journal: ((li.querySelector('.chat-journal-body') || {}).textContent || '').replace(/\s+/g, ' ').slice(0, 40),
      actions: Array.from(li.querySelectorAll('button[data-action]')).map((b) => b.dataset.action)
    }))
  };
};
