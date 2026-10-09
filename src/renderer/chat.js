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

/* ---------------- 消息渲染 ---------------- */

/** 解析一条回答（带缓存，流式时只在内容变化时重解析） */
/** 草稿指纹：新增条目与改动内容，用来判断卡片要不要重建 */
function draftKey(parsed) {
  return `${parsed.journal}|${parsed.edit}`;
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
      const stripped = first.textContent
        .replace(/^\s+/, '')
        .replace(/^\[( |x|X|>|!)\]\s?/, (match, mark) => {
          if (mark !== ' ') glyph = mark === 'x' || mark === 'X' ? '☑' : mark === '>' ? '»' : '!';
          return '';
        });
      first.textContent = stripped.replace(/^\s+/, '');
    }

    li.insertBefore(document.createTextNode(`${glyph} `), li.firstChild);
  });

  return holder.innerHTML;
}

/** 现在会写到哪儿（写入按钮所在卡片上显示的提示） */
function targetLabel() {
  return chatEls.target.value === 'daily' ? '记入：今天的日记' : '记入：当前笔记';
}

/** 改动指令 → 界面上显示的动词 */
const EDIT_LABELS = { replace: '改写', done: '完成', remove: '删除' };

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

    const op = document.createElement('span');
    op.className = 'chat-edit-op';
    op.textContent = EDIT_LABELS[edit.kind] || edit.kind;

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
    row.textContent = `（看不懂这行，已忽略：${line}）`;
    list.append(row);
  });

  return list;
}

/** 卡片头上的「新增 N 条 · 改动 M 处」 */
function draftBadge(adds, edits) {
  const bits = [];
  if (adds) bits.push(`新增 ${adds} 条`);
  if (edits) bits.push(`改动 ${edits} 处`);
  return bits.join(' · ');
}

/** 记入/参考两个下拉框选的是哪一篇 */
function selectedTarget() {
  return chatEls.target.value === 'daily' ? 'daily' : 'current';
}

function selectionLabel(target) {
  return target === 'daily' ? '今天的日记' : '当前笔记';
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

  if (isFallback) {
    // 模型没按协议回答：只能用兜底按钮，而且在卡片上说明白
    card.classList.add('is-empty', 'is-fallback');
    hint.textContent = 'AI 没有给出独立的新增条目，写入会用全文要点；对话里的寒暄也会一起进去';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn tiny';
    saveBtn.dataset.action = 'save-full';
    saveBtn.textContent = '写入全文要点';
    tools.append(saveBtn);
  } else if (adds || edits.length) {
    if (!parsed.journalComplete && adds) hint.textContent = '正在生成…';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn tiny primary';
    saveBtn.dataset.action = 'save-note';
    saveBtn.textContent = adds ? '写入笔记' : '应用改动';
    tools.append(saveBtn);

    const opt = document.createElement('label');
    opt.className = 'chat-journal-opt';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.dataset.role = 'with-question';
    opt.append(box, document.createTextNode('带提问'));
    tools.append(opt);
  } else {
    // 两段都是空的：这轮真的没有什么要写进笔记的
    card.classList.add('is-empty');
    hint.textContent = parsed.edit.trim()
      ? '改动指令没看懂，已忽略（见上文）；这轮没有要写进笔记的内容'
      : 'AI 认为这轮没有需要写进笔记的内容';
  }

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'btn tiny';
  copyBtn.dataset.action = 'copy-draft';
  copyBtn.textContent = '复制草稿';

  tools.append(copyBtn, status);
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
    text = `预览算不出来（${err && err.message ? err.message : err}），写入时还会再对一次`;
  }

  const preview = message.element && message.element.querySelector('.chat-journal-preview');
  if (preview) preview.textContent = text;
}

function describePreview(report, snapshot) {
  const bits = [];
  if (report.added.length) bits.push(`新增 ${report.added.length} 条`);
  if (report.merged.length) bits.push(`并入已有条目 ${report.merged.length} 条`);
  if (report.edits.applied.length) bits.push(`改动 ${report.edits.applied.length} 处`);
  if ((report.edits.unchanged || []).length) bits.push(`${report.edits.unchanged.length} 处改动已是最新`);
  if (report.duplicates.length) bits.push(`跳过重复 ${report.duplicates.length} 条`);
  if (report.edits.skipped.length) bits.push(`${report.edits.skipped.length} 处改动没对上`);

  const where = selectionLabel(snapshot.target);
  if (!bits.length) return `对照${where}：这里的条目笔记里已经有了，写入不会有改动`;
  const duplicate = report.duplicates.length ? '（与已有条目重复的不再写一遍）' : '';
  return `对照${where}：${bits.join(' · ')}${duplicate}`;
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
    // 气泡里只放对话内容，日记块单独成卡片
    const parsed = parsedReply(message);
    body.innerHTML = parsed.chat
      ? markdown(parsed.chat)
      : '<p class="chat-body-dim">（这条回答只有日记内容）</p>';
  }

  li.append(role, body);

  if (message.role === 'assistant' && !message.error) {
    li.append(renderJournalCard(message));

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
    const parsed = parsedReply(message);

    const body = message.element.querySelector('.chat-body');
    if (body) {
      body.innerHTML = parsed.chat
        ? markdown(parsed.chat)
        : '<p class="chat-body-dim">（这条回答只有日记内容）</p>';
    }

    // 草稿内容变了才重建卡片，避免把卡片上的勾选状态冲掉
    const card = message.element.querySelector('.chat-journal');
    if (card && message.renderedJournal !== draftKey(parsed)) {
      card.replaceWith(renderJournalCard(message));
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
    note.textContent = '先打开一篇笔记';
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
  if (!result.changed) return '没有写入：这些内容笔记里已经有了，重复的条目不会再记一遍';

  const bits = [`新增 ${(report.added || []).length}`];
  if ((report.merged || []).length) bits.push(`并入 ${report.merged.length}`);
  if ((report.edits || {}).applied && report.edits.applied.length) bits.push(`改动 ${report.edits.applied.length}`);
  if ((report.duplicates || []).length) bits.push(`跳过重复 ${report.duplicates.length}`);
  return `已写入 ${result.name}${result.created ? '（新建）' : ''}：${bits.join(' · ')}`;
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
  scheduleAssistantRender(assistant);
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
  chatEls.form.requestSubmit();

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
 * 主进程把它们和 styles.css 拼成复核页，能直接打开看实际排版与提示词。
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
