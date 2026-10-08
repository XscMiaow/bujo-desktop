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
  content: document.getElementById('content'),
  sidebar: document.getElementById('sidebar'),
  sidebarToggle: document.getElementById('sidebar-toggle'),
  sidebarRefresh: document.getElementById('sidebar-refresh'),
  sidebarDir: document.getElementById('sidebar-dir'),
  sidebarEmpty: document.getElementById('sidebar-empty'),
  journalList: document.getElementById('journal-list')
};

const SIDEBAR_KEY = 'bujo.sidebar.collapsed';

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
  const order = ['task', 'done', 'migrated', 'scheduled', 'priority', 'note', 'event'];

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
  if (stats.priority) chips.push(`<span class="chip">优先 ${stats.priority}</span>`);
  if (stats.event) chips.push(`<span class="chip">事件 ${stats.event}</span>`);
  if (stats.migrated) chips.push(`<span class="chip">迁移 ${stats.migrated}</span>`);
  if (stats.note) chips.push(`<span class="chip">笔记 ${stats.note}</span>`);
  chips.push(
    `<span class="chip">进度 ${stats.progress}%</span><span class="progress"><span style="width:${stats.progress}%"></span></span>`
  );
  els.stats.innerHTML = chips.join('');
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

    li.append(glyph, text);
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

// 笔记里的外链交给系统浏览器
els.note.addEventListener('click', (event) => {
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

  return {
    ok:
      before.entries > 0 &&
      document.querySelectorAll('.md-block').length > 0 &&
      sidebarItems.length > 0 &&
      switched &&
      afterSidebarOpen.entries > 0 &&
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
      activeHighlighted: Boolean(activePath)
    },
    afterSidebarOpen,
    collapse: { collapsedWidth, expandedWidth, listHidden, refreshHiddenWhenCollapsed, refreshVisibleWhenExpanded }
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

  await refreshJournals();
  const initial = await window.bujo.getInitialFile();
  if (initial) await loadFile(initial);
})();
