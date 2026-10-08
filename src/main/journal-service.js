'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { dailyFileName, dateLabel } = require('../shared/journal-date');

/** 允许出现在日记栏里的文件类型 */
const JOURNAL_EXTENSIONS = new Set(['.md', '.markdown']);

/** 说明文档不算日记，不进日记栏 */
const IGNORED_NAMES = new Set(['readme.md']);

const DAY_RE = /^(\d{4}-\d{2}-\d{2})/;
const MONTH_RE = /^(\d{4}-\d{2})$/;

/**
 * 从文件名推断排序用的「日期键」。
 * 2026-10-07.md -> 2026-10-07；2026-10.md -> 2026-10；其他 -> null
 */
function dateKeyOf(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  return (DAY_RE.exec(base) || [])[1] || ((MONTH_RE.exec(base) || [])[1] ?? null);
}

/**
 * 列出日记目录里的 Markdown 文件，最新的排在前面。
 * 目录不存在时返回空列表（首次使用还没建目录，不该算错误）。
 */
async function listJournals(dir) {
  const resolved = path.resolve(dir);
  let entries;
  try {
    entries = await fs.readdir(resolved, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { dir: resolved, files: [] };
    throw new Error(`无法读取日记目录：${err.message}`);
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!JOURNAL_EXTENSIONS.has(extension)) continue;
    if (IGNORED_NAMES.has(entry.name.toLowerCase())) continue;

    const fullPath = path.join(resolved, entry.name);
    const stat = await fs.stat(fullPath);
    files.push({
      name: entry.name,
      path: fullPath,
      dateKey: dateKeyOf(entry.name),
      extension,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    });
  }

  files.sort((a, b) => {
    if (a.dateKey && b.dateKey) return b.dateKey.localeCompare(a.dateKey) || b.name.localeCompare(a.name);
    if (a.dateKey) return -1; // 认得出日期的排在前面
    if (b.dateKey) return 1;
    return b.name.localeCompare(a.name);
  });

  return { dir: resolved, files };
}

/** 新建日记时写入的骨架，末尾留空行方便继续追加 */
function dailyTemplate(date) {
  return `# ${dateLabel(date)}\n\n## 任务\n\n## 笔记\n`;
}

/**
 * 拿到某天的日记文件，不存在就按模板建一个。
 * @returns {Promise<{ path: string, name: string, created: boolean }>}
 */
async function ensureDailyJournal(dir, date = new Date()) {
  const resolvedDir = path.resolve(dir);
  const filePath = path.join(resolvedDir, dailyFileName(date));

  try {
    await fs.access(filePath);
    return { path: filePath, name: path.basename(filePath), created: false };
  } catch {
    // 还没有今天的日志，下面创建
  }

  await fs.mkdir(resolvedDir, { recursive: true });
  try {
    // wx：已存在就不覆盖（并发时别人先建了也没关系）
    await fs.writeFile(filePath, dailyTemplate(date), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if (err.code !== 'EEXIST') throw new Error(`无法创建日记文件：${err.message}`);
  }

  return { path: filePath, name: path.basename(filePath), created: true };
}

module.exports = { listJournals, dateKeyOf, dailyTemplate, ensureDailyJournal, JOURNAL_EXTENSIONS, IGNORED_NAMES };
