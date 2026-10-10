'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { parseBulletLine, parseDocument, countStats } = require('../src/shared/bullet-parser.js');

test('识别 Markdown 复选框为对应的子弹类型', () => {
  assert.equal(parseBulletLine('- [ ] 写周报').kind, 'task');
  assert.equal(parseBulletLine('- [x] 写完周报').kind, 'done');
  assert.equal(parseBulletLine('- [X] 大写也算完成').kind, 'done');
  assert.equal(parseBulletLine('- [>] 迁移').kind, 'migrated');
  assert.equal(parseBulletLine('- [<] 计划').kind, 'scheduled');
  assert.equal(parseBulletLine('- [!] 优先').kind, 'priority');
  // 划去：条目还在，只是划掉（不是删除）
  assert.equal(parseBulletLine('- [-] 不做了').kind, 'cancelled');
  assert.equal(parseBulletLine('- [-] 不做了').text, '不做了', '正文照旧能读出来');
});

test('每个条目都带上它在源文件里的行号（界面靠它写回正确的那一行）', () => {
  const source = ['# 标题', '', '- [ ] 一', '随便一句', '- [x] 二', '- [-] 三'].join('\n');
  const { blocks } = parseDocument(source);
  const items = blocks.filter((b) => b.type === 'bullets').flatMap((b) => b.items);

  assert.deepEqual(
    items.map((item) => ({ line: item.line, text: item.text })),
    [
      { line: 2, text: '一' },
      { line: 4, text: '二' },
      { line: 5, text: '三' }
    ]
  );
});

test('划去计入统计，但不影响完成进度', () => {
  const { stats } = parseDocument(['- [ ] 一', '- [x] 二', '- [-] 三'].join('\n'));
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.total, 3);
  assert.equal(stats.progress, 50, '进度只看待办与完成');
});

test('普通列表项是笔记，原生符号是任务与事件', () => {
  assert.equal(parseBulletLine('- 随手记一句').kind, 'note');
  assert.equal(parseBulletLine('* 星号列表也算笔记').kind, 'note');
  assert.equal(parseBulletLine('• 原生任务').kind, 'task');
  assert.equal(parseBulletLine('o 下午三点评审').kind, 'event');
});

test('不会把普通文字误判成子弹', () => {
  assert.equal(parseBulletLine('on Monday we ship'), null, 'on 不是事件');
  assert.equal(parseBulletLine('oo 双字母开头不是事件'), null);
  assert.equal(parseBulletLine('## 标题'), null);
  assert.equal(parseBulletLine(''), null);
  assert.equal(parseBulletLine('#comment 不是列表'), null);
});

test('保留缩进层级与正文', () => {
  const item = parseBulletLine('    - [ ] 子任务');
  assert.equal(item.indent, 4);
  assert.equal(item.text, '子任务');

  const tabbed = parseBulletLine('\t- [ ] 制表符缩进');
  assert.equal(tabbed.indent, 4);

  const symbol = parseBulletLine('  o 带缩进的事件');
  assert.equal(symbol.kind, 'event');
  assert.equal(symbol.indent, 2);
});

test('分组：连续子弹合成一个块，空行切分', () => {
  const { blocks } = parseDocument(['# 标题', '', '- [ ] 一', '- [x] 二', '', '正文段落', '- 三'].join('\n'));
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['markdown', 'bullets', 'markdown', 'bullets']
  );
  assert.equal(blocks[1].items.length, 2);
  assert.equal(blocks[3].items[0].kind, 'note');
});

test('代码围栏内的内容不会被当成子弹', () => {
  const source = ['```text', '- [ ] 这不是任务', 'o 这不是事件', '```', '- [ ] 这才是任务'].join('\n');
  const { blocks, stats } = parseDocument(source);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, 'markdown');
  assert.match(blocks[0].text, /- \[ \] 这不是任务/);
  assert.equal(blocks[1].type, 'bullets');
  assert.equal(stats.task, 1);
});

test('统计包含进度百分比', () => {
  const { stats } = parseDocument(['- [ ] 一', '- [ ] 二', '- [x] 三', '- [x] 四', '- 笔记', 'o 事件'].join('\n'));
  assert.equal(stats.task, 2);
  assert.equal(stats.done, 2);
  assert.equal(stats.note, 1);
  assert.equal(stats.event, 1);
  assert.equal(stats.total, 6);
  assert.equal(stats.progress, 50);
  assert.equal(countStats([]).progress, 0, '没有任务时进度为 0');
});

test('统一换行符，兼容 Windows 与 CRLF 文件', () => {
  const { blocks } = parseDocument('- [ ] 一\r\n- [x] 二\r\n');
  assert.equal(blocks[0].items.length, 2);
  assert.equal(blocks[0].items[0].text, '一');
});

test('真实示例文件能解析出各类子弹', () => {
  const file = path.join(__dirname, '..', 'samples', 'Bullet-Journal.md');
  const { blocks, stats } = parseDocument(fs.readFileSync(file, 'utf8'));

  assert.ok(blocks.some((b) => b.type === 'markdown' && b.text.includes('# 2026 年 10 月')), '标题被保留为 markdown 块');
  const items = blocks.filter((b) => b.type === 'bullets').flatMap((b) => b.items);
  const kinds = new Set(items.map((i) => i.kind));
  ['task', 'done', 'cancelled', 'migrated', 'scheduled', 'priority', 'note', 'event'].forEach((kind) => {
    assert.ok(kinds.has(kind), `示例文件缺少 ${kind} 类型`);
  });
  assert.equal(items.filter((i) => i.text.includes('代码块里的减号')).length, 0, '示例里的代码块不应产生子弹');
  assert.ok(stats.task > 0 && stats.done > 0);
});
