'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { appendToNote, readNote, integrateNoteFile, setBulletMark, locateBullet, isInsideDirectory } = require('../src/main/note-service.js');

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

test('整合写入：改已有条目、跳过重复条目，其它内容原样保留', async () => {
  const file = path.join(tmpDir, 'g.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 写周报\n- 整理收件箱\n', 'utf8');

  const result = await integrateNoteFile(file, {
    edit: '完成：整理收件箱',
    header: '**AI 记录 · 09:05**',
    lines: ['- [ ] 给客户回信', '- 整理收件箱']
  });

  assert.equal(result.changed, true);
  assert.equal(result.name, 'g.md');
  assert.equal(result.report.added.length, 1);
  assert.equal(result.report.duplicates.length, 1);
  assert.equal(result.report.edits.applied.length, 1);

  const content = await fs.readFile(file, 'utf8');
  assert.ok(content.startsWith('# 笔记'), '原有内容不动');
  assert.ok(content.includes('- [x] 整理收件箱'), '改的是已有那一行');
  assert.ok(content.includes('- [ ] 给客户回信'));
  assert.equal((content.match(/整理收件箱/g) || []).length, 1, '重复的条目不再写一遍');
});


test('重复的一轮不会写文件（笔记没变化时不动磁盘）', async () => {
  const file = path.join(tmpDir, 'h.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 给客户回信\n', 'utf8');
  const before = await fs.stat(file);

  const again = await integrateNoteFile(file, { header: '**AI 记录 · 09:05**', lines: ['- 给客户回信'] });

  assert.equal(again.changed, false);
  assert.equal(again.report.added.length, 0);
  assert.equal(again.report.duplicates.length, 1);
  const after = await fs.stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, '没有改动就不落盘');
  assert.equal(await fs.readFile(file, 'utf8'), '# 笔记\n\n- [ ] 给客户回信\n');
});


test('readNote 读不到就报错，不返回空字符串', async () => {
  await assert.rejects(() => readNote(path.join(tmpDir, 'nope.md')), /文件不存在/);
  await assert.rejects(() => readNote(path.join(tmpDir, 'x.exe')), /只能写入 Markdown/);
});


test('手工改标记：完成 / 划去 / 恢复，都只改那一行', async () => {
  const file = path.join(tmpDir, 'marks.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 写周报\n- 整理收件箱\n  - [!] 子任务\n', 'utf8');

  const done = await setBulletMark(file, { line: 2, text: '写周报', mark: 'x' });
  assert.equal(done.changed, true);
  assert.equal(done.state, 'done');
  assert.equal(done.after, '- [x] 写周报');

  const cancelled = await setBulletMark(file, { line: 3, text: '整理收件箱', mark: '-' });
  assert.equal(cancelled.after, '- [-] 整理收件箱');

  const restored = await setBulletMark(file, { line: 4, text: '子任务', mark: ' ' });
  assert.equal(restored.after, '  - [ ] 子任务', '缩进保留');

  const content = await fs.readFile(file, 'utf8');
  assert.equal(
    content,
    ['# 笔记', '', '- [x] 写周报', '- [-] 整理收件箱', '  - [ ] 子任务', ''].join('\n'),
    '一行都没删，只改了三处的标记'
  );
});


test('已经是这个状态时不写文件，也不报成改过了', async () => {
  const file = path.join(tmpDir, 'marks-same.md');
  await fs.writeFile(file, '- [x] 写周报\n', 'utf8');
  const before = await fs.stat(file);

  const again = await setBulletMark(file, { line: 0, text: '写周报', mark: 'x' });
  assert.equal(again.changed, false);
  const after = await fs.stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, '没有变化就不动磁盘');
});


test('行号偏了按内容找回；找不到或两条一样就拒绝，绝不乱改', async () => {
  const file = path.join(tmpDir, 'marks-stale.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 写周报\n- 整理收件箱\n', 'utf8');

  // 行号给错（文件在外部被改过），但内容对得上：找回来
  const found = await setBulletMark(file, { line: 0, text: '整理收件箱', mark: '-' });
  assert.equal(found.changed, true);
  assert.equal(found.after, '- [-] 整理收件箱');

  await assert.rejects(() => setBulletMark(file, { line: 1, text: '不存在的事', mark: 'x' }), /找不到这一条/);
  await assert.rejects(() => setBulletMark(file, { line: 1, text: '写周报', mark: '?' }), /不支持的标记/);
  await assert.rejects(() => setBulletMark(file, { line: 1, text: '  ', mark: 'x' }), /没有可比对的内容/);
});


test('两条一模一样的条目：宁可拒绝也不猜（返回明确错误）', async () => {
  const file = path.join(tmpDir, 'marks-dup.md');
  await fs.writeFile(file, '开头\n\n- [ ] 买牛奶\n\n- [ ] 买牛奶\n', 'utf8');

  await assert.rejects(() => setBulletMark(file, { line: 1, text: '买牛奶', mark: 'x' }), /一样的条目/);
  assert.equal(await fs.readFile(file, 'utf8'), '开头\n\n- [ ] 买牛奶\n\n- [ ] 买牛奶\n', '拒绝时文件完全不动');
});


test('段落、标题、空行都不是条目：不给它们打标记', async () => {
  const file = path.join(tmpDir, 'marks-plain.md');
  const original = '# 标题\n\n这是一段普通文字\n';
  await fs.writeFile(file, original, 'utf8');

  for (const target of [
    { line: 2, text: '这是一段普通文字' },
    { line: 0, text: '# 标题' },
    { line: 1, text: '开头' }
  ]) {
    await assert.rejects(() => setBulletMark(file, { ...target, mark: 'x' }), /不是条目|找不到这一条/, JSON.stringify(target));
  }

  assert.equal(await fs.readFile(file, 'utf8'), original, '拒绝时一个字都不动');
});


test('locateBullet 只认条目行', () => {
  const lines = ['# 标题', '- [ ] 写周报', '普通文字', 'o 开会'];
  assert.equal(locateBullet(lines, '写周报'), 1);
  assert.equal(locateBullet(lines, '开会'), 3, '事件也算条目');
  assert.throws(() => locateBullet(lines, '普通文字'), /找不到这一条/);
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
