/**
 * 把已有笔记拼成发给模型的上下文块（浏览器与 Node 共用）。
 *
 * 笔记可能很长，直接塞进请求会撑爆 token 也可能盖住用户的问题，
 * 所以这里做两件事：
 *   1. 首尾保留：开头是标题与结构（今天写了什么），结尾是最新的条目
 *      （追加写的都在末尾），中间省略并明确写出省略了多少字；
 *   2. 包在 <note file="…">…</note> 里，和对话内容分得清。
 *
 * 纯函数：主进程用它拼请求，单元测试直接喂文本。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NoteContext = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 默认最多带多少字（约 1.5k token，够读懂一篇当天笔记） */
  const DEFAULT_MAX_CHARS = 2400;
  /** 超过上限时，开头最多留多少字（标题与结构） */
  const DEFAULT_HEAD_CHARS = 700;

  const TAG_OPEN = '<note';
  const TAG_CLOSE = '</note>';

  function escapeAttr(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[ch]);
  }

  /**
   * 生成上下文块。
   *
   * @param {{ name?: string, content?: string, maxChars?: number, headChars?: number }} options
   * @returns {{ included: boolean, text: string, name: string, chars: number, total: number, truncated: boolean, reason: string }}
   */
  function buildNoteContext(options) {
    const {
      name = 'note.md',
      content = '',
      maxChars = DEFAULT_MAX_CHARS,
      headChars = DEFAULT_HEAD_CHARS
    } = options || {};

    const source = typeof content === 'string' ? content.replace(/\r\n?/g, '\n').trim() : '';
    if (!source) {
      return { included: false, text: '', name, chars: 0, total: 0, truncated: false, reason: '笔记还是空的' };
    }

    const limit = Math.max(200, maxChars);
    const head = Math.min(Math.max(0, headChars), Math.floor(limit / 2));

    let body = source;
    let carried = source.length;
    let truncated = false;
    if (source.length > limit) {
      truncated = true;
      carried = limit;
      const tail = source.slice(source.length - (limit - head));
      body = `${source.slice(0, head)}\n…（中间省略 ${source.length - limit} 字）…\n${tail}`;
    }

    const text = [`${TAG_OPEN} file="${escapeAttr(name)}">`, body.trim(), TAG_CLOSE].join('\n');
    return { included: true, text, name, chars: carried, total: source.length, truncated, reason: '' };
  }

  return { buildNoteContext, DEFAULT_MAX_CHARS, DEFAULT_HEAD_CHARS };
});
