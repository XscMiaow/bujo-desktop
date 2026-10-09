'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { MARKDOWN_EXTENSIONS } = require('./file-service');
const { parseEditBlock, integrate } = require('../shared/note-edit.js');

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

  if (!report.changed || text === existing) {
    return { path: resolved, name: path.basename(resolved), changed: false, size: Buffer.byteLength(existing, 'utf8'), report };
  }

  const written = await writeNote(resolved, text);
  return { path: written.path, name: written.name, changed: true, size: written.size, report };
}

module.exports = { appendToNote, readNote, writeNote, integrateNoteFile, isInsideDirectory, assertWritable };
