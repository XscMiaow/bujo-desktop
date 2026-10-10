'use strict';

/* 渲染层：没有 Node 权限，所有文件操作都经过 window.bujo（preload 桥） */

const Bujo = window.BulletJournal;
const marked = window.marked;

marked.setOptions({ gfm: true, breaks: false });

const els = {
  openBtn: document.getElementById('open-btn'),
  reloadBtn: document.getElementById('reload-btn'),
  viewPreview: document.getElementById('view-preview'),
  viewSource: document.getElementById('view-source'),
  fileMeta: document.getElementById('file-meta'),
  stats: document.getElementById('stats'),
  error: document.getElementById('error'),
  emptyState: document.getElementById('empty-state'),
  emptyLegend: document.getElementById('empty-legend'),
  note: document.getElementById('note'),
  legend: document.getElementById('legend'),
  dropOverlay: document.getElementById('drop-overlay'),
  toast: document.getElementById('toast'),
  content: document.getElementById('content'),
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarRefresh: document.getElementById('sidebar-refresh'),
  sidebarDir: document.getElementById('sidebar-dir'),
  sidebarEmpty: document.getElementById('sidebar-empty'),
  journalList: document.getElementById('journal-list')
};

const SIDEBAR_KEY = 'bujo.sidebar.collapsed';

/** 悬浮小窗模式：同一页面用 URL 参数识别，切到精简布局 */
const IS_FLOATING = new URLSearchParams(window.location.search).get('floating') === '1';

const state = {
  file: null, // { path, name, dir, size, modifiedAt, content }
  blocks: [],
  stats: null,
  view: 'preview',
  journals: [] // 日记目录里的文件，最新在前
};

/* ---------------- 渲染 ---------------- */

function renderLegend() {
  const kinds = Bujo.KINDS;
  const order = ['task', 'done', 'cancelled', 'migrated', 'scheduled', 'priority', 'note', 'event'];

  els.legend.innerHTML = order
    .map((key) => {
      const meta = kinds[key];
      return `<span><span class="glyph" style="color:var(--kind-${key})">${meta.glyph}</span>${meta.label} <code>${escapeHtml(meta.symbol)}</code></span>`;
    })
    .join('');

  els.emptyLegend.innerHTML = order
    .map((key) => {
      const meta = kinds[key];
      return `<li><span class="glyph" style="color:var(--kind-${key})">${meta.glyph}</span>${meta.label}<code>${escapeHtml(meta.symbol)}</code></li>`;
    })
    .join('');
}

function renderFileMeta() {
  if (!state.file) {
    els.fileMeta.textContent = '尚未打开文件 —— 点击「打开 .md 文件」，或把 .md 拖进窗口';
    return;
  }
  const { name, dir, size, modifiedAt } = state.file;
  const kb = (size / 1024).toFixed(1);
  const time = new Date(modifiedAt).toLocaleString('zh-CN', { hour12: false });
  els.fileMeta.innerHTML = `<strong>${escapeHtml(name)}</strong> · ${escapeHtml(dir)} · ${kb} KB · 修改于 ${time}`;
}

function renderStats(stats) {
  if (!stats || stats.total === 0) {
    els.stats.innerHTML = '';
    return;
  }
  const chips = [];
  if (stats.task) chips.push(`<span class="chip">待办 ${stats.task}</span>`);
  if (stats.done) chips.push(`<span class="chip">完成 ${stats.done}</span>`);
  if (stats.cancelled) chips.push(`<span class="chip">划去 ${stats.cancelled}</span>`);
  if (stats.priority) chips.push(`<span class="chip">优先 ${stats.priority}</span>`);
  if (stats.event) chips.push(`<span class="chip">事件 ${stats.event}</span>`);
  if (stats.migrated) chips.push(`<span class="chip">迁移 ${stats.migrated}</span>`);
  if (stats.note) chips.push(`<span class="chip">笔记 ${stats.note}</span>`);
  chips.push(
    `<span class="chip">进度 ${stats.progress}%</span><span class="progress"><span style="width:${stats.progress}%"></span></span>`
  );
  els.stats.innerHTML = chips.join('');
}

/** 能「完成」的条目类型 */
const TASK_LIKE = new Set(['task', 'priority', 'scheduled', 'migrated']);

/** 条目右侧的一个小操作按钮 */
function entryAction(act, label, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bujo-act';
  button.dataset.act = act;
  button.textContent = label;
  button.title = title;
  return button;
}

/**
 * 手工操作：待办可以「完成」或「划去」；已完成的可以「取消完成」或「划去」；
 * 已经划去的可以「恢复为待办」。划去只改标记，原文一直留在文件里。
 */
function buildEntryActions(item) {
  const acts = document.createElement('span');
  acts.className = 'bujo-acts';

  if (item.kind === 'done') {
    acts.append(entryAction('restore', '取消完成', '改回待办'));
  } else if (item.kind === 'cancelled') {
    acts.append(entryAction('restore', '恢复', '恢复为待办'));
  } else if (TASK_LIKE.has(item.kind)) {
    acts.append(entryAction('done', '完成', '标记为已完成'));
  }

  if (item.kind !== 'cancelled') {
    acts.append(entryAction('cancel', '划去', '划去这一条（原文保留在笔记里）'));
  }

  return acts;
}

/** 一个子弹列表 → <ul>，符号由「子弹类型」决定，而不是原始文本 */
function buildBulletList(block) {
  const ul = document.createElement('ul');
  ul.className = 'bujo-list';

  block.items.forEach((item) => {
    const meta = Bujo.KINDS[item.kind] || Bujo.KINDS.note;
    const li = document.createElement('li');
    li.className = `bujo-entry ${meta.cls}`;
    li.dataset.kind = item.kind;
    // 行号与正文：改标记时靠它们精准找到文件里的那一行
    li.dataset.line = String(item.line);
    li.dataset.text = item.text;

    // 缩进映射成固定步长，层级太深也不会跑出屏幕
    const indentPx = Math.min(item.indent, 12) * 6;
    if (indentPx > 0) li.style.setProperty('--indent', `${indentPx}px`);

    const glyph = document.createElement('span');
    glyph.className = 'bujo-glyph';
    glyph.textContent = meta.glyph;
    glyph.title = meta.label;

    const text = document.createElement('span');
    text.className = 'bujo-text';
    text.innerHTML = marked.parseInline(item.text);

    li.append(glyph, text, buildEntryActions(item));
    ul.append(li);
  });

  return ul;
}

function renderNote() {
  els.note.innerHTML = '';
  els.note.hidden = false;
  els.emptyState.hidden = true;

  if (state.view === 'source') {
    const pre = document.createElement('pre');
    pre.className = 'source-view';
    pre.textContent = state.file ? state.file.content : '';
    els.note.append(pre);
    return;
  }

  state.blocks.forEach((block) => {
    if (block.type === 'bullets') {
      if (block.items.length) els.note.append(buildBulletList(block));
      return;
    }
    // 普通 Markdown 交给 marked，用一层 div 承载它的 HTML
    const wrapper = document.createElement('div');
    wrapper.className = 'md-block';
    wrapper.innerHTML = marked.parse(block.text);
    els.note.append(wrapper);
  });
}

function renderAll() {
  renderFileMeta();
  renderStats(state.stats);

  const hasFile = Boolean(state.file);
  els.reloadBtn.disabled = !hasFile;
  if (!hasFile) {
    els.note.hidden = true;
    els.emptyState.hidden = false;
    return;
  }
  renderNote();
}

/* ---------------- 左侧日记栏 ---------------- */

/** 文件名 → 列表里的主标题与副标题（星期算法与主进程共用 journal-date.js） */
function formatJournalLabel(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const day = window.JournalDate && window.JournalDate.parseDateKey(base);
  if (day) return { name: base, sub: window.JournalDate.weekdayLabel(day) };
  if (/^\d{4}-\d{2}$/.test(base)) return { name: base, sub: '月度日志' };
  return { name: base, sub: '笔记' };
}

function shortTime(iso) {
  const date = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function samePath(a, b) {
  return Boolean(a) && Boolean(b) && a.toLowerCase() === b.toLowerCase();
}

function journalItems() {
  return [...els.journalList.querySelectorAll('.journal-item')];
}

/** 当前打开的日记在列表里高亮 */
function markActiveJournal() {
  journalItems().forEach((li) => li.classList.toggle('active', samePath(li.dataset.path, state.file && state.file.path)));
}

/** 单击只选中（键盘可达），双击才打开 */
function markSelectedJournal(path) {
  journalItems().forEach((li) => li.classList.toggle('selected', samePath(li.dataset.path, path)));
}

function renderJournalList() {
  els.journalList.innerHTML = '';
  els.sidebarEmpty.hidden = state.journals.length > 0;

  state.journals.forEach((file) => {
    const label = formatJournalLabel(file.name);
    const li = document.createElement('li');
    li.className = 'journal-item';
    li.dataset.path = file.path;
    li.tabIndex = 0;
    li.title = `${file.path}\n双击打开`;
    li.innerHTML =
      `<span class="journal-name">${escapeHtml(label.name)}</span>` +
      `<span class="journal-sub">${escapeHtml(`${label.sub} · ${shortTime(file.modifiedAt)}`)}</span>`;
    els.journalList.append(li);
  });

  markActiveJournal();
}

async function refreshJournals() {
  const result = await window.bujo.listJournals();
  if (!result || !result.ok) {
    showError(`读取日记目录失败：${(result && result.error) || '未知错误'}`);
    return;
  }
  state.journals = result.files;
  els.sidebarDir.textContent = result.dir;
  els.sidebarDir.title = result.dir;
  renderJournalList();
}

function setSidebarCollapsed(collapsed) {
  els.sidebar.classList.toggle('collapsed', collapsed);
  els.sidebarToggle.textContent = collapsed ? '›' : '‹';
  els.sidebarToggle.title = collapsed ? '展开日记栏' : '收起日记栏';
  try {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  } catch {
    /* 存储不可用时忽略，只影响偏好记忆 */
  }
}

/* ---------------- 数据加载 ---------------- */

function showError(message) {
  els.error.hidden = false;
  els.error.textContent = message;
}

function clearError() {
  els.error.hidden = true;
  els.error.textContent = '';
}

/* ---------------- 手工改条目状态 ---------------- */

/** 按钮上的动作 → 写进文件的标记 */
const ACT_MARKS = { done: 'x', cancel: '-', restore: ' ' };
const STATE_LABELS = { task: '待办', done: '已完成', cancelled: '已划去（原文保留）' };

let toastTimer = null;

/** 一闪而过的结果提示（右下角），不打断阅读 */
function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show');
    els.toast.hidden = true;
  }, 2600);
}

/**
 * 点条目上的「完成 / 划去 / 恢复」：把这一条的行号与正文交给主进程，
 * 主进程重新读文件、核对内容后再改那一行的标记，然后界面整篇重新载入。
 */
async function applyBulletAction(act) {
  const entry = act.closest('.bujo-entry');
  const mark = ACT_MARKS[act.dataset.act];
  if (!entry || !mark || !state.file) return;

  const buttons = [...entry.querySelectorAll('.bujo-act')];
  buttons.forEach((button) => {
    button.disabled = true;
  });

  const result = await window.bujo.setBulletMark({
    filePath: state.file.path,
    line: Number(entry.dataset.line),
    text: entry.dataset.text || '',
    mark
  });

  if (!result || !result.ok) {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    showError(`改不了这一条：${(result && result.error) || '未知错误'}`);
    return;
  }

  clearError();
  const label = STATE_LABELS[result.state] || result.state;
  showToast(result.changed ? `已标记为${label}` : `这一条已经是${label}`);

  // 重新解析整篇：符号、统计、行号都跟着更新（保持滚动位置，别把视线顶回页首）
  const scrollTop = els.content.scrollTop;
  await loadFile(state.file.path);
  els.content.scrollTop = scrollTop;
}

async function loadFile(filePath) {
  const result = await window.bujo.readFile(filePath);
  if (!result || !result.ok) {
    showError(`打开失败：${(result && result.error) || '未知错误'}`);
    return { ok: false, error: result && result.error };
  }
  clearError();

  state.file = result.file;
  const parsed = Bujo.parseDocument(result.file.content);
  state.blocks = parsed.blocks;
  state.stats = parsed.stats;

  document.title = `${result.file.name} — 子弹笔记`;
  renderAll();
  markActiveJournal();
  els.content.scrollTop = 0;
  return { ok: true, ...parsed, file: result.file };
}

async function openViaDialog() {
  const result = await window.bujo.openFileDialog();
  if (!result) return null; // 用户取消
  if (!result.ok) {
    showError(`打开失败：${result.error}`);
    return null;
  }
  clearError();
  state.file = result.file;
  const parsed = Bujo.parseDocument(result.file.content);
  state.blocks = parsed.blocks;
  state.stats = parsed.stats;
  document.title = `${result.file.name} — 子弹笔记`;
  renderAll();
  markActiveJournal();
  els.content.scrollTop = 0;
  return result.file;
}

async function reload() {
  if (!state.file) return;
  await loadFile(state.file.path);
}

/* ---------------- 事件绑定 ---------------- */

function setView(view) {
  state.view = view;
  els.viewPreview.classList.toggle('active', view === 'preview');
  els.viewSource.classList.toggle('active', view === 'source');
  if (state.file) renderNote();
}

els.openBtn.addEventListener('click', openViaDialog);
els.reloadBtn.addEventListener('click', reload);
els.viewPreview.addEventListener('click', () => setView('preview'));
els.viewSource.addEventListener('click', () => setView('source'));
els.sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!els.sidebar.classList.contains('collapsed')));
els.sidebarRefresh.addEventListener('click', refreshJournals);

// 日记列表：单击选中，双击打开（回车同样可以打开）
els.journalList.addEventListener('click', (event) => {
  const item = event.target.closest('.journal-item');
  if (item) markSelectedJournal(item.dataset.path);
});
els.journalList.addEventListener('dblclick', async (event) => {
  const item = event.target.closest('.journal-item');
  if (!item) return;
  markSelectedJournal(item.dataset.path);
  await loadFile(item.dataset.path);
});
els.journalList.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const item = event.target.closest('.journal-item');
  if (item) await loadFile(item.dataset.path);
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    openViaDialog();
  }
});

// 条目上的操作按钮（完成 / 划去 / 恢复）优先，其次是笔记里的外链
els.note.addEventListener('click', async (event) => {
  const act = event.target.closest('.bujo-act');
  if (act) {
    event.preventDefault();
    await applyBulletAction(act);
    return;
  }

  const anchor = event.target.closest('a[href]');
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href');
  if (/^https?:/i.test(href)) window.bujo.openExternal(href);
});

// 拖拽打开：文件路径只能由 preload 的 webUtils 解析
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer || !event.dataTransfer.types.includes('Files')) return;
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) els.dropOverlay.hidden = true;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', async (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;

  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;
  const filePath = window.bujo.getPathForFile(file);
  if (!filePath) {
    showError('无法获取拖入文件的路径，请改用「打开 .md 文件」按钮');
    return;
  }
  await loadFile(filePath);
});

/* ---------------- 启动 ---------------- */

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/** 给聊天面板用的最小接口：打开/重载笔记、刷新日记栏、拿当前文件 */
window.BujoApp = {
  loadFile,
  reload,
  refreshJournals,
  currentFile: () => state.file
};

/** 自检入口：electron . --smoke-test 会调用它，验证整条链路 */
function snapshot() {
  const entries = [...document.querySelectorAll('.bujo-entry')];
  return {
    file: state.file && state.file.name,
    blocks: state.blocks.length,
    entries: entries.length,
    kinds: entries.reduce((acc, el) => ((acc[el.dataset.kind] = (acc[el.dataset.kind] || 0) + 1), acc), {}),
    headings: document.querySelectorAll('#note h1, #note h2').length,
    stats: state.stats
  };
}

window.__bujoSmokeTest = async (filePath) => {
  const result = await loadFile(filePath);
  if (!result.ok) return { ok: false, error: result.error };
  const before = snapshot();
  const sidebarItems = journalItems();

  // 双击侧边栏第一条：应该换成那一篇日记的内容
  const first = sidebarItems[0];
  const firstPath = first && first.dataset.path;
  const initialWasFirstItem = samePath(firstPath, result.file.path);
  let afterSidebarOpen = null;
  if (first) {
    first.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    afterSidebarOpen = snapshot();
  }
  const activePath = document.querySelector('.journal-item.active')?.dataset.path ?? null;

  // 收起 / 展开：关掉过渡再量，拿到的是真实布局宽度
  const previousTransition = els.sidebar.style.transition;
  els.sidebar.style.transition = 'none';
  setSidebarCollapsed(true);
  const collapsedWidth = Math.round(els.sidebar.getBoundingClientRect().width);
  const listHidden = getComputedStyle(els.journalList).display === 'none';
  const refreshHiddenWhenCollapsed = getComputedStyle(els.sidebarRefresh).display === 'none';
  setSidebarCollapsed(false);
  const expandedWidth = Math.round(els.sidebar.getBoundingClientRect().width);
  const refreshVisibleWhenExpanded = getComputedStyle(els.sidebarRefresh).display !== 'none';
  els.sidebar.style.transition = previousTransition;

  const switched = Boolean(afterSidebarOpen) && (initialWasFirstItem || afterSidebarOpen.file !== before.file);
  // 双击打开的那一篇真的渲染出来了：至少有一个块，条目数与统计一致。
  // 不能要求「一定有子弹条目」：今天刚建的日记是个空模板，那样断言会看环境翻脸。
  const rendered = Boolean(afterSidebarOpen) && afterSidebarOpen.blocks > 0 && afterSidebarOpen.entries === afterSidebarOpen.stats.total;

  return {
    ok:
      before.entries > 0 &&
      document.querySelectorAll('.md-block').length > 0 &&
      sidebarItems.length > 0 &&
      switched &&
      rendered &&
      samePath(activePath, firstPath) &&
      collapsedWidth < expandedWidth &&
      listHidden &&
      refreshHiddenWhenCollapsed &&
      refreshVisibleWhenExpanded,
    initial: before,
    sidebar: {
      dir: els.sidebarDir.textContent,
      items: sidebarItems.length,
      names: sidebarItems.map((li) => li.querySelector('.journal-name').textContent),
      openedByDoubleClick: afterSidebarOpen && afterSidebarOpen.file,
      switched,
      rendered,
      activeHighlighted: Boolean(activePath)
    },
    afterSidebarOpen,
    collapse: { collapsedWidth, expandedWidth, listHidden, refreshHiddenWhenCollapsed, refreshVisibleWhenExpanded }
  };
};

/* ---------------- 悬浮小窗 ---------------- */

/**
 * 悬浮小窗是同一个页面的精简形态（?floating=1）：
 *   - 隐藏工具栏、日记栏、文件条、图例，只留「当天要点 + 回主窗口」与聊天面板；
 *   - 聊天面板默认展开（悬浮窗的主要交互就是它）；
 *   - 自动打开当天的日记（不存在则不创建，主窗口里再创建）。
 */
const floating = {
  active: IS_FLOATING,
  reused: false, // 自检用：applyFloatingMode() 已初始化过
  daily: null // 自动参考的当天日记 { path, name }
};

function applyFloatingMode() {
  document.body.classList.toggle('is-floating', IS_FLOATING);
  const toggle = document.getElementById('floating-toggle');
  if (toggle) toggle.hidden = IS_FLOATING;
  if (!IS_FLOATING) return;

  // 悬浮窗里聊天常驻展开
  if (window.BujoChat && typeof window.BujoChat.setOpen === 'function') window.BujoChat.setOpen(true);
  els.sidebar.classList.add('collapsed');

  // 顶部换成一条极简悬浮条，只带「回主窗口」
  const bar = document.createElement('div');
  bar.id = 'float-bar';
  bar.innerHTML = [
    '<span class="float-title">• 今日要点</span>',
    '<button id="float-back" class="btn tiny" type="button">回主窗口</button>'
  ].join('');
  document.body.prepend(bar);
  const back = bar.querySelector('#float-back');
  back.addEventListener('click', async () => {
    await window.bujo.toggleFloating();
  });

  floating.reused = true;
  showFloatingDaily();
}

/**
 * 悬浮窗自动载入「当天日记」。
 * 只读不创建（不存在时主窗口里再建），并记住路径写入 chat 的「记入」目标默认值——
 * 在悬浮窗里多半就是往今天记一笔。
 */
async function showFloatingDaily() {
  const today = await window.bujo.getTodayJournal({ create: false });
  if (today && today.ok && today.exists) {
    floating.daily = { path: today.path, name: today.name };
    await loadFile(today.path);
  } else {
    els.fileMeta.textContent = '今天的日记还没有 —— 回主窗口打开即可自动创建';
  }
}

/** 自检用：找正文匹配的条目（重载后 DOM 会重建，所以每次都重新查） */
function findEntryByText(needle) {
  return [...document.querySelectorAll('.bujo-entry')].find((el) => el.dataset.text === needle) || null;
}

/**
 * 自检入口：悬浮小窗模式的页面形态。
 * 悬浮窗打开后加载数当日日记（若存在），检查：精简条存在、完整工具栏/侧栏/图例被隐藏、
 * 正文确实渲染出了条目、聊天面板展开、「回主窗口」按钮存在。
 */
window.__bujoSmokeTestFloatingPage = async () => {
  const reused = floating.reused; // applyFloatingMode() 被调了一次后置 true，防双插悬浮条
  const bar = document.getElementById('float-bar');
  const toolbarHidden = getComputedStyle(document.querySelector('.toolbar')).display === 'none';
  const sidebarHidden = getComputedStyle(els.sidebar).display === 'none';
  const legendHidden = getComputedStyle(els.legend).display === 'none';
  const chatOpen = !document.getElementById('chat-panel').hidden;
  const hasBack = Boolean(bar && bar.querySelector('#float-back'));
  const fileMeta = els.fileMeta.textContent || '';
  const entries = document.querySelectorAll('.bujo-entry').length;

  return {
    ok: Boolean(bar) && toolbarHidden && sidebarHidden && legendHidden && chatOpen && hasBack && (entries > 0 || fileMeta.includes('还没有')),
    reused,
    barPresent: Boolean(bar),
    toolbarHidden,
    sidebarHidden,
    legendHidden,
    chatOpen,
    hasBack,
    dailyFile: (floating.daily && floating.daily.name) || null,
    fileMeta,
    entries
  };
};

/** 自检用：等条目变成期望的状态 */
async function waitEntryKind(text, kind, timeout = 3000) {
  const deadline = Date.now() + timeout;
  let seen = null;
  while (Date.now() < deadline) {
    const entry = findEntryByText(text);
    seen = entry ? entry.dataset.kind : null;
    if (seen === kind) return { ok: true, kind: seen };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { ok: false, kind: seen };
}

/**
 * 自检入口 3：真的去点条目上的「完成 / 划去 / 恢复」，验证写回文件的那一行。
 * 线序：待办 → 完成；普通笔记 → 划去；待办 → 划去 → 恢复；已划去的只能恢复。
 */
window.__bujoSmokeTestMarks = async () => {
  const steps = [];

  async function step(text, act, expectKind) {
    const entry = findEntryByText(text);
    const button = entry && entry.querySelector(`.bujo-act[data-act="${act}"]`);
    if (!button) {
      steps.push({ text, act, button: false, ok: false });
      return null;
    }
    button.click();
    const waited = await waitEntryKind(text, expectKind);
    steps.push({ text, act, button: true, expectKind, gotKind: waited.kind, ok: waited.ok });
    return findEntryByText(text);
  }

  await step('先写周报', 'done', 'done');
  await step('整理收件箱', 'cancel', 'cancelled');
  await step('买牛奶', 'cancel', 'cancelled');
  await step('买牛奶', 'restore', 'task');

  // 已经划去的条目：只给「恢复」，不给「划去」
  const already = findEntryByText('已经划去的老条目');
  const alreadyActs = already ? [...already.querySelectorAll('.bujo-act')].map((b) => b.dataset.act) : [];

  // 每个状态的条目各有哪些按钮，逐一记下来供人工核对
  const inventory = [...document.querySelectorAll('.bujo-entry')].map((el) => ({
    text: el.dataset.text,
    kind: el.dataset.kind,
    line: el.dataset.line,
    acts: [...el.querySelectorAll('.bujo-act')].map((b) => b.dataset.act)
  }));

  // 按钮不是「存在就行」：得真的排版出来、并且在窗口里看得见
  const layout = [...document.querySelectorAll('.bujo-entry')].map((el) => {
    const acts = el.querySelector('.bujo-acts');
    const buttons = [...el.querySelectorAll('.bujo-act')];
    return {
      text: el.dataset.text,
      actsOpacity: acts ? Number(getComputedStyle(acts).opacity) : 0,
      boxes: buttons.map((button) => {
        const box = button.getBoundingClientRect();
        return `${Math.round(box.width)}x${Math.round(box.height)}`;
      }),
      visible: buttons.length > 0 && buttons.every((button) => {
        const box = button.getBoundingClientRect();
        return box.width > 12 && box.height > 8 && box.right <= window.innerWidth + 1 && box.left >= 0;
      })
    };
  });
  const layoutOk = layout.length > 0 && layout.every((item) => item.visible && item.actsOpacity > 0);
  const toastText = (els.toast && els.toast.textContent) || '';
  const toastShown = Boolean(toastText) && !els.toast.hidden;

  return {
    ok: steps.every((item) => item.ok) && alreadyActs.join(',') === 'restore' && layoutOk && toastShown,
    steps,
    alreadyActs,
    inventory,
    layout,
    layoutOk,
    toast: toastText,
    toastShown,
    entries: inventory.length
  };
};

(async function init() {
  renderLegend();
  renderAll();

  // 记住上次的折叠状态，但初始化时不要反过来写存储
  const remembered = (() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY);
    } catch {
      return null;
    }
  })();
  els.sidebar.classList.toggle('collapsed', remembered === '1');
  els.sidebarToggle.textContent = remembered === '1' ? '›' : '‹';

  if (floating.active) {
    applyFloatingMode();
  } else {
    // 悬浮窗入口按钮只出现在主窗口工具栏
    const toggle = document.getElementById('floating-toggle');
    if (toggle) {
      toggle.hidden = false;
      toggle.addEventListener('click', async () => {
        const result = await window.bujo.toggleFloating();
        if (result && !result.ok) showError(`切换悬浮小窗失败：${result.error}`);
      });
    }
  }

  await refreshJournals();
  const initial = await window.bujo.getInitialFile();
  if (initial) await loadFile(initial);
})();
