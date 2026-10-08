'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { appendToNote, isInsideDirectory } = require('../src/main/note-service.js');

let tmpDir;

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-note-'));
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('追加到已有内容后面，前面留一个空行', async () => {
  const file = path.join(tmpDir, 'a.md');
  await fs.writeFile(file, '# 标题\n- [ ] 原有任务\n', 'utf8');

  const result = await appendToNote(file, '- 新内容');
  assert.equal(result.created, false);

  const content = await fs.readFile(file, 'utf8');
  assert.equal(content, '# 标题\n- [ ] 原有任务\n\n- 新内容\n');
});

test('原有文件没有结尾换行时也不会粘在一起', async () => {
  const file = path.join(tmpDir, 'b.md');
  await fs.writeFile(file, '最后一行没有换行', 'utf8');

  await appendToNote(file, '- 追加');
  assert.equal(await fs.readFile(file, 'utf8'), '最后一行没有换行\n\n- 追加\n');
});

test('已有空行结尾时不会越加越多空行', async () => {
  const file = path.join(tmpDir, 'c.md');
  await fs.writeFile(file, '内容\n\n', 'utf8');

  await appendToNote(file, '- 一');
  await appendToNote(file, '- 二');
  assert.equal(await fs.readFile(file, 'utf8'), '内容\n\n- 一\n\n- 二\n');
});

test('可以新建文件（日记场景），并保留初始模板', async () => {
  const file = path.join(tmpDir, 'nest', '2026-10-07.md');
  const result = await appendToNote(file, '- 第一条', {
    createIfMissing: true,
    initialContent: '# 2026-10-07 星期三\n\n## 笔记\n'
  });

  assert.equal(result.created, true);
  assert.equal(result.name, '2026-10-07.md');
  const content = await fs.readFile(file, 'utf8');
  assert.match(content, /^# 2026-10-07 星期三/);
  assert.match(content, /- 第一条\n$/);
});

test('不允许新建时，文件不存在要报错', async () => {
  await assert.rejects(() => appendToNote(path.join(tmpDir, 'missing.md'), '- x'), /文件不存在/);
});

test('空内容、非 Markdown、缺参数都会被拒绝', async () => {
  const file = path.join(tmpDir, 'd.md');
  await fs.writeFile(file, 'x\n', 'utf8');

  await assert.rejects(() => appendToNote(file, '   \n  '), /没有可写入的内容/);
  await assert.rejects(() => appendToNote(path.join(tmpDir, 'e.exe'), '- x'), /只能写入 Markdown/);
  await assert.rejects(() => appendToNote('', '- x'), /未提供要写入的文件/);
});

test('CRLF 内容会被统一成 LF', async () => {
  const file = path.join(tmpDir, 'f.md');
  await fs.writeFile(file, '头部\n', 'utf8');
  await appendToNote(file, '- 一\r\n- 二\r\n');
  assert.equal(await fs.readFile(file, 'utf8'), '头部\n\n- 一\n- 二\n');
});

test('isInsideDirectory 只认子路径', () => {
  const journals = path.join(tmpDir, 'journals');
  assert.equal(isInsideDirectory(path.join(journals, '2026-10-07.md'), journals), true);
  assert.equal(isInsideDirectory(path.join(journals, 'sub', 'a.md'), journals), true);
  assert.equal(isInsideDirectory(journals, journals), false, '目录本身不算');
  assert.equal(isInsideDirectory(path.join(tmpDir, 'other.md'), journals), false);
  assert.equal(isInsideDirectory(path.join(tmpDir, 'journals-evil', 'a.md'), journals), false, '前缀相同但不是子目录');
  assert.equal(isInsideDirectory(null, journals), false);
});
