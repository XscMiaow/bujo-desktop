'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { listJournals, dateKeyOf, ensureDailyJournal, dailyTemplate } = require('../src/main/journal-service.js');
const { dailyFileName, dateLabel, parseDateKey } = require('../src/shared/journal-date.js');

let tmpDir;

async function write(name, content = '# 日记\n- [ ] 任务\n') {
  await fs.writeFile(path.join(tmpDir, name), content, 'utf8');
}

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-journals-'));
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('从文件名推断日期键', () => {
  assert.equal(dateKeyOf('2026-10-07.md'), '2026-10-07');
  assert.equal(dateKeyOf('2026-10.md'), '2026-10');
  assert.equal(dateKeyOf('future-log.md'), null);
  assert.equal(dateKeyOf('README.md'), null);
});

test('列出 .md 文件，最新的排在最前面', async () => {
  await write('2026-10-05.md');
  await write('2026-10-07.md');
  await write('2026-10.md');
  await write('future-log.md');

  const { dir, files } = await listJournals(tmpDir);
  const names = files.map((f) => f.name);

  assert.equal(dir, path.resolve(tmpDir));
  assert.equal(names[0], '2026-10-07.md', '最新的日期在最前');
  assert.equal(names[1], '2026-10-05.md');
  assert.equal(names[2], '2026-10.md');
  assert.equal(names.at(-1), 'future-log.md', '认不出日期的排在最后');

  const first = files[0];
  assert.equal(path.dirname(first.path), path.resolve(tmpDir));
  assert.ok(first.size > 0);
  assert.ok(!Number.isNaN(Date.parse(first.modifiedAt)));
});

test('忽略非 Markdown 文件与子目录', async () => {
  await write('notes.txt', '纯文本');
  await write('archive.markdown');
  await fs.mkdir(path.join(tmpDir, 'nested'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, 'nested', '2026-01-01.md'), '# 深层文件', 'utf8');

  const { files } = await listJournals(tmpDir);
  const names = files.map((f) => f.name);
  assert.ok(!names.includes('notes.txt'), '.txt 不进日记栏');
  assert.ok(names.includes('archive.markdown'), '.markdown 也算日记');
  assert.ok(!names.includes('2026-01-01.md'), '子目录里的文件不列出');
});

test('目录不存在时返回空列表而不是报错', async () => {
  const missing = path.join(tmpDir, 'not-created-yet');
  const { dir, files } = await listJournals(missing);
  assert.equal(dir, path.resolve(missing));
  assert.deepEqual(files, []);
});

test('ensureDailyJournal 按模板新建今天的日志，再调用不会重复写', async () => {
  const dir = path.join(tmpDir, 'daily');
  const date = new Date(2026, 9, 7, 8, 0);

  const first = await ensureDailyJournal(dir, date);
  assert.equal(first.created, true);
  assert.equal(first.name, '2026-10-07.md');
  assert.equal(dailyFileName(date), '2026-10-07.md');

  const content = await fs.readFile(first.path, 'utf8');
  assert.equal(content, '# 2026-10-07 星期三\n\n## 任务\n\n## 笔记\n');
  assert.equal(content, dailyTemplate(date));

  await fs.writeFile(first.path, '- [ ] 我写了一点东西\n', 'utf8');
  const second = await ensureDailyJournal(dir, date);
  assert.equal(second.created, false);
  assert.equal(await fs.readFile(first.path, 'utf8'), '- [ ] 我写了一点东西\n', '已存在时不会覆盖');
});

test('日期标签按本地时间算星期', () => {
  assert.equal(dateLabel(new Date(2026, 9, 7)), '2026-10-07 星期三');
  assert.equal(dateLabel(new Date(2026, 9, 11)), '2026-10-11 星期日');
  assert.equal(parseDateKey('2026-10-07').getDay(), 3, '不能被当成 UTC 解析成星期二');
  assert.equal(parseDateKey('2026-10'), null);
});

test('真实 journals 目录里有今天这份日记', async () => {
  const repoJournals = path.join(__dirname, '..', 'journals');
  const { files } = await listJournals(repoJournals);
  const names = files.map((f) => f.name);
  assert.ok(names.includes('2026-10-07.md'), `journals/ 里应该有示例日记，实际：${names.join(', ')}`);
  assert.ok(!names.includes('README.md'), 'README 是说明文档，不该混进日记列表');
});
