'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const { MARKDOWN_EXTENSIONS } = require('./file-service');
const { parseBulletLine } = require('../shared/bullet-parser.js');
const { parseEditBlock, integrate, normalizeForMatch, matchScore, setMark } = require('../shared/note-edit.js');
const { submit, withFileLock } = require('./write-queue');

/**
 * 手工改标记时允许的值。
 * 单字符：' ' 待办 / 'x' 完成 / '-' 划去（退回旧值，等价于划去待办）。
 * 双字符划去 [-!] / [-n] / [-e]：划去某个 具体类型（优先 / 笔记 / 事件），
 * 恢复时能回到原符号，而不是一律变回待办。
 * 恢复动作：'n' 要点、'e' 事件、'!' 优先。
 */
const BULLET_MARKS = {
  ' ': 'task',
  x: 'done',
  '-': 'cancelled',
  '-!': 'cancelled',
  '-n': 'cancelled',
  '-e': 'cancelled',
  '-n!': 'cancelled',
  '-e!': 'cancelled',
  n: 'note',
  e: 'event',
  '!': 'task', // 旧版「恢复为优先事项」＝ 待办 + 优先（现在优先是叠加标记）
  '+': 'priority-toggle', // 界面「★」按钮：保持类型，只加星（+! 由界面发送时再叠优先）
  p: 'unchanged' // 只去掉优先标志，基础标记不变（界面「去★」按钮）
};

/** 目标路径是否在某个目录内（用于把写入限制在日记目录里） */
function isInsideDirectory(childPath, dirPath) {
  if (!childPath || !dirPath) return false;
  const relative = path.relative(path.resolve(dirPath), path.resolve(childPath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function assertWritable(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('未提供要写入的文件');
  const resolved = path.resolve(filePath.trim());
  const extension = path.extname(resolved).toLowerCase();
  if (!MARKDOWN_EXTENSIONS.has(extension)) {
    throw new Error(`只能写入 Markdown 文件，收到的是「${extension || '无扩展名'}」`);
  }
  return resolved;
}

/**
 * 把一段 Markdown 追加到笔记末尾（自动补换行，不会破坏原有内容）。
 *
 * @param {string} filePath
 * @param {string} markdown
 * @param {{ createIfMissing?: boolean }} [options]
 * @returns {Promise<{ path: string, name: string, created: boolean, added: number, size: number }>}
 */
async function appendToNote(filePath, markdown, options = {}) {
  const resolved = assertWritable(filePath);
  const text = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n').trimEnd() : '';
  if (!text) throw new Error('没有可写入的内容');

  // 应用与 CLI 的写入口共用同一套队列：先入有界串行队列（满即拒），再拿跨进程文件锁（同一文件串行）
  return submit(() =>
    withFileLock(resolved, async () => {
      let existing = '';
      let created = false;
      try {
        existing = await fs.readFile(resolved, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT' || !options.createIfMissing) {
          throw new Error(err.code === 'ENOENT' ? `文件不存在：${resolved}` : `无法读取文件：${err.message}`);
        }
        created = true;
        if (options.initialContent) existing = `${String(options.initialContent).trimEnd()}\n`;
      }

      // 原有内容和新内容之间保证一个空行，并让文件以换行结尾
      let separator = '';
      if (existing.trim() !== '') {
        if (!existing.endsWith('\n')) separator += '\n';
        if (!existing.endsWith('\n\n')) separator += '\n';
      }
      const next = `${existing}${separator}${text}\n`;

      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, next, 'utf8');

      return {
        path: resolved,
        name: path.basename(resolved),
        created,
        added: text.length,
        size: Buffer.byteLength(next, 'utf8')
      };
    })
  );
}

/**
 * 读一篇笔记的原文（只读，不改动）。
 * @returns {Promise<string>}
 */
async function readNote(filePath) {
  const resolved = assertWritable(filePath);
  try {
    return await fs.readFile(resolved, 'utf8');
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `文件不存在：${resolved}` : `无法读取文件：${err.message}`);
  }
}

/** 整体写回一篇笔记（内容已由调用方拼好，这里只做落盘与信息回传） */
async function writeNote(filePath, text) {
  const resolved = assertWritable(filePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, text, 'utf8');
  return { path: resolved, name: path.basename(resolved), size: Buffer.byteLength(text, 'utf8') };
}

/**
 * 把 AI 的新增条目与「笔记改动」整合进一篇已有笔记，并写回文件。
 *
 * 与 appendToNote 的区别：这里会先读原文，再按 note-edit 的规则
 * 改已有条目、跳过重复条目，最后才落盘；笔记没变化时不写文件。
 *
 * @param {string} filePath
 * @param {{ edit?: string, header?: string, lines?: string[], dedupe?: boolean }} changes
 * @returns {Promise<{ path:string, name:string, changed:boolean, size:number, report:object }>}
 */
async function integrateNoteFile(filePath, changes = {}) {
  const resolved = assertWritable(filePath);
  const existing = await readNote(resolved);
  const parsed = parseEditBlock(changes.edit || '');
  const { text, report } = integrate(existing, {
    edits: parsed.edits,
    header: changes.header || '',
    lines: Array.isArray(changes.lines) ? changes.lines : [],
    dedupe: changes.dedupe !== false
  });
  report.ignored = parsed.ignored;

  // 队列 + 锁：任何进程都不会并发读改写同一份笔记
  return submit(() =>
    withFileLock(resolved, async () => {
      if (!report.changed || text === existing) {
        return { path: resolved, name: path.basename(resolved), changed: false, size: Buffer.byteLength(existing, 'utf8'), report };
      }
      const written = await writeNote(resolved, text);
      return { path: written.path, name: written.name, changed: true, size: written.size, report };
    })
  );
}

/**
 * 按内容找回某一条所在的行。
 * 只在唯一命中时才返回行号：两条一样的内容宁可不改，也不乱改。
 */
function locateBullet(lines, wanted) {
  const exact = [];
  const near = [];
  lines.forEach((line, index) => {
    if (!parseBulletLine(line)) return;
    const score = matchScore(wanted, normalizeForMatch(line));
    if (score === 1) exact.push(index);
    else if (score >= 0.92) near.push(index);
  });

  const pool = exact.length ? exact : near;
  if (pool.length === 1) return pool[0];
  if (pool.length > 1) throw new Error(`笔记里有 ${pool.length} 条一样的条目，没法确定改哪一条（已重新载入）`);
  throw new Error('笔记里找不到这一条（可能刚被改过），已重新载入');
}

/**
 * 手工改一条条目的标记：' ' 待办 / 'x' 完成 / '-' 划去。
 *
 * 行号优先，内容核对兜底：你在外部编辑器里改过文件、行号偏了也能对上；
 * 对不上就报错让界面重新载入，绝不改错行。划去只把标记改成 [-]，原文留在文件里。
 *
 * @param {string} filePath
 * @param {{ line?: number, text?: string, mark?: string }} target
 * @returns {Promise<{ path:string, name:string, changed:boolean, line:number, before:string, after:string, state:string }>}
 */
async function setBulletMark(filePath, target = {}) {
  const resolved = assertWritable(filePath);
  const { line, text, mark } = target;
  if (!Object.prototype.hasOwnProperty.call(BULLET_MARKS, mark)) {
    throw new Error(`不支持的标记：${String(mark)}`);
  }

  const wanted = normalizeForMatch(text);
  if (!wanted) throw new Error('这一条没有可比对的内容');

  // 队列 + 锁：与 append/integrate 同一套入口，应用与 CLI 完全一致
  return submit(() =>
    withFileLock(resolved, async () => {
      // 锁内重新读全文：别的进程可能刚改过这个文件，行号随时会变
      const source = (await readNote(resolved)).replace(/\r\n?/g, '\n');
      if (!source.trim()) throw new Error('笔记里还没有可改的条目');
      const lines = source.replace(/\s+$/, '').split('\n');

      let index = Number.isInteger(line) && line >= 0 && line < lines.length ? line : -1;
      if (index === -1 || normalizeForMatch(lines[index]) !== wanted) index = locateBullet(lines, wanted);

      const before = lines[index];
      const parsed = parseBulletLine(before);
      if (!parsed) throw new Error('这一行已经不是条目了，已重新载入');

      // 划去时写入「之前是什么」的提示（[-!]/[-n]/[-e]，优先再补一个 !：[-n!] 等），
      // 恢复时能回到原类型；显式的带提示标记（如 -n、-n!）优先于自动推断。
      let markToUse = mark;
      if (mark === '-') {
        const base = parsed.kind === 'note' ? '-n' : parsed.kind === 'event' ? '-e' : '-';
        // 优先是叠加标记：只要原条目带着 priority 标志（含旧版 [!]/[*]），
        // 划去标记在「-n/-e/-」之上再叠「!」（[-n!] 优先笔记被划去；[-!] 优先待办被划去）
        markToUse = parsed.priority ? `${base}!` : base;
      }
      // 「★」按钮：保持原类型，只加优先标志 → 用基础标记 + 强制「!」
      //（[ ] → [!]、[x] → [x!]、原生笔记 → [n!]、事件 → [e!]、[-n] → [-n!]）
      if (mark === '+') {
        markToUse = '+!';
      }
      const after = setMark(before, markToUse);
      if (!after) throw new Error('这一条没有可比对的内容');

      const info = {
        path: resolved,
        name: path.basename(resolved),
        line: index,
        before,
        after,
        state: BULLET_MARKS[markToUse] || BULLET_MARKS[mark]
      };
      if (after === before) return { ...info, changed: false };

      lines[index] = after;
      const written = await writeNote(resolved, `${lines.join('\n')}\n`);
      return { ...info, changed: true, size: written.size };
    })
  );
}

/**
 * 迁移 / 推迟一条条目到另一篇日记。
 *
 * 语义（与子弹笔记的 [>] 迁移、[<] 计划一致）：
 *   - 原文**就地保留**在源文件里，标记改成 [>]（迁移）或 [<]（推迟）——不是删除；
 *     优先标志随标记一起走（[!] → [>!] / [<!]）。
 *   - 只能搬「还没做完」的：待办/优先/笔记/事件/已计划（[<]）可以再迁；
 *     已迁移（[>]）、已划去、已完成的源行一律拒绝——先取消迁移/恢复，再搬。
 *     迁到目标日志里的副本是新条目，它自己再迁一次就是「重新迁移旧项目」，不受此限。
 *   - 目标日记里补同内容的条目：类型与优先保持（待办→[ ]、[!]→[!]、笔记→原生、事件→o），
 *     用整合规则写入：重复不会越迁越多。
 *   - 顺序：锁定源文件定位解析 → 写目标 → 改源标记；目标写入失败则源文件一行不动。
 *
 * @param {string} sourcePath
 * @param {string} destPath 目标日记文件（应已由 ensureMoveDestination 建好）
 * @param {{ line?: number, text?: string, mode?: 'migrate'|'postpone' }} [params]
 *   text 是条目正文（renderer 的 dataset.text / CLI 的参数）；line 是可选的行号提示
 * @returns {Promise<{ mode:string, path:string, name:string, line:number, before:string, after:string, changed:boolean,
 *                     destPath:string, destName:string, destChanged:boolean, destAdded:number, destReport:object }>}
 */
async function moveBullet(sourcePath, destPath, params = {}) {
  const source = assertWritable(sourcePath);
  const dest = assertWritable(destPath);
  const mode = params.mode === 'postpone' ? 'postpone' : 'migrate';
  const movedMark = mode === 'postpone' ? '<' : '>';
  const wanted = normalizeForMatch(params.text);
  if (!wanted) throw new Error('这一条没有可比对的内容');

  // 1) 锁定源文件：定位解析，算出「原文的新标记」与「目标条目」，先不落盘
  const plan = await submit(() =>
    withFileLock(source, () => readNote(source).then((sourceText) => {
      const text = sourceText.replace(/\r\n?/g, '\n');
      if (!text.trim()) throw new Error('源笔记里已经没有内容');
      const lines = text.replace(/\s+$/, '').split('\n');

      let index = Number.isInteger(params.line) && params.line >= 0 && params.line < lines.length ? params.line : -1;
      if (index === -1 || normalizeForMatch(lines[index]) !== wanted) index = locateBullet(lines, wanted);

      const before = lines[index];
      const parsed = parseBulletLine(before);
      if (!parsed) throw new Error('这一行已经不是条目了，已重新载入');

      // 迁移的规矩：已迁移（[>]）/已划去/已完成的条目不能再从原地搬一次，
      // 先「取消迁移/恢复」回到普通状态，再搬；目标日志里的副本自己再迁一次，
      // 就等于把这件事重新迁到新的位置（重新迁移旧项目），不受这里限制
      if (parsed.kind === 'migrated') {
        throw new Error('已迁移（[>]）的条目不能继续迁移，请先「取消迁移」再搬');
      }
      if (parsed.kind === 'cancelled') {
        throw new Error('已划去的条目不能迁移，先恢复为原来的类型再搬');
      }
      if (parsed.kind === 'done') {
        throw new Error('已完成的条目不能迁移，先取消完成再搬');
      }

      // 目标条目：同一件事「重开」为未完成态，类型与优先保持
      const priorKind = parsed.kind;
      const destBase = priorKind === 'note' ? 'n' : priorKind === 'event' ? 'e' : ' ';
      const plain = setMark(before, destBase); // 恢复为未完成（保留优先 → [!]/[n!]/[e!]）
      const destLine = parsed.priority ? setMark(plain, '+!') : plain;
      if (!destLine) throw new Error('这一条没有可比对的内容');

      return {
        index,
        before,
        priorKind,
        after: setMark(before, movedMark),
        destLine
      };
    }))
  );

  // 2) 写目标日记：先去重算出 accepted，再插到对应小节（任务/笔记）下；路径外部已建好
  const destResult = await submit(() =>
    withFileLock(dest, async () => {
      let existing = '';
      try {
        existing = await readNote(dest);
      } catch (err) {
        if (!/不存在/.test(err.message)) throw err; // 目标被外部删掉了：当作空文件重建
      }

      const { report } = integrate(existing.trimEnd(), { lines: [plan.destLine], dedupe: true });
      const destName = path.basename(dest);
      if (!report.added.length && !report.merged.length && !report.edits.applied.length) {
        return { destName, destChanged: false, destAdded: 0, destReport: report };
      }

      // 合并改动（目标里已有同内容的划去条目等）:直接用 integrate 的结果
      if (report.merged.length || report.edits.applied.length) {
        const { text } = integrate(existing.trimEnd(), { lines: [plan.destLine], dedupe: true });
        const written = await writeNote(dest, text);
        return { destName: written.name, destChanged: true, destAdded: written.size, destReport: report };
      }

      // 纯新增：插进对应小节（任务/笔记）里，没有对应小节才追加到末尾
      const priorKind = plan.priorKind;
      const wantedLabel = priorKind === 'note' || priorKind === 'event' ? '笔记' : '任务';
      const lines = existing.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n');
      const plan2 = insertionUnderSection(lines, wantedLabel);
      let text;
      if (plan2.mode === 'end' || !lines.length) {
        const { text: appended } = integrate(existing.trimEnd(), { lines: [plan.destLine], dedupe: true });
        text = appended;
      } else {
        lines.splice(plan2.insertAt, 0, plan.destLine);
        text = `${lines.join('\n')}\n`;
      }
      const written = await writeNote(dest, text);
      return { destName: written.name, destChanged: true, destAdded: written.size, destReport: report };
    })
  );

  // 3) 源文件就地标 [>] / [<]（锁内重新读全文，行号可能已被别的进程改过）
  const sourceResult = await submit(() =>
    withFileLock(source, async () => {
      const text = (await readNote(source)).replace(/\r\n?/g, '\n');
      const lines = text.replace(/\s+$/, '').split('\n');

      let index = plan.index;
      const valid = Number.isInteger(index) && index >= 0 && index < lines.length && lines[index] === plan.before;
      if (!valid) index = locateBullet(lines, wanted);

      const before = lines[index];
      const after = normalizeForMatch(before) === wanted ? setMark(before, movedMark) : '';
      if (!after) throw new Error('这一条没有可比对的内容（源文件刚被改过，已重新载入）');

      const info = {
        path: source,
        name: path.basename(source),
        line: index,
        before,
        after,
        changed: after !== before
      };
      if (after !== before) {
        const updated = [...lines];
        updated[index] = after;
        await writeNote(source, `${updated.join('\n')}\n`);
      }
      return info;
    })
  );

  return { mode, path: sourceResult.path, ...sourceResult, ...destResult, destPath: dest };
}

/**
 * 在「任务 / 笔记」小节的末尾插入新条目的位置；没有这个小节或者条目相关的都不是标题时回退末尾追加。
 * @param {string[]} lines
 * @param {string} wantedLabel '任务' 或 '笔记'
 * @returns {{ mode: 'section'|'end', insertAt?: number }}
 */
function insertionUnderSection(lines, wantedLabel) {
  const headingRe = /^\s*#{1,6}\s+\S/;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!headingRe.test(lines[i])) continue;
    if (normalizeForMatch(lines[i]) === wantedLabel) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return { mode: 'end' };

  let insertAt = headerIndex + 1; // 标题下紧跟一行空白或标题前都可行
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (headingRe.test(lines[i])) break;
    if (lines[i].trim() !== '') insertAt = i + 1;
  }
  /* 把插入点之前紧挨着的空行收掉：别在标题后额外堆一排空行 */
  while (insertAt > headerIndex + 1 && lines[insertAt - 1] === '') insertAt--;
  return { mode: 'section', insertAt };
}

module.exports = {
  appendToNote,
  readNote,
  writeNote,
  integrateNoteFile,
  setBulletMark,
  moveBullet,
  locateBullet,
  isInsideDirectory,
  assertWritable,
  BULLET_MARKS
};
