'use strict';

/**
 * 笔记写入的有界串行队列（应用与 CLI 共用一套机制）。
 *
 * - 串行：队列里一次只执行一个写操作，前后任务绝不并发。
 * - 有界：等待中的任务数达到上限（环境变量 BUJO_WRITE_QUEUE_MAX，默认 32）时，
 *   submit() 不排队、不等待，立即抛出 QueueFullError——调用方应马上把「队列满」
 *   报告给用户或对端，而不是把请求无限囤积起来。
 * - 跨进程：应用窗口与 CLI、以及多个 CLI 进程可能同时写同一份笔记，
 *   这里提供系统临时目录下的 .lock 文件锁（wxCreate 互斥 + 陈旧锁自动接管 + Windows 删除挂起重试），
 *   同一个文件上的读改写永远整体串行；不同文件互相不等待。
 *
 * 纯 Node 实现，不依赖 Electron，CLI 直接 require 复用。
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

/** 队列上限：等待中的任务达到这个数就立刻拒绝新任务 */
const WRITE_QUEUE_LIMIT = readLimit(process.env.BUJO_WRITE_QUEUE_MAX);

function readLimit(raw) {
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1 && value <= 10_000) return value;
  return 32;
}

/** 队列满时抛出的错误：调用方据此立即返回「操作失败」 */
class QueueFullError extends Error {
  constructor(message = '写入队列已满，操作未被接受') {
    super(message);
    this.name = 'QueueFullError';
    this.code = 'EWRITE_QUEUE_FULL';
  }
}

/** 等文件锁超时：可能有另一个进程正在写这个文件 */
class LockTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LockTimeoutError';
    this.code = 'EWRITE_LOCK_BUSY';
  }
}

let active = 0; // 正在执行的任务数：串行队列里只会是 0 或 1
const waiting = []; // 排队中的任务

/**
 * 把一个写操作提交进队列，串行执行。
 * 队列满时立即抛出/拒绝 QueueFullError，不会入队。
 *
 * @param {() => Promise<any>} task
 */
function submit(task) {
  if (typeof task !== 'function') return Promise.reject(new Error('队列任务是函数'));
  if (active + waiting.length >= WRITE_QUEUE_LIMIT) {
    return Promise.reject(new QueueFullError(`写入队列已满（上限 ${WRITE_QUEUE_LIMIT} 个任务），本操作未执行`));
  }

  return new Promise((resolve, reject) => {
    waiting.push(async () => {
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      }
    });
    void pump();
  });
}

/** 依次取任务执行；同一时刻只有一个任务在跑 */
async function pump() {
  while (waiting.length && active === 0) {
    active = 1;
    const task = waiting.shift();
    if (task) await task();
    active = 0;
  }
}

/* ---------------- 跨进程文件锁 ---------------- */

const LOCK_STALE_MS = 30_000; // 锁超过这么久没人动，视为持有进程已挂，直接接管
const LOCK_RETRY_MS = 25; // 抢锁失败后的重试间隔（会加随机抖动防踩踏）

function lockPathFor(filePath) {
  // 锁文件放系统临时目录，不污染笔记目录；按路径哈希命名，跨进程、跨工作目录一致
  const hash = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `bujo-write-${hash}.lock`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在一把按文件名生成的跨进程锁里执行 fn。
 * 同一文件（按绝对路径）在所有进程之间串行；不同文件各用各的锁，互不阻塞。
 *
 * @param {string} filePath
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withFileLock(filePath, fn, options = {}) {
  const target = path.resolve(String(filePath || ''));
  const lockFile = lockPathFor(target);
  const timeoutMs = readTimeout(options.timeoutMs ?? process.env.BUJO_WRITE_LOCK_TIMEOUT);
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx');
      await handle.write(JSON.stringify({ pid: process.pid, at: Date.now() }), null, 'utf8');
      await handle.close();
      break; // 拿到锁了
    } catch (err) {
      // EEXIST：别人持锁。Windows 上刚被 rm 的锁文件可能短暂处于删除挂起态，
      // 此时 wx 的 open 会报 EPERM——同样是「抢不到，过会儿再试」，不是致命错误。
      if (err && err.code !== 'EEXIST' && err.code !== 'EPERM') {
        throw new Error(`无法创建锁文件：${err.message}`);
      }
      // 别人持锁：看看是不是陈旧的（持有进程没了），否则稍等重试
      let stale = false;
      try {
        if (err && err.code === 'EPERM') {
          stale = false; // 删除挂起中：别去 rm（也会 EPERM），直接等下一圈
        } else {
          const stat = await fs.stat(lockFile);
          if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) stale = true;
        }
      } catch {
        stale = err && err.code === 'EPERM' ? false : true; // 刚刚被释放，下一圈重试马上就能抢到
      }
      if (stale) {
        try { await fs.rm(lockFile, { force: true }); } catch { /* 下一圈再试 */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(`等待「${path.basename(target)}」的写锁超时（${timeoutMs}ms），可能有另一个进程正在写`);
      }
      await sleep(LOCK_RETRY_MS + Math.floor(Math.random() * 25));
    }
  }

  try {
    return await fn();
  } finally {
    try { await fs.rm(lockFile, { force: true }); } catch { /* 无能为力：陈旧检查会兜底 */ }
  }
}

function readTimeout(raw) {
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0) return Math.min(value, 60_000);
  return 10_000;
}

module.exports = {
  submit,
  withFileLock,
  lockPathFor,
  QueueFullError,
  LockTimeoutError,
  WRITE_QUEUE_LIMIT
};
