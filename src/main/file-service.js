'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

/** 允许打开的文本类笔记文件 */
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt']);

/**
 * 读取一个 Markdown 笔记文件，返回渲染层需要的信息。
 * 只做读取，不写文件——保证「打开笔记」不会意外改动用户数据。
 */
async function readMarkdownFile(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('未提供文件路径');
  }

  const resolved = path.resolve(filePath.trim());
  const ext = path.extname(resolved).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(ext)) {
    throw new Error(`只支持 Markdown 文件（${[...MARKDOWN_EXTENSIONS].join(' / ')}），收到的是「${ext || '无扩展名'}」`);
  }

  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`文件不存在：${resolved}`);
    throw new Error(`无法访问文件：${err.message}`);
  }
  if (!stat.isFile()) throw new Error('目标不是文件');

  const content = await fs.readFile(resolved, 'utf8');
  return {
    path: resolved,
    name: path.basename(resolved),
    dir: path.dirname(resolved),
    extension: ext,
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    content
  };
}

module.exports = { readMarkdownFile, MARKDOWN_EXTENSIONS };
