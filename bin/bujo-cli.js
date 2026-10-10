#!/usr/bin/env node
'use strict';

/**
 * 子弹笔记 CLI —— 其他 agent / 脚本操作笔记文档的入口。
 *
 * 与应用内置写操作共用同一套「有界串行写入队列」（src/main/write-queue.js）：
 *   - 同一份笔记上的操作按队列串行执行，绝不并发读改写；
 *   - 等待中的任务达到上限（BUJO_WRITE_QUEUE_MAX，默认 32）时，新操作
 *     不排队、立即失败退出（退出码 3，JSON 里 error.code = EWRITE_QUEUE_FULL）。
 *
 * 用法：
 *   node bin/bujo-cli.js append <file> "<markdown>" [--create] [--initial "<模板>"]
 *   node bin/bujo-cli.js mark   <file> "<条目正文>" [--line N] [--mark task|done|cancelled]   （默认 done）
 *   node bin/bujo-cli.js read   <file> [--json]
 *
 * 全局选项：--json   机器可读输出；退出码：0 成功，1 用法/参数错误，
 * 2 操作失败（文件不存在、找不到条目等），3 队列满（EWRITE_QUEUE_FULL），
 * 4 锁超时（EWRITE_LOCK_BUSY）。
 */

const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const { appendToNote, readNote, setBulletMark } = require(path.join(projectRoot, 'src/main/note-service'));
const { QueueFullError, LockTimeoutError } = require(path.join(projectRoot, 'src/main/write-queue'));

const USAGE = `用法：
  bujo append <file> "<markdown>" [--create] [--initial "<模板文本>"]
  bujo mark   <file> "<条目正文>" [--line N] [--mark task|done|cancelled]
  bujo read   <file> [--json]

说明：
  append  把一段 Markdown 追加到笔记末尾；--create 允许新建文件（配合 --initial 当初始内容）
  mark    改一条条目的状态：task=待办 [ ]、done=完成 [x]、cancelled=划去 [-]（原文保留，不真删）
          以条目正文定位；同一正文出现多次时会报错，可加 --line 指明行号
  read    输出笔记原文（--json 则输出 { ok, path, name, content }）

队列约定：所有写操作与应用内置写入口共用同一套有界串行队列；队列满时立即返回失败（退出码 3）。
全局选项：--json 输出 JSON。`;

function fail(code, message, json) {
  if (json) console.log(JSON.stringify({ ok: false, error: { code, message } }));
  else console.error(`错误：${message}`);
  process.exit(code);
}

/** 把 ' ' / 'x' / '-' 这类标记与 task/done/cancelled 互相认一下 */
function normalizeMark(raw) {
  const aliases = { task: ' ', ' ': ' ', todo: ' ', done: 'x', x: 'x', complete: 'x', cancelled: '-', '-': '-', cancel: '-', strikethrough: '-' };
  const key = String(raw == null ? 'done' : raw).trim().toLowerCase();
  if (!(key in aliases)) {
    throw new Error(`不支持的 mark：${raw}（可选：task / done / cancelled）`);
  }
  return aliases[key];
}

async function main(argv) {
  const args = argv.slice();
  const json = args.includes('--json');
  const rest = args.filter((item) => item !== '--json');
  const [command, ...operands] = rest;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }

  try {
    if (command === 'append' || command === 'mark' || command === 'read') {
      const file = operands[0];
      if (!file) fail(2, '缺少文件路径', json);
      return await dispatch({ command, file, operands: operands.slice(1), json });
    }
    fail(2, `未知命令「${command}」。${USAGE}`, json);
  } catch (err) {
    if (err instanceof QueueFullError) fail(3, err.message, json);
    if (err instanceof LockTimeoutError) fail(4, err.message, json);
    fail(2, err && err.message ? err.message : String(err), json);
  }
}

async function dispatch({ command, file, operands, json }) {
  const resolved = path.resolve(file);

  if (command === 'read') {
    const content = await readNote(resolved);
    if (json) console.log(JSON.stringify({ ok: true, path: resolved, name: path.basename(resolved), content }));
    else process.stdout.write(content);
    return 0;
  }

  if (command === 'append') {
    const markdown = operands[0];
    if (typeof markdown !== 'string' || !markdown.trim()) fail(2, '缺少要追加的内容', json);
    const flags = collectFlags(operands.slice(1));
    const result = await appendToNote(resolved, markdown, {
      createIfMissing: flags.has('--create'),
      initialContent: flags.get('--initial')
    });
    report({ ok: true, command, ...result }, json);
    return 0;
  }

  // mark
  const text = operands[0];
  if (typeof text !== 'string' || !text.trim()) fail(2, '缺少要标记的条目正文', json);
  const flags = collectFlags(operands.slice(1));
  const lineValue = Number(flags.get('--line'));
  let mark;
  try {
    mark = normalizeMark(flags.get('--mark'));
  } catch (err) {
    fail(2, err.message, json);
  }
  const result = await setBulletMark(resolved, {
    line: Number.isInteger(lineValue) && lineValue >= 0 ? lineValue : undefined,
    text,
    mark
  });
  report({ ok: true, command, ...result }, json);
  return 0;
}

/** 从参数里收出 --flag value / --flag，返回 Map */
function collectFlags(tokens) {
  const map = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('--')) {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        map.set(token, next);
        i++;
      } else {
        map.set(token, true);
      }
    }
  }
  return map;
}

function report(result, json) {
  if (json) console.log(JSON.stringify(result));
  else {
    const { ok, command, path: filePath, name, ...detail } = result;
    if (command === 'mark') {
      console.log(`${name}：${detail.changed ? '已更新' : '本来就是最新'} — ${detail.after}`);
    } else {
      console.log(`${name}：已追加 ${detail.created ? '（新建文件）' : ''}${detail.added} 个字符`);
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { main, normalizeMark, USAGE };
