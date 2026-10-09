/**
 * 把 AI 的**日记块**改写成「子弹笔记」条目（浏览器与 Node 共用）。
 *
 * 输入是回答里的 <journal> 段（见 ai-reply.js），不是整段对话——
 * 聊天里的解释与寒暄不会写进日记。
 *
 * 规则很简单：AI 爱用各种列表写法，统一收敛成子弹笔记的符号：
 *   - [ ] / [x] / [>] / [<] / [!]  原样保留（任务状态不能丢）
 *   - * + • 与 1. 2. 的列表       → -
 *   - 引用 > ...                  → -（子弹笔记里用笔记条目代替引用）
 *   - 代码围栏与标题              原样保留，交给 Markdown 渲染
 *   - 普通句子                    → - 句子
 *   空行会被去掉，让内容拼成一段紧凑的子弹列表。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChatToNote = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHECKBOX_RE = /^(\s*)[-*+]\s+\[([ xX><!*-])\]\s*(.*)$/;
  const BULLET_RE = /^(\s*)[-*+•·]\s+(.*)$/;
  const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;
  const QUOTE_RE = /^(\s*)>\s?(.*)$/;
  const HEADING_RE = /^\s{0,3}#{1,6}\s/;
  const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

  /** 一行 → 子弹笔记行；不是列表就当成笔记条目 */
  function toBulletLine(line) {
    const checkbox = CHECKBOX_RE.exec(line);
    if (checkbox) {
      const kind = checkbox[2] === 'X' ? 'x' : checkbox[2];
      return `${checkbox[1]}- [${kind}] ${checkbox[3].trim()}`.trimEnd();
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) return `${bullet[1]}- ${bullet[2].trim()}`.trimEnd();

    const ordered = ORDERED_RE.exec(line);
    if (ordered) return `${ordered[1]}- ${ordered[2].trim()}`.trimEnd();

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const text = quote[2].trim();
      return text ? `${quote[1]}- ${text}`.trimEnd() : '';
    }

    // 普通句子 / 缩进的续写：保留缩进，让层级关系不丢
    const indent = /^(\s*)/.exec(line)[1];
    return `${indent}- ${line.trim()}`.trimEnd();
  }

  /**
   * AI 回答 → 子弹笔记行数组
   * @param {string} answer
   * @returns {string[]}
   */
  function toBulletLines(answer) {
    const text = typeof answer === 'string' ? answer.replace(/\r\n?/g, '\n') : '';
    const lines = text.split('\n');
    const out = [];
    let fence = null;

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');

      if (fence) {
        // 代码块内容原样保留，代码里以 - 或数字开头的行不会被改写
        out.push(line);
        const closing = FENCE_RE.exec(line);
        if (closing && closing[1][0] === fence[0] && closing[1].length >= fence.length) fence = null;
        continue;
      }

      const opening = FENCE_RE.exec(line);
      if (opening) {
        fence = opening[1];
        out.push(line);
        continue;
      }

      if (line.trim() === '') continue; // 去掉空行，拼成一段紧凑列表
      if (HEADING_RE.test(line)) {
        out.push(line.trimEnd());
        continue;
      }

      out.push(toBulletLine(line));
    }

    return out;
  }

  function firstLine(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .find((line) => line.trim() !== '') || '';
  }

  /**
   * 追加内容时放在最上面的块：`**AI 记录 · 14:32**`，勾了「带提问」还会加一行引用。
   * 它和条目分开，是因为整合时只对条目做去重，时间戳与提问行照写。
   */
  function toNoteHeader(options) {
    const { question, at = new Date() } = options || {};
    const lines = [`**AI 记录 · ${formatTime(at)}**`];

    const asked = firstLine(question);
    if (asked) lines.push('', `> 问：${asked.slice(0, 200)}`);

    return lines.join('\n');
  }

  /**
   * 要新增的条目行。
   *
   * 优先用 AI 单独的日记块（journal）——对话内容不该进日记；
   * answer 只在模型没按协议给出日记块时作为兜底。
   */
  function toNoteLines(options) {
    const { journal, answer } = options || {};
    const content = typeof journal === 'string' && journal.trim() ? journal : answer;
    return toBulletLines(content || '');
  }

  /**
   * 生成写入笔记的完整 Markdown 块（header + 条目）。
   *
   * @param {{ question?: string, journal?: string, answer?: string, at?: Date }} options
   * @returns {string}
   */
  function toNoteBlock(options) {
    const { question, journal, answer, at } = options || {};
    const header = toNoteHeader({ question, at });
    const lines = toNoteLines({ journal, answer });
    return lines.length ? `${header}\n\n${lines.join('\n')}` : header;
  }

  function formatTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  return { toBulletLines, toBulletLine, toNoteBlock, toNoteHeader, toNoteLines, firstLine, formatTime };
});
