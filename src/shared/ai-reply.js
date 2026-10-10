/**
 * AI 回答的三段式协议（浏览器与 Node 共用）。
 *
 * 模型被要求把一次回答拆成三段：
 *
 *   <chat>       给用户看的对话内容（解释、建议、追问）        </chat>
 *   <journal>    只写「新增」的子弹笔记条目                    </journal>
 *   <note-edit>  对**已有**条目的改动（改 / 完成 / 划去）      </note-edit>
 *
 * 只有后两段会动到笔记：聊天里的寒暄、解释、追问不会落进日记。
 * 另外，笔记原文会以 <note file="…">…</note> 的形式作为上下文发给模型，
 * 让它先看清已经记过什么，再决定要新增还是改动。
 *
 * 解析器是流式友好的：只收到一半（标签开了、没闭合）时，前面的段落已经稳定，
 * 后面那段按当前增量给出来。
 *
 * 容错：模型不写标签时，也认「【日记】」「日记块：」「## 日记」「笔记改动：」这类小标题。
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AiReply = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHAT_NAMES = 'chat|对话|聊天';
  const JOURNAL_NAMES = 'journal|日记块|日记|笔记块|notes?';
  const EDIT_NAMES = 'note-edit|noteedit|笔记改动|改动|编辑|修改';

  // 标签名清单：用来识别「流式收到一半」的标签碎片（`<note-ed` 这种）
  const ALL_NAMES = [
    'chat',
    '对话',
    '聊天',
    'journal',
    '日记块',
    '日记',
    '笔记块',
    'note',
    'notes',
    'note-edit',
    'noteedit',
    '笔记改动',
    '改动',
    '编辑',
    '修改'
  ];

  const BLOCKS = [
    { key: 'journal', names: JOURNAL_NAMES, headerKey: 'journal' },
    { key: 'edit', names: EDIT_NAMES, headerKey: 'edit' }
  ];

  function headerRegex(names) {
    return new RegExp(
      '^[ \\t]*(?:' +
        `#{1,6}[ \\t]*(?:\\*\\*)?(?:【[ \\t]*(?:${names})[ \\t]*】|(?:${names}))(?:[ \\t]*[:：])?[ \\t]*\\*{0,2}` +
        `|【[ \\t]*(?:${names})[ \\t]*】` +
        `|(?:${names})[ \\t]*[:：][ \\t]*\\*{0,2}` +
        ')[ \\t]*$',
      'im'
    );
  }

  const JOURNAL_HEADER = headerRegex(JOURNAL_NAMES);
  const EDIT_HEADER = headerRegex(EDIT_NAMES);

  /** 模型有时会把整段包在代码围栏里，这里剥掉最外层的围栏 */
  function stripWrapperFence(text) {
    const trimmed = text.trim();
    const match = /^(```[^\n]*\n)([\s\S]*?)\n?```$/.exec(trimmed);
    return match ? match[2] : trimmed;
  }

  function openTagRegex(names) {
    return new RegExp(`<\\s*(?:${names})\\s*>`, 'gi');
  }

  /**
   * 末尾那截「半个标签」：流式收到 `<jour` 时，别把它当成可见文本。
   * 只有真的是这个块认识的标签名前缀才算数（`</jour` 不能算成改动块的开始）。
   * @returns {{ index:number, length:number } | null}
   */
  function partialTagSuffix(text, names) {
    const match = /<(\/?[a-zA-Z\u4e00-\u9fa5-]{2,12})\s*$/.exec(text);
    if (!match) return null;
    const name = match[1].replace(/^\//, '');
    const known = names ? names.split('|') : ALL_NAMES;
    if (!known.some((candidate) => candidate.startsWith(name))) return null;
    return { index: match.index, length: match[0].length };
  }

  function headerOf(block) {
    return block.headerKey === 'edit' ? EDIT_HEADER : JOURNAL_HEADER;
  }

  /** 找某个块的开始标签（或末尾的半个标签），返回它之后的位置 */
  function findBlockOpen(source, from, block) {
    const re = openTagRegex(block.names);
    re.lastIndex = from;
    const match = re.exec(source);
    if (match) return { contentStart: match.index + match[0].length, cut: match.index };

    const partial = partialTagSuffix(source.slice(from), block.names);
    if (partial) return { contentStart: from + partial.length, cut: from + partial.index, partial: true };
    return null;
  }

  /**
   * 一个块的正文到哪里结束：结束标签、下一个块的开始标签（含半个）、
   * 以及（小标题写法时）下一个块的小标题，取最早出现的那个。
   */
  function findBlockEnd(source, from, block, others, useHeaders) {
    const closeRe = new RegExp(`<\\s*/\\s*(?:${block.names})\\s*>`, 'i');
    const close = closeRe.exec(source.slice(from));
    const closeAt = close ? from + close.index : -1;
    const closeLength = close ? close[0].length : 0;

    let stopAt = source.length;
    if (closeAt !== -1) stopAt = closeAt;

    const tail = source.slice(from);
    for (const other of others) {
      const open = openTagRegex(other.names);
      open.lastIndex = 0;
      const match = open.exec(tail);
      if (match && from + match.index < stopAt) stopAt = from + match.index;

      const partial = partialTagSuffix(tail, other.names);
      if (partial && from + partial.index < stopAt) stopAt = from + partial.index;

      if (useHeaders) {
        const header = headerOf(other).exec(tail);
        if (header && from + header.index < stopAt) stopAt = from + header.index;
      }
    }

    const ownPartial = partialTagSuffix(tail, block.names);
    if (ownPartial && from + ownPartial.index < stopAt) stopAt = from + ownPartial.index;

    const closed = closeAt !== -1 && stopAt === closeAt;
    return { bodyEnd: stopAt, cursor: closed ? closeAt + closeLength : stopAt, closed };
  }

  function stripChatTags(text) {
    return (
      text
        .replace(openTagRegex(CHAT_NAMES), '')
        .replace(/<\s*\/\s*(?:chat|对话|聊天)\s*>/gi, '')
        .replace(openTagRegex(JOURNAL_NAMES), '')
        .replace(/<\s*\/\s*(?:journal|日记块|日记|笔记块|notes?)\s*>/gi, '')
        .replace(openTagRegex(EDIT_NAMES), '')
        .replace(/<\s*\/\s*(?:note-edit|noteedit|笔记改动|改动|编辑|修改)\s*>/gi, '')
        // 流式过程中可能停在半个标签上（如「</chat」），别让碎片露进气泡
        .replace(/<[a-zA-Z\u4e00-\u9fa5/\s-]*$/, '')
    );
  }

  /**
   * 把一段（可能还没生成完的）回答拆成对话 / 新增条目 / 笔记改动。
   *
   * @param {string} text
   * @returns {{ chat: string, journal: string, edit: string, hasJournal: boolean, hasEdit: boolean, journalComplete: boolean, editComplete: boolean }}
   *   hasJournal / hasEdit      是否出现过对应的块（哪怕是空的）
   *   journalComplete / editComplete 该块是否已经结束（流式过程中显示「生成中」）
   */
  function splitReply(text) {
    const source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
    const parsed = {
      chat: '',
      journal: '',
      edit: '',
      hasJournal: false,
      hasEdit: false,
      journalComplete: false,
      editComplete: false
    };
    if (!source.trim()) return parsed;

    let chatRaw = '';
    let cursor = 0;

    for (let index = 0; index < BLOCKS.length; index++) {
      const block = BLOCKS[index];
      const others = BLOCKS.slice(index + 1);
      let open = findBlockOpen(source, cursor, block);
      let fromHeader = false;

      if (!open) {
        // 没有标签时试试小标题兜底（【日记】/ 笔记改动： / ## 日记）
        const header = (block.headerKey === 'edit' ? EDIT_HEADER : JOURNAL_HEADER).exec(source.slice(cursor));
        if (!header) continue;
        fromHeader = true;
        open = { contentStart: cursor + header.index + header[0].length, cut: cursor + header.index };
      }

      const flag = block.key === 'journal' ? 'hasJournal' : 'hasEdit';
      const doneFlag = block.key === 'journal' ? 'journalComplete' : 'editComplete';
      parsed[flag] = true;
      chatRaw += source.slice(cursor, open.cut);

      if (fromHeader) {
        // 小标题没有结束标签：正文一直到最后（或被下一个块的标签/小标题打断）
        const end = findBlockEnd(source, open.contentStart, block, others, true);
        parsed[block.key] = source.slice(open.contentStart, end.bodyEnd);
        parsed[doneFlag] = true;
        cursor = end.bodyEnd;
        continue;
      }

      const end = findBlockEnd(source, open.contentStart, block, others, false);
      parsed[block.key] = source.slice(open.contentStart, end.bodyEnd);
      parsed[doneFlag] = end.closed;
      cursor = end.cursor;

      // 没闭合（模型漏了结束标签，或被下一个块的标签截断）时，剩下的已经归到这一段里；
      // 继续下一轮：光标就停在被截断的位置，后面的块还能被认出来
    }

    chatRaw += source.slice(cursor);

    return {
      chat: stripChatTags(chatRaw).replace(/\n{3,}/g, '\n\n').trim(),
      journal: stripWrapperFence(parsed.journal).trim(),
      edit: stripWrapperFence(parsed.edit).trim(),
      hasJournal: parsed.hasJournal,
      hasEdit: parsed.hasEdit,
      journalComplete: parsed.journalComplete,
      editComplete: parsed.editComplete
    };
  }

  /**
   * 追加在用户的系统提示词后面，保证模型一定按协议回答。
   * 里面的符号就是 bullet-parser 与 note-edit 真正认识的写法，别改成别的符号。
   */
  const PROTOCOL_PROMPT = [
    '【参考笔记】',
    '请求里可能带着 <note file="文件名">…</note>，那是用户笔记的现有内容，先用它判断已经记过什么。',
    '同一件事不要重复记一条：已经存在的条目要改就写「笔记改动」，不要另加一条。',
    '零散的说法能并进同一条就并成一条，让每件事在笔记里只出现一次。',
    '',
    '【回答格式】',
    '每条回答分成三段，用下面的标签标出；标签前后不要加代码围栏、也不要另起别的标题：',
    '<chat>',
    '给用户看的对话内容：结论、解释、建议、追问，用完整的句子说清楚。',
    '</chat>',
    '<journal>',
    '只写要**新增**的子弹笔记条目，一行一条，用这些符号：',
    '- [ ] 待办事项',
    '- [x] 已完成的事',
    '- [-] 不再做的事（划去，原文保留）',
    '- [>] 要迁移到明天的事',
    '- [<] 需要提前安排的事',
    '- [!] 优先处理的事',
    '- 要点或想法',
    'o 发生的事件（会议、约定、时间点）',
    '不要写解释性长句，不要重复对话里已经说过的话；没有值得记录的内容时就留空写成 <journal></journal>。',
    '</journal>',
    '<note-edit>',
    '只写对**已有**条目的改动，一行一条，原文照抄笔记里的写法（应用会做模糊匹配）：',
    '改：已有条目的原文 => 改写后的完整条目',
    '完成：已有条目的原文',
    '划去：已有条目的原文（只划掉，不会删掉原文）',
    '没有要改的就留空写成 <note-edit></note-edit>。',
    '</note-edit>'
  ].join('\n');

  /**
   * 拼出发给模型的系统提示词。
   * 用户自己在设置里写了标签就不再追加，避免提示词重复。
   *
   * @param {string} [userPrompt]
   * @returns {string}
   */
  function buildSystemPrompt(userPrompt) {
    const base = typeof userPrompt === 'string' ? userPrompt.trim() : '';
    if (!base) return PROTOCOL_PROMPT;
    if (/<\s*(?:journal|note-edit)\s*>/i.test(base)) return base;
    return `${base}\n\n${PROTOCOL_PROMPT}`;
  }

  return {
    splitReply,
    buildSystemPrompt,
    stripWrapperFence,
    PROTOCOL_PROMPT,
    CHAT_NAMES,
    JOURNAL_NAMES,
    EDIT_NAMES,
    FORMAT_CONTEXT_PROMPT: PROTOCOL_PROMPT
  };
});
