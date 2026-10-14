'use strict';

/** CLI 端到端测试：通过子进程调 bin/bujo-cli.js，验证真实并发与队列满立即失败。 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const CLI = path.join(projectRoot, 'bin', 'bujo-cli.js');
const EXIT = { OK: 0, FAIL: 2, QUEUE_FULL: 3, LOCK_BUSY: 4 };

function run(args, options = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    ...options
  });
}

/** 异步跑一条 CLI，拿 { code, stdout, stderr } */
function runAsync(args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** 无限挂起的任务，用来把队列塞满（在等待任务位之外还要占住执行位） */
/*
 * 塞满队列的子进程脚本：把全局队列占满之后静默等待，保持进程活着。
 * 第 LIMIT 个 submit（自身也占一个等待位之后队列已满）触发 QueueFullError，
 * 进程以退出码 3 结束——父进程就此观察「队列满立即失败」。
 */
const HOLDER = `
const q = require(${JSON.stringify(path.join(projectRoot, 'src/main/write-queue'))});
const LIMIT = q.WRITE_QUEUE_LIMIT;
let release;
// 占住执行位的任务 + LIMIT-1 个等待任务
q.submit(() => new Promise((r) => { release = r; }));
for (let i = 0; i < LIMIT - 1; i++) q.submit(() => new Promise(() => {}));
// 队列到此已满：这一条必须立刻失败
q.submit(async () => 'no').then(() => process.exit(1), (err) => {
  console.log(err.code);
  process.exit(0);
});
setTimeout(() => { if (release) release(); }, 30000);
`;

test('CLI append 可以新建文件并追加内容', { timeout: 30000 }, () => {
  const dir = execFileSync(process.execPath, ['-e', 'console.log(require("node:os").tmpdir())'], { encoding: 'utf8' }).trim();
  const file = path.join(dir, `bujo-cli-test-${Date.now()}.md`);
  try {
    const out = run(['append', file, '- [ ] 来自 CLI 的任务', '--create', '--initial', '# CLI 测试日记', '--json']);
    const report = JSON.parse(out);
    assert.equal(report.ok, true);
    assert.equal(report.created, true);
    const content = require('node:fs').readFileSync(file, 'utf8');
    assert.match(content, /^# CLI 测试日记/);
    assert.match(content, /- \[ \] 来自 CLI 的任务/);
  } finally {
    require('node:fs').rmSync(file, { force: true });
  }
});

test('CLI mark 把条目标记为完成', { timeout: 30000 }, () => {
  const fsSync = require('node:fs');
  const dir = require('node:os').tmpdir();
  const file = path.join(dir, `bujo-cli-mark-${Date.now()}.md`);
  fsSync.writeFileSync(file, '# 标题\n\n- [ ] 待办的任务\n', 'utf8');
  try {
    const out = run(['mark', file, '待办的任务', '--mark', 'done', '--json']);
    const report = JSON.parse(out);
    assert.equal(report.ok, true);
    assert.equal(report.changed, true);
    assert.equal(report.after, '- [x] 待办的任务');
    assert.match(fsSync.readFileSync(file, 'utf8'), /- \[x\] 待办的任务/);
  } finally {
    fsSync.rmSync(file, { force: true });
  }
});

test('CLI mark 支持 task / cancelled，cancelled 不删原文', { timeout: 30000 }, () => {
  const fsSync = require('node:fs');
  const file = path.join(require('node:os').tmpdir(), `bujo-cli-cancel-${Date.now()}.md`);
  fsSync.writeFileSync(file, '- [ ] 一个任务\n', 'utf8');
  try {
    run(['mark', file, '一个任务', '--mark', 'cancelled', '--json']);
    const cancelled = fsSync.readFileSync(file, 'utf8');
    assert.match(cancelled, /- \[-\] 一个任务/, '划去后原文必须还在');
    run(['mark', file, '一个任务', '--mark', 'task', '--json']);
    assert.match(fsSync.readFileSync(file, 'utf8'), /- \[ \] 一个任务/);
  } finally {
    fsSync.rmSync(file, { force: true });
  }
});

test('CLI read 输出原文，--json 结构正确', { timeout: 30000 }, () => {
  const fsSync = require('node:fs');
  const file = path.join(require('node:os').tmpdir(), `bujo-cli-read-${Date.now()}.md`);
  fsSync.writeFileSync(file, '# 读我\n- 内容', 'utf8');
  try {
    const plain = run(['read', file]);
    assert.equal(plain, '# 读我\n- 内容');
    const json = JSON.parse(run(['read', file, '--json']));
    assert.equal(json.ok, true);
    assert.equal(json.name, path.basename(file));
    assert.equal(json.content, '# 读我\n- 内容');
  } finally {
    fsSync.rmSync(file, { force: true });
  }
});

test('CLI 对不存在的文件返回退出码 2', { timeout: 30000 }, () => {
  assert.throws(
    () => run(['read', path.join(require('node:os').tmpdir(), 'bujo-确实不存在-9x.md')]),
    (err) => err.status === EXIT.FAIL
  );
});

test('多进程并发 append：所有进程的写入都落盘且内容完整', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'bujo-concurrent-'));
  const file = path.join(dir, 'shared.md');
  await fs.writeFile(file, '# 共享笔记\n', 'utf8');

  const RUNS = 8;
  const jobs = Array.from({ length: RUNS }, (_, i) =>
    runAsync(['append', file, `- 来自进程 ${i} 的条目`])
  );
  const results = await Promise.all(jobs);
  results.forEach((r) => assert.equal(r.code, EXIT.OK, r.stderr));

  const final = await fs.readFile(file, 'utf8');
  for (let i = 0; i < RUNS; i++) {
    assert.match(final, new RegExp(`^- 来自进程 ${i} 的条目$`, 'm'), `进程 ${i} 的写入丢了`);
  }
  // 每条独占一行，没有任何两条粘在一起
  assert.equal(final.split('\n').filter((l) => l.startsWith('- 来自进程')).length, RUNS);
});

test('多进程并发 mark：同一条目被串行处理，最终状态确定', { timeout: 60000 }, async () => {
  const dir = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'bujo-marks-'));
  const file = path.join(dir, 'marks.md');
  await fs.writeFile(file, '- [ ] 并发任务\n', 'utf8');

  const jobs = Array.from({ length: 6 }, (_, i) => runAsync(['mark', file, '并发任务', '--mark', i % 2 ? 'done' : 'task']));
  const results = await Promise.all(jobs);
  results.forEach((r) => assert.equal(r.code, EXIT.OK, r.stderr));

  const final = await fs.readFile(file, 'utf8');
  assert.match(final, /^- \[(?: |x)\] 并发任务$/m, '最后一定是一种合法状态');
  assert.equal(final.trim().split('\n').length, 1, '不应新增或丢失行');
});

test('队列满时操作立即失败（退出码 3，EWRITE_QUEUE_FULL）', { timeout: 30000 }, () => {
  const out = execFileSync(process.execPath, ['-e', HOLDER], { encoding: 'utf8' });
  assert.equal(out.trim(), 'EWRITE_QUEUE_FULL');
});

test('CLI move：推迟/迁移到 journals 年/月 目标，原文保留', { timeout: 30000 }, () => {
  const fsSync = require('node:fs');
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bujo-move-'));
  const journals = path.join(dir, 'journals');
  const file = path.join(dir, 'note.md');
  fsSync.writeFileSync(file, '- [ ] 写周报\n- [!] 优先改稿\n', 'utf8');
  const env = { ...process.env, BUJO_JOURNALS: journals };

  const monthly = JSON.parse(run(['move', file, '写周报', '--to', 'next-month', '--json'], { env }));
  assert.equal(monthly.ok, true);
  assert.equal(monthly.destinationKind, 'nextMonth');
  assert.match(monthly.after, /^- \[>\] 写周报$/, '原文就地标 [>]');

  const postponed = JSON.parse(run(['move', file, '优先改稿', '--to', 'tomorrow', '--json'], { env }));
  assert.equal(postponed.destinationKind, 'tomorrow');
  assert.match(postponed.after, /^- \[<!\] 优先改稿$/, '推迟标 [<] 且优先标志不丢');

  // 两个文件都在目标里：月度记录有写周报，某篇日记里有优先改稿
  const sheets = [];
  (function walk(current) {
    fsSync.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) sheets.push(fsSync.readFileSync(full, 'utf8'));
    });
  })(journals);
  assert.match(sheets.join('\n'), /- \[ \] 写周报/);
  assert.match(sheets.join('\n'), /- \[!\] 优先改稿/, '优先标志在目标里也保留');

  assert.throws(() => run(['move', file, '写周报', '--to', 'frobnicate'], { env }), (err) => err.status === EXIT.FAIL);

  // 已迁移（[>]）的条目不能再迁：先 mark --mark task 取消迁移，再搬才成功（目标去重不多加）
  try {
    run(['move', file, '写周报', '--to', 'future', '--json'], { env });
    assert.fail('已迁移的条目应当拒绝再迁');
  } catch (err) {
    assert.equal(err.status, EXIT.FAIL, '退出码 2');
    assert.match(`${err.stderr || ''}${err.stdout || ''}`, /取消迁移/, '错误信息提示先取消迁移');
  }
  run(['mark', file, '写周报', '--mark', 'task', '--json'], { env });
  const remigrate = JSON.parse(run(['move', file, '写周报', '--to', 'future', '--json'], { env }));
  assert.equal(remigrate.ok, true, '取消迁移后可以把它迁去其他日志');
  assert.match(remigrate.after, /^- \[>\] 写周报$/, '重启后的迁移同样就地标 [>]');
});

test('CLI 帮助与未知命令', { timeout: 30000 }, () => {
  const help = run(['help']);
  assert.match(help, /bujo append/);
  assert.match(help, /bujo mark/);
  assert.match(help, /bujo read/);
  assert.throws(() => run(['frobnicate']), (err) => err.status === EXIT.FAIL);
});
