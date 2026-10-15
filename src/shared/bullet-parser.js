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
 *     划去_note 只是把标记换成 [-]，但为了恢复时能回到原类型，
 *     双字符标记会记下原来是什么：[-!] 曾是优先、[-n] 曾是笔记、[-e] 曾是事件。
 *     老文件里只有 [-] 的条目恢复时按待人处理（与旧行为一致）。
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
    // 双字符划去标记：额外记住被划去之前的类型，恢复时不「全变回待人」
    '-n': 'cancelled',
    '-e': 'cancelled',
    '>': 'migrated',
    '<': 'scheduled',
    // 优先是叠加标记：笔记/事件也用复刻框形式保留（[n!] 笔记+优先、[e!] 事件+优先）
    n: 'note',
    e: 'event',
    // 旧版单字符写法：[!] / [*] ＝ 任务 + 优先（兼容老文件）
    '!': 'task',
    '*': 'task'
  };

  /** 旧版单字符写法：[!] / [*] ＝ 待办且优先（兼容老文件） */

  /** 划去标记 → 被划去之前的类型（恢复「取消划去」时用它还回原符号） */
  var CANCEL_PRIOR = {
    '-': 'task',
    '-n': 'note',
    '-e': 'event'
  };

  // Markdown 列表项：- / * / + / 1. 都要有后续空白
  var LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])([ \t]+)(.*)$/;
  // 复选框内ō 1–3 个字符，内容在代码里细分：
  //   基础标记：' ' 待办 / x 完成 / >  迁移 / < 计划 / - 划去 / -n 划去笔记 / -e 划去事件
  //   优先修饰符：后面再跟一个「!」表示这条带优先（可叠在任意基础标记上：
  //   [x!] 完成且优先、[ -n!] 划去的优先笔记、[>!] 迁移且优先）
  //   旧写法：[!] / [*] ＝ 待办且优先
  var CHECKBOX_RE = /^\[([^\]]{1,3})\]([ \t]*)(.*)$/;
  /** 复选框内塢 → { mark, priority }；不认识的写法返回 null */
  function splitBoxMark(inner) {
    if (inner == null) return null;
    var mark = inner;
    var priority = false;
    if (mark === '!' || mark === '*') {
      // 旧版单字符：待办 + 优先
      return { mark: ' ', priority: true };
    }
    if (mark.length > 1 && mark.charAt(mark.length - 1) === '!') {
      // 「!」修饰符：优先可叠在任意基础标记上
      priority = true;
      mark = mark.slice(0, -1);
    }
    if (mark === 'X') mark = 'x';
    if (CHECKBOX_TO_KIND[mark] === undefined) return null;
    return { mark: mark, priority: priority };
  }
  // 原生子弹写法：• 任务、o 事件（o 必须是独立单词，避免 "on Monday" 被误判）
  var NATIVE_RE = /^([ \t]*)([•·○])[ \t]+(.*)$/;
  var EVENT_RE = /^([ \t]*)o[ \t]+(.*)$/;
  var FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;

  /* ---------------- 插件注册的自定义子弹 ---------------- */

  /**
   * 插件清单带来的自定义子弹（registerCustomBullets 登记后生效）：
   *   { kind, marks?, native?, glyph, label, cls?, color?, taskLike? }
   *   + marks  复选框写法：marks:['p'] → `- [p] 文字` 到 kind
   *   + native 原生符号写法：native:['◐'] → `◐ 文字`（单字、非字母数字，避免跟单词冲突）
   * taskLike（默认 true）：能不能「完成」；颜色由界面拿 color 写进 --kind-<kind> 变量。
   */
  var customBullets = []; // 登记成功的，按注册顺序
  var customNative = []; // { glyph, kind, re }

  var RESERVED_KIND_RE = /^(total|progress)$/; // 与统计条目的预设计数键冲突，不能当 kind
  var RESERVED_GLYPH_RE = /^[o•·○]$/i; // 与内置事件/任务的原生符号冲突，不收

  function glyphRegex(glyph) {
    // 单字符直接上行首匹配；用捕获组拿缩进与正文
    return new RegExp('^([ \\t]*)' + glyph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[ \\t]+(.*)$');
  }

  /**
   * 注册一批自定义子弹成功返回 true；kind 重复/写法非法返回 false（忽略该条，不抛异常）。
   * @returns {{ kind: string, glyph: string, label: string, cls: string, symbol: string, taskLike: boolean }}
   */
  function registerCustomBullet(bullet) {
    bullet = bullet || {};
    var kind = String(bullet.kind || '').toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(kind) || RESERVED_KIND_RE.test(kind) || KINDS[kind]) return null;

    var marks = (Array.isArray(bullet.marks) ? bullet.marks : [])
      .map(function (mark) { return String(mark); })
      .filter(function (mark) {
        // 空白标记/带空格标记会撞「- [ ] 」待办写法，一律不收
        return /^[^\[\]]{1,3}$/.test(mark) && mark === mark.trim() && mark.length > 0 && CHECKBOX_TO_KIND[mark] === undefined;
      });

    var nativeGlyphs = (Array.isArray(bullet.native) ? bullet.native : [])
      .map(function (glyph) { return String(glyph); })
      .filter(function (glyph) {
        return glyph.length === 1 && !/[a-zA-Z0-9\[\]]/.test(glyph) && !RESERVED_GLYPH_RE.test(glyph);
      });

    if (!marks.length && !nativeGlyphs.length) return null; // 至少要有一种写法

    // 登记前先检查冲突：有任何一个 mark/native 撞上已登记的就放弃整个 bullet（先到先得）
    var conflicts = false;
    marks.forEach(function (mark) {
      if (CHECKBOX_TO_KIND[mark] !== undefined) conflicts = true;
    });
    // native 检查内置符号和已登记 native 的冲突
    nativeGlyphs.forEach(function (glyph) {
      if (customNative.some(function (entry) { return entry.glyph === glyph; })) conflicts = true;
    });
    if (conflicts) return null;

    marks.forEach(function (mark) {
      CHECKBOX_TO_KIND[mark] = kind;
    });

    nativeGlyphs.forEach(function (glyph) {
      customNative.push({ glyph: glyph, kind: kind, re: glyphRegex(glyph) });
    });

    var meta = {
      kind: kind,
      glyph: String(bullet.glyph || (nativeGlyphs[0] || marks[0])).slice(0, 3),
      label: String(bullet.label || kind).slice(0, 20),
      cls: String(bullet.cls || '').replace(/[^a-zA-Z0-9-]/g, '') || 'is-' + kind,
      symbol: bullet.symbol || (nativeGlyphs.length ? nativeGlyphs[0] + ' text' : '- [' + marks[0] + ']'),
      taskLike: bullet.taskLike !== false,
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(bullet.color || '')) ? bullet.color : null
    };
    KINDS[kind] = meta;
    customBullets.push(meta);
    return meta;
  }

  /** 注册一批插件清单里的自定义子弹；逐条登记，返回成功的清单（含归一化后的 meta） */
  function registerCustomBullets(bullets) {
    return (Array.isArray(bullets) ? bullets : []).map(registerCustomBullet).filter(Boolean);
  }

  /** 已登记的自定义子弹 meta（界面拿它补图例/统计/按钮，主进程拿它校验） */
  function getCustomBullets() {
    return customBullets.slice();
  }

  /**
   * 解析单行为子弹条目，不是子弹则返回 null。
   * 划去条目会带 prior（被划去之前的类型），供「取消划去」还回原符号。
   * @returns {{kind:string, text:string, indent:number, prior?:string}|null}
   */
  function parseBulletLine(line) {
    if (typeof line !== 'string' || line.trim() === '') return null;

    var m = NATIVE_RE.exec(line);
    if (m) {
      return { kind: 'task', text: m[3].trim(), indent: indentWidth(m[1]) };
    }

    // 插件的自定义原生符号（◐ 日记 之类）：和 o 事件同位匹配
    for (var ci = 0; ci < customNative.length; ci++) {
      m = customNative[ci].re.exec(line);
      if (m) {
        return { kind: customNative[ci].kind, text: m[2].trim(), indent: indentWidth(m[1]) };
      }
    }

    m = LIST_RE.exec(line);
    if (m) {
      var body = m[3];
      var box = CHECKBOX_RE.exec(body);
      if (box) {
        var split = splitBoxMark(box[1]);
        if (split) {
          var kind = CHECKBOX_TO_KIND[split.mark];
          var parsed = { kind: kind, text: box[3].trim(), indent: indentWidth(m[1]) };
          if (kind === 'cancelled') parsed.prior = CANCEL_PRIOR[split.mark] || 'task';
          if (split.priority) parsed.priority = true;
          return parsed;
        }
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
        var item = { kind: bullet.kind, text: bullet.text, indent: bullet.indent, line: i };
        if (bullet.prior) item.prior = bullet.prior;
        if (bullet.priority) item.priority = true;
        items.push(item);
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

  /** 统计各类子弹数量，用于顶部的「今日进度」；插件自定义 kind 按需生成计数字段 */
  function countStats(blocks) {
    var stats = { total: 0, task: 0, done: 0, cancelled: 0, note: 0, event: 0, migrated: 0, scheduled: 0, priority: 0 };
    // priority 现在是叠加标记：单独为带星标的条目计数，供顶部「优先 N」小胶囊展示
    (blocks || []).forEach(function (block) {
      if (block.type !== 'bullets') return;
      block.items.forEach(function (item) {
        stats.total += 1;
        stats[item.kind] = (stats[item.kind] || 0) + 1;
        if (item.priority) stats.priority += 1;
      });
    });
    stats.progress = stats.task + stats.done > 0 ? Math.round((stats.done / (stats.task + stats.done)) * 100) : 0;
    return stats;
  }

  return {
    KINDS: KINDS,
    CHECKBOX_TO_KIND: CHECKBOX_TO_KIND,
    CANCEL_PRIOR: CANCEL_PRIOR,
    registerCustomBullet: registerCustomBullet,
    registerCustomBullets: registerCustomBullets,
    getCustomBullets: getCustomBullets,
    parseBulletLine: parseBulletLine,
    parseDocument: parseDocument,
    countStats: countStats,
    indentWidth: indentWidth
  };
});
