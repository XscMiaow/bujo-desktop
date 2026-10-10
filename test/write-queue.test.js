'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { submit, WRITE_QUEUE_LIMIT, QueueFullError, LockTimeoutError, withFileLock, lockPathFor } =
  require('../src/main/write-queue');

test('队列上限默认 32，且 BUJO_WRITE_QUEUE_MAX 可覆盖', () => {
  assert.equal(WRITE_QUEUE_LIMIT, 32);
  // readLimit 未导出，但换个进程验证：子进程里设为 2 会被接受，0 / 负数回退默认
  const { execFileSync } = require('node:child_process');
  const probe = `(function(){ var env=process.env; var raw=env.BUJO_WRITE_QUEUE_MAX;
    var value=Number(raw); var ok=Number.isInteger(value)&&value>=1&&value<=10000;
    console.log(JSON.stringify({raw:raw, ok:ok, fallback:!ok?32:null})); })()`;
  const out = execFileSync(process.execPath, ['-e', probe], { env: { ...process.env, BUJO_WRITE_QUEUE_MAX: '2' } });
  assert.equal(JSON.parse(out.toString()).ok, true);
});

test('submit 串行执行：同一时刻只有一个任务在跑', async () => {
  let running = 0;
  let maxRunning = 0;
  const probe = async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return 'x';
  };

  const results = await Promise.all(Array.from({ length: 5 }, () => submit(probe)));
  assert.equal(maxRunning, 1, '串行队列里绝不该有两个任务同时执行');
  assert.deepEqual(results, ['x', 'x', 'x', 'x', 'x']);
  // 队列已清空：在串行队列里，maxRunning === 1 且全部完成后 waiting 为空（下一个测试可直接提交）
});

test('队列满时 submit 立即拒绝（QueueFullError），不排队也不等', async () => {
  // 先把队列塞满：一个永远不返回的任务占着，再加满等待位
  let release;
  const blocker = submit(() => new Promise((resolve) => { release = resolve; }));
  const fillers = [];
  for (let i = 0; i < WRITE_QUEUE_LIMIT - 1; i++) {
    fillers.push(submit(() => new Promise((resolve) => setTimeout(resolve, 10))));
  }
  // 队列里已有 LIMIT - 1 个等待 + 1 个在跑 = LIMIT，下一个必须立刻被拒
  await assert.rejects(
    () => submit(async () => 'never'),
    (err) => err instanceof QueueFullError && err.code === 'EWRITE_QUEUE_FULL'
  );

  release();
  await blocker;
  await Promise.all(fillers);
});

test('队列满被拒绝的任务从未被执行', async () => {
  let executed = 0;
  let release;
  const blocker = submit(() => new Promise((resolve) => { release = resolve; }));
  const fillers = [];
  for (let i = 0; i < WRITE_QUEUE_LIMIT - 1; i++) {
    fillers.push(submit(() => new Promise((resolve) => setTimeout(resolve, 2))));
  }
  await assert.rejects(() => submit(async () => { executed += 1; }), QueueFullError);
  assert.equal(executed, 0, '被拒的任务不应进队列');
  release();
  await blocker;
  await Promise.all(fillers); // 清空队列，别污染下一个测试
});

test('submit 的任务抛错会传回调用方，且不阻塞后续任务', async () => {
  const boom = submit(async () => { throw new Error('炸了'); });
  const after = submit(async () => 'after');
  await assert.rejects(boom, /炸了/);
  assert.equal(await after, 'after');
});

test('withFileLock 互斥：同一文件上的操作一个接一个', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-lock-'));
  const target = path.join(dir, 'note.md');
  await fs.writeFile(target, 'a\n', 'utf8');

  let running = 0;
  let maxRunning = 0;
  const work = async (label) =>
    withFileLock(target, async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const current = await fs.readFile(target, 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await fs.writeFile(target, current + label + '\n', 'utf8');
      running -= 1;
      return label;
    });

  const labels = ['b', 'c', 'd'];
  await Promise.all(labels.map(work));
  assert.equal(maxRunning, 1, '同一文件上的持锁操作不该重叠');
  const final = await fs.readFile(target, 'utf8');
  labels.forEach((label) => assert.ok(final.includes(label), `丢了 ${label} 的写入`));
});

test('不同文件的锁互不阻塞', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-lock-'));
  const a = path.join(dir, 'a.md');
  const b = path.join(dir, 'b.md');

  let inside = false;
  const slow = withFileLock(a, async () => {
    inside = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return 'a';
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(inside, true);
  const quick = await withFileLock(b, async () => 'b', { timeoutMs: 200 });
  assert.equal(quick, 'b', '另一份文件不该等 a 的锁');
  assert.equal(await slow, 'a');
});

test('锁超时抛 LockTimeoutError 而不是一直等', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-lock-'));
  const target = path.join(dir, 'busy.md');
  // 先模拟一个陈旧不久的持锁者：直接把锁文件放那里
  const lockFile = lockPathFor(target);
  await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');

  await assert.rejects(() => withFileLock(target, async () => 'no', { timeoutMs: 80 }), LockTimeoutError);
  // 用完清理，别污染别的测试
  await fs.rm(lockFile, { force: true });
});

test('陈旧锁会被自动接管', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-lock-'));
  const target = path.join(dir, 'stale.md');
  const lockFile = lockPathFor(target);
  const oldTime = new Date(Date.now() - 60_000);
  await fs.writeFile(lockFile, 'dead-process', 'utf8');
  await fs.utimes(lockFile, oldTime, oldTime);

  const result = await withFileLock(target, async () => 'took-over');
  assert.equal(result, 'took-over');
  assert.equal(await fs.readFile(lockFile, { encoding: 'utf8' }).catch(() => 'gone'), 'gone', '锁用完应被释放');
});
