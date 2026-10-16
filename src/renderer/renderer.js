'use strict';

/* 渲染层：没有 Node 权限，所有文件操作都经过 window.bujo（preload 桥） */

const Bujo = window.BulletJournal;
const marked = window.marked;
const I18n = window.I18n;

marked.setOptions({ gfm: true, breaks: false });

/** 取词捷径；kindLabel 用「kind.<id>」键，插件的自定义类型回落到 plugin.label */
function t(key, params) {
  return I18n.t(key, params);
}

function kindLabel(key, meta) {
  const translated = t(`kind.${key}`);
  if (translated !== `kind.${key}`) return translated;
  return (meta && meta.label) || key;
}

function kindClassVar(kind) {
  return `var(--kind-${kind})`;
}

const els = {
  openBtn: document.getElementById('open-btn'),
  reloadBtn: document.getElementById('reload-btn'),
  viewPreview: document.getElementById('view-preview'),
  viewSource: document.getElementById('view-source'),
  viewTasks: document.getElementById('view-tasks'),
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
  journalList: document.getElementById('journal-list'),
  themeSelect: document.getElementById('theme-select')
};

const SIDEBAR_KEY = 'bujo.sidebar.collapsed';

/** 悬浮小窗模式：同一页面用 URL 参数识别，切到精简布局 */
const IS_FLOATING = new URLSearchParams(window.location.search).get('floating') === '1';

const state = {
  file: null, // { path, name, dir, size, modifiedAt, content }
  blocks: [],
  stats: null,
  view: 'preview',
  journals: [], // 日记目录里的文件，最新在前
  taskJournal: null, // 「每日任务」视图：今天的日记 { path, name, content } 或 null
  taskError: null, // 「每日任务」读不到的原因（'none' = 今天的日记还没建）
  taskListPath: null, // 「每日任务」视图里操作写回的目标（今天的日记）
  foldedGroups: loadFoldedGroups() // 侧边栏折叠中的分组 key（年/月/集子）
};

/** 侧边栏分组折叠的存储键与读写（坏值一律当「全展开」处理） */
const FOLD_STORAGE_KEY = 'bujo.sidebar.fold';
function loadFoldedGroups() {
  try {
    const parsed = JSON.parse(localStorage.getItem(FOLD_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}
function saveFoldedGroups() {
  try {
    localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify([...state.foldedGroups]));
  } catch { /* 存不了只影响偏好记忆 */ }
}

/* ---------------- 渲染 ---------------- */

function renderLegend() {
  const kinds = Bujo.KINDS;
  // 内置八大类在前，插件自定义类型按注册顺序跟上
  const order = ['task', 'done', 'cancelled', 'migrated', 'scheduled', 'priority', 'note', 'event']
    .concat(Object.keys(kinds).filter((key) => !['task', 'done', 'cancelled', 'migrated', 'scheduled', 'priority', 'note', 'event'].includes(key)));

  els.legend.innerHTML = order
    .map((key) => {
      const meta = kinds[key];
      return `<span><span class="glyph" style="color:${kindClassVar(key)}">${meta.glyph}</span>${kindLabel(key, meta)} <code>${escapeHtml(meta.symbol)}</code></span>`;
    })
    .join('');

  els.emptyLegend.innerHTML = order
    .map((key) => {
      const meta = kinds[key];
      return `<li><span class="glyph" style="color:${kindClassVar(key)}">${meta.glyph}</span>${kindLabel(key, meta)}<code>${escapeHtml(meta.symbol)}</code></li>`;
    })
    .join('');
}

function renderFileMeta() {
  if (!state.file) {
    els.fileMeta.textContent = t('fileMeta.none');
    return;
  }
  const { name, dir, size, modifiedAt } = state.file;
  const kb = (size / 1024).toFixed(1);
  // 时间戳跟着界面语言走（zh-CN 中文格式，en 英文格式…）
  const time = new Date(modifiedAt).toLocaleString(I18n.getLocale() || 'zh-CN', { hour12: false });
  els.fileMeta.innerHTML = `<strong>${escapeHtml(name)}</strong> · ${escapeHtml(t('fileMeta.line', { dir: escapeHtml(dir), kb, time }))}`;
}

function renderStats(stats) {
  if (!stats || stats.total === 0) {
    els.stats.innerHTML = '';
    return;
  }
  const chips = [];
  const pushChip = (key, count) => {
    if (count) chips.push(`<span class="chip">${escapeHtml(t('stats.chip', { label: t(`stats.${key}`), n: count }))}</span>`);
  };
  pushChip('task', stats.task);
  pushChip('done', stats.done);
  pushChip('cancelled', stats.cancelled);
  pushChip('priority', stats.priority);
  pushChip('event', stats.event);
  pushChip('migrated', stats.migrated);
  pushChip('note', stats.note);
  // 插件的自定义类型：有计数就补一枚胶囊（标签用插件给的，不走 t()）
  Bujo.getCustomBullets().forEach((bullet) => {
    if (stats[bullet.kind]) chips.push(`<span class="chip">${escapeHtml(bullet.label)} ${stats[bullet.kind]}</span>`);
  });
  chips.push(
    `<span class="chip">${escapeHtml(t('stats.progress', { n: stats.progress }))}</span><span class="progress"><span style="width:${stats.progress}%"></span></span>`
  );
  els.stats.innerHTML = chips.join('');
}

/** 能「完成」的条目类型：内置四种 + 插件声明 taskLike 的自定义类型 */
const TASK_LIKE = new Set(['task', 'priority', 'scheduled', 'migrated']);

function isTaskLike(kind) {
  if (TASK_LIKE.has(kind)) return true;
  const meta = Bujo.KINDS[kind];
  return Boolean(meta && meta.custom && meta.taskLike);
}

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

/** 恢复到某种类型的标记：任务系用复选框字符，笔记/事件回到原符号 */
const RESTORE_MARKS = { task: ' ', note: 'n', event: 'e' };

/** 划去时写入的带提示标记；优先是叠加位，会自动跟着写回 [-!]/[-n!] 等 */
const CANCEL_MARKS = { task: '-', note: '-n', event: '-e' };

/**
 * 手工操作：待办可以「完成」；划去的恢复回**原来的类型**（笔记/事件 → 原符号，待办 → 待办）；
 * 优先是叠加标记：任何类型都能加/去星标（★），完成/划去/恢复都不丢；
 * 划去只改标记，原文一直留在文件里。
 */
function buildEntryActions(item) {
  const acts = document.createElement('span');
  acts.className = 'bujo-acts';

  if (item.kind === 'done') {
    acts.append(entryAction('restore', t('act.restore.done'), t('act.restore.done.title')));
  } else if (item.kind === 'cancelled') {
    const back = item.prior || 'task';
    const labelMeta = Bujo.KINDS[back] || Bujo.KINDS.task;
    const backLabel = kindLabel(back, labelMeta);
    acts.append(entryAction('restore', t('act.restoreTo', { label: backLabel }), t('act.restoreTo.title', { label: backLabel })));
  } else if (isTaskLike(item.kind)) {
    acts.append(entryAction('done', t('act.done'), t('act.done.title')));
  }

  // 迁移/推迟的「回退」：这一行恢复为待办；已搬进目标日志的条目原地不动，
  // 它自己要再搬就等于「重新迁移旧项目」，不需要其他操作。
  // （已迁移的条目不能从原地再搬一次：先取消迁移，或者去目标日志搬那个副本）
  if (item.kind === 'migrated') {
    acts.append(entryAction('restore', t('act.unmigrate'), t('act.unmigrate.title')));
  } else if (item.kind === 'scheduled') {
    acts.append(entryAction('restore', t('act.unschedule'), t('act.unschedule.title')));
  }

  // 优先开关：任意类型（含已完成/计划/迁移）都能 ★；划去态也保留原优先，可去可加
  acts.append(
    entryAction(
      'priority',
      item.priority ? t('act.priority.remove') : t('act.priority.add'),
      item.priority ? t('act.priority.removeTitle') : t('act.priority.addTitle')
    )
  );

  if (item.kind !== 'cancelled') {
    acts.append(entryAction('cancel', t('act.cancel'), t('act.cancel.title')));
  }

  // 迁移/推迟：待办、笔记、事件、已计划（[<]）的都能再搬；已完成/已划去/已迁移的不给
  //（已迁移的想再搬：先「取消迁移」，或去目标日志搬那个副本 = 重新迁移旧项目）
  if (!item.kind || ['task', 'note', 'event', 'scheduled'].includes(item.kind)) {
    acts.append(entryAction('move', t('act.move'), t('act.move.title')));
  }

  return acts;
}

/** 迁移/推迟的目的地（与主进程 ensureMoveDestination 的 kind 对齐）；文案走 i18n */
const MOVE_OPTIONS = [
  { destination: 'tomorrow', labelKey: 'move.tomorrow', hintKey: 'move.tomorrow.hint' },
  { destination: 'nextMonth', labelKey: 'move.nextMonth', hintKey: 'move.nextMonth.hint' },
  { destination: 'future', labelKey: 'move.future', hintKey: 'move.future.hint' }
];

/** 关掉别的条目还开着的迁移菜单 */
function closeMoveMenus(exceptEntry) {
  document.querySelectorAll('.bujo-move-menu').forEach((menu) => {
    const entry = menu.closest('.bujo-entry');
    if (!exceptEntry || !entry || entry !== exceptEntry) menu.remove();
  });
}

/** 点「»」：弹出本条目的迁移菜单（推送到再点或点别处关闭） */
function toggleMoveMenu(button) {
  const entry = button.closest('.bujo-entry');
  if (!entry) return;
  const existing = entry.querySelector('.bujo-move-menu');
  closeMoveMenus(entry);
  if (existing) return; // 再点一次就是收起

  entry.style.position = entry.style.position && entry.style.position !== 'static' ? entry.style.position : 'relative';
  const menu = document.createElement('span');
  menu.className = 'bujo-move-menu';
  menu.innerHTML = MOVE_OPTIONS.map(
    (option) =>
      `<button type="button" class="bujo-move-option" data-move="${option.destination}" title="${escapeHtml(t(option.hintKey))}">${escapeHtml(t(option.labelKey))}</button>`
  ).join('');
  entry.append(menu);
}

/**
 * 点菜单里的目的地：主进程把这一条搬到目标日志（自动建），原文就地标 [>]/[<]。
 * 结束后整篇重载 + 刷新侧边栏（目标可能是新文件）。
 */
async function applyMoveAction(entry, destination) {
  const buttons = [...entry.querySelectorAll('.bujo-act')];
  buttons.forEach((button) => {
    button.disabled = true;
  });

  const result = await window.bujo.moveBullet({
    filePath: activeWritePath(),
    line: Number(entry.dataset.line),
    text: entry.dataset.text || '',
    destination
  });

  if (!result || !result.ok) {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    showError(t('error.moveFailed', { error: (result && result.error) || t('error.prefix') }));
    return;
  }

  clearError();
  const movedLabel = result.destinationKind === 'tomorrow'
    ? t('toast.movedToTomorrow')
    : t('toast.movedTo', { name: (result && result.destName) || t('toast.target.default') });
  const alreadyLabel = result.destinationKind === 'tomorrow'
    ? t('toast.alreadyInTomorrow')
    : t('toast.alreadyInTarget', { target: (result && result.destName) || t('toast.target.default') });
  showToast(result.destChanged ? movedLabel : alreadyLabel);

  await reloadAfterWrite();
  await refreshJournals();
}

/** 一个子弹列表 → <ul>，符号由「子弹类型」决定，而不是原始文本 */
function buildBulletList(block) {
  const ul = document.createElement('ul');
  ul.className = 'bujo-list';

  // [-] 划去条目排到列表末尾独立成一区；[!] 优先留在原位（样式上单独突出）
  const ordered = [
    ...block.items.filter((item) => item.kind !== 'cancelled'),
    ...block.items.filter((item) => item.kind === 'cancelled')
  ];

  ordered.forEach((item) => {
    const meta = Bujo.KINDS[item.kind] || Bujo.KINDS.note;
    const li = document.createElement('li');
    li.className = `bujo-entry ${meta.cls}`;
    li.dataset.kind = item.kind;
    // 优先是叠加标记：任意类型都能带（样式突出 + 星标开关都看它）
    if (item.priority) {
      li.classList.add('is-priority');
      li.dataset.priority = '1';
    }
    // 划去条目的「之前类型」：恢复时要回到原符号，而不是一律变回待办
    if (item.prior) li.dataset.prior = item.prior;
    // 行号与正文：改标记时靠它们精准找到文件里的那一行
    li.dataset.line = String(item.line);
    li.dataset.text = item.text;

    // 缩进映射成固定步长，层级太深也不会跑出屏幕
    const indentPx = Math.min(item.indent, 12) * 6;
    if (indentPx > 0) li.style.setProperty('--indent', `${indentPx}px`);    const glyph = document.createElement('span');
      glyph.className = 'bujo-glyph';
      glyph.textContent = meta.glyph;
      glyph.title = kindLabel(item.kind, meta);

    // 优先居标：紧跟主符号后面的一个金色 ★，任何类型上都能看到
    if (item.priority) {
      const star = document.createElement('span');
      star.className = 'bujo-star';
      star.textContent = '★';
      star.title = t('state.priority');
      glyph.after(star);
    }

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

  // 「每日任务」视图：今天的任务清单（不需要先打开文件）
  if (state.view === 'tasks') {
    renderDailyTasksInto(els.note);
    return;
  }

  // 「原文」视图：直接可编辑的 Markdown 编辑器（Ctrl/Cmd + S 保存，或点保存按钮）
  if (state.view === 'source') {
    const editor = document.createElement('textarea');
    editor.id = 'source-editor';
    editor.className = 'source-editor';
    editor.spellcheck = false;
    editor.value = state.file ? state.file.content : '';
    editor.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveSourceEditor();
      }
    });

    const bar = document.createElement('div');
    bar.className = 'source-editor-bar';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn primary tiny';
    saveBtn.dataset.role = 'save-source';
    saveBtn.textContent = t('source.save');
    saveBtn.addEventListener('click', () => saveSourceEditor());
    const hint = document.createElement('span');
    hint.className = 'source-editor-hint';
    hint.textContent = t('source.editor.hint');
    bar.append(saveBtn, hint);

    els.note.append(bar, editor);
    if (state.focusSource) {
      state.focusSource = false;
      editor.focus();
    }
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

  // 「每日任务」视图不需要先打开文件也能工作
  const hasContent = Boolean(state.file) || state.view === 'tasks';
  els.reloadBtn.disabled = !state.file;
  if (!hasContent) {
    els.note.hidden = true;
    els.emptyState.hidden = false;
    return;
  }
  renderNote();
}

/* ---------------- 原文编辑器（source 视图直接改 Markdown） ---------------- */

/** 编辑器被改动后标记有未保存内容（离开前不丢）；保存成功后就清掉 */
function markSourceDirty() {
  state.sourceDirty = true;
}

/** 把原文编辑器里的内容保存回原文件（白名单与其它写入口一致） */
async function saveSourceEditor() {
  if (!state.file || state.view !== 'source') return;
  const editor = document.getElementById('source-editor');
  if (!editor) return;

  const result = await window.bujo.saveNote(state.file.path, editor.value);
  if (!result || !result.ok) {
    showError(t('error.saveSource', { error: (result && result.error) || t('error.prefix') }));
    return;
  }
  state.sourceDirty = false;
  clearError();
  showToast(t('toast.saved'));
  const view = els.content.scrollTop;
  await loadFile(state.file.path);
  els.content.scrollTop = view;
}

/* ---------------- 每日任务列表（视图：今天日记里的任务清单） ---------------- */

/** 拉今天的日记（不会顺手建文件），算出任务清单的班级数据 */
async function loadDailyTasks() {
  state.taskListPath = null;
  state.taskJournal = null;
  state.taskError = null;
  const result = await window.bujo.getTodayJournal({ create: false });
  if (!result || !result.ok) {
    state.taskError = (result && result.error) || t('error.prefix');
  } else if (!result.exists) {
    state.taskError = 'none';
  } else {
    state.taskJournal = { path: result.path, name: result.name, content: result.content || '' };
    state.taskListPath = result.path;
  }
  if (state.view === 'tasks') renderNote();
}

/** 今天的任务清单：待办/优先/计划/迁移在前，完成次之，划去垫底（不可操作的行不带按钮） */
function renderDailyTasksInto(target) {
  target.innerHTML = '';
  const lib = window.JournalDate;
  const date = new Date();

  const holder = document.createElement('div');
  holder.className = 'daily-tasks';

  const head = document.createElement('h2');
  head.className = 'daily-tasks-head';
  head.textContent = `${lib.dateKey(date)} · ${t('tasks.title')}`;
  const meta = document.createElement('p');
  meta.className = 'daily-tasks-meta';

  if (!state.taskJournal) {
    meta.textContent = state.taskError === 'none' ? t('tasks.none') : `${t('tasks.readFailed')}：${state.taskError || t('error.prefix')}`;
    holder.append(head, meta);
    target.append(holder);
    return;
  }

  const parsed = Bujo.parseDocument(state.taskJournal.content || '');
  const items = parsed.blocks.flatMap((block) => (block.type === 'bullets' ? block.items : []));
  const open = items.filter((item) => isTaskLike(item.kind) || item.kind === 'migrated' || item.kind === 'scheduled');
  const done = items.filter((item) => item.kind === 'done');
  const struck = items.filter((item) => item.kind === 'cancelled');
  meta.textContent = t('tasks.count', { open: open.length, done: done.length, struck: struck.length });

  const ordered = [
    ...open.filter((item) => !item.priority),
    ...open.filter((item) => item.priority),
    ...done,
    ...struck
  ];
  holder.append(head, meta);
  if (ordered.length) holder.append(buildBulletList({ type: 'bullets', items: ordered }));
  const hint = document.createElement('p');
  hint.className = 'daily-tasks-hint';
  hint.textContent = t('tasks.hint');
  holder.append(hint);
  target.append(holder);
}

/** 条目操作写回的目标路径：每日任务视图里是今天的日记，其它情况是当前打开的文件 */
function activeWritePath() {
  return state.view === 'tasks' && state.taskListPath ? state.taskListPath : state.file && state.file.path;
}

/** 写完后的刷新：任务列表视图重新拉今天的清单，其它视图重载当前文件 */
async function reloadAfterWrite() {
  const scroll = els.content.scrollTop;
  if (state.view === 'tasks') {
    await loadDailyTasks();
  } else if (state.file) {
    await loadFile(state.file.path);
    if (state.view === 'source') {
      // 原文编辑器不被外部旧值覆盖：重载后重新渲染（编辑器是新的一捧）
      state.focusSource = false;
    }
  }
  els.content.scrollTop = scroll;
}

/* ---------------- 左侧日记栏 ---------------- */

/** 文件名（+角色）→ 列表里的主标题与副标题（星期算法与主进程共用 journal-date.js） */
function journalLabel(fileName, role) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '');
  const lib = window.JournalDate;
  const day = lib && lib.parseDateKey(base);
  if (role === 'future') return { name: base, sub: t('sidebar.futureRecord.note') };
  if (role === 'monthly') {
    const month = lib && lib.parseMonthKey(base);
    return { name: t('sidebar.monthlyRecord'), sub: month ? lib.monthLabel(month) : t('sidebar.monthlyRecord') };
  }
  if (day) return { name: base, sub: lib.weekdayLabel(day) };
  return { name: base, sub: t('journal.sub.note') };
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

/** 生成一行日记条目；pending 传 ensure 参数（还没建的「未来记录 / 月度记录」） */
function journalRow({ label, path = '', pending = null, modifiedAt = null }) {
  const li = document.createElement('li');
  li.className = 'journal-item' + (pending ? ' pending' : '');
  if (path) li.dataset.path = path;
  if (pending) li.dataset.ensure = JSON.stringify(pending);
  li.tabIndex = 0;
  li.title = path ? `${path}\n${t('sidebar.row.openHint')}` : t('sidebar.row.pendingHint');
  const sub = [label.sub, modifiedAt ? shortTime(modifiedAt) : null].filter(Boolean).join(' · ');
  li.innerHTML =
    `<span class="journal-name">${escapeHtml(label.name)}</span>` +
    `<span class="journal-sub">${escapeHtml(sub)}</span>`;
  return li;
}

function renderJournalList() {
  els.journalList.innerHTML = '';
  els.sidebarEmpty.hidden = state.journals.length > 0;
  const lib = window.JournalDate;

  const { years, strays, collections: collectionMap } = groupJournals(state.journals);

  [...years.values()]
    .sort((a, b) => Number(b.year) - Number(a.year))
    .forEach((yearGroup) => {
      // 年文件夹标题（可折叠：点一下收起/展开整年的日记）
      const head = document.createElement('li');
      head.className = 'journal-group';
      head.dataset.foldKey = `y:${yearGroup.year}`;
      head.title = t('sidebar.group.fold.hint');
      head.innerHTML = `<span class="fold-caret">▾</span><span class="journal-group-name">${escapeHtml(yearGroup.year)}</span><span class="journal-group-hint">${escapeHtml(t('sidebar.group.year'))}</span>`;
      els.journalList.append(head);

      // 年度（未来）记录：已有用真实文件，否则给一行「双击新建」
      if (yearGroup.future) {
        const file = yearGroup.future;
        els.journalList.append(journalRow({ label: { name: lib.FUTURE_RECORD_FILE.replace(/\.md$/, '') || t('sidebar.futureRecord'), sub: t('sidebar.futureRecord.sub', { year: yearGroup.year }) }, path: file.path, modifiedAt: file.modifiedAt }));
      } else {
        els.journalList.append(
          journalRow({ label: { name: t('sidebar.futureRecord'), sub: t('sidebar.futureRecord.pending', { year: yearGroup.year }) }, pending: { kind: 'future', year: yearGroup.year } })
        );
      }

      // 年文件夹下认不出月份的散文件（迁移残留等，罕见）
      yearGroup.others.forEach((file) => {
        els.journalList.append(journalRow({ label: journalLabel(file.name, file.role), path: file.path, modifiedAt: file.modifiedAt }));
      });

      [...yearGroup.months.values()]
        .sort((a, b) => b.month.localeCompare(a.month))
        .forEach((monthGroup) => {
          const monthDate = lib && lib.parseMonthKey(monthGroup.month);
          const monthHead = document.createElement('li');
          monthHead.className = 'journal-group month';
          if (monthDate) monthHead.title = lib.monthLabel(monthDate);
          monthHead.dataset.foldKey = `m:${monthGroup.month}`;
          monthHead.innerHTML = `<span class="fold-caret">▾</span><span class="journal-group-name">${escapeHtml(monthDate ? lib.monthLabel(monthDate) : monthGroup.month)}</span>`;
          els.journalList.append(monthHead);

          if (monthGroup.monthly) {
            const file = monthGroup.monthly;
            els.journalList.append(journalRow({ label: { name: t('sidebar.monthlyRecord'), sub: monthDate ? lib.monthLabel(monthDate) : monthGroup.month }, path: file.path, modifiedAt: file.modifiedAt }));
          } else {
            els.journalList.append(
              journalRow({ label: { name: t('sidebar.monthlyRecord'), sub: t('sidebar.monthlyRecord.pending') }, pending: { kind: 'monthly', month: monthGroup.month } })
            );
          }

          // 每日记录：主进程已按日期新→旧排序
          monthGroup.entries.forEach((file) => {
            els.journalList.append(journalRow({ label: journalLabel(file.name, file.role), path: file.path, modifiedAt: file.modifiedAt }));
          });
        });
    });

  // 自定义集子：journals/ 下自己建的文件夹（不叫年份的）自成一组
  [...collectionMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([name, files]) => {
      const head = document.createElement('li');
      head.className = 'journal-group collection';
      head.dataset.foldKey = `c:${name}`;
      head.innerHTML = `<span class="fold-caret">▾</span><span class="journal-group-name">${escapeHtml(name)}</span><span class="journal-group-hint">${escapeHtml(t('sidebar.group.collection'))}</span>`;
      els.journalList.append(head);
      files.forEach((file) => {
        els.journalList.append(journalRow({ label: journalLabel(file.name, file.role), path: file.path, modifiedAt: file.modifiedAt }));
      });
    });

  if (strays.length) {
    const head = document.createElement('li');
    head.className = 'journal-group';
    head.innerHTML = `<span class="journal-group-name">${escapeHtml(t('sidebar.group.other'))}</span>`;
    els.journalList.append(head);
    strays.forEach((file) => {
      els.journalList.append(journalRow({ label: journalLabel(file.name, file.role), path: file.path, modifiedAt: file.modifiedAt }));
    });
  }

  // 折叠归属：按源序扫描，分组头记录当前上下文链，子行带上自己的链
  let foldChain = [];
  [...els.journalList.children].forEach((li) => {
    if (li.classList.contains('journal-group')) {
      if (li.dataset.foldKey) {
        foldChain = [...(li.dataset.foldChain || '').split(';').filter(Boolean), li.dataset.foldKey];
        // 组头自己也会被外层折叠（折叠「2026」时月组头也收起来）
        li.dataset.foldChain = foldChain.slice(0, -1).join(';');
      } else {
        foldChain = [];
      }
      return;
    }
    li.dataset.foldChain = foldChain.join(';');
  });
  applyGroupFolds();
  markActiveJournal();

  /** 把文件列表归成「年 → 月 + 自定义集子」；认不出年份且不在集子里的归入末尾散件组 */
  function groupJournals(files) {
    const years = new Map();
    const collections = new Map();
    const strays = [];

    files.forEach((file) => {
      if (file.collection) {
        // 自定义集子：顶层自己建的文件夹（名字不是年份）
        const group = collections.get(file.collection) || [];
        group.push(file);
        collections.set(file.collection, group);
        return;
      }
      if (!file.year) {
        strays.push(file);
        return;
      }
      const key = String(file.year);
      const yearGroup = years.get(key) || { year: key, future: null, months: new Map(), others: [] };
      years.set(key, yearGroup);

      if (file.role === 'future') {
        yearGroup.future = yearGroup.future || file;
      } else if (file.month) {
        const monthKey = String(file.month);
        const month = yearGroup.months.get(monthKey) || { month: monthKey, monthly: null, entries: [] };
        yearGroup.months.set(monthKey, month);
        if (file.role === 'monthly') month.monthly = month.monthly || file;
        else month.entries.push(file);
      } else {
        yearGroup.others.push(file);
      }
    });

    return { years, strays, collections };
  }
}

async function refreshJournals() {
  const result = await window.bujo.listJournals();
  if (!result || !result.ok) {
    showError(t('error.readJournals', { error: (result && result.error) || t('error.prefix') }));
    return;
  }
  state.journals = result.files;
  els.sidebarDir.textContent = result.dir;
  els.sidebarDir.title = result.dir;
  renderJournalList();
}

/**
 * 应用分组折叠：折叠组收起它的全部子行；偏好存在 localStorage（坏值当全展开）。
 * 组头上的「▾/▸」随状态翻面。
 */
function applyGroupFolds() {
  [...els.journalList.children].forEach((li) => {
    const chain = (li.dataset.foldChain || '').split(';').filter(Boolean);
    li.hidden = chain.some((key) => state.foldedGroups.has(key));
    if (li.dataset.foldKey) {
      const caret = li.querySelector('.fold-caret');
      if (caret) caret.textContent = state.foldedGroups.has(li.dataset.foldKey) ? '▸' : '▾';
    }
  });
}

function setSidebarCollapsed(collapsed) {
  els.sidebar.classList.toggle('collapsed', collapsed);
  els.sidebarToggle.textContent = collapsed ? '›' : '‹';
  els.sidebarToggle.title = collapsed ? t('sidebar.toggle.expand') : t('sidebar.toggle.collapse');
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

/**
 * 动作 → 写进文件的标记。
 * 恢复/划去按「原来是什么」映射（划去待办是 [-]，划去笔记/事件用双字符提示）；
 * 优先是叠加位：主进程在 setMark 里根据原行的 priority 自动补/去「!」尾缀（[-!] / [-n!] / [x!]）。
 */
function markForAction(entry, act) {
  const kind = entry.dataset.kind;
  const prior = entry.dataset.prior || 'task';
  const hasPriority = entry.dataset.priority === '1';
  if (act === 'done') return 'x';
  if (act === 'priority') return hasPriority ? 'p' : '+'; // 'p' 去星（类型不变）；'+' 加星（类型不变）
  if (act === 'cancel') return CANCEL_MARKS[prior] || '-';
  if (act === 'restore') {
    // 取消完成 → 改回待办；setMark 会保留原行已有的优先标志（[x!] 恢复回 [!]）
    if (kind === 'done') return ' ';
    // 取消迁移/取消推迟 → 恢复为普通待办（正文保留，优先标志不动）
    if (kind === 'migrated' || kind === 'scheduled') return ' ';
    return RESTORE_MARKS[prior] || ' '; // 取消划去 → 回到原来的类型
  }
  return null;
}
/** 提示条里的状态名（i18n；插件类型用 plugin.label 兜底） */
function stateLabel(kind) {
  const translated = t(`state.${kind}`);
  if (translated !== `state.${kind}`) return translated;
  return (Bujo.KINDS[kind] && Bujo.KINDS[kind].label) || kind;
}

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
  const mark = entry && markForAction(entry, act.dataset.act);
  const filePath = activeWritePath();
  if (!entry || !mark || !filePath) return;

  const buttons = [...entry.querySelectorAll('.bujo-act')];
  buttons.forEach((button) => {
    button.disabled = true;
  });

  const result = await window.bujo.setBulletMark({
    filePath,
    line: Number(entry.dataset.line),
    text: entry.dataset.text || '',
    mark
  });

  if (!result || !result.ok) {
    buttons.forEach((button) => {
      button.disabled = false;
    });
    showError(t('error.cannotChange', { error: (result && result.error) || t('error.prefix') }));
    return;
  }

  clearError();
  const label = stateLabel(result.state);
  showToast(result.changed ? t('toast.marked', { label }) : t('toast.already', { label }));

  // 重新解析整篇：符号、统计、行号都跟着更新（保持滚动位置，别把视线顶回页首）
  await reloadAfterWrite();
}

async function loadFile(filePath) {
  const result = await window.bujo.readFile(filePath);
  if (!result || !result.ok) {
    showError(t('error.openFailed', { error: (result && result.error) || t('error.prefix') }));
    return { ok: false, error: result && result.error };
  }
  clearError();

  state.file = result.file;
  const parsed = Bujo.parseDocument(result.file.content);
  state.blocks = parsed.blocks;
  state.stats = parsed.stats;

  document.title = t('app.docTitle', { name: result.file.name });
  renderAll();
  markActiveJournal();
  els.content.scrollTop = 0;
  return { ok: true, ...parsed, file: result.file };
}

async function openViaDialog() {
  const result = await window.bujo.openFileDialog();
  if (!result) return null; // 用户取消
  if (!result.ok) {
    showError(t('error.openFailed', { error: result.error }));
    return null;
  }
  clearError();
  state.file = result.file;
  const parsed = Bujo.parseDocument(result.file.content);
  state.blocks = parsed.blocks;
  state.stats = parsed.stats;
  document.title = t('app.docTitle', { name: result.file.name });
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
  if (els.viewTasks) els.viewTasks.classList.toggle('active', view === 'tasks');
  if (view === 'tasks') {
    loadDailyTasks();
    return;
  }
  if (state.file) renderNote();
}

els.openBtn.addEventListener('click', openViaDialog);
els.reloadBtn.addEventListener('click', reload);
els.viewPreview.addEventListener('click', () => setView('preview'));
els.viewSource.addEventListener('click', () => setView('source'));
if (els.viewTasks) els.viewTasks.addEventListener('click', () => setView('tasks'));
els.sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!els.sidebar.classList.contains('collapsed')));
els.sidebarRefresh.addEventListener('click', refreshJournals);

/**
 * 双击/回车打开一篇日记。还没建的「未来记录 / 月度记录」行（data-ensure）
 * 先按模板创建，再刷新列表并载入新建的文件。
 */
async function openJournalRow(li) {
  if (!li) return;
  const ensureSpec = li.dataset.ensure;
  if (!ensureSpec && !li.dataset.path) return; // 分组头不是日记，点了也不应该有反映
  if (ensureSpec) {
    let spec;
    try {
      spec = JSON.parse(ensureSpec);
    } catch {
      return;
    }
    const result = await window.bujo.ensureJournal(spec);
    if (!result || !result.ok) {
      showError(t('error.createJournalFailed', { error: (result && result.error) || t('error.prefix') }));
      return;
    }
    clearError();
    await refreshJournals();
    await loadFile(result.path);
    return;
  }
  await loadFile(li.dataset.path);
}

// 日记列表：单击选中，双击打开（回车同样可以打开）；点分组头 = 折叠/展开该组
els.journalList.addEventListener('click', (event) => {
  const head = event.target.closest('.journal-group[data-fold-key]');
  if (head) {
    const key = head.dataset.foldKey;
    if (state.foldedGroups.has(key)) state.foldedGroups.delete(key);
    else state.foldedGroups.add(key);
    saveFoldedGroups();
    applyGroupFolds();
    return;
  }
  const item = event.target.closest('.journal-item');
  if (item) markSelectedJournal(item.dataset.path);
});
els.journalList.addEventListener('dblclick', async (event) => {
  const item = event.target.closest('.journal-item');
  if (!item) return;
  markSelectedJournal(item.dataset.path);
  await openJournalRow(item);
});
els.journalList.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const item = event.target.closest('.journal-item');
  if (item) await openJournalRow(item);
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    openViaDialog();
  }
});

// 点菜单外面 / 按 Esc 关掉迁移菜单
document.addEventListener('click', (event) => {
  if (event.target.closest('.bujo-move-menu')) return;
  if (event.target.closest('.bujo-act[data-act="move"]')) return;
  closeMoveMenus();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMoveMenus();
});

// 条目上的操作按钮（完成 / 划去 / 恢复 / 迁移菜单）优先，其次是笔记里的外链
els.note.addEventListener('click', async (event) => {
  const moveOption = event.target.closest('.bujo-move-option');
  if (moveOption) {
    const entry = moveOption.closest('.bujo-entry');
    closeMoveMenus();
    if (entry && state.file) await applyMoveAction(entry, moveOption.dataset.move);
    return;
  }

  const act = event.target.closest('.bujo-act');
  if (act) {
    event.preventDefault();
    if (act.dataset.act === 'move') {
      toggleMoveMenu(act);
      return;
    }
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
    showError(t('error.dropPath'));
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
  // 页面初始化时的第一次日记扫描可能早于自检预置文件；这里按磁盘最新状态再扫一次
  await refreshJournals();
  let sidebarItems = journalItems();

  // 新结构下侧栏最前面常有「年度 / 月度记录还没建」的 pending 行：
  // 双击第一条 pending 行 → 应按模板自动建出来并载入，刷新后变成真实行且高亮。
  let ensuredPending = null;
  const firstPending = [...els.journalList.querySelectorAll('.journal-item.pending')][0];
  if (firstPending) {
    firstPending.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ensuredPath = state.file && state.file.path;
    await refreshJournals();
    const nowReal = [...journalItems()].find((li) => samePath(li.dataset.path, ensuredPath));
    ensuredPending = {
      opened: Boolean(state.file),
      fileName: state.file && state.file.name,
      listedAfterRefresh: Boolean(nowReal),
      highlighted: Boolean(nowReal && nowReal.classList.contains('active'))
    };
    sidebarItems = journalItems();
  }

  // 双击侧边栏第一篇真实日记：应该换成那一篇日记的内容
  const first = journalItems().find((li) => li.dataset.path);
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
  const ensureOk = !ensuredPending || (ensuredPending.opened && ensuredPending.listedAfterRefresh && ensuredPending.highlighted);

  // 自定义集子：journals/<不是年份>/… 出现在侧边栏的集子分组里，双击可打开
  const collectionGroups = [...document.querySelectorAll('.journal-group.collection')]
    .map((el) => (el.querySelector('.journal-group-name') || {}).textContent)
    .filter(Boolean);
  const collectionLi = journalItems().find((li) => li.dataset.path && li.dataset.path.includes('读书笔记'));
  let collection = { groups: collectionGroups, opened: null, customBullet: null, ok: collectionGroups.length > 0 && Boolean(collectionLi) };
  if (collectionLi) {
    collectionLi.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const progressEntry = document.querySelector('.bujo-entry[data-kind="in-progress"]');
    collection = {
      groups: collectionGroups,
      opened: state.file && state.file.name,
      customBullet: progressEntry
        ? { kind: progressEntry.dataset.kind, glyph: (progressEntry.querySelector('.bujo-glyph') || {}).textContent, inLegend: els.legend.textContent.includes('进行中') }
        : null,
      ok: true
    };
    collection.ok = Boolean(collection.opened) && Boolean(collection.customBullet) && collection.customBullet.inLegend;
    // 回到最初的日记，免得改变后续自检步骤的前提
    if (firstPath) await loadFile(firstPath);
  }

  // 界面语言：切到英文 → 工具栏真的变英文；切回中文原样恢复
  let i18nCheck = { ok: false, reason: 'not-run' };
  if (typeof I18n !== 'undefined') {
    const openBtn = document.getElementById('open-btn');
    const zhLabel = openBtn.textContent;
    I18n.setLocale('en', { force: true });
    I18n.applyStatic(document);
    rerenderDynamicText();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const enLabel = openBtn.textContent;
    const langOptions = document.getElementById('lang-select') ? document.getElementById('lang-select').options.length : 0;
    I18n.setLocale('zh-CN', { force: true });
    I18n.applyStatic(document);
    rerenderDynamicText();
    await new Promise((resolve) => setTimeout(resolve, 80));
    i18nCheck = {
      ok: enLabel !== zhLabel && openBtn.textContent === zhLabel && langOptions >= 2,
      zhLabel,
      enLabel,
      langOptions
    };
  }

  return {
    ok:
      before.entries > 0 &&
      document.querySelectorAll('.md-block').length > 0 &&
      sidebarItems.length > 0 &&
      switched &&
      rendered &&
      ensureOk &&
      samePath(activePath, firstPath) &&
      collapsedWidth < expandedWidth &&
      listHidden &&
      refreshHiddenWhenCollapsed &&
      refreshVisibleWhenExpanded &&
      collection.ok &&
      i18nCheck.ok,
    initial: before,
    sidebar: {
      dir: els.sidebarDir.textContent,
      items: sidebarItems.length,
      names: sidebarItems.map((li) => li.querySelector('.journal-name').textContent),
      openedByDoubleClick: afterSidebarOpen && afterSidebarOpen.file,
      switched,
      rendered,
      activeHighlighted: Boolean(activePath),
      ensuredPending
    },
    collection,
    i18n: i18nCheck,
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
  collapsed: false, // 当前是否折叠成一条窄碎
  unread: false, // 消息区收着、AI 又有新回复
  daily: null // 自动参考的当天日记 { path, name }
};

function applyFloatingMode() {
  document.body.classList.toggle('is-floating', IS_FLOATING);
  const toggle = document.getElementById('floating-toggle');
  if (toggle) toggle.hidden = IS_FLOATING;
  if (!IS_FLOATING) return;

  els.sidebar.classList.add('collapsed');

  // 进悬浮窗：消息区收起（正文博满余下空间，输入行贴底），AI 有新回复时才自动弹出。
  // 走统一入口而不是直接挂类：收起态的正文博满与贴底样式也会一并生效（否则开窗时仍是半屏黑区）。
  // 同时强制打开聊天面板：主窗口里把聊天收起过的状态不能带入悬浮窗（否则小窗里压根开不了聊天）。
  const panelAtOpen = document.getElementById('chat-panel');
  if (panelAtOpen) panelAtOpen.hidden = false;
  setFloatingMessagesVisible(false);

  /**
   * 悬浮窗没有系统标题栏（主进程 frame:false）：
   *   - 页面顶部一条窄碎悬浮条同时充当拖拽区与状态栏；
   *   - 左侧「⌂」回主窗口；未读点表示 AI 有新回复未读；
   *   - 「⌕」手动收/展开聊天回复区；最右「−」折叠整窗成一条窄条。
   */
  const bar = document.createElement('div');
  bar.id = 'float-bar';
  bar.className = 'float-bar'; // 样式全部走 .float-bar 类（此前只有 id，样式规则没命中 → 整条不可拖、折叠钮不靠右、间距丢失）
  bar.innerHTML = [
    `<button id="float-back" class="float-btn" type="button" title="${escapeHtml(t('floating.back'))}">⌂</button>`,
    `<button id="chat-new" class="float-btn" type="button" title="${escapeHtml(t('chat.new.title'))}">＋</button>`,
    `<button id="chat-clear-screen" class="float-btn" type="button" title="${escapeHtml(t('chat.clear.title'))}">⌫</button>`,
    `<span id="float-title" class="float-title" draggable="false">${escapeHtml(t('floating.title'))}</span>`,
    '<span id="float-unread" class="float-unread" hidden></span>',
    `<button id="float-collapse" class="float-btn" type="button" title="${escapeHtml(t('floating.collapse.expand'))}">−</button>`
  ].join('');
  document.body.prepend(bar);

  // 无边框窗口的拖拽：CSS -webkit-app-region: drag（样式表里），按钮排除在外

  // 「⌂」回主窗口：关掉悬浮窗、主窗口靠主进程召回
  const backBtn = bar.querySelector('#float-back');
  backBtn.addEventListener('click', async () => {
    const result = await window.bujo.toggleFloating();
    if (result && !result.ok) showError(t('error.backMain', { error: result.error }));
  });
  backBtn.dataset.wired = 'toggle-floating'; // 自检用：有这个标记 = 监听器已接上（getEventListeners 不在页面环境）

  // 「−」：调窗口尺寸（主进程），并切换页面布局——按钮固定在悬浮条最右侧
  const collapseBtn = bar.querySelector('#float-collapse');
  collapseBtn.addEventListener('click', async () => {
    const next = !floating.collapsed;
    const result = await window.bujo.setFloatingCollapsed(next);
    if (result && result.ok) applyFloatingCollapsed(next, result.ok);
  });

  // 回复区右上角的折叠/展开按钮：AI 未回复时手动收起/展开聊天回复区
  //（回复中不关——正在生成时收起会截断视线，等这次生成完后自然展示）
  const panel = document.getElementById('chat-panel');
  const messagesBtn = document.createElement('button');
  messagesBtn.id = 'chat-messages-btn';
  messagesBtn.className = 'float-btn chat-messages-btn';
  messagesBtn.type = 'button';
  messagesBtn.title = t('floating.messages.expand');
  messagesBtn.textContent = '⌄';
  panel.prepend(messagesBtn);
  messagesBtn.addEventListener('click', () => {
    if (chatStateStreaming()) return; // 正在生成：不收，避免截断正在写出的回复
    setFloatingMessagesVisible(floating.messagesHidden);
  });
  syncFloatingMessagesButton();

  // 主进程发回实际状态（初次加载时对齐一次）；页面点击同样驱动
  window.bujo.onFloatingCollapsed?.(({ collapsed }) => {
    if (collapsed !== floating.collapsed) {
      floating.collapsed = collapsed;
      applyFloatingCollapsed(collapsed);
    }
  });

  floating.reused = true;
  showFloatingDaily();
}

/** 折叠/展开的页面布局：折叠时只剩悬浮条一条，正文与聊天都收起 */
function applyFloatingCollapsed(collapsed) {
  floating.collapsed = Boolean(collapsed);
  document.body.classList.toggle('is-floating-collapsed', floating.collapsed);
  const button = document.getElementById('float-collapse');
  if (button) {
    button.textContent = floating.collapsed ? '+' : '−';
    button.title = floating.collapsed ? t('floating.expand') : t('floating.collapse');
  }
}

/** 全局属性：聊天是否正在生成（真布尔值；BujoChat 还没加载时视为 false） */
function chatStateStreaming() {
  return Boolean(window.BujoChat?.peekStreaming?.() === true);
}

/**
 * 悬浮窗的聊天弹出逻辑（chat.js 在收到首个流式增量时调 __bujoOnChatActivity）：
 * 仅当 AI 有最新回复（首个增量到达）时弹出消息区；用户主动收起后不会自动再弹。
 * 弹出不是永久：点「⌕」可再收起，收起后未读点亮起。
 */
window.__bujoOnChatActivity = async ({ from }) => {
  if (!IS_FLOATING || from !== 'delta') return;
  if (floating.collapsed) {
    // 折叠时收到回复：先自动展开（不然用户什么都看不见）
    await window.bujo.setFloatingCollapsed(false);
    applyFloatingCollapsed(false);
  }
  // 用户手动收起时不再自动弹出（未读点已亮），否则把刚收起的消息区又攻破
  if (!floating.messagesHidden) setFloatingMessagesVisible(true);
  syncFloatingMessagesButton();
};

/** 消息区显示状态：一个事实来源（面板上的类 + floating.messagesHidden） */
function setFloatingMessagesVisible(visible) {
  floating.messagesHidden = !visible;
  const panel = document.getElementById('chat-panel');
  if (panel) {
    panel.classList.toggle('messages-hidden', !visible);
    if (visible) {
      const list = panel.querySelector('.chat-messages');
      if (list) list.scrollTop = list.scrollHeight;
    }
  }
  // 回复区收起时正文撑满余下空间（不再被 46% 上限压成半屏黑区）
  document.body.classList.toggle('floating-chat-collapsed', !visible);
  const dot = document.getElementById('float-unread');
  if (dot) dot.hidden = visible || !chatHasUnread();
  syncFloatingMessagesButton();
}

/** 回复区右上角按钮状态与标题随之变（含回复中锁定提示） */
function syncFloatingMessagesButton() {
  const button = document.getElementById('chat-messages-btn');
  if (!button) return;
  const streaming = chatStateStreaming();
  button.textContent = floating.messagesHidden ? '⌄' : '⌃';
  // 展开时按钮在消息区顶部露出（向下收）；收起时贴输入行上方露出（向上开）
  button.title = streaming
    ? t('floating.messages.locked')
    : floating.messagesHidden ? t('floating.messages.expand') : t('floating.messages.collapse');
  button.classList.toggle('locked', streaming);
}

/** chat.js：用户刚发送消息（点发送 / Enter）——自动展开回复区 */
window.__bujoOnChatSend = () => {
  if (!IS_FLOATING) return;
  if (floating.messagesHidden) setFloatingMessagesVisible(true);
  syncFloatingMessagesButton();
};

// chat.js 生成开始/结束时同步一次按钮锁定态（chatState 是唯一源头）
window.__bujoOnChatStreamingChanged = () => syncFloatingMessagesButton();

/** 消息区收着时有没有没读过的 AI 回复（最后一个助手消息） */
function chatHasUnread() {
  const messages = window.BujoChat ? window.BujoChat.peekMessages?.() : null;
  if (!messages || !messages.length) return false;
  const last = messages[messages.length - 1];
  return Boolean(last && last.role === 'assistant' && (last.content || '').trim());
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
    els.fileMeta.textContent = t('floating.daily.none');
  }
}

/** 自检用：找正文匹配的条目（重载后 DOM 会重建，所以每次都重新查） */
function findEntryByText(needle) {
  return [...document.querySelectorAll('.bujo-entry')].find((el) => el.dataset.text === needle) || null;
}

/** 自检用：把悬浮窗恢复到刚打开时的状态（回复区收起、窗口展开），主进程几何探针先调 */
window.__bujoSmokeTestFloatingPageReset = () => {
  applyFloatingCollapsed(false);
  setFloatingMessagesVisible(false);
};

// 自检调试窗口（常态为 null，只在页面自检过程中有值）：收起态正文的实测数据
window.__bujoMainColProbeDebug = null;

/**
 * 自检入口：悬浮小窗的页面形态（无边框版）。
 * 检查：悬浮条存在且带三个部件（回主窗/标题/折叠钮）、工具栏/侧栏/图例被隐藏、
 * 开始时消息区收着（只剩输入行）、折叠后只剩一条、再展开后正文回来了。
 */
window.__bujoSmokeTestFloatingPage = async () => {
  window.__bujoMainColProbeDebug = null; // 每次重置
  const reused = floating.reused;
  const bar = document.getElementById('float-bar');
  const toolbarHidden = getComputedStyle(document.querySelector('.toolbar')).display === 'none';
  const sidebarHidden = getComputedStyle(els.sidebar).display === 'none';
  const legendHidden = getComputedStyle(els.legend).display === 'none';
  const chatOpen = !document.getElementById('chat-panel').hidden;
  const hasBack = Boolean(bar && bar.querySelector('#float-back'));
  // ⌂ 钮确实接了 toggleFloating：监听时打 data.wired 标记（页面环境拿不到 getEventListeners）
  const backWired = Boolean(bar && bar.querySelector('#float-back')?.dataset.wired === 'toggle-floating');
  const hasCollapse = Boolean(bar && bar.querySelector('#float-collapse'));
  const chatHeadHiddenWhenFloating = getComputedStyle(document.querySelector('.chat-head')).display === 'none';
  const fileMeta = els.fileMeta.textContent || '';
  const entriesAtOpen = document.querySelectorAll('.bujo-entry').length;
  const messagesHiddenAtStart = floating.messagesHidden === true &&
    document.getElementById('chat-panel').classList.contains('messages-hidden');
  const composerVisibleAtStart = document.querySelector('.chat-composer') &&
    getComputedStyle(document.querySelector('.chat-composer')).display !== 'none';
  // 回复区右上角的折叠钮：回复区展开时必须贴回复区右上角（悬浮条里不再有这个钮）。
  // 注意页面初始消息区收着，按钮那时贴输入行上方；这里先展开回复区再量右上角。
  const hasMessagesBtn = Boolean(document.getElementById('chat-messages-btn'));
  let messagesBtnTopRight = false;
  if (hasMessagesBtn) {
    setFloatingMessagesVisible(true); // 展开 → 按钮应移到回复区右上角
    const msgBtnBox = document.getElementById('chat-messages-btn').getBoundingClientRect();
    const panelBox = document.getElementById('chat-panel').getBoundingClientRect();
    messagesBtnTopRight = Boolean(
      Math.abs(msgBtnBox.top - panelBox.top) <= 8 && // 贴回复区顶部
      Math.abs(msgBtnBox.right - panelBox.right) <= 10 // 贴回复区右上角
    );
    setFloatingMessagesVisible(false); // 恢复初始收起态，别打乱后面的断言
  }

  // 发送键在输入行右侧（同一行、在 textarea 右边），而不是沉在下面一整行
  const inputRow = document.querySelector('.chat-input-row');
  const sendBox = document.getElementById('chat-send')?.getBoundingClientRect();
  const inputBox = document.getElementById('chat-input')?.getBoundingClientRect();
  const sendInlineRight = Boolean(
    inputRow && sendBox && inputBox &&
    Math.abs(inputBox.bottom - sendBox.bottom) < 40 && // 垂直同一行（textarea 可高过按钮，底部对齐）
    sendBox.left >= inputBox.right - 2 // 水平在 textarea 右侧
  );

  // 折叠 → 只剩一条 → 再展开 → 正文回来；输入行在任何形态都在（不可关闭）
  await window.bujo.setFloatingCollapsed(true);
  applyFloatingCollapsed(true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const composerInCollapsed = document.querySelector('.chat-composer') &&
    getComputedStyle(document.querySelector('.chat-composer')).display === 'none'; // 折叠时正文都收起（chat-panel 也不显示）
  const collapsedOnlyBar = floating.collapsed &&
    getComputedStyle(document.querySelector('.main-col')).display === 'none' &&
    getComputedStyle(document.getElementById('chat-panel')).display === 'none' &&
    getComputedStyle(bar).display !== 'none';

  await window.bujo.setFloatingCollapsed(false);
  applyFloatingCollapsed(false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const expandedAgain = !floating.collapsed &&
    getComputedStyle(document.querySelector('.main-col')).display !== 'none';
  const composerBackAfterExpand = document.querySelector('.chat-composer') &&
    getComputedStyle(document.querySelector('.chat-composer')).display !== 'none';
  const messagesStillHidden = floating.messagesHidden === true; // 展开回来时不自动弹消息区，仍以未读点提示

  // 输入行是「无法关闭」的：展开态下它必须可见
  const composerAlwaysOn = composerVisibleAtStart && composerBackAfterExpand;

  // 几何验证：输入行贴窗口底边（黑色空区修复的实际效果），
  // 且悬浮条出现在页面顶上（正文 + 聊天布满余下全部空间）。
  const composerBox = document.querySelector('.chat-composer').getBoundingClientRect();
  const barBox = bar.getBoundingClientRect();
  const composerAtBottom = Math.abs(
    composerBox.bottom - document.documentElement.clientHeight
  ) <= 2;
  const barAtTop = Math.abs(barBox.top - document.documentElement.clientTop) <= 2;
  const noBlackGapUnderChat = composerAtBottom;

  // 顶部栏几何：折叠钮必须是最右控件（悬浮条上没有消息开关了）
  const collapseBox = document.getElementById('float-collapse').getBoundingClientRect();
  const collapseAtRightEdge = collapseBox.right >= document.documentElement.clientWidth - 8;
  const barButtons = [...bar.querySelectorAll('button')];
  const collapseRightmost = barButtons.length > 0 &&
    barButtons[barButtons.length - 1] === document.getElementById('float-collapse');

  // 手动折叠消息区：点「⌕」收起/展开回复区（floating.messagesHidden 翻转）。
  // 结束时必须回到初始收起态（隐藏），不能打乱后面的几何断言与页面状态。
  const canToggleMessagesManually = await (async () => {
    const messagesBtn = document.getElementById('chat-messages-btn');
    if (!messagesBtn) return false;
    setFloatingMessagesVisible(true); // 先展开
    messagesBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const hiddenAfterFirstClick = floating.messagesHidden === true;
    // 向下折叠：收起后不保留黑色空区——输入行必须仍然贴窗口底边
    const composerStillAtBottom = Math.abs(
      document.querySelector('.chat-composer').getBoundingClientRect().bottom -
      document.documentElement.clientHeight
    ) <= 2;
    messagesBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const visibleAfterSecondClick = floating.messagesHidden === false;
    setFloatingMessagesVisible(false); // 恢复初始收起态
    return hiddenAfterFirstClick && visibleAfterSecondClick && composerStillAtBottom;
  })();

  // 回复区收起时：正文区撑满全部余下空间（不再被 46% 上限压成半屏黑区）。
  // 验证：收起态下聊天面板只剩输入行（flex:none），正文块 + 输入行无缝填满窗高，两块中间/底下都没有黑区。
  const mainColFillsWhenCollapsed = (() => {
    setFloatingMessagesVisible(false); // 收起
    const mainCol = document.querySelector('.main-col');
    const panel = document.getElementById('chat-panel');
    const classOn = document.body.classList.contains('floating-chat-collapsed');
    const mainColRect = mainCol.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const totalFilled = Math.abs(
      (mainColRect.bottom + panelRect.height) - document.documentElement.clientHeight
    ) <= 2; // 正文 + 输入行 = 全窗高（无第三块）
    const panelStaysSmall = panelRect.height < document.documentElement.clientHeight * 0.25; // 只剩输入行，不再平分
    window.__bujoMainColProbeDebug = {
      classOn,
      mainColHeight: Math.round(mainColRect.height),
      panelHeight: Math.round(panelRect.height),
      clientH: document.documentElement.clientHeight,
      totalFilled,
      panelStaysSmall
    };
    setFloatingMessagesVisible(true); // 展开：正文上限回 46%，类撤掉
    const classOff = !document.body.classList.contains('floating-chat-collapsed');
    return classOn && classOff && totalFilled && panelStaysSmall;
  })();

  // 发送自动展开：chat.js 在用户发送时调 __bujoOnChatSend；这里模拟该钩子。
  // 结束时恢复初始收起态。
  const sendAutoExpand = typeof window.__bujoOnChatSend === 'function' &&
    (() => {
      window.__bujoOnChatSend();
      const opened = floating.messagesHidden === false;
      setFloatingMessagesVisible(false); // 恢复
      return opened;
    })();

  const ok = Boolean(
    bar && hasBack && hasCollapse && hasMessagesBtn && toolbarHidden && sidebarHidden && legendHidden &&
    chatOpen && chatHeadHiddenWhenFloating && messagesHiddenAtStart && composerAlwaysOn &&
    collapsedOnlyBar && expandedAgain && messagesStillHidden &&
    composerAtBottom && barAtTop && noBlackGapUnderChat &&
    sendInlineRight && collapseAtRightEdge && collapseRightmost && canToggleMessagesManually &&
    messagesBtnTopRight && sendAutoExpand && mainColFillsWhenCollapsed &&
    (entriesAtOpen > 0 || fileMeta.includes('还没有'))
  );

  return {
    ok,
    reused,
    barPresent: Boolean(bar),
    hasBack,
    hasCollapse,
    hasMessagesBtn,
    backWired, // ⌂ 钮已接 toggleFloating（回主窗口）
    sendInlineRight, // 发送键在聊天输入行右侧
    messagesBtnTopRight, // 回复区折叠钮贴回复区右上角
    sendAutoExpand, // 向 AI 发送后自动展开回复区
    mainColFillsWhenCollapsed, // 回复区收起时正文撑满余下空间
    collapseAtRightEdge, // 折叠钮贴顶栏最右
    collapseRightmost,
    canToggleMessagesManually, // 回复区右上角钮可手动收/展开（收起时输入行仍贴底）
    composerAtBottom, // 输入行贴底（几何验证：无黑色空区）
    barAtTop,
    noBlackGapUnderChat,
    toolbarHidden,
    sidebarHidden,
    legendHidden,
    chatOpen,
    chatHeadHiddenWhenFloating,
    messagesHiddenAtStart,
    composerVisibleAtStart,
    composerBackAfterExpand,
    messagesStillHidden,
    collapsedOnlyBar,
    expandedAgain,
    dailyFile: (floating.daily && floating.daily.name) || null,
    fileMeta,
    entriesAtOpen
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
 * 线序：待办 → 完成；普通笔记 → 划去 → 恢复回笔记；待办 → 划去 → 恢复；已划去的只能恢复。
 */
/** 自检：点某条目的「»」→ 选迁移目的地，回传操作前后的状态 */
window.__bujoSmokeTestMove = async (option, text) => {
  const entry = findEntryByText(text);
  const button = entry && entry.querySelector('.bujo-act[data-act="move"]');
  if (!button) return { ok: false, reason: 'no-move-button', text, option, kindAfter: entry && entry.dataset.kind };
  button.click();
  await new Promise((r) => setTimeout(r, 80));
  const entry2 = findEntryByText(text);
  const optionBtn = entry2 && entry2.querySelector(`.bujo-move-menu .bujo-move-option[data-move="${option}"]`);
  if (!optionBtn) return { ok: false, reason: 'no-menu', text, option, kindAfter: entry2 && entry2.dataset.kind };
  optionBtn.click();
  await new Promise((r) => setTimeout(r, 450));
  const afterEntry = findEntryByText(text);
  return {
    ok: Boolean(afterEntry && (afterEntry.dataset.kind === 'scheduled' || afterEntry.dataset.kind === 'migrated')),
    text,
    option,
    kindAfter: afterEntry && afterEntry.dataset.kind
  };
};

/**
 * 自检：迁移语义的三步闭环——
 * ① 已迁移（[>]）的条目不再给「»」，原地直接迁会被判为不可迁；
 * ② 点「取消迁移」回到普通待办；目标日志里的原样副本 **同时被收掉**；
 * ③ 重新迁移：目标日志里重新出现一份（且只有一份，与取消迁移前不残留多余子弹）。
 */
window.__bujoSmokeTestRemigrate = async (text) => {
  const entry = findEntryByText(text);
  // ① 已迁移的条目不再给迁移按钮
  const moveBlocked = Boolean(entry && !entry.querySelector('.bujo-act[data-act="move"]'));
  if (!entry) return { ok: false, reason: 'no-entry', text, moveBlocked };

  /** 数一数目标日志（月度记录）里同一件事的副本出现的次数；读不到返回 null */
  const countInTarget = async (needle) => {
    try {
      const listed = await window.bujo.listJournals();
      const monthly = (listed.files || []).find((file) => file.role === 'monthly');
      if (!monthly) return null;
      const file = await window.bujo.readFile(monthly.path);
      if (!file || !file.ok) return null;
      return file.file.content.split(String(needle)).length - 1;
    } catch { return null; }
  };

  // ② 取消迁移：恢复为普通待办（副本同时被收掉）
  const restore = entry.querySelector('.bujo-act[data-act="restore"]');
  let restoredKind = null;
  if (restore) {
    restore.click();
    const waited = await waitEntryKind(text, 'task');
    restoredKind = waited.kind;
  }
  const destCountAfterRestore = await countInTarget(text);

  // ③ 再迁一次：目标已收掉的副本重新迁出（这次是全新的一份，目标里仍只有一份）
  let reMovedKind = null;
  let toastText = '';
  const button = findEntryByText(text) && findEntryByText(text).querySelector('.bujo-act[data-act="move"]');
  if (button) {
    button.click();
    await new Promise((r) => setTimeout(r, 80));
    const optionBtn = findEntryByText(text).querySelector('.bujo-move-menu .bujo-move-option[data-move="nextMonth"]');
    if (optionBtn) {
      optionBtn.click();
      await new Promise((r) => setTimeout(r, 450));
      const afterEntry = findEntryByText(text);
      reMovedKind = afterEntry && afterEntry.dataset.kind;
      toastText = els.toast.hidden ? '' : els.toast.textContent;
    }
  }
  const destCountAfterMove = await countInTarget(text);

  const ok = moveBlocked && restoredKind === 'task' && reMovedKind === 'migrated' &&
    (destCountAfterRestore !== null && destCountAfterRestore === 0) &&
    (destCountAfterMove !== null && destCountAfterMove === 1);
  return { ok, text, moveBlocked, restoredKind, reMovedKind, toastText, destCountAfterRestore, destCountAfterMove, hasMoveAfterRestore: Boolean(button) };
};

/**
 * 自检：主题切换真的换了素材并拉动了计算样式——
 * 从 深→浅→深 切一遍：背景与文字颜色都要变，并回弹到原值。
 */
window.__bujoSmokeTestTheme = async () => {
  const link = document.getElementById('theme-style');
  const currentThemeId = () => (document.body.dataset.theme || (/styles\/([a-z0-9-]+)\.css/.test(link ? link.getAttribute('href') || '' : '') && RegExp.$1) || 'dark');
  const read = () => ({
    body: getComputedStyle(document.body).backgroundColor,
    text: getComputedStyle(document.body).color,
    panel: getComputedStyle(document.querySelector('.sidebar') || document.body).backgroundColor
  });
  const original = currentThemeId();
  applyTheme('light');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const light = read();
  applyTheme('dark');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const dark = read();
  applyTheme(original);

  const ok = light.body !== dark.body && light.text !== dark.text && light.panel !== dark.panel && currentThemeId() === 'dark';
  return { ok, linkHref: link && link.getAttribute('href'), options: els.themeSelect ? els.themeSelect.options.length : 0, light, dark };
};

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
  // 划去的笔记恢复时回到**原来的类型**（笔记），不是变回待办
  await step('整理收件箱', 'restore', 'note');
  // 这条划了就不再恢复：留给文件层核对中间态 [-n]
  await step('回顾设计稿', 'cancel', 'cancelled');

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
    // 已划去条目只能「恢复」与「星标」，不能再「划去」（也不该出现在末尾区）
    ok: steps.every((item) => item.ok) && alreadyActs.join(',') === 'restore,priority' && layoutOk && toastShown,
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

/* ---------------- 界面主题（styles/）+ 语言（locales/）+ 插件（plugins/） ---------------- *
 * 三个可选资源文件夹都在启动时接上：
 *   styles/<id>.css  主题（theme-select 下拉）
 *   locales/<id>.js  语言（lang-select 下拉；i18n.js 提供组装器）
 *   plugins/<name>/  插件（plugin.json 清单里的自定义子弹注册进解析器）
 */
const DEFAULT_THEME = 'dark';

/** 重画所有带动态文案的区域（切语言后调用；当前语言下保持与原来相同的内容感） */
function rerenderDynamicText() {
  renderLegend();
  renderFileMeta();
  if (state.stats) renderStats(state.stats);
  renderJournalList();
  if (state.file) document.title = t('app.docTitle', { name: state.file.name });
}

/** 把 <link id="theme-style"> 换到 styles/<id>.css（base.css 布局基底不动） */
function applyTheme(id) {
  const link = document.getElementById('theme-style');
  if (!link || !/^styles\//.test(link.getAttribute('href') || '') || !/^[a-z0-9-]{1,24}$/.test(String(id))) return;
  link.setAttribute('href', `styles/${id}.css`);
  document.body.dataset.theme = id;
  if (els.themeSelect && [...els.themeSelect.options].some((opt) => opt.value === id)) els.themeSelect.value = id;
}

/** 启动时：拉主题列表填下拉，再把设置里记的主题套上（坏值回落到默认深色） */
async function initTheme() {
  if (!els.themeSelect) return;

  let themes = [];
  try {
    const res = await window.bujo.listThemes();
    themes = (res && res.themes) || [];
  } catch { /* 主进程还慢着：先不填下拉 */ }
  if (themes.length) {
    els.themeSelect.innerHTML = themes
      .map((theme) => {
        // 内置主题的显示名走 i18n（深色/浅色 → Dark/Light），其它按文件夹名
        const label = t(`settings.theme.${theme.id}`);
        const display = label === `settings.theme.${theme.id}` ? theme.label : label;
        return `<option value="${escapeHtml(theme.id)}">${escapeHtml(display)}</option>`;
      })
      .join('');
    if (!themes.some((theme) => theme.id === DEFAULT_THEME)) {
      els.themeSelect.insertAdjacentHTML(
        'beforeend',
        `<option value="${DEFAULT_THEME}">${escapeHtml(DEFAULT_THEME)}</option>`
      );
    }
  } else {
    els.themeSelect.hidden = true; // 连主题列表都读不到时，最多就是保持默认深色
  }

  // 记住的主题：设置里的值必须还在主题文件夹里，否则回落到默认深色
  let remembered = DEFAULT_THEME;
  try {
    const settings = await window.bujo.getSettings();
    if (settings && settings.theme) {
      const known = themes.length ? themes.some((theme) => theme.id === settings.theme) : settings.theme === DEFAULT_THEME;
      if (known) remembered = settings.theme;
    }
  } catch { }
  applyTheme(remembered);
}

if (els.themeSelect) {
  els.themeSelect.addEventListener('change', async () => {
    const next = els.themeSelect.value;
    applyTheme(next);
    try {
      await window.bujo.saveSettings({ theme: next });
    } catch { /* 保存失败只影响下次启动，本次界面已生效 */ }
  });
}

/* ---------------- 界面语言（locales 文件夹） ---------------- */

/** 语言下拉：locales/<id>.js 里必须有 I18N_<ID> 字典；切换即存设置并重画界面 */
async function initLocales() {
  const select = document.getElementById('lang-select');
  if (!select || typeof I18n === 'undefined') return;

  let locales = [];
  try {
    const res = await window.bujo.listLocales();
    locales = ((res && res.locales) || []).filter((locale) => I18n.hasLocale(locale.id));
  } catch { }
  if (locales.length) {
    select.innerHTML = locales
      .map((locale) => `<option value="${escapeHtml(locale.id)}">${escapeHtml(locale.label)}</option>`)
      .join('');
  } else {
    select.hidden = true;
    return;
  }

  // 记住的语言：设置优先；没有设置先用电 memory
  let remembered = I18n.getLocale();
  try {
    const settings = await window.bujo.getSettings();
    if (settings && settings.locale && I18n.hasLocale(settings.locale) && locales.some((locale) => locale.id === settings.locale)) {
      remembered = settings.locale;
    }
  } catch { }
  if (I18n.hasLocale(remembered) && locales.some((locale) => locale.id === remembered)) applyLocale(remembered, { skipSave: true });

  select.addEventListener('change', () => applyLocale(select.value));
}

/** 切语言：字典切换 → 静态文案 + 动态区域重画；设置里记住（skipSave 供启动时回放） */
function applyLocale(id, options = {}) {
  if (typeof I18n === 'undefined') return;
  I18n.setLocale(id);
  const select = document.getElementById('lang-select');
  if (select && [...select.options].some((opt) => opt.value === I18n.getLocale())) select.value = I18n.getLocale();
  rerenderDynamicText();
  if (options.skipSave) return;
  window.bujo.saveSettings({ locale: I18n.getLocale() }).catch(() => { });
}

/* ---------------- 插件（plugins 文件夹：自定义子弹） ---------------- */

/** 拉插件清单 → 登记进解析器 → 写入颜色变量 → 图例/统计重画 */
async function initPlugins() {
  let plugins = [];
  try {
    const res = await window.bujo.listPlugins();
    plugins = (res && res.plugins) || [];
  } catch { }

  const bullets = plugins.flatMap((plugin) => plugin.bullets || []);
  if (!bullets.length) return;

  const registered = Bujo.registerCustomBullets(bullets);
  registered.forEach((bullet) => {
    if (bullet.color) {
      document.documentElement.style.setProperty(`--kind-${bullet.kind}`, bullet.color);
    }
  });
}

(async function init() {
  // 静态界面文案先按当前语言填好（语言变化时 i18n 会再通知一次）
  if (typeof I18n !== 'undefined') {
    I18n.applyStatic(document);
    I18n.onChange(() => I18n.applyStatic(document));
  }
  renderLegend();
  renderAll();
  initTheme();
  initLocales();
  initPlugins().then(() => {
    // 插件带来的自定义类型要重新画图例（新 kind 变成可统计/可显示的）
    renderLegend();
  });

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
        if (result && !result.ok) showError(t('error.floatingToggle', { error: result.error }));
      });
    }
  }

  await refreshJournals();
  const initial = await window.bujo.getInitialFile();
  if (initial) await loadFile(initial);
})();

/* ---------------- 自检：新增能力的整链验证（tasks / 折叠 / 原文编辑器） ---------------- */

window.__bujoSmokeTestExtra = async () => {
  const report = {};

  // ① 每日任务列表：今天的日记（smoke 预置了一条待办）→ 切到 tasks 视图能列出；点「完成」写回今天的日记
  const previousView = state.view;
  setView('tasks');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const taskHead = document.querySelector('.daily-tasks-head');
  const taskEntries = [...document.querySelectorAll('#note .bujo-entry')];
  const target = taskEntries.find((li) => li.dataset.text === '自检侧边栏示例');

  let doneWritten = false;
  if (target) {
    const act = target.querySelector('.bujo-act[data-act="done"]');
    if (act) {
      act.click();
      await new Promise((resolve) => setTimeout(resolve, 450));
      const today = await window.bujo.getTodayJournal({ create: false });
      doneWritten = Boolean(today && today.content && today.content.includes('- [x] 自检侧边栏示例'));
    }
  }
  report.tasks = {
    head: taskHead ? taskHead.textContent : null,
    entries: taskEntries.length,
    countMeta: (document.querySelector('.daily-tasks-meta') || {}).textContent || '',
    dailyDoneWritten: doneWritten,
    ok: Boolean(taskHead) && taskEntries.length > 0 && doneWritten
  };
  setView(previousView === 'tasks' ? 'preview' : previousView);
  await new Promise((resolve) => setTimeout(resolve, 120));

  // ② 分组折叠：年组头点一下收起（子行隐藏、记忆保留），再点展开；收起时月组头也被一并收下
  const yearHead = els.journalList.querySelector('.journal-group[data-fold-key^="y:"]');
  let fold = { ok: false };
  if (yearHead) {
    const yearKey = yearHead.dataset.foldKey;
    const childrenBefore = [...els.journalList.children].filter((li) => li.hidden).length;
    yearHead.click();
    const collapsedChildren = [...els.journalList.children].filter((li) => li.hidden).length;
    const persisted = (() => {
      try { return (JSON.parse(localStorage.getItem(FOLD_STORAGE_KEY) || '[]')).includes(yearKey); } catch { return false; }
    })();
    const caretFolded = (yearHead.querySelector('.fold-caret') || {}).textContent === '▸';
    yearHead.click();
    const restoredChildren = [...els.journalList.children].filter((li) => li.hidden).length;
    fold = {
      ok: collapsedChildren > childrenBefore && persisted && caretFolded && restoredChildren === childrenBefore,
      collapsedChildren,
      persisted,
      caretFolded
    };
  }
  report.fold = fold;

  // ③ 原文编辑器：切到原文 → textarea 可编辑 → 点保存 → 文件落盘并被重新解析
  const originalPreviewFile = (state.file && state.file.path) || null;
  setView('source');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const editor = document.getElementById('source-editor');
  let editorOk = false;
  if (editor && state.file) {
    editor.value = `${state.file.content}\n- [ ] 编辑器自检条目\n`;
    const saveBtn = editor.parentElement.querySelector('button[data-role="save-source"]');
    saveBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const file = await window.bujo.readFile(state.file.path);
    editorOk = Boolean(file && file.ok && file.file.content.includes('编辑器自检条目'));
  }
  report.sourceEditor = {
    editorPresent: Boolean(editor),
    saved: editorOk,
    ok: Boolean(editor) && editorOk
  };
  if (originalPreviewFile) await loadFile(originalPreviewFile);
  setView('preview');

  report.ok = report.tasks.ok && report.fold.ok && report.sourceEditor.ok;
  return report;
};
