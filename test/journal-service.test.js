'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  listJournals,
  dateKeyOf,
  locationFrom,
  roleOf,
  dailyTemplate,
  monthlyTemplate,
  futureTemplate,
  ensureDailyJournal,
  ensureMonthlyJournal,
  ensureFutureLog,
  dailyJournalPath,
  migrateFlatJournals,
  ensureMoveDestination,
  STRUCTURE_MARKER
} = require('../src/main/journal-service.js');
const {
  dailyFileName,
  dateLabel,
  parseDateKey,
  parseMonthKey,
  parseYearKey,
  monthLabel,
  yearLabel
} = require('../src/shared/journal-date.js');

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
  assert.equal(dateKeyOf('未来记录.md'), null);
  assert.equal(dateKeyOf('README.md'), null);
});

test('从文件夹与文件名推断归属（年 / 月）与角色', () => {
  assert.deepEqual(locationFrom('2026/2026-10', '2026-10-07.md'), { year: '2026', month: '2026-10' });
  assert.deepEqual(locationFrom('2026', '未来记录.md'), { year: '2026', month: null });
  // 旧平铺文件也可从文件名兜底
  assert.deepEqual(locationFrom('', '2026-10-07.md'), { year: '2026', month: '2026-10' });
  assert.deepEqual(locationFrom('', '随手记.md'), { year: null, month: null });

  assert.equal(roleOf('2026-10-07.md'), 'daily');
  assert.equal(roleOf('2026-10.md'), 'monthly');
  // 旧版中文名与新默认英文名都是同一种角色
  assert.equal(roleOf('月度记录.md'), 'monthly');
  assert.equal(roleOf('Monthly Log.md'), 'monthly');
  assert.equal(roleOf('未来记录.md'), 'future');
  assert.equal(roleOf('Future Log.md'), 'future');
  assert.equal(roleOf('future-log.md'), 'future');
  assert.equal(roleOf('随手记.md'), 'other');
});

test('递归列出 .md 文件，年→月→角色→日期排序（新的在前）', async () => {
  await fs.mkdir(path.join(tmpDir, 'flat'), { recursive: true });
  const dir = path.join(tmpDir, 'flat');
  const mk = async (rel, name, content) => {
    await fs.mkdir(path.join(dir, rel), { recursive: true });
    await fs.writeFile(path.join(dir, rel, name), content || '# 日记\n', 'utf8');
  };

  await mk('', '2026-10-05.md');
  await mk('', '2026-10-07.md');
  await mk('', 'future-log.md');
  await mk('2026', '未来记录.md');
  await mk('2026/2026-10', '月度记录.md');
  await mk('2026/2026-10', '2026-10-07.md');
  await mk('2026/2026-09', '2026-09-01.md');
  await mk('2050', '未来记录.md');

  const { dir: resolved, files } = await listJournals(dir);
  const labels = files.map((f) => `${f.folder || '(root)'}┆${f.name}`);

  assert.equal(resolved, path.resolve(dir));
  // 同一个月的文件聚在一起（根级平铺残留也从文件名推出了月份）；未来记录排在当年月份前
  assert.deepEqual(labels, [
    '2050┆未来记录.md',
    '2026┆未来记录.md',
    '2026/2026-10┆月度记录.md',
    '2026/2026-10┆2026-10-07.md',
    '(root)┆2026-10-07.md',
    '(root)┆2026-10-05.md',
    '2026/2026-09┆2026-09-01.md',
    '(root)┆future-log.md'
  ]);

  const first = files[0];
  assert.ok(first.size > 0);
  assert.ok(!Number.isNaN(Date.parse(first.modifiedAt)));
});

test('忽略非 Markdown 文件、README 与隐藏文件；嵌套子目录同样过滤', async () => {
  await fs.mkdir(path.join(tmpDir, 'weird'), { recursive: true });
  const dir = path.join(tmpDir, 'weird');
  await fs.writeFile(path.join(dir, 'notes.txt'), '纯文本', 'utf8');
  await fs.writeFile(path.join(dir, 'archive.markdown'), '# ok\n', 'utf8');
  await fs.writeFile(path.join(dir, 'README.md'), '# 说明\n', 'utf8');
  await fs.writeFile(path.join(dir, '.journal-structure-v2'), '{}\n', 'utf8');
  await fs.mkdir(path.join(dir, 'nested', 'deeper'), { recursive: true });
  await fs.writeFile(path.join(dir, 'nested', 'deeper', '2026-01-01.md'), '# 深层\n', 'utf8');

  const { files } = await listJournals(dir);
  const names = files.map((f) => f.name);
  assert.ok(names.includes('archive.markdown'), '.markdown 也算日记');
  assert.ok(names.includes('2026-01-01.md'), '嵌套子目录里的日记也列出（新结构就在子目录里）');
  assert.ok(!names.includes('notes.txt'), '.txt 不进日记栏');
  assert.ok(!names.includes('README.md'), 'README 是说明文档，不混进日记列表');
  assert.ok(!files.some((f) => f.name.startsWith('.')), '隐藏 marker 文件不进日记栏');
  assert.equal(files.find((f) => f.name === '2026-01-01.md').folder, 'nested/deeper');
});

test('目录不存在时返回空列表而不是报错', async () => {
  const missing = path.join(tmpDir, 'not-created-yet');
  const { dir, files } = await listJournals(missing);
  assert.equal(dir, path.resolve(missing));
  assert.deepEqual(files, []);
});

const DAY = new Date(2026, 9, 7, 8, 0);

test('ensureDailyJournal 建在 年/月 文件夹里，再调用不会重复写', async () => {
  const dir = path.join(tmpDir, 'daily');

  const first = await ensureDailyJournal(dir, DAY);
  assert.equal(first.created, true);
  assert.equal(first.name, '2026-10-07.md');
  assert.equal(dailyFileName(DAY), '2026-10-07.md');
  assert.equal(first.path, dailyJournalPath(dir, DAY));

  const rel = path.relative(dir, first.path);
  assert.equal(rel.replaceAll('\\', '/'), '2026/2026-10/2026-10-07.md', '每日记录应在 年/月 文件夹下');

  const content = await fs.readFile(first.path, 'utf8');
  assert.equal(content, '# 2026-10-07 星期三\n\n## 任务\n\n## 笔记\n');
  assert.equal(content, dailyTemplate(DAY));

  await fs.writeFile(first.path, '- [ ] 我写了一点东西\n', 'utf8');
  const second = await ensureDailyJournal(dir, DAY);
  assert.equal(second.created, false);
  assert.equal(await fs.readFile(first.path, 'utf8'), '- [ ] 我写了一点东西\n', '已存在时不会覆盖');
});

test('ensureMonthlyJournal / ensureFutureLog 按各自文件夹与模板建（默认英文模板）', async () => {
  const dir = path.join(tmpDir, 'periodic');

  const monthly = await ensureMonthlyJournal(dir, DAY);
  assert.equal(path.relative(dir, monthly.path).replaceAll('\\', '/'), '2026/2026-10/Monthly Log.md');
  assert.equal(await fs.readFile(monthly.path, 'utf8'), monthlyTemplate(DAY));
  assert.equal(monthlyTemplate(DAY), '# October 2026 · Monthly Log\n\n## Tasks\n\n## Notes\n');

  const future = await ensureFutureLog(dir, DAY);
  assert.equal(path.relative(dir, future.path).replaceAll('\\', '/'), '2026/Future Log.md');
  assert.equal(await fs.readFile(future.path, 'utf8'), futureTemplate(DAY));
  assert.equal(futureTemplate(DAY), '# 2026 · Future Log\n\n## Tasks\n\n## Notes\n');

  // 再调用不覆盖
  assert.equal((await ensureMonthlyJournal(dir, DAY)).created, false);
  assert.equal((await ensureFutureLog(dir, DAY)).created, false);
});

test('一次性迁移：平铺的日期日记与月记移进 年/月 文件夹，只跑一次', async () => {
  const dir = path.join(tmpDir, 'migrate');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-07.md'), '# 旧日记\n', 'utf8');
  await fs.writeFile(path.join(dir, '2026-10-12.md'), '# 旧日记2\n', 'utf8');
  await fs.writeFile(path.join(dir, '2026-09.md'), '# 旧月记\n', 'utf8');
  await fs.writeFile(path.join(dir, 'future-log.md'), '# 散件\n', 'utf8');

  const report = await migrateFlatJournals(dir);
  assert.equal(report.needed, true);
  assert.deepEqual(report.moved.map((m) => m.from).sort(), ['2026-09.md', '2026-10-07.md', '2026-10-12.md']);
  assert.equal(
    await fs.readFile(path.join(dir, '2026', '2026-10', '2026-10-07.md'), 'utf8'),
    '# 旧日记\n'
  );
  assert.equal(
    await fs.readFile(path.join(dir, '2026', '2026-09', 'Monthly Log.md'), 'utf8'),
    '# 旧月记\n',
    '旧平铺月记应改名为 Monthly Log.md 放进对应月文件夹'
  );
  assert.ok(await fs.access(path.join(dir, 'future-log.md')).then(() => true, () => false), '非日期命名的散件原地不动');
  assert.ok(await fs.access(path.join(dir, STRUCTURE_MARKER)).then(() => true, () => false), '迁移完成要留标记');

  // 第二次调用直接跳过，不再报告移动
  const again = await migrateFlatJournals(dir);
  assert.equal(again.needed, false);
  assert.deepEqual(again.moved, []);

  // 目标已存在时不覆盖不移动
  const dir2 = path.join(tmpDir, 'migrate-conflict');
  await fs.mkdir(path.join(dir2, '2026', '2026-10'), { recursive: true });
  await fs.writeFile(path.join(dir2, '2026-10-07.md'), '# 新的\n', 'utf8');
  await fs.writeFile(path.join(dir2, '2026', '2026-10', '2026-10-07.md'), '# 已存在\n', 'utf8');
  const conflict = await migrateFlatJournals(dir2);
  assert.deepEqual(conflict.moved, []);
  assert.equal(conflict.skipped.length, 1);
  assert.equal(
    await fs.readFile(path.join(dir2, '2026', '2026-10', '2026-10-07.md'), 'utf8'),
    '# 已存在\n'
  );
});

test('ensureMoveDestination：明天/下月跨月跨年归位，未来记录按年建', async () => {
  const dir = path.join(tmpDir, 'move-dest');

  const tomorrow = await ensureMoveDestination(dir, { kind: 'tomorrow', date: '2026-12-31' });
  assert.equal(path.relative(dir, tomorrow.path).replaceAll('\\', '/'), '2027/2027-01/2027-01-01.md', '跨年也归位正确');
  assert.equal(tomorrow.label, '明天（2027-01-01）的日记');
  assert.ok((await fs.readFile(tomorrow.path, 'utf8')).startsWith('# 2027-01-01'));

  const next = await ensureMoveDestination(dir, { kind: 'nextMonth', date: '2026-12-05' });
  assert.equal(path.relative(dir, next.path).replaceAll('\\', '/'), '2027/2027-01/Monthly Log.md');
  assert.equal(next.label, '下月（2027-01-01）的 Monthly Log');
  assert.equal(await fs.readFile(next.path, 'utf8'), monthlyTemplate(new Date(2027, 0, 1)));

  const future = await ensureMoveDestination(dir, { kind: 'future', date: '2026-10-13' });
  assert.equal(path.relative(dir, future.path).replaceAll('\\', '/'), '2026/Future Log.md');
  assert.equal(future.label, '2026 Future Log');

  // 字符串简写、重复调用不覆盖
  assert.equal((await ensureMoveDestination(dir, 'future')).created, false);
  // 简写不带 date：以当前日期为基准，去的是「今天的明天」（按当下动态算，不硬编码，免得跨天翻车）
  const now = new Date();
  const tomorrowKey = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const expectedFile = `${tomorrowKey.getFullYear()}-${String(tomorrowKey.getMonth() + 1).padStart(2, '0')}-${String(tomorrowKey.getDate()).padStart(2, '0')}.md`;
  const tomorrowPlain = await ensureMoveDestination(dir, 'tomorrow');
  assert.ok(tomorrowPlain.path.replaceAll('\\', '/').endsWith(`/${tomorrowKey.getFullYear()}/${tomorrowKey.getFullYear()}-${String(tomorrowKey.getMonth() + 1).padStart(2, '0')}/${expectedFile}`),
    `简写 should 取今天+1（${expectedFile}），实际 ${tomorrowPlain.path}`);
  assert.equal((await ensureMoveDestination(dir, 'tomorrow')).created, false);

  await assert.rejects(() => ensureMoveDestination(dir, 'yesterday'), /未知的迁移目的地/);
});

test('日期与年月标签按本地时间算', () => {
  assert.equal(dateLabel(new Date(2026, 9, 7)), '2026-10-07 星期三');
  assert.equal(dateLabel(new Date(2026, 9, 11)), '2026-10-11 星期日');
  assert.equal(parseDateKey('2026-10-07').getDay(), 3, '不能被当成 UTC 解析成星期二');
  assert.equal(parseDateKey('2026-10'), null);

  assert.equal(parseMonthKey('2026-10').getMonth(), 9);
  assert.equal(parseMonthKey('2026-13'), null);
  assert.equal(parseMonthKey('随便'), null);
  assert.equal(parseYearKey('2026').getFullYear(), 2026);
  assert.equal(parseYearKey('202x'), null);
  // 年度/月度记录默认用英文生成：月份标签也是英文的
  assert.equal(monthLabel(new Date(2026, 9, 13)), 'October 2026');
  assert.equal(yearLabel(new Date(2026, 9, 13)), '2026');
});

test('真实 journals 目录已是 年/月 嵌套结构', async () => {
  const repoJournals = path.join(__dirname, '..', 'journals');
  const { files } = await listJournals(repoJournals);
  assert.ok(
    files.some((f) => f.folder.replace(/\\/g, '/') === '2026/2026-10' && f.role === 'daily'),
    `journals/ 迁移后应有 2026/2026-10/2026-10-XX.md 日记，实际：${files.map((f) => f.folder + '/' + f.name).join(', ')}`
  );
  assert.ok(files.some((f) => f.role === 'monthly'), '月度记录应已建出');
  assert.ok(files.some((f) => f.role === 'future'), '未来记录应已建出');
  assert.ok(!files.some((f) => f.folder === ''), '旧平铺日记应已迁走');
  assert.ok(!files.some((f) => f.name.toLowerCase() === 'readme.md'), 'README 是说明文档，不该混进日记列表');
});

test('自定义集子：顶层非年份文件夹 → collection；年份文件夹与根级 → null；集子排到年份之后', async () => {
  await fs.mkdir(path.join(tmpDir, '收件箱'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, '2020', '2020-05'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, '收件箱', '存货.md'), '# 存货\n', 'utf8');
  await fs.writeFile(path.join(tmpDir, '收件箱', '旧件.md'), '# 旧\n', 'utf8');
  // 同一组文件的 mtime 粒度太细会重合：显式设时间让「新→旧」可比
  await fs.utimes(path.join(tmpDir, '收件箱', '存货.md'), new Date(2026, 0, 2), new Date(2026, 0, 2));
  await fs.utimes(path.join(tmpDir, '收件箱', '旧件.md'), new Date(2026, 0, 1), new Date(2026, 0, 1));
  await fs.writeFile(path.join(tmpDir, '2020', '2020-05', '2020-05-01.md'), '# 日\n', 'utf8');

  const { files } = await listJournals(path.join(tmpDir));
  const byName = (name) => files.find((f) => f.name === name);
  assert.equal(byName('存货.md').collection, '收件箱', '集子文件夹里的文件带上 collection');
  assert.equal(byName('旧件.md').collection, '收件箱');
  assert.equal(byName('2020-05-01.md').collection, null, '年/月文件夹的文件不属于集子');

  // 排序：年份（2020）在前，集子按名字垫底；同一集子内修改时间新→旧
  const labels = files.map((f) => f.name);
  assert.ok(labels.indexOf('2020-05-01.md') < labels.indexOf('存货.md'), '年份日记永远排在集子前');
  assert.ok(labels.indexOf('旧件.md') > labels.indexOf('存货.md'), '同集子内修改时间新→旧（旧件后写但内容同名）');
});
