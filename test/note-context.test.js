'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildNoteContext, DEFAULT_MAX_CHARS } = require('../src/shared/note-context.js');

const NOTE = '# 2026-10-09 星期四\n\n## 任务\n\n- [ ] 写周报\n- 整理收件箱';

test('整篇笔记包在 <note> 里，带上文件名，内容原样保留', () => {
  const context = buildNoteContext({ name: '2026-10-09.md', content: NOTE });

  assert.equal(context.included, true);
  assert.equal(context.truncated, false);
  assert.equal(context.chars, NOTE.length);
  assert.ok(context.text.startsWith('<note file="2026-10-09.md">'));
  assert.ok(context.text.endsWith('</note>'));
  assert.ok(context.text.includes('- [ ] 写周报'));
  assert.ok(context.text.includes('- 整理收件箱'));
});

test('过长时首尾都留：开头保留结构，结尾保留最新条目，中间写明省略了多少字', () => {
  const head = '# 2026-10-09 星期四\n\n## 任务\n\n- [ ] 很早以前的任务';
  const middle = `\n${'中间的内容'.repeat(400)}\n`;
  const tail = '- [ ] 刚刚加的任务';
  const context = buildNoteContext({ name: '2026-10-09.md', content: `${head}${middle}${tail}`, maxChars: 600, headChars: 200 });

  assert.equal(context.included, true);
  assert.equal(context.truncated, true);
  assert.ok(context.text.includes('# 2026-10-09 星期四'), '开头保留');
  assert.ok(context.text.includes('- [ ] 刚刚加的任务'), '结尾（最新条目）保留');
  assert.match(context.text, /…（中间省略 \d+ 字）…/);
  assert.ok(context.chars <= 600, `截断后的正文不能超过上限，实际 ${context.chars}`);
  assert.equal(context.total, `${head}${middle}${tail}`.length);
});

test('空笔记不附带：明确说清原因，而不是发一个空标签', () => {
  for (const content of ['', '   \n\n  ', undefined, null]) {
    const context = buildNoteContext({ name: 'x.md', content });
    assert.equal(context.included, false);
    assert.equal(context.text, '');
    assert.equal(context.reason, '笔记还是空的');
  }
});

test('CRLF 会统一成 LF，文件名里的引号会被转义（不让模型看到半个标签）', () => {
  const context = buildNoteContext({ name: 'a"b.md', content: '- 一\r\n- 二' });
  assert.ok(!context.text.includes('\r'));
  assert.ok(context.text.includes('file="a&quot;b.md"'));
  assert.ok(!context.text.includes('- 一\n\n'), '没有多余空行');
});

test('默认上限是一个有界的数字（请求不会被一篇长笔记撑爆）', () => {
  assert.ok(DEFAULT_MAX_CHARS >= 1000 && DEFAULT_MAX_CHARS <= 8000);
  const long = '- 一条'.repeat(3000);
  const context = buildNoteContext({ name: 'long.md', content: long });
  assert.equal(context.truncated, true);
  assert.ok(context.chars <= DEFAULT_MAX_CHARS);
  assert.ok(context.text.length < long.length);
});
