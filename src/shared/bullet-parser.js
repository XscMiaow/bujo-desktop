/**
 * 子弹笔记解析器（主进程 / 渲染进程通用）
 *
 * 把一份 Markdown 文本切成两种块：
 *   - { type: 'markdown', text }       普通 Markdown，交给 marked 渲染
 *   - { type: 'bullets',  items: [...] } 子弹条目，由渲染层按「子弹笔记」样式绘制
 *
 * 支持的子弹符号（同时兼容 Markdown 复选框写法）：
 *   - [ ] 待办任务        • text   / - [ ] text
 *   - [x] 已完成          - [x] text
 *   - [-] 划去（不删原文） - [-] text
 *   - [>] 迁移            - [>] text
 *   - [<] 计划            - [<] text
 *   - [!] 优先            - [!] text
 *   - 普通笔记            - text
 *   - 事件                o text
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BulletJournal = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 子弹类型定义：glyph 是显示符号，cls 是样式类，label 用于图例与统计 */
  var KINDS = {
    task: { glyph: '•', label: '任务', cls: 'is-task', symbol: '[ ]' },
    done: { glyph: '✕', label: '完成', cls: 'is-done', symbol: '[x]' },
    cancelled: { glyph: '✗', label: '划去', cls: 'is-cancelled', symbol: '[-]' },
    migrated: { glyph: '›', label: '迁移', cls: 'is-migrated', symbol: '[>]' },
    scheduled: { glyph: '‹', label: '计划', cls: 'is-scheduled', symbol: '[<]' },
    priority: { glyph: '★', label: '优先', cls: 'is-priority', symbol: '[!]' },
    note: { glyph: '–', label: '笔记', cls: 'is-note', symbol: '-' },
    event: { glyph: 'o', label: '事件', cls: 'is-event', symbol: 'o' }
  };

  var CHECKBOX_TO_KIND = {
    ' ': 'task',
    x: 'done',
    X: 'done',
    // [-] 是「划去」：条目留在文件里，只是划掉（不真删）
    '-': 'cancelled',
    '>': 'migrated',
    '<': 'scheduled',
    '!': 'priority',
    '*': 'priority'
  };

  // Markdown 列表项：- / * / + / 1. 都要有后续空白
  var LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])([ \t]+)(.*)$/;
  // 复选框：[ ]、[x]、[>] ...
  var CHECKBOX_RE = /^\[([ xX><!*-])\]([ \t]*)(.*)$/;
  // 原生子弹写法：• 任务、o 事件（o 必须是独立单词，避免 "on Monday" 被误判）
  var NATIVE_RE = /^([ \t]*)([•·○])[ \t]+(.*)$/;
  var EVENT_RE = /^([ \t]*)o[ \t]+(.*)$/;
  var FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

  /**
   * 解析单行为子弹条目，不是子弹则返回 null。
   * @returns {{kind:string, text:string, indent:number}|null}
   */
  function parseBulletLine(line) {
    if (typeof line !== 'string' || line.trim() === '') return null;

    var m = NATIVE_RE.exec(line);
    if (m) {
      return { kind: 'task', text: m[3].trim(), indent: indentWidth(m[1]) };
    }

    m = LIST_RE.exec(line);
    if (m) {
      var body = m[3];
      var box = CHECKBOX_RE.exec(body);
      if (box) {
        var kind = CHECKBOX_TO_KIND[box[1]] || 'task';
        return { kind: kind, text: box[3].trim(), indent: indentWidth(m[1]) };
      }
      return { kind: 'note', text: body.trim(), indent: indentWidth(m[1]) };
    }

    m = EVENT_RE.exec(line);
    if (m) {
      return { kind: 'event', text: m[2].trim(), indent: indentWidth(m[1]) };
    }

    return null;
  }

  function indentWidth(whitespace) {
    var width = 0;
    for (var i = 0; i < whitespace.length; i++) {
      width += whitespace[i] === '\t' ? 4 : 1;
    }
    return width;
  }

  /** 把原始 Markdown 切成 markdown / bullets 两种块 */
  function parseDocument(markdown) {
    var text = typeof markdown === 'string' ? markdown : '';
    // 统一换行符，避免 \r 进入渲染结果
    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var blocks = [];
    var buffer = []; // 待输出的 markdown 行
    var items = []; // 待输出的子弹条目
    var fence = null; // 当前代码围栏标记，例如 "```"

    function flushMarkdown() {
      if (!buffer.length) return;
      var joined = buffer.join('\n');
      if (joined.trim() !== '') blocks.push({ type: 'markdown', text: joined });
      buffer = [];
    }

    function flushBullets() {
      if (!items.length) return;
      blocks.push({ type: 'bullets', items: items });
      items = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fenceMatch = FENCE_RE.exec(line);

      if (fence) {
        buffer.push(line);
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
          fence = null;
        }
        continue;
      }

      if (fenceMatch) {
        flushBullets();
        fence = fenceMatch[1];
        buffer.push(line);
        continue;
      }

      var bullet = parseBulletLine(line);
      if (bullet) {
        flushMarkdown();
        // line：这一条在源文件里的行号（0 起）。界面靠它把操作写回正确的那一行
        items.push({ kind: bullet.kind, text: bullet.text, indent: bullet.indent, line: i });
        continue;
      }

      if (line.trim() === '') {
        // 空行结束一个子弹列表；空行本身留给 markdown 分段
        flushBullets();
        buffer.push(line);
        continue;
      }

      // 越级缩进的行（例如子弹下的续行）先结束子弹列表，再当作 markdown 处理
      flushBullets();
      buffer.push(line);
    }

    flushBullets();
    flushMarkdown();

    return { blocks: blocks, stats: countStats(blocks) };
  }

  /** 统计各类子弹数量，用于顶部的「今日进度」 */
  function countStats(blocks) {
    var stats = { total: 0, task: 0, done: 0, cancelled: 0, note: 0, event: 0, migrated: 0, scheduled: 0, priority: 0 };
    (blocks || []).forEach(function (block) {
      if (block.type !== 'bullets') return;
      block.items.forEach(function (item) {
        stats.total += 1;
        if (stats[item.kind] !== undefined) stats[item.kind] += 1;
      });
    });
    stats.progress = stats.task + stats.done > 0 ? Math.round((stats.done / (stats.task + stats.done)) * 100) : 0;
    return stats;
  }

  return {
    KINDS: KINDS,
    CHECKBOX_TO_KIND: CHECKBOX_TO_KIND,
    parseBulletLine: parseBulletLine,
    parseDocument: parseDocument,
    countStats: countStats,
    indentWidth: indentWidth
  };
});
