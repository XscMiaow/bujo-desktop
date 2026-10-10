'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { MARKDOWN_EXTENSIONS } = require('./file-service');
const { parseBulletLine } = require('../shared/bullet-parser.js');
const { parseEditBlock, integrate, normalizeForMatch, matchScore, setMark } = require('../shared/note-edit.js');
const { submit, withFileLock } = require('./write-queue');

/** 手工改标记时允许的状态 */
const BULLET_MARKS = { ' ': 'task', x: 'done', '-': 'cancelled' };

/** 目标路径是否在某个目录内（用于把写入限制在日记目录里） */
function isInsideDirectory(childPath, dirPath) {
  if (!childPath || !dirPath) return false;
  const relative = path.relative(path.resolve(dirPath), path.resolve(childPath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertWritable(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('未提供要写入的文件');
  const resolved = path.resolve(filePath.trim());
  const extension = path.extname(resolved).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    throw new Error(`只能写入 Markdown 文件，收到的是「${extension || '无扩展名'}」`);
  }
  return resolved;
}

/**
 * 把一段 Markdown 追加到笔记末尾（自动补换行，不会破坏原有内容）。
 *
 * @param {string} filePath
 * @param {string} markdown
 * @param {{ createIfMissing?: boolean }} [options]
 * @returns {Promise<{ path: string, name: string, created: boolean, added: number, size: number }>}
 */
async function appendToNote(filePath, markdown, options = {}) {
  const resolved = assertWritable(filePath);
  const text = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n').trimEnd() : '';
  if (!text) throw new Error('没有可写入的内容');

  // 应用与 CLI 的写入口共用同一套队列：先入有界串行队列（满即拒），再拿跨进程文件锁（同一文件串行）
  return submit(() =>
    withFileLock(resolved, async () => {
      let existing = '';
      let created = false;
      try {
        existing = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT' || !options.createIfMissing) {
          throw new Error(err.code === 'ENOENT' ? `文件不存在：${resolved}` : `无法读取文件：${err.message}`);
        }
        created = true;
        if (options.initialContent) existing = `${String(options.initialContent).trimEnd()}\n`;
      }

      // 原有内容和新内容之间保证一个空行，并让文件以换行结尾
      let separator = '';
      if (existing.trim() !== '') {
        if (!existing.endsWith('\n')) separator += '\n';
        if (!existing.endsWith('\n\n')) separator += '\n';
      }
      const next = `${existing}${separator}${text}\n`;

      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, next, 'utf8');

      return {
        path: resolved,
        name: path.basename(resolved),
        created,
        added: text.length,
        size: Buffer.byteLength(next, 'utf8')
      };
    })
  );
}

/**
 * 读一篇笔记的原文（只读，不改动）。
 * @returns {Promise<string>}
 */
async function readNote(filePath) {
  const resolved = assertWritable(filePath);
  try {
    return await fs.readFile(resolved, 'utf8');
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `文件不存在：${resolved}` : `无法读取文件：${err.message}`);
  }
}

/** 整体写回一篇笔记（内容已由调用方拼好，这里只做落盘与信息回传） */
async function writeNote(filePath, text) {
  const resolved = assertWritable(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, text, 'utf8');
  return { path: resolved, name: path.basename(resolved), size: Buffer.byteLength(text, 'utf8') };
}

/**
 * 把 AI 的新增条目与「笔记改动」整合进一篇已有笔记，并写回文件。
 *
 * 与 appendToNote 的区别：这里会先读原文，再按 note-edit 的规则
 * 改已有条目、跳过重复条目，最后才落盘；笔记没变化时不写文件。
 *
 * @param {string} filePath
 * @param {{ edit?: string, header?: string, lines?: string[], dedupe?: boolean }} changes
 * @returns {Promise<{ path:string, name:string, changed:boolean, size:number, report:object }>}
 */
async function integrateNoteFile(filePath, changes = {}) {
  const resolved = assertWritable(filePath);
  const existing = await readNote(resolved);
  const parsed = parseEditBlock(changes.edit || '');
  const { text, report } = integrate(existing, {
    edits: parsed.edits,
    header: changes.header || '',
    lines: Array.isArray(changes.lines) ? changes.lines : [],
    dedupe: changes.dedupe !== false
  });
  report.ignored = parsed.ignored;

  // 队列 + 锁：任何进程都不会并发读改写同一份笔记
  return submit(() =>
    withFileLock(resolved, async () => {
      if (!report.changed || text === existing) {
        return { path: resolved, name: path.basename(resolved), changed: false, size: Buffer.byteLength(existing, 'utf8'), report };
      }
      const written = await writeNote(resolved, text);
      return { path: written.path, name: written.name, changed: true, size: written.size, report };
    })
  );
}

/**
 * 按内容找回某一条所在的行。
 * 只在唯一命中时才返回行号：两条一样的内容宁可不改，也不乱改。
 */
function locateBullet(lines, wanted) {
  const exact = [];
  const near = [];
  lines.forEach((line, index) => {
    if (!parseBulletLine(line)) return;
    const score = matchScore(wanted, normalizeForMatch(line));
    if (score === 1) exact.push(index);
    else if (score >= 0.92) near.push(index);
  });

  const pool = exact.length ? exact : near;
  if (pool.length === 1) return pool[0];
  if (pool.length > 1) throw new Error(`笔记里有 ${pool.length} 条一样的条目，没法确定改哪一条（已重新载入）`);
  throw new Error('笔记里找不到这一条（可能刚被改过），已重新载入');
}

/**
 * 手工改一条条目的标记：' ' 待办 / 'x' 完成 / '-' 划去。
 *
 * 行号优先，内容核对兜底：你在外部编辑器里改过文件、行号偏了也能对上；
 * 对不上就报错让界面重新载入，绝不改错行。划去只把标记改成 [-]，原文留在文件里。
 *
 * @param {string} filePath
 * @param {{ line?: number, text?: string, mark?: string }} target
 * @returns {Promise<{ path:string, name:string, changed:boolean, line:number, before:string, after:string, state:string }>}
 */
async function setBulletMark(filePath, target = {}) {
  const resolved = assertWritable(filePath);
  const { line, text, mark } = target;
  if (!Object.prototype.hasOwnProperty.call(BULLET_MARKS, mark)) {
    throw new Error(`不支持的标记：${String(mark)}`);
  }

  const wanted = normalizeForMatch(text);
  if (!wanted) throw new Error('这一条没有可比对的内容');

  // 队列 + 锁：与 append/integrate 同一套入口，应用与 CLI 完全一致
  return submit(() =>
    withFileLock(resolved, async () => {
      // 锁内重新读全文：别的进程可能刚改过这个文件，行号随时会变
      const source = (await readNote(resolved)).replace(/\r\n?/g, '\n');
      if (!source.trim()) throw new Error('笔记里还没有可改的条目');
      const lines = source.replace(/\s+$/, '').split('\n');

      let index = Number.isInteger(line) && line >= 0 && line < lines.length ? line : -1;
      if (index === -1 || normalizeForMatch(lines[index]) !== wanted) index = locateBullet(lines, wanted);

      const before = lines[index];
      if (!parseBulletLine(before)) throw new Error('这一行已经不是条目了，已重新载入');

      const after = setMark(before, mark);
      if (!after) throw new Error('这一条没有可比对的内容');

      const info = { path: resolved, name: path.basename(resolved), line: index, before, after, state: BULLET_MARKS[mark] };
      if (after === before) return { ...info, changed: false };

      lines[index] = after;
      const written = await writeNote(resolved, `${lines.join('\n')}\n`);
      return { ...info, changed: true, size: written.size };
    })
  );
}

module.exports = {
  appendToNote,
  readNote,
  writeNote,
  integrateNoteFile,
  setBulletMark,
  locateBullet,
  isInsideDirectory,
  assertWritable,
  BULLET_MARKS
};
