'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  dailyFileName,
  dateKey,
  dateLabel,
  yearFolderName,
  monthFolderName,
  FUTURE_RECORD_FILE,
  MONTHLY_RECORD_FILE,
  monthLabel,
  yearLabel,
  parseDateKey
} = require('../shared/journal-date');

/** 允许出现在日记栏里的文件类型 */
const JOURNAL_EXTENSIONS = new Set(['.md', '.markdown']);

/** 说明文档不算日记，不进日记栏 */
const IGNORED_NAMES = new Set(['readme.md']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const YEAR_RE = /^\d{4}$/;

/**
 * 自定义集子（journals 下的自建文件夹，不叫年份的都算，例如 journals/读书笔记/）。
 * 一个集子自带分组，在侧边栏里跟「年」并列展示；年/月文件夹里的文件不属于集子。
 */
function collectionOf(relativeFolder) {
  const firstSegment = String(relativeFolder || '').split('/')[0];
  if (!relativeFolder || !firstSegment || YEAR_RE.test(firstSegment)) return null; // 年文件夹（或根级）不是集子
  return firstSegment;
}

/**
 * 新目录结构（2026-10 起采用，目录里用一次性迁移过渡）：
 *
 *   journals/
 *     .journal-structure-v2            ← 迁移标记（迁移完成后写一次）
 *     2026/                            ← 年文件夹
 *       未来记录.md                     ← 年度（未来）记录，一年一篇
 *       2026-10/                       ← 月文件夹
 *         月度记录.md                   ← 月度记录，一月一篇
 *         2026-10-13.md                ← 每日记录，一天一篇
 *
 * 「周」层级按产品决定不设：日记直接挂在月文件夹下。
 */

/** 一次性迁移用的标记文件：只在第一次启动时执行迁移 */
const STRUCTURE_MARKER = '.journal-structure-v2';

/**
 * 纯文件名 → 日期键：'2026-10-07.md' → '2026-10-07'，'2026-10.md' → '2026-10'，其他 → null
 */
function dateKeyOf(fileName) {
  const base = stripExtension(fileName);
  if (DAY_RE.test(base)) return base;
  if (MONTH_RE.test(base)) return base;
  return null;
}

function stripExtension(fileName) {
  return String(fileName || '').replace(/\.[^.]+$/, '');
}

/**
 * 从「相对文件夹」与文件名推断归属：年（'2320'）与月（'2026-10'）。
 * 优先看文件夹段（2026/2026-10/…），旧平铺文件再从文件名兜底；认不出就是 null。
 */
function locationFrom(folder, fileName) {
  const segments = String(folder || '').split('/');
  let year = null;
  let month = null;
  for (const segment of segments) {
    if (!month && MONTH_RE.test(segment)) {
      month = segment;
      if (!year) year = segment.slice(0, 4);
    } else if (!year && /^\d{4}$/.test(segment)) {
      year = segment;
    }
  }
  const base = stripExtension(fileName);
  if (!year && MONTH_RE.test(base)) year = base.slice(0, 4);
  if (!month && MONTH_RE.test(base)) month = base;
  if (!year && month) year = month.slice(0, 4);
  if (!year && DAY_RE.test(base)) {
    year = base.slice(0, 4);
    month = base.slice(0, 7);
  }
  return { year, month };
}

/**
 * 一篇日记在侧边栏里的角色：
 *   'daily'   每日记录（文件名形如 2026-10-07）
 *   'monthly' 月度记录（默认英文「Monthly Log」；旧版中文名「月度记录」与平铺的 2026-10.md 仍按同一角色识别）
 *   'future'  年度（未来）记录（默认英文「Future Log」；旧版中文名「未来记录」仍按同一角色识别）
 *   'other'   认不出角色的散文件，照样列出
 */
function roleOf(fileName) {
  const base = stripExtension(fileName) || '';
  const lower = base.toLowerCase();
  if (DAY_RE.test(base)) return 'daily';
  // 月度：2026-10 平铺迁移件 / 默认英文名 / 旧版中文名，都算
  if (MONTH_RE.test(base)) return 'monthly';
  if (['monthly log', '月度记录', '月记录', '月度笔记'].includes(lower)) return 'monthly';
  // 年度（未来）记录：默认英文名 / 带连字符的旧写法 / 旧版中文名，都算
  if (['future log', 'future-log', '未来记录', '年度记录'].includes(lower)) return 'future';
  return 'other';
}

/* ---------------- 列表 ---------------- */

/**
 * 递归列出日记目录里的 Markdown 文件（含 年/月 子文件夹）。
 * 目录不存在时返回空列表（首次使用还没建目录，不该算错误）。
 * 每个文件都带 folder（相对日记目录的文件夹，根级为 ''）与 year/month（推断归属）。
 */
async function listJournals(dir) {
  const resolved = path.resolve(dir);
  const files = [];

  async function walk(current, relative) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return; // 子目录消失时忽略整支
      throw new Error(`无法读取日记目录：${err.message}`);
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // marker 等隐藏文件与隐藏目录不进日记栏
      const fullPath = path.join(current, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const extension = path.extname(entry.name).toLowerCase();
      if (!JOURNAL_EXTENSIONS.has(extension)) continue;
      if (IGNORED_NAMES.has(entry.name.toLowerCase())) continue;

      const stat = await fs.stat(fullPath);
      const { year, month } = locationFrom(relative, entry.name);
      const collection = collectionOf(relative);
      files.push({
        name: entry.name,
        path: fullPath,
        folder: relative,
        collection,
        role: roleOf(entry.name),
        dateKey: dateKeyOf(entry.name),
        year,
        month,
        extension,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString()
      });
    }
  }

  try {
    await walk(resolved, '');
  } catch (err) {
    if (err.code === 'ENOENT') return { dir: resolved, files: [] };
    throw new Error(`无法读取日记目录：${err.message}`);
  }

  sortJournals(files);
  return { dir: resolved, files };
}

/** 侧边栏排序：集子（按文件夹名）→ 年的历史在前 → 月在前 → 角色（未来/月度/每日/散件）→ 日期新的在前面 */
const ROLE_RANK = { future: 0, monthly: 1, daily: 2, other: 3 };

function sortJournals(files) {
  files.sort((a, b) => {
    // 集子统一排在 年/月 日记的后面：先按集子名分组，组内修改时间新→旧
    if (a.collection && b.collection) {
      if (a.collection !== b.collection) return a.collection.localeCompare(b.collection);
      return b.modifiedAt.localeCompare(a.modifiedAt) || b.name.localeCompare(a.name);
    }
    if (a.collection) return 1; // a 在集子里，b 不在：b 永远在前
    if (b.collection) return -1;
    // —— 以下与原排序一致 ——
    if (a.year !== b.year) {
      if (a.year == null) return 1; // 没年份的永远垫底
      if (b.year == null) return -1;
      return Number(b.year) - Number(a.year);
    }
    // 年度（未来）记录排在当年所有月份之前
    const aIsFuture = a.role === 'future';
    if (aIsFuture !== (b.role === 'future')) return aIsFuture ? -1 : 1;
    if (a.month !== b.month) {
      if (a.month == null) return 1;
      if (b.month == null) return -1;
      return a.month < b.month ? 1 : -1;
    }
    const role = ROLE_RANK[a.role] - ROLE_RANK[b.role];
    if (role) return role;
    if (a.dateKey && b.dateKey) return b.dateKey.localeCompare(a.dateKey) || b.name.localeCompare(a.name);
    return b.name.localeCompare(a.name);
  });
}

/* ---------------- 模板 ---------------- */

/** 新建日记时写入的骨架，末尾留空行方便继续追加 */
function dailyTemplate(date) {
  return `# ${dateLabel(date)}\n\n## 任务\n\n## 笔记\n`;
}

/**
 * 月度记录（一月一篇，与每日记录同一个月文件夹）。
 * 默认用英文生成（与 Monthly Log.md 文件名配套）；旧文件里的中文小节不受影响——
 * 写入已不再依赖「任务/笔记」小节，统一在末尾追加并去重。
 */
function monthlyTemplate(date) {
  return `# ${monthLabel(date)} · Monthly Log\n\n## Tasks\n\n## Notes\n`;
}

/** 年度（未来）记录（一年一篇，年文件夹里）；默认同样用英文生成 */
function futureTemplate(date) {
  return `# ${yearLabel(date)} · Future Log\n\n## Tasks\n\n## Notes\n`;
}

/* ---------------- 相对路径（归属于哪个文件夹） ---------------- */

/** 每日记录：2026/2026-10/2026-10-13.md */
function dailyRelativePath(date) {
  return path.posix.join(yearFolderName(date), monthFolderName(date), dailyFileName(date));
}

/** 月度记录：2026/2026-10/月度记录.md */
function monthlyRelativePath(date) {
  return path.posix.join(yearFolderName(date), monthFolderName(date), MONTHLY_RECORD_FILE);
}

/** 年度（未来）记录：2026/未来记录.md */
function futureRelativePath(date) {
  return path.posix.join(yearFolderName(date), FUTURE_RECORD_FILE);
}

/** 绝对路径版本（主进程读/写与上下文要用） */
function dailyJournalPath(dir, date = new Date()) {
  return path.join(path.resolve(dir), dailyRelativePath(date));
}

/* ---------------- ensure：不存在才按模板建 ---------------- */

/**
 * 在日记目录下确保某个（可能带文件夹的）文件存在：不存在就写模板，存在绝不覆盖。
 * @returns {Promise<{ path: string, name: string, created: boolean }>}
 */
async function ensureJournalFile(dirRoot, relativePath, template) {
  const root = path.resolve(dirRoot);
  const filePath = path.join(root, relativePath);

  try {
    await fs.access(filePath);
    return { path: filePath, name: path.basename(filePath), created: false };
  } catch {
    // 还没有这份记录，下面创建
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    // wx：已存在就不覆盖（并发时别人先建了也没关系）
    await fs.writeFile(filePath, template, { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw new Error(`无法创建日记文件：${err.message}`);
  }

  return { path: filePath, name: path.basename(filePath), created: true };
}

/**
 * 拿到某天的每日记录（2026/2026-10/2026-10-13.md），年/月文件夹缺了会一起建好。
 */
async function ensureDailyJournal(dir, date = new Date()) {
  return ensureJournalFile(dir, dailyRelativePath(date), dailyTemplate(date));
}

/**
 * 拿到某月的月度记录（2026/2026-10/月度记录.md），不存在才按模板建。
 */
async function ensureMonthlyJournal(dir, date = new Date()) {
  return ensureJournalFile(dir, monthlyRelativePath(date), monthlyTemplate(date));
}

/**
 * 拿到某年的年度（未来）记录（2026/未来记录.md），不存在才按模板建。
 */
async function ensureFutureLog(dir, date = new Date()) {
  return ensureJournalFile(dir, futureRelativePath(date), futureTemplate(date));
}

/* ---------------- 迁移 / 推迟的目标日志 ---------------- */

/**
 * 解析「迁移 / 推迟」要去的日记并确保它存在（不存在才按模板建，绝不覆盖）：
 *   tomorrow     → 明天的每日记录（2026/2026-10/2026-10-14.md，跨月跨年自动归位）
 *   nextMonth    → 下个月的月度记录（2026/2026-11/月度记录.md，跨年归到下年）
 *   future       → 今年的年度（未来）记录（2026/未来记录.md）
 *
 * spec 可以是上面三个字符串之一，也可以是 { kind, date }，date 是 'YYYY-MM-DD' 或 Date。
 * @returns {Promise<{ path: string, name: string, kind: string, dateKey: string, label: string, created: boolean }>}
 */
async function ensureMoveDestination(dir, spec = {}) {
  const kind = typeof spec === 'string' ? spec : spec && spec.kind;
  const base = typeof spec === 'object' && spec && spec.date
    ? parseDateKey(spec.date) || new Date()
    : new Date();

  let targetDate;
  if (kind === 'tomorrow') {
    targetDate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  } else if (kind === 'nextMonth') {
    targetDate = new Date(base.getFullYear(), base.getMonth() + 1, 1);
  } else if (kind === 'future') {
    targetDate = base;
  } else {
    throw new Error(`未知的迁移目的地：${String(kind)}（可选：tomorrow / nextMonth / future）`);
  }

  let journal;
  if (kind === 'tomorrow') journal = await ensureDailyJournal(dir, targetDate);
  else if (kind === 'nextMonth') journal = await ensureMonthlyJournal(dir, targetDate);
  else journal = await ensureFutureLog(dir, targetDate);

  const label =
    kind === 'tomorrow'
      ? `明天（${dateKey(targetDate)}）的日记`
      : kind === 'nextMonth'
        ? `下月（${dateKey(targetDate)}）的 Monthly Log`
        : `${yearLabel(targetDate)} Future Log`;

  return { path: journal.path, name: journal.name, kind, dateKey: dateKey(targetDate), label, created: journal.created };
}

/* ---------------- 一次性迁移旧平铺目录 ---------------- */

/**
 * 把旧版平铺结构（journals/2026-10-07.md、journals/2026-10.md）移进 年/月 文件夹：
 *   journals/2026-10-07.md → journals/2026/2026-10/2026-10-07.md
 *   journals/2026-10.md    → journals/2026/2026-10/月度记录.md
 * 名字对不上的散文件（未来记录.md 等）留在原地。目标已存在时不移动、不覆盖。
 * 整个流程靠 STRUCTURE_MARKER 只跑一次，跑完以后再调用直接跳过。
 */
async function migrateFlatJournals(dir) {
  const resolved = path.resolve(dir);
  const marker = path.join(resolved, STRUCTURE_MARKER);

  try {
    await fs.access(marker);
    return { needed: false, moved: [], skipped: [] }; // 已迁移过
  } catch {
    // 第一次：接下来迁移
  }

  await fs.mkdir(resolved, { recursive: true });
  let entries;
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    throw new Error(`无法读取日记目录：${err.message}`);
  }

  const moved = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!JOURNAL_EXTENSIONS.has(extension) || IGNORED_NAMES.has(entry.name.toLowerCase())) continue;

    const base = stripExtension(entry.name);
    let relativeTarget = null;
    if (DAY_RE.test(base)) {
      relativeTarget = path.join(base.slice(0, 4), base.slice(0, 7), entry.name);
    } else if (MONTH_RE.test(base)) {
      relativeTarget = path.join(base.slice(0, 4), base, MONTHLY_RECORD_FILE);
    }
    if (!relativeTarget) continue; // 非日期命名的文件不动

    const target = path.join(resolved, relativeTarget);
    let targetExists = false;
    try {
      await fs.access(target);
      targetExists = true;
    } catch {
      // 目标还没有，可以移过去
    }
    if (targetExists) {
      skipped.push({ name: entry.name, reason: '目标已存在，保留原文件' });
      continue;
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.rename(path.join(resolved, entry.name), target);
      moved.push({ from: entry.name, to: relativeTarget });
    } catch (err) {
      skipped.push({ name: entry.name, reason: err.message });
    }
  }

  await fs.writeFile(
    marker,
    `${JSON.stringify({ version: 2, migratedAt: new Date().toISOString(), moved, skipped }, null, 2)}\n`,
    'utf8'
  );

  return { needed: true, moved, skipped };
}

module.exports = {
  listJournals,
  dateKeyOf,
  locationFrom,
  roleOf,
  dailyTemplate,
  monthlyTemplate,
  futureTemplate,
  dailyRelativePath,
  monthlyRelativePath,
  futureRelativePath,
  dailyJournalPath,
  ensureDailyJournal,
  ensureMonthlyJournal,
  ensureFutureLog,
  ensureJournalFile,
  ensureMoveDestination,
  migrateFlatJournals,
  STRUCTURE_MARKER,
  JOURNAL_EXTENSIONS,
  IGNORED_NAMES,
  parseDateKey
};
