'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseEditBlock,
  integrate,
  normalizeForMatch,
  similarity,
  matchScore,
  asBulletLine,
  markDone
} = require('../src/shared/note-edit.js');
const { toBulletLines, toNoteHeader, toNoteLines } = require('../src/shared/chat-to-note.js');
const { parseDocument } = require('../src/shared/bullet-parser.js');

const NOTE = [
  '# 2026-10-09 星期四',
  '',
  '## 任务',
  '',
  '- [ ] 写周报',
  '- 整理收件箱',
  '',
  '## 笔记',
  '',
  '- 下午三点跟产品对预算'
].join('\n');

/* ---------------- 指令解析 ---------------- */

test('改动指令：改 / 完成 / 删 三种写法都认，模型加的列表符号会剥掉', () => {
  const { edits, ignored } = parseEditBlock(
    ['改：整理收件箱 => 整理收件箱和邮件', '- 完成：写周报', '* 删：下午三点跟产品对预算', '- [>] 改：写周报 => 周五交周报'].join('\n')
  );

  assert.equal(ignored.length, 0);
  assert.deepEqual(
    edits.map((edit) => ({ kind: edit.kind, target: edit.target, next: edit.next })),
    [
      { kind: 'replace', target: '整理收件箱', next: '整理收件箱和邮件' },
      { kind: 'done', target: '写周报', next: undefined },
      { kind: 'remove', target: '下午三点跟产品对预算', next: undefined },
      { kind: 'replace', target: '写周报', next: '周五交周报' }
    ]
  );
});

test('箭头与 ~ 写法一样认，看不懂的行进 ignored 而不是被当成改动', () => {
  const { edits, ignored } = parseEditBlock(['~ 写周报 → 周五交周报', '这行是解释，不是指令', '改成什么样呢？'].join('\n'));

  assert.deepEqual(edits, [{ kind: 'replace', target: '写周报', next: '周五交周报', raw: '~ 写周报 → 周五交周报' }]);
  assert.equal(ignored.length, 2);
});

test('代码块里的内容不会被当成指令', () => {
  const { edits, ignored } = parseEditBlock(['```', '改：a => b', '```', '改：写周报 => 周五交周报'].join('\n'));
  assert.equal(edits.length, 1);
  assert.equal(edits[0].target, '写周报');
  assert.equal(ignored.length, 1);
});

test('空改动块不会产生指令', () => {
  assert.deepEqual(parseEditBlock('').edits, []);
  assert.deepEqual(parseEditBlock('   \n\n').edits, []);
});

/* ---------------- 行匹配与归一化 ---------------- */

test('归一化：符号、复选框、标点、空格都不影响比对', () => {
  assert.equal(normalizeForMatch('- [ ] 整理收件箱'), normalizeForMatch('- 整理收件箱。'));
  assert.equal(normalizeForMatch('o 三点开会'), normalizeForMatch('- 三点开会'));
  assert.equal(normalizeForMatch('**写周报**'), '写周报');
});

test('相似度：相同为 1，包含关系单独加权，完全无关为 0', () => {
  assert.equal(similarity('写周报', '写周报'), 1);
  assert.ok(Math.abs(matchScore('先写周报', '写周报') - 0.8) < 1e-9, '短行不用包含关系硬凑');
  assert.ok(matchScore('整理收件箱和邮件', '整理收件箱') >= 0.92);
  assert.ok(similarity('写周报', '修水管') < 0.2);
});

test('改写目标会规范成子弹条目，保留原缩进', () => {
  assert.equal(asBulletLine('整理收件箱和邮件', ''), '- 整理收件箱和邮件');
  assert.equal(asBulletLine('* [x] 已完成', '    '), '    - [x] 已完成');
  assert.equal(asBulletLine('> 引用写法', ''), '- 引用写法');
  assert.equal(asBulletLine('   ', ''), '');
  assert.equal(markDone('- 整理收件箱'), '- [x] 整理收件箱');
  assert.equal(markDone('- [ ] 写周报'), '- [x] 写周报');
});

/* ---------------- 整合进已有笔记 ---------------- */

test('改动改的是已有那一行：另加一条不算数，其它内容原样保留', () => {
  const { edits } = parseEditBlock('改：整理收件箱 => 整理收件箱和邮件');
  const { text, report } = integrate(NOTE, { edits, header: '**AI 记录 · 14:32**', lines: [] });

  assert.equal(report.mode, 'edits');
  assert.equal(report.edits.applied.length, 1);
  assert.equal(report.edits.applied[0].how, '完全相同');
  assert.ok(text.includes('- 整理收件箱和邮件'));
  assert.ok(!text.includes('- 整理收件箱\n'), '旧写法被替换掉了');
  assert.ok(text.includes('- [ ] 写周报'), '没被指定的条目不动');
  assert.ok(text.startsWith('# 2026-10-09 星期四'));
  // 只有改动、没有新增时不该留下一个孤零零的时间戳
  assert.ok(!text.includes('**AI 记录'), '没有新增条目就不写时间戳（header 只在真的有新增时才用）');
});

test('完成指令：待办就地变已完成，普通笔记条目会被补上复选框', () => {
  const doneTask = integrate(NOTE, { edits: parseEditBlock('完成：写周报').edits, lines: [] });
  assert.ok(doneTask.text.includes('- [x] 写周报'));

  const doneNote = integrate(NOTE, { edits: parseEditBlock('完成：下午三点跟产品对预算').edits, lines: [] });
  assert.ok(doneNote.text.includes('- [x] 下午三点跟产品对预算'));

  // 结果仍然能被子弹笔记解析器读懂：就地把待办变成完成，不会多出一条
  const { stats } = parseDocument(doneTask.text);
  assert.equal(stats.done, 1);
  assert.equal(stats.task, 0, '不再留下重复的待办');
  assert.equal(stats.note, 2, '收件箱与笔记区那两条照旧');
});

test('删除指令：整行删掉，并收拾掉多余空行', () => {
  const { text, report } = integrate(NOTE, { edits: parseEditBlock('删：下午三点跟产品对预算').edits, lines: [] });
  assert.equal(report.edits.applied.length, 1);
  assert.ok(!text.includes('下午三点跟产品对预算'));
  assert.ok(!/\n{3,}/.test(text), '不留下连续空行');
  assert.ok(text.includes('## 笔记'));
});

test('找不到对应条目时明确报出来，绝不动别的行', () => {
  const { text, report } = integrate(NOTE, { edits: parseEditBlock('完成：买牛奶').edits, lines: [] });

  assert.equal(report.edits.applied.length, 0);
  assert.equal(report.edits.skipped.length, 1);
  assert.match(report.edits.skipped[0].reason, /没找到/);
  assert.equal(text, `${NOTE}\n`, '文本不变（只统一结尾换行）');
  assert.equal(report.changed, false);
});

test('不会拿相近但不是同一件的行乱改', () => {
  const { report } = integrate(NOTE, { edits: parseEditBlock('完成：整理房间').edits, lines: [] });
  assert.equal(report.edits.applied.length, 0);
  assert.equal(report.edits.skipped.length, 1);
});

test('新增条目与已有条目重复时不再写一遍，并在报告里说清楚跟哪一条重复', () => {
  const lines = toBulletLines('- 整理收件箱\n- [ ] 给客户回信');
  const { text, report } = integrate(NOTE, { header: toNoteHeader({ at: new Date(2026, 9, 9, 14, 32) }), lines });

  assert.deepEqual(report.added, ['- [ ] 给客户回信']);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].how, '完全相同');
  assert.match(report.duplicates[0].matched, /整理收件箱/);
  assert.equal((text.match(/整理收件箱/g) || []).length, 1, '整篇里只留一条');
  assert.ok(text.includes('**AI 记录 · 14:32**'));
});

test('同一件事只是状态变了：就地改状态，不新增一条', () => {
  const lines = toBulletLines('- [x] 写周报');
  const { text, report } = integrate(NOTE, { lines });

  assert.equal(report.merged.length, 1);
  assert.equal(report.added.length, 0);
  assert.ok(text.includes('- [x] 写周报'));
  assert.equal((text.match(/写周报/g) || []).length, 1);
});

test('不拿旧的待办盖掉已经完成的条目', () => {
  const done = NOTE.replace('- [ ] 写周报', '- [x] 写周报');
  const { report, text } = integrate(done, { lines: toBulletLines('- [ ] 写周报') });

  assert.equal(report.merged.length, 0);
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.added.length, 0);
  assert.equal((text.match(/写周报/g) || []).length, 1);
  assert.ok(text.includes('- [x] 写周报'), '完成状态没被退回');
});

test('同一批新增里自己重复的也只留一条', () => {
  const { report } = integrate('# 笔记\n', { lines: toBulletLines('- 买牛奶\n- 买牛奶') });
  assert.equal(report.added.length, 1);
  assert.equal(report.duplicates.length, 1);
});

test('改动与新增一起用（mixed）：改完已有条目再追加新条目', () => {
  const changes = {
    edit: '完成：整理收件箱',
    header: toNoteHeader({ at: new Date(2026, 9, 9, 14, 32) }),
    lines: toBulletLines('- [ ] 给客户回信\n- 整理收件箱')
  };
  const { text, report } = integrate(NOTE, {
    edits: parseEditBlock(changes.edit).edits,
    header: changes.header,
    lines: changes.lines,
    dedupe: true
  });

  assert.equal(report.mode, 'mixed');
  assert.ok(text.includes('- [x] 整理收件箱'));
  assert.equal(report.added.length, 1);
  assert.equal(report.duplicates.length, 1);
  assert.equal((text.match(/整理收件箱/g) || []).length, 1);
  assert.ok(text.indexOf('- [ ] 给客户回信') > text.indexOf('# 2026-10-09'), '新条目追加在末尾');
});

test('dedupe 关掉时只做去重的部分不做：全部照写', () => {
  const { report, text } = integrate(NOTE, { lines: toBulletLines('- 整理收件箱'), dedupe: false });
  assert.equal(report.duplicates.length, 0);
  assert.equal(report.added.length, 1);
  assert.equal((text.match(/整理收件箱/g) || []).length, 2);
});

test('标题不参与去重（它只是结构）', () => {
  const { report } = integrate(NOTE, { lines: ['## 笔记', '- 新想法'] });
  assert.equal(report.duplicates.length, 0);
  assert.deepEqual(report.added, ['## 笔记', '- 新想法']);
});

test('对空笔记：全部当作新增，且结果能被解析器读懂', () => {
  const { text, report } = integrate('', { header: '**AI 记录 · 09:05**', lines: toBulletLines('- [ ] 写周报\n- 要点') });

  assert.equal(report.added.length, 2);
  assert.equal(text.startsWith('**AI 记录 · 09:05**'), true);
  const { stats } = parseDocument(text);
  assert.equal(stats.task, 1);
  assert.equal(stats.note, 1);
});

test('整合过的笔记再整合一次不会重复写入（幂等）', () => {
  const changes = { edits: parseEditBlock('完成：写周报').edits, header: '**AI 记录 · 14:32**', lines: toBulletLines('- [ ] 给客户回信') };
  const first = integrate(NOTE, changes);
  assert.equal(first.report.changed, true);

  // 第二轮的输入换成上一轮的结果：同样三条指令都不该再产生改动
  const again = integrate(first.text, { edits: parseEditBlock('完成：写周报').edits, lines: toBulletLines('- [ ] 给客户回信') });
  assert.equal(again.report.added.length, 0, '已有条目不再重复追加');
  assert.equal(again.report.duplicates.length, 1);
  assert.equal(again.report.edits.applied.length, 0, '已经完成的不算「改了一处」');
  assert.equal(again.report.edits.unchanged.length, 1, '只报「已是最新」');
  assert.equal(again.report.changed, false, '整轮没有任何变化就不该落盘');
  assert.equal(again.text, first.text, '文本一字不变');
});

test('toNoteLines / toNoteHeader 各管一段：条目只来自日记块，时间戳与提问单独一行', () => {
  const lines = toNoteLines({ journal: '- [ ] 一', answer: '不该用到的兜底全文' });
  assert.deepEqual(lines, ['- [ ] 一']);
  assert.deepEqual(toNoteLines({ journal: '  ', answer: '- 兜底' }), ['- 兜底']);
  assert.equal(toNoteHeader({ question: '今天做什么？', at: new Date(2026, 9, 9, 8, 5) }), '**AI 记录 · 08:05**\n\n> 问：今天做什么？');
});
