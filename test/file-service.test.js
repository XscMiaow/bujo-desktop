'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { readMarkdownFile, MARKDOWN_EXTENSIONS } = require('../src/main/file-service.js');

let tmpDir;

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-test-'));
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('读取 .md 文件并返回路径、名称、大小与内容', async () => {
  const file = path.join(tmpDir, 'note.md');
  await fs.writeFile(file, '# 标题\n\n- [ ] 任务\n', 'utf8');

  const result = await readMarkdownFile(file);
  assert.equal(result.name, 'note.md');
  assert.equal(result.dir, tmpDir);
  assert.equal(result.extension, '.md');
  assert.ok(result.size > 0);
  assert.match(result.content, /- \[ \] 任务/);
  assert.ok(!Number.isNaN(Date.parse(result.modifiedAt)), 'modifiedAt 是合法时间');
});

test('支持大写扩展名与其他文本后缀', async () => {
  const upper = path.join(tmpDir, 'UPPER.MD');
  await fs.writeFile(upper, 'x', 'utf8');
  assert.equal((await readMarkdownFile(upper)).extension, '.md');

  assert.ok(MARKDOWN_EXTENSIONS.has('.md') && MARKDOWN_EXTENSIONS.has('.markdown'));
});

test('拒绝非 Markdown 文件与空路径', async () => {
  const exe = path.join(tmpDir, 'danger.exe');
  await fs.writeFile(exe, 'x', 'utf8');
  await assert.rejects(() => readMarkdownFile(exe), /只支持 Markdown 文件/);
  await assert.rejects(() => readMarkdownFile('   '), /未提供文件路径/);
  await assert.rejects(() => readMarkdownFile(undefined), /未提供文件路径/);
});

test('文件不存在或不是文件时给出可读错误', async () => {
  await assert.rejects(() => readMarkdownFile(path.join(tmpDir, 'missing.md')), /文件不存在/);

  // 同名的目录即使后缀是 .md 也不能当文件读
  const folder = path.join(tmpDir, 'folder.md');
  await fs.mkdir(folder, { recursive: true });
  await assert.rejects(() => readMarkdownFile(folder), /目标不是文件/);

  // 没有扩展名的路径先被扩展名校验拦住
  await assert.rejects(() => readMarkdownFile(tmpDir), /只支持 Markdown 文件/);
});
