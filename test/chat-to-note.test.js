'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toBulletLines, toBulletLine, toNoteBlock } = require('../src/shared/chat-to-note.js');
const { parseDocument } = require('../src/shared/bullet-parser.js');

test('各种列表写法都收敛成子弹笔记符号', () => {
  assert.equal(toBulletLine('- 普通短横线'), '- 普通短横线');
  assert.equal(toBulletLine('* 星号列表'), '- 星号列表');
  assert.equal(toBulletLine('• 圆点列表'), '- 圆点列表');
  assert.equal(toBulletLine('1. 有序列表'), '- 有序列表');
  assert.equal(toBulletLine('2) 另一种有序'), '- 另一种有序');
  assert.equal(toBulletLine('> 引用句'), '- 引用句');
  assert.equal(toBulletLine('一句话结论'), '- 一句话结论');
  assert.equal(toBulletLine('   缩进的句子'), '   - 缩进的句子', '缩进保留');
});

test('复选框状态原样保留，不会把已完成的任务丢掉', () => {
  assert.equal(toBulletLine('- [ ] 待办'), '- [ ] 待办');
  assert.equal(toBulletLine('- [x] 已完成'), '- [x] 已完成');
  assert.equal(toBulletLine('* [X] 大写完成'), '- [x] 大写完成');
  assert.equal(toBulletLine('- [>] 迁移'), '- [>] 迁移');
  assert.equal(toBulletLine('- [!] 优先'), '- [!] 优先');
});

test('去掉空行并保留标题', () => {
  const lines = toBulletLines('## 结论\n\n\n- 一\n\n- 二\n');
  assert.deepEqual(lines, ['## 结论', '- 一', '- 二']);
});

test('代码块内容原样保留', () => {
  const answer = ['先看这段：', '', '```js', 'const a = 1;', '- [ ] 这行是代码不是任务', '```', '', '完成'].join('\n');
  const lines = toBulletLines(answer);

  assert.deepEqual(lines, ['- 先看这段：', '```js', 'const a = 1;', '- [ ] 这行是代码不是任务', '```', '- 完成']);
  assert.ok(lines.includes('```js'), '围栏保留，让 Markdown 继续按代码块渲染');
});

test('转换结果本身能被子弹笔记解析器读懂', () => {
  const block = toNoteBlock({
    question: '今天该做什么？',
    answer: '## 建议\n- [ ] 先写周报\n- 顺手整理一下收件箱',
    at: new Date(2026, 9, 7, 14, 32)
  });

  assert.match(block, /\*\*AI 记录 · 14:32\*\*/);
  assert.match(block, /> 问：今天该做什么？/);

  const { stats } = parseDocument(block);
  assert.equal(stats.task, 1, '回答里的待办变成了真任务');
  assert.equal(stats.note, 1, '另一条是笔记条目');
  assert.equal(stats.total, 2);
});

test('问题只取第一行并截断，避免把整段对话塞进笔记', () => {
  const long = `第一行问题\n第二行\n${'很长的内容'.repeat(100)}`;
  const block = toNoteBlock({ question: long, answer: '好的', at: new Date(2026, 9, 7, 9, 5) });
  const quoted = block.split('\n').find((line) => line.startsWith('> 问：'));
  assert.ok(quoted.includes('第一行问题'));
  assert.ok(!quoted.includes('第二行'));
  assert.ok(quoted.length < 220);
});

test('没有问题时不会留下空的引用行', () => {
  const block = toNoteBlock({ answer: '- 一条', at: new Date(2026, 9, 7, 9, 5) });
  assert.equal(block, '**AI 记录 · 09:05**\n\n- 一条');
});

test('空回答只会得到时间戳标题，不会破坏笔记', () => {
  const block = toNoteBlock({ answer: '', at: new Date(2026, 9, 7, 9, 5) });
  assert.equal(block.trim(), '**AI 记录 · 09:05**');
});
