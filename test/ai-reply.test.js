'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { splitReply, buildSystemPrompt, PROTOCOL_PROMPT } = require('../src/shared/ai-reply.js');

test('分段回答：对话与日记块各自分开，标签不进内容', () => {
  const reply = ['<chat>', '今天先把周报写完。', '要我列一下收件箱的清理步骤吗？', '</chat>', '<journal>', '## 今日重点', '- [ ] 先写周报', '- 再整理一下收件箱', '</journal>'].join('\n');
  const parsed = splitReply(reply);

  assert.equal(parsed.hasJournal, true);
  assert.equal(parsed.journalComplete, true);
  assert.equal(parsed.chat, '今天先把周报写完。\n要我列一下收件箱的清理步骤吗？');
  assert.equal(parsed.journal, '## 今日重点\n- [ ] 先写周报\n- 再整理一下收件箱');
  assert.ok(!parsed.chat.includes('先写周报'), '日记块的内容不能出现在对话里');
  assert.ok(!parsed.journal.includes('要我列'), '对话内容不能出现在日记块里');
});

test('流式增量：一路拼接的中间态始终分得清对话与日记块', () => {
  const reply = ['<chat>', '一句话解释。', '还想知道细节吗？', '</chat>', '<journal>', '- [ ] 交周报', '</journal>'].join('\n');
  let acc = '';
  const states = [];
  for (const ch of reply) {
    acc += ch;
    states.push(splitReply(acc));
  }

  assert.equal(states.at(-1).chat, '一句话解释。\n还想知道细节吗？');
  assert.equal(states.at(-1).journal, '- [ ] 交周报');
  // 任何中间态都不能把日记块的内容混进对话（气泡里不许出现任务文本）
  assert.ok(states.every((state) => !state.chat.includes('交周报')));
  // 半个标签也不能漏成可见文本
  assert.ok(states.every((state) => !/<\/?chat/.test(state.chat)));
  // 对话部分先稳定下来，之后不再变
  const settled = states.filter((state) => state.chat === '一句话解释。\n还想知道细节吗？');
  assert.ok(settled.length > 10, '对话部分在日记块开始前就已稳定');
  assert.equal(settled.at(-1).journalComplete, true);
});

test('日记块还没结束（没收到 </journal>）时，日记内容按当前增量给出', () => {
  const parsed = splitReply('<chat>\n好\n</chat>\n<journal>\n- [ ] 一');
  assert.equal(parsed.hasJournal, true);
  assert.equal(parsed.journalComplete, false);
  assert.equal(parsed.chat, '好');
  assert.equal(parsed.journal, '- [ ] 一');
});

test('模型把日记块包进代码围栏时能剥掉围栏', () => {
  const parsed = splitReply('<journal>\n```\n- [ ] 一\n```\n</journal>');
  assert.equal(parsed.journal, '- [ ] 一');
});

test('结束标签之后的补充文字归回对话，不会凭空丢掉', () => {
  const parsed = splitReply('<chat>\n先这样\n</chat>\n<journal>\n- [ ] 一\n</journal>\n还有别的想法？');
  assert.equal(parsed.chat, '先这样\n\n还有别的想法？');
  assert.equal(parsed.journal, '- [ ] 一');
});

test('没有日记块标记时：整段都是对话，日记块为空', () => {
  const parsed = splitReply('直接回答的一段话');
  assert.equal(parsed.hasJournal, false);
  assert.equal(parsed.journal, '');
  assert.equal(parsed.chat, '直接回答的一段话');
});

test('容错：模型用小标题代替标签时也认得出日记块', () => {
  assert.equal(splitReply('【日记】\n- [ ] 一').journal, '- [ ] 一');
  assert.equal(splitReply('先聊聊\n\n日记块：\n- 要点').journal, '- 要点');
  assert.equal(splitReply('先聊聊\n\n## 日记\n- 要点').journal, '- 要点');
  assert.equal(splitReply('先聊聊\n\n## 日记\n- 要点').chat, '先聊聊');
  assert.equal(splitReply('今天读了《日记的写法》这本书').journal, '', '正文里的词不当成小标题');
});

test('空回答与空日记块都不会炸', () => {
  const parsed = splitReply('<chat>\n\n</chat>\n<journal>\n</journal>');
  assert.equal(parsed.chat, '');
  assert.equal(parsed.journal, '');
  assert.equal(parsed.hasJournal, true, '明确给了空日记块：说明这轮没内容可记');
  assert.deepEqual(splitReply(''), {
    chat: '',
    journal: '',
    edit: '',
    hasJournal: false,
    hasEdit: false,
    journalComplete: false,
    editComplete: false
  });
});

test('三段式：新增条目与笔记改动各归各的，标签不进内容', () => {
  const reply = [
    '<chat>',
    '收件箱那条已经完成了，我顺手把它标上；再给你加一条新的。',
    '</chat>',
    '<journal>',
    '- [ ] 列一下收件箱的清理步骤',
    '</journal>',
    '<note-edit>',
    '完成：整理收件箱',
    '改：写周报 => 周五交周报',
    '</note-edit>'
  ].join('\n');
  const parsed = splitReply(reply);

  assert.equal(parsed.hasJournal, true);
  assert.equal(parsed.hasEdit, true);
  assert.equal(parsed.journalComplete, true);
  assert.equal(parsed.editComplete, true);
  assert.equal(parsed.journal, '- [ ] 列一下收件箱的清理步骤');
  assert.equal(parsed.edit, '完成：整理收件箱\n改：写周报 => 周五交周报');
  // 气泡里只剩对话：改动指令不能跑进对话，也不能跑进新增条目
  assert.ok(!parsed.chat.includes('完成：'));
  assert.ok(!parsed.journal.includes('完成：'));
  assert.ok(!/note-edit/.test(parsed.chat));
});

test('只有改动、没有新增时：journal 为空但不当作「没按协议回答」', () => {
  const parsed = splitReply('<chat>\n改好了\n</chat>\n<journal></journal>\n<note-edit>\n删：买牛奶\n</note-edit>');
  assert.equal(parsed.hasJournal, true);
  assert.equal(parsed.hasEdit, true);
  assert.equal(parsed.journal, '');
  assert.equal(parsed.edit, '删：买牛奶');
});

test('流式：改动块写到一半时，对话与新增条目已经稳定，半个标签不漏出去', () => {
  const reply = ['<chat>\n好了\n</chat>\n<journal>\n- [ ] 一\n</journal>\n<note-edit>\n完成：二\n</note-edit>'].join('\n');
  let acc = '';
  const states = [];
  for (const ch of reply) {
    acc += ch;
    states.push(splitReply(acc));
  }

  assert.ok(states.every((state) => !state.chat.includes('完成：')), '改动指令不会漏进气泡');
  assert.ok(states.every((state) => !state.journal.includes('完成：')), '也不会漏进新增条目');
  assert.equal(states.at(-1).edit, '完成：二');
  assert.equal(states.at(-1).editComplete, true);
  // 扣着半个 <note-edit 的那些中间态：还没结束，但对话已经稳定
  const mid = states.filter((state) => state.hasEdit && !state.editComplete);
  assert.ok(mid.length > 0, '确实经历过改动块未结束的中间态');
  assert.ok(mid.every((state) => state.chat === '好了'));
});

test('模型漏了 </journal> 直接写改动块：改动不会被当成新条目', () => {
  const parsed = splitReply('<chat>\n好\n</chat>\n<journal>\n- [ ] 一\n<note-edit>\n完成：二\n</note-edit>');

  assert.equal(parsed.journal, '- [ ] 一');
  assert.equal(parsed.edit, '完成：二');
  assert.equal(parsed.editComplete, true);
  assert.ok(!parsed.chat.includes('完成：'), '掉下来的内容不许跑进对话');
});

test('小标题写法也认得改动块（模型不写标签时的容错）', () => {
  const parsed = splitReply('先聊聊\n\n## 日记\n- [ ] 一\n\n笔记改动：\n完成：二');
  assert.equal(parsed.chat, '先聊聊');
  assert.equal(parsed.journal, '- [ ] 一');
  assert.equal(parsed.edit, '完成：二');
});

test('协议里教给模型的符号就是解析器真正认识的符号', () => {
  // 与 bullet-parser 的 KINDS 对应：待办 / 完成 / 迁移 / 计划 / 优先 / 笔记 / 事件
  for (const symbol of ['- [ ] ', '- [x] ', '- [>] ', '- [<] ', '- [!] ', '- ', 'o ']) {
    assert.ok(PROTOCOL_PROMPT.includes(symbol), `协议里缺少符号 ${symbol}`);
  }
  assert.match(PROTOCOL_PROMPT, /没有值得记录的内容/);
  assert.match(PROTOCOL_PROMPT, /不要重复对话/);
});

test('协议里写明了三段式标签、改动写法与参考笔记的规则', () => {
  for (const tag of ['<chat>', '</chat>', '<journal>', '</journal>', '<note-edit>', '</note-edit>']) {
    assert.ok(PROTOCOL_PROMPT.includes(tag), `协议里缺少标签 ${tag}`);
  }
  // 改动指令的三个写法必须与 note-edit 的解析规则一致
  assert.match(PROTOCOL_PROMPT, /改：.*=>/);
  assert.match(PROTOCOL_PROMPT, /完成：/);
  assert.match(PROTOCOL_PROMPT, /划去：.*不会删掉原文/);
  // 划去是补列出的新符号之一，得和 bullet-parser 的 [- ] 对应
  assert.ok(PROTOCOL_PROMPT.includes('- [-] '), '协议里要教模型写划去的条目');
  // 上下文与整合要求
  assert.match(PROTOCOL_PROMPT, /<note file=/);
  assert.match(PROTOCOL_PROMPT, /同一件事不要重复记一条/);
  assert.match(PROTOCOL_PROMPT, /已经存在的条目要改/);
});

test('系统提示词总会带上三段式协议，用户自己写了就不重复追加', () => {
  const built = buildSystemPrompt('你是笔记助手。');
  assert.ok(built.startsWith('你是笔记助手。'));
  assert.ok(built.includes('<journal>') && built.includes('</journal>'));
  assert.ok(built.includes('<note-edit>'));
  assert.ok(built.includes(PROTOCOL_PROMPT));

  for (const custom of ['你是助手，按 <journal> 格式回答。', '你是助手，用 <note-edit> 标改动。']) {
    assert.equal(buildSystemPrompt(custom), custom);
  }

  assert.equal(buildSystemPrompt(''), PROTOCOL_PROMPT);
  assert.equal(buildSystemPrompt(undefined), PROTOCOL_PROMPT);
});
