/**
 * 「笔记改动」指令 + 把 AI 的新增条目整合进已有笔记（浏览器与 Node 共用）。
 *
 * 分工：
 *   - parseEditBlock()：解析 <note-edit> 段里的改动指令（改 / 完成 / 删）
 *   - integrate()：把改动与新增条目合并进现有笔记文本，并顺手做整合：
 *       * 与已有条目重复的新增条目不再写一遍（报给界面看）
 *       * 同一件事只是状态变了（待办 → 已完成等）就地改状态，不新增一条
 *       * 一行一条，改的是原行，其它内容原样保留
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
  const CHECKBOX_RE = /^\s*[-*+]?\s*\[([ xX><!*-])\]\s*(.*)$/;

  // 改写写法：改：旧 => 新（也认 ~、→、->）
  const REPLACE_SEP = /(?:=>|⇒|→|->)/;
  const REPLACE_PREFIX = /^(?:~|改|更新|修改|调整)\s*[:：]?\s*/;
  const DONE_PREFIX = /^(?:[xX✓☑]|完成|已完成|搞定)(?:\s*[:：]\s*|\s+)/;
  const REMOVE_PREFIX = /^(?:删|删除|移除|去掉)\s*[:：]?\s*/;

  /** 新增条目与已有条目「算同一件事」的相似度门槛 */
  const DUPLICATE_THRESHOLD = 0.86;
  /** 改动指令匹配原条目时的最低相似度 */
  const MATCH_THRESHOLD = 0.72;
  /** 第二名不能咬得太紧，否则退回「找不到」，不拿相近的行乱改 */
  const MATCH_MARGIN = 0.08;
  /** 短于这个长度的行不用「包含」关系来判断（「写周报」不该匹配「先写周报」） */
  const CONTAIN_MIN = 4;

  /** 归一化：去掉列表符号、复选框、Markdown 记号、空白与标点，只留可比对的内容 */
  function normalizeForMatch(line) {
    return String(line == null ? '' : line)
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\s*[-*+]?\s*\[[ xX><!*-]\]\s*/, '')
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

  /** 拆分复选框条目：{ indent, mark, text }；不是复选框条目则返回 null */
  function boxParts(line) {
    const match = CHECKBOX_RE.exec(String(line || ''));
    if (!match) return null;
    const indent = /^\s*/.exec(line)[0];
    return { indent, mark: match[1] === 'X' ? 'x' : match[1], text: match[2].trim() };
  }

  /** 把任意写法的一行规范成子弹条目，保留缩进 */
  function asBulletLine(text, indent) {
    let body = String(text == null ? '' : text)
      .trim()
      .replace(/^>\s*/, '')
      .replace(LIST_PREFIX_RE, '')
      .replace(/^[•·○]\s+/, '');

    let marker = '';
    const box = /^\[([ xX><!*-])\]\s*(.*)$/.exec(body);
    if (box) {
      marker = `[${box[1] === 'X' ? 'x' : box[1]}] `;
      body = box[2].trim();
    }

    if (!body && !marker) return '';
    return `${indent || ''}- ${marker}${body}`.trimEnd();
  }

  /** 把一条已有条目标成已完成 */
  function markDone(line, indent) {
    const box = boxParts(line);
    if (box) return `${box.indent}- [x] ${box.text}`.trimEnd();
    return asBulletLine(line, indent || (/^\s*/.exec(line) || [''])[0]).replace(/^(\s*)- /, '$1- [x] ');
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
        .replace(/^\[[ xX><!*-]\]\s*/, '')
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

      const remove = REMOVE_PREFIX.exec(body);
      if (remove) {
        const target = body.slice(remove[0].length).trim();
        if (target) edits.push({ kind: 'remove', target, raw: line.trim() });
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
  function findTargetLine(lines, target, isTaken) {
    const needle = normalizeForMatch(target);
    if (!needle) return null;

    let exact = null;
    let best = null;
    let runnerUp = 0;

    lines.forEach((line, index) => {
      if (line === null || (isTaken && isTaken(index))) return;
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
  function findMergeCandidate(lines, line, isTaken) {
    const incoming = boxParts(line);
    if (!incoming || incoming.mark === ' ') return null;
    const incomingText = normalizeForMatch(incoming.text);
    if (!incomingText) return null;

    for (let index = 0; index < lines.length; index++) {
      const existing = lines[index];
      if (existing === null || (isTaken && isTaken(index))) continue;
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

    const pool = lines.filter((item) => item !== null && item.trim()).concat(accepted);
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

    let removedCount = 0;
    const removed = new Set();
    const isRemoved = (index) => removed.has(index);
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
      const hit = findTargetLine(work, edit.target, isRemoved);
      if (!hit) {
        report.edits.skipped.push({ kind: edit.kind, target: edit.target, reason: '笔记里没找到对应的条目' });
        continue;
      }

      const before = work[hit.index];
      if (edit.kind === 'remove') {
        removed.add(hit.index);
        work[hit.index] = null;
        removedCount += 1;
        report.edits.applied.push({ kind: 'remove', from: before, to: '', how: hit.how });
        continue;
      }

      if (edit.kind === 'done') {
        const after = markDone(before);
        work[hit.index] = after;
        recordEdit('done', before, after, hit.how);
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

      const merge = findMergeCandidate(work, line, isRemoved);
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

    let text = work.filter((line) => line !== null).join('\n');
    // 删行可能留下多余空行，只在真的删过的时候收拾一下
    if (removedCount) text = text.replace(/\n{3,}/g, '\n\n');
    text = text.replace(/\s+$/, '');

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
    markDone,
    DUPLICATE_THRESHOLD,
    MATCH_THRESHOLD
  };
});
