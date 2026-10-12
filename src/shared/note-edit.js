/**
 * 「笔记改动」指令 + 把 AI 的新增条目整合进已有笔记（浏览器与 Node 共用）。
 *
 * 分工：
 *   - parseEditBlock()：解析 <note-edit> 段里的改动指令（改 / 完成 / 划去）
 *   - integrate()：把改动与新增条目合并进现有笔记文本，并顺手做整合：
 *       * 与已有条目重复的新增条目不再写一遍（报给界面看）
 *       * 同一件事只是状态变了（待办 → 已完成等）就地改状态，不新增一条
 *       * 一行一条，改的是原行，其它内容原样保留
 *
 * 「删除」在这个应用里就是「划去」：条目留在文件里，只把标记改成 [-]，
 * 任何时候都不会有一行内容被默默删掉。
 *
 * 纯函数，不碰文件系统：主进程用它真正落盘，渲染层用它做写入前的预览，
 * 两边走同一套规则，界面上的数字和文件里的结果就不会对不上。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NoteEdit = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HEADING_RE = /^\s{0,3}#{1,6}\s/;
  const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
  const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const LIST_PREFIX_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
  const CHECKBOX_RE = /^\s*[-*+]?\s*\[([^\]]{1,3})\]\s*(.*)$/;
  /** 拆出复选框内咓：基础标记 + 优先谓钮（末尾的「!」）；X 归一化为小写 */
  function splitBoxInner(inner) {
    let mark = inner;
    let priority = false;
    if (mark === '!' || mark === '*') {
      // 旧版单字符写法：待办 + 优先
      return { mark: ' ', priority: true };
    }
    if (mark.length > 1 && mark.charAt(mark.length - 1) === '!') {
      priority = true;
      mark = mark.slice(0, -1);
    }
    if (mark === 'X') mark = 'x';
    return { mark, priority };
  }
  /** 基础标记是否认识（与 bullet-parser 的 CHECKBOX_TO_KIND 一致，含 n/e 恢复标记） */
  function knownMark(mark) {
    return [' ', 'x', '-', '-n', '-e', '>', '<', 'n', 'e'].includes(mark);
  }
  const NATIVE_RE = /^\s*[•·○]\s+/;
  const EVENT_RE = /^\s*[oO][ \t]+(?=\S)/;

  // 改写写法：改：旧 => 新（也认 ~、→、->）
  const REPLACE_SEP = /(?:=>|⇒|→|->)/;
  const REPLACE_PREFIX = /^(?:~|改|更新|修改|调整)\s*[:：]?\s*/;
  const DONE_PREFIX = /^(?:[xX✓☑]|完成|已完成|搞定)(?:\s*[:：]\s*|\s+)/;
  // 划去（保留原文）；「删」这类要求也按划去处理，不会真删掉一行
  const CANCEL_PREFIX = /^(?:划去|划掉|删|删除|移除|去掉)\s*[:：]?\s*/;

  /** 新增条目与已有条目「算同一件事」的相似度门槛 */
  const DUPLICATE_THRESHOLD = 0.86;
  /** 改动指令匹配原条目时的最低相似度 */
  const MATCH_THRESHOLD = 0.72;
  /** 第二名不能咬得太紧，否则退回「找不到」，不拿相近的行乱改 */
  const MATCH_MARGIN = 0.08;
  /** 短于这个长度的行不用「包含」关系来判断（「写周报」不该匹配「先写周报」） */
  const CONTAIN_MIN = 4;

  /** 归一化：去掉列表符号、复选框（含 [-n]/[-e]/[-!] 这类双字符划去标记）、Markdown 记号、空白与标点，只留可比对的内容 */
  function normalizeForMatch(line) {
    return String(line == null ? '' : line)
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\s*[-*+]?\s*\[[^\]]{1,3}\]\s*/, '')
      .replace(/^\s*[•·○]\s*/, '')
      .replace(/^\s*[oO][ \t]+(?=\S)/, '')
      .replace(/[*_`#]/g, '')
      .replace(/\s+/g, '')
      .replace(/[，。、；：！？「」『』（）()【】〔〕《》"“”'‘’.,!?;:]/g, '')
      .toLowerCase();
  }

  function bigrams(text) {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
    return set;
  }

  /** Dice 系数：0 表示毫无重叠，1 表示完全相同 */
  function similarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const left = bigrams(a);
    const right = bigrams(b);
    let shared = 0;
    left.forEach((gram) => {
      if (right.has(gram)) shared += 1;
    });
    return (2 * shared) / (left.size + right.size);
  }

  /** 两行算不算同一件事：完全相同、一方包含另一方，或足够相似 */
  function matchScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length >= CONTAIN_MIN && b.length >= CONTAIN_MIN) {
      if (a.includes(b) || b.includes(a)) return Math.max(0.92, similarity(a, b));
    }
    return similarity(a, b);
  }

  /** 拆分复选框条目：{ indent, mark, text }；不是复选框条目则返回 null。
   * 划去的双字符标记（[-!] / [-n] / [-e]）原样进 mark，供恢复时判断原类型。 */
  function boxParts(line) {
    const match = CHECKBOX_RE.exec(String(line || ''));
    if (!match) return null;
    const split = splitBoxInner(match[1]);
    if (!knownMark(split.mark)) return null;
    const indent = /^\s*/.exec(line)[0];
    const parts = { indent, mark: split.mark, text: match[2].trim() };
    if (split.priority) parts.priority = true;
    return parts;
  }

  /** 把任意写法的一行规范成子弹条目，保留缩进与优先修饰符 */
  function asBulletLine(text, indent) {
    let body = String(text == null ? '' : text)
      .trim()
      .replace(/^>\s*/, '')
      .replace(LIST_PREFIX_RE, '')
      .replace(/^[•·○]\s+/, '');

    let marker = '';
    const box = /^\[([^\]]{1,3})\]\s*(.*)$/.exec(body);
    if (box) {
      const split = splitBoxInner(box[1]);
      if (knownMark(split.mark)) {
        marker = `[${split.mark}${split.priority ? '!' : ''}] `;
        body = box[2].trim();
      }
    }

    if (!body && !marker) return '';
    return `${indent || ''}- ${marker}${body}`.trimEnd();
  }

  /** 去掉列表符号与复选框，只留正文 */
  function bulletBody(line) {
    return asBulletLine(line, '')
      .replace(/^- (?:\[[^\]]{1,3}\]\s*)?/, '')
      .replace(EVENT_RE, '')
      .trim();
  }

  /** 这一行是不是「条目」：只有条目能被标记，段落与标题不动 */
  function isBulletLine(line) {
    const text = String(line == null ? '' : line);
    return LIST_PREFIX_RE.test(text) || NATIVE_RE.test(text) || EVENT_RE.test(text);
  }

  /**
   * 改写一条条目的标记，保留缩进、正文与优先修饰符。
   *
   * mark 只是基础标记（' ' 待办 / 'x' 完成 / '-' 划去 / '-n' 划去笔记 / '-e' 划去事件 /
   * '-n!' '-e!' '-!' 带优先的划去 / 'n' 恢复成笔记 / 'e' 恢复成事件 / '!' 旧版优先待办）；
   * mark 自带「!」时表示「不管原行有没有优先，写回的结果都带优先」；
   * 原行带优先而 mark 没带时优先照样保留——完成/划去/恢复都不会把「这是优先事项」丢掉。
   */
  function setMark(line, mark) {
    const box = boxParts(line);
    // mark 末尾的「!」是「强制带优先」的指令：剥掉它之后基础标记才参与类型判断
    let forcedPriority = mark.length > 1 && mark.charAt(mark.length - 1) === '!';
    let baseMark = forcedPriority ? mark.slice(0, -1) : mark;
    // 旧版恢复指令「!」＝ 待办 + 优先
    if (baseMark === '!') {
      forcedPriority = true;
      baseMark = ' ';
    }
    // 「p」＝ 只去掉优先标志，基础标记保持原样。
    // 先抹掉原行的优先（临时去掉内文里的 !），再按基础标记重写，这样递归不会把优先又加回来。
    if (baseMark === 'p') {
      if (!box || !box.priority) return line.trimEnd();
      const stripped = box.indent + line.trim().slice(box.indent.length).replace(/^(- \[)\s*[^\]]*(!?)\]/, '$1' + box.mark + ']');
      return setMark(stripped, box.mark === ' ' ? ' ' : box.mark);
    }
    // 「+!」＝ 保持原类型，只加星（待办/笔记/事件/完成都可加优先标志，划去态也一样保留）
    if (baseMark === '+') {
      if (box) {
        // 复选框行：在原提示上补 !（[-n] → [-n!]，[-] → [-!]，[ ] → [!]，[x] → [x!] ……）
        // 空格基础用旧版单字符 [!]（parser 读作「待办且优先」，避免写出 [ !]）
        const mark = box.mark === ' ' ? '' : box.mark;
        return `${box.indent}- [${mark}!] ${bulletBody(line)}`.trimEnd();
      }
      // 没有复选框的原生行：笔记用 [n!] 承载；事件用 [e!]
      return EVENT_RE.test(String(line)) ? setMark(line, 'e!') : setMark(line, 'n!');
    }
    const priority = forcedPriority || Boolean(box && box.priority);
    const indent = box ? box.indent : (/^\s*/.exec(String(line == null ? '' : line)) || [''])[0];
    const body = bulletBody(line);
    if (!body) return '';
    // 优先是叠加标记：完成/划去/恢复都不丢——n/e 恢复时原本带优先就留在复选框里
    //（[n!] / [e!]，parser 读作笔记/事件 + 优先；不带优先则回到原生行写法）
    if (baseMark === 'n') {
      return priority ? `${indent}- [n!] ${body}`.trimEnd() : `${indent}- ${body}`.trimEnd();
    }
    if (baseMark === 'e') {
      return priority ? `${indent}- [e!] ${body}`.trimEnd() : `${indent}o ${body}`.trimEnd();
    }
    // 泛化划去（mark === '-'）：从当前标记推「曾是」什么（[n!] → [-n!]，[e!] → [-e!]），
    // 再叠上优先修饰符，恢复时两头信息都不丢
    let cancelBase = baseMark;
    if (baseMark === '-' && box) {
      if (box.mark === 'n') cancelBase = '-n';
      else if (box.mark === 'e') cancelBase = '-e';
      else if (box.mark === '-') cancelBase = '-'; // 已是划去态重划一次：不动原提示
      else cancelBase = box.mark === 'x' ? '-' : '-';
      // 优先永远跟着走；[-!] / [-n!] / [-e!] 都是这个约定
    }
    if (baseMark === '-' && cancelBase !== '-') {
      return `${indent}- [${cancelBase}${priority ? '!' : ''}] ${body}`.trimEnd();
    }
    // 已是划去态又划一次：保留原来的提示（[-n] 重划仍是 [-n]，[-n!] 仍是 [-n!]）
    if (baseMark === '-' && box && ['-n', '-e'].includes(box.mark)) {
      return `${indent}- [${box.mark}${priority ? '!' : ''}] ${body}`.trimEnd();
    }
    // 待办 + 优先时借用旧版单字符写法 [!]（parser 兼容读作「待办且优先」），
    // 避免写出 [ !] 这种空格标记，别的工具看着也自然
    if (baseMark === ' ' && priority) return `${indent}- [!] ${body}`.trimEnd();
    return `${indent}- [${baseMark}${priority ? '!' : ''}] ${body}`.trimEnd();
  }

  function markTask(line) {
    return setMark(line, ' ');
  }

  /** 标记完成 */
  function markDone(line) {
    return setMark(line, 'x');
  }

  /** 划去：条目留在文件里，只是划掉 */
  function markCancelled(line) {
    return setMark(line, '-');
  }

  /**
   * 解析改动块里的每一行。
   * @param {string} text <note-edit> 段的内容
   * @returns {{ edits: Array<{kind:string, target:string, next?:string, raw:string}>, ignored: string[] }}
   */
  function parseEditBlock(text) {
    const source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : '';
    const edits = [];
    const ignored = [];
    let fence = null;

    for (const rawLine of source.split('\n')) {
      const line = rawLine.replace(/\s+$/, '');
      if (!line.trim()) continue;

      const opening = FENCE_RE.exec(line);
      if (fence || opening) {
        if (fence && opening && opening[1][0] === fence[0]) fence = null;
        else if (!fence) fence = opening[1];
        // 围栏本身不是指令；围栏里面的行不进 ignored，免得界面被噪声刷满
        if (!opening) ignored.push(line.trim());
        continue;
      }

      // 先剥掉模型爱加的列表符号（-、*、1.）与复选框，再认操作符
      const body = line
        .trim()
        .replace(LIST_PREFIX_RE, '')
        .replace(/^\[[^\]]{1,3}\]\s*/, '')
        .trim();
      if (!body) continue;

      const replaced = REPLACE_SEP.exec(body);
      if (replaced) {
        const target = body.slice(0, replaced.index).replace(REPLACE_PREFIX, '').trim();
        const next = body.slice(replaced.index + replaced[0].length).replace(/^(?:为|成)\s*/, '').trim();
        if (target && next) {
          edits.push({ kind: 'replace', target, next, raw: line.trim() });
          continue;
        }
        ignored.push(line.trim());
        continue;
      }

      const done = DONE_PREFIX.exec(body);
      if (done) {
        const target = body.slice(done[0].length).trim();
        if (target) edits.push({ kind: 'done', target, raw: line.trim() });
        else ignored.push(line.trim());
        continue;
      }

      const cancel = CANCEL_PREFIX.exec(body);
      if (cancel) {
        const target = body.slice(cancel[0].length).trim();
        if (target) edits.push({ kind: 'cancel', target, raw: line.trim() });
        else ignored.push(line.trim());
        continue;
      }

      ignored.push(line.trim());
    }

    return { edits, ignored };
  }

  /**
   * 在一份（可能已被改动过的）行数组里找指令指向的那一行。
   * @returns {{ index:number, score:number, how:string } | null}
   */
  function findTargetLine(lines, target) {
    const needle = normalizeForMatch(target);
    if (!needle) return null;

    let exact = null;
    let best = null;
    let runnerUp = 0;

    lines.forEach((line, index) => {
      if (!line.trim() || HEADING_RE.test(line) || RULE_RE.test(line)) return;
      const score = matchScore(needle, normalizeForMatch(line));
      if (score === 1 && !exact) exact = { index, score, how: '完全相同' };
      if (score > (best ? best.score : 0)) {
        runnerUp = best ? best.score : 0;
        best = { index, score, how: score >= 0.92 ? '内容近似' : '写法相近' };
      } else if (score > runnerUp) {
        runnerUp = score;
      }
    });

    if (exact) return exact;
    if (!best) return null;
    if (best.score < MATCH_THRESHOLD) return null;
    if (best.score - runnerUp < MATCH_MARGIN) return null; // 两行都像，宁可不改
    return best;
  }

  /** 新增条目能不能并进已有条目（同一件事，只是状态变了） */
  function findMergeCandidate(lines, line) {
    const incoming = boxParts(line);
    if (!incoming || incoming.mark === ' ') return null;
    const incomingText = normalizeForMatch(incoming.text);
    if (!incomingText) return null;

    for (let index = 0; index < lines.length; index++) {
      const existing = lines[index];
      const box = boxParts(existing);
      if (!box || box.mark === incoming.mark) continue;
      const score = matchScore(incomingText, normalizeForMatch(box.text));
      if (score >= DUPLICATE_THRESHOLD) {
        return { index, line: `${box.indent}- [${incoming.mark}] ${box.text}`.trimEnd(), before: existing, text: box.text };
      }
    }
    return null;
  }

  /** 新增条目是不是已经在笔记里（或这一批里）了 */
  function findDuplicate(lines, accepted, line) {
    const needle = normalizeForMatch(line);
    if (!needle) return null;

    const pool = lines.filter((item) => item.trim()).concat(accepted);
    let best = null;
    for (const other of pool) {
      if (HEADING_RE.test(other) || RULE_RE.test(other)) continue;
      const score = matchScore(needle, normalizeForMatch(other));
      if (!best || score > best.score) best = { matched: other.trim(), score };
    }

    if (!best || best.score < DUPLICATE_THRESHOLD) return null;
    return { matched: best.matched, how: best.score === 1 ? '完全相同' : '内容近似' };
  }

  function indentOf(line) {
    return (/^\s*/.exec(line) || [''])[0];
  }

  /**
   * 把改动 + 新增条目整合进一份笔记文本。
   *
   * @param {string} existingText 现有笔记原文
   * @param {{ edits?: Array, header?: string, lines?: string[], dedupe?: boolean }} options
   *   edits   parseEditBlock() 得到的指令
   *   header  追加时放在最上面的块（例如 `**AI 记录 · 14:32**`）
   *   lines   新增条目的行（已规范成子弹写法）
   *   dedupe  是否跳过与已有条目重复的新增条目（默认开）
   * @returns {{ text: string, report: object }}
   */
  function integrate(existingText, options) {
    const { edits = [], header = '', lines = [], dedupe = true } = options || {};
    const source = typeof existingText === 'string' ? existingText.replace(/\r\n?/g, '\n') : '';
    const original = source.replace(/\s+$/, '');
    const work = original ? original.split('\n') : [];
    const report = {
      mode: 'append',
      // applied 是真的改动了；unchanged 是「指令对上了但内容已经是最新」（例如已经是已完成）
      edits: { applied: [], unchanged: [], skipped: [] },
      added: [],
      duplicates: [],
      merged: [],
      changed: false
    };

    /** 内容跟原来一样就不算「改了一处」，只报「已是最新」 */
    const recordEdit = (kind, from, to, how) => {
      const entry = { kind, from, to, how };
      if (to === from) report.edits.unchanged.push(entry);
      else report.edits.applied.push(entry);
    };

    for (const edit of edits) {
      const hit = findTargetLine(work, edit.target);
      if (!hit) {
        report.edits.skipped.push({ kind: edit.kind, target: edit.target, reason: '笔记里没找到对应的条目' });
        continue;
      }

      const before = work[hit.index];
      // 只动「条目」，段落与标题不动
      if (!isBulletLine(before)) {
        report.edits.skipped.push({ kind: edit.kind, target: edit.target, reason: '这一行不是条目，没有改它' });
        continue;
      }

      if (edit.kind === 'done') {
        const after = markDone(before);
        work[hit.index] = after;
        recordEdit('done', before, after, hit.how);
        continue;
      }

      if (edit.kind === 'cancel') {
        const after = markCancelled(before);
        work[hit.index] = after;
        recordEdit('cancel', before, after, hit.how);
        continue;
      }

      const after = asBulletLine(edit.next, indentOf(before));
      if (!after) {
        report.edits.skipped.push({ kind: edit.kind, target: edit.target, reason: '改写后的条目是空的' });
        continue;
      }
      work[hit.index] = after;
      recordEdit('replace', before, after, hit.how);
    }

    const accepted = [];
    for (const raw of lines) {
      const line = String(raw == null ? '' : raw).replace(/\s+$/, '');
      if (!line.trim()) continue;

      // 标题与分隔线是结构，不参与去重
      if (HEADING_RE.test(line) || RULE_RE.test(line)) {
        accepted.push(line);
        continue;
      }

      if (!dedupe) {
        accepted.push(line);
        continue;
      }

      const merge = findMergeCandidate(work, line);
      if (merge) {
        work[merge.index] = merge.line;
        report.merged.push({ line: line.trim(), before: merge.before, after: merge.line, matched: merge.text });
        continue;
      }

      const duplicate = findDuplicate(work, accepted, line);
      if (duplicate) {
        report.duplicates.push({ line: line.trim(), matched: duplicate.matched, how: duplicate.how });
        continue;
      }

      accepted.push(line);
    }

    report.added = accepted.slice();
    report.mode = report.edits.applied.length && accepted.length ? 'mixed' : report.edits.applied.length ? 'edits' : 'append';
    report.changed = Boolean(report.edits.applied.length || accepted.length || report.merged.length);

    // 一行都不会被删掉：划去只是把标记改成 [-]
    let text = work.join('\n').replace(/\s+$/, '');

    // 没有新增条目就不追加任何东西：时间戳只在真的有内容时才写
    const block = accepted.length
      ? [String(header || '').replace(/\s+$/, ''), accepted.join('\n')].filter((part) => part !== '').join('\n\n')
      : '';

    if (block) text = text ? `${text}\n\n${block}` : block;
    if (text) text += '\n';

    return { text, report };
  }

  return {
    parseEditBlock,
    integrate,
    normalizeForMatch,
    similarity,
    matchScore,
    boxParts,
    asBulletLine,
    bulletBody,
    isBulletLine,
    setMark,
    markTask,
    markDone,
    markCancelled,
    DUPLICATE_THRESHOLD,
    MATCH_THRESHOLD
  };
});
