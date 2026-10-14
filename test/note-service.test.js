'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { appendToNote, readNote, integrateNoteFile, setBulletMark, moveBullet, locateBullet, isInsideDirectory } = require('../src/main/note-service.js');

let tmpDir;

test.before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-note-'));
});

test.after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('追加到已有内容后面，前面留一个空行', async () => {
  const file = path.join(tmpDir, 'a.md');
  await fs.writeFile(file, '# 标题\n- [ ] 原有任务\n', 'utf8');

  const result = await appendToNote(file, '- 新内容');
  assert.equal(result.created, false);

  const content = await fs.readFile(file, 'utf8');
  assert.equal(content, '# 标题\n- [ ] 原有任务\n\n- 新内容\n');
});

test('原有文件没有结尾换行时也不会粘在一起', async () => {
  const file = path.join(tmpDir, 'b.md');
  await fs.writeFile(file, '最后一行没有换行', 'utf8');

  await appendToNote(file, '- 追加');
  assert.equal(await fs.readFile(file, 'utf8'), '最后一行没有换行\n\n- 追加\n');
});

test('已有空行结尾时不会越加越多空行', async () => {
  const file = path.join(tmpDir, 'c.md');
  await fs.writeFile(file, '内容\n\n', 'utf8');

  await appendToNote(file, '- 一');
  await appendToNote(file, '- 二');
  assert.equal(await fs.readFile(file, 'utf8'), '内容\n\n- 一\n\n- 二\n');
});

test('可以新建文件（日记场景），并保留初始模板', async () => {
  const file = path.join(tmpDir, 'nest', '2026-10-07.md');
  const result = await appendToNote(file, '- 第一条', {
    createIfMissing: true,
    initialContent: '# 2026-10-07 星期三\n\n## 笔记\n'
  });

  assert.equal(result.created, true);
  assert.equal(result.name, '2026-10-07.md');
  const content = await fs.readFile(file, 'utf8');
  assert.match(content, /^# 2026-10-07 星期三/);
  assert.match(content, /- 第一条\n$/);
});

test('不允许新建时，文件不存在要报错', async () => {
  await assert.rejects(() => appendToNote(path.join(tmpDir, 'missing.md'), '- x'), /文件不存在/);
});

test('空内容、非 Markdown、缺参数都会被拒绝', async () => {
  const file = path.join(tmpDir, 'd.md');
  await fs.writeFile(file, 'x\n', 'utf8');

  await assert.rejects(() => appendToNote(file, '   \n  '), /没有可写入的内容/);
  await assert.rejects(() => appendToNote(path.join(tmpDir, 'e.exe'), '- x'), /只能写入 Markdown/);
  await assert.rejects(() => appendToNote('', '- x'), /未提供要写入的文件/);
});

test('CRLF 内容会被统一成 LF', async () => {
  const file = path.join(tmpDir, 'f.md');
  await fs.writeFile(file, '头部\n', 'utf8');
  await appendToNote(file, '- 一\r\n- 二\r\n');
  assert.equal(await fs.readFile(file, 'utf8'), '头部\n\n- 一\n- 二\n');
});

test('整合写入：改已有条目、跳过重复条目，其它内容原样保留', async () => {
  const file = path.join(tmpDir, 'g.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 写周报\n- 整理收件箱\n', 'utf8');

  const result = await integrateNoteFile(file, {
    edit: '完成：整理收件箱',
    header: '**AI 记录 · 09:05**',
    lines: ['- [ ] 给客户回信', '- 整理收件箱']
  });

  assert.equal(result.changed, true);
  assert.equal(result.name, 'g.md');
  assert.equal(result.report.added.length, 1);
  assert.equal(result.report.duplicates.length, 1);
  assert.equal(result.report.edits.applied.length, 1);

  const content = await fs.readFile(file, 'utf8');
  assert.ok(content.startsWith('# 笔记'), '原有内容不动');
  assert.ok(content.includes('- [x] 整理收件箱'), '改的是已有那一行');
  assert.ok(content.includes('- [ ] 给客户回信'));
  assert.equal((content.match(/整理收件箱/g) || []).length, 1, '重复的条目不再写一遍');
});


test('重复的一轮不会写文件（笔记没变化时不动磁盘）', async () => {
  const file = path.join(tmpDir, 'h.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 给客户回信\n', 'utf8');
  const before = await fs.stat(file);

  const again = await integrateNoteFile(file, { header: '**AI 记录 · 09:05**', lines: ['- 给客户回信'] });

  assert.equal(again.changed, false);
  assert.equal(again.report.added.length, 0);
  assert.equal(again.report.duplicates.length, 1);
  const after = await fs.stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, '没有改动就不落盘');
  assert.equal(await fs.readFile(file, 'utf8'), '# 笔记\n\n- [ ] 给客户回信\n');
});


test('readNote 读不到就报错，不返回空字符串', async () => {
  await assert.rejects(() => readNote(path.join(tmpDir, 'nope.md')), /文件不存在/);
  await assert.rejects(() => readNote(path.join(tmpDir, 'x.exe')), /只能写入 Markdown/);
});


test('手工改标记：完成 / 划去 / 恢复，都只改那一行；划去笔记会带回「曾是笔记」的提示', async () => {
  const file = path.join(tmpDir, 'marks.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 写周报\n- 整理收件箱\n  - [!] 子任务\n', 'utf8');

  const done = await setBulletMark(file, { line: 2, text: '写周报', mark: 'x' });
  assert.equal(done.changed, true);
  assert.equal(done.state, 'done');
  assert.equal(done.after, '- [x] 写周报');

  // 划去一条笔记：写成 [-n]（曾是笔记），恢复时能回原类型而不是变待办
  const cancelled = await setBulletMark(file, { line: 3, text: '整理收件箱', mark: '-' });
  assert.equal(cancelled.after, '- [-n] 整理收件箱');
  assert.equal(cancelled.state, 'cancelled');

  const restored = await setBulletMark(file, { line: 4, text: '子任务', mark: ' ' });
  // 「子任务」原本写的是 [!]（任务+优先的叠加标记）：恢复待办后优先照旧保留
  assert.equal(restored.after, '  - [!] 子任务', '缩进保留，优先叠加标记也不丢');

  // 划去的笔记恢复成笔记，不是待办
  const noteBack = await setBulletMark(file, { line: 3, text: '整理收件箱', mark: 'n' });
  assert.equal(noteBack.after, '- 整理收件箱', '恢复成笔记条目，不带复选框');
  assert.equal(noteBack.state, 'note');

  const content = await fs.readFile(file, 'utf8');
  assert.equal(
    content,
    ['# 笔记', '', '- [x] 写周报', '- 整理收件箱', '  - [!] 子任务', ''].join('\n'),
    '一行都没删，只改了几处的标记'
  );
});

test('划去优先事项写成 [-!]，恢复时回到 [!] 而不是待办', async () => {
  const file = path.join(tmpDir, 'marks-priority.md');
  await fs.writeFile(file, '- [!] 完成原型\n', 'utf8');

  const cancelled = await setBulletMark(file, { line: 0, text: '完成原型', mark: '-' });
  assert.equal(cancelled.after, '- [-!] 完成原型', '优先事项划去时记住原类型');

  const restored = await setBulletMark(file, { line: 0, text: '完成原型', mark: '!' });
  assert.equal(restored.after, '- [!] 完成原型', '恢复成优先事项');
});

test('优先是叠加标记：完成/划去/恢复全程保留，任意类型可带，可单独去掉', async () => {
  const file = path.join(tmpDir, 'marks-priority-flag.md');
  // 完成的优先事项 → 划去 → 恢复成待办：星标一路跟随
  await fs.writeFile(file, '- [x!] 交付原型\n', 'utf8');
  const cancel = await setBulletMark(file, { line: 0, text: '交付原型', mark: '-' });
  assert.equal(cancel.after, '- [-!] 交付原型', '划去不丢优先');
  const restore = await setBulletMark(file, { line: 0, text: '交付原型', mark: ' ' });
  assert.equal(restore.after, '- [!] 交付原型', '恢复后优先还在');
  const done = await setBulletMark(file, { line: 0, text: '交付原型', mark: 'x' });
  assert.equal(done.after, '- [x!] 交付原型', '完成也不丢');

  // 单独去星：[x!] → [x]，基础标记不变
  const strip = await setBulletMark(file, { line: 0, text: '交付原型', mark: 'p' });
  assert.equal(strip.after, '- [x] 交付原型', '去优先只去 !，类型不变');

  // 再加回来：任意类型可以加星（保持类型，只加优先标志）
  const add = await setBulletMark(file, { line: 0, text: '交付原型', mark: '+' });
  assert.equal(add.after, '- [x!] 交付原型', '重新标星');

  // 优先笔记的完整循环：[·笔记]→划去→恢复，两边都带优先
  await fs.writeFile(file, '- [n!] 优先笔记\n', 'utf8');
  const cn = await setBulletMark(file, { line: 0, text: '优先笔记', mark: '-' });
  assert.equal(cn.after, '- [-n!] 优先笔记', '双字符提示与优先双保留');
  const rn2 = await setBulletMark(file, { line: 0, text: '优先笔记', mark: 'n' });
  assert.equal(rn2.after, '- [n!] 优先笔记', '恢复成笔记且优先还在');
});

test('划去事件写成 [-e]，恢复时回到 o 事件行', async () => {
  const file = path.join(tmpDir, 'marks-event.md');
  await fs.writeFile(file, 'o 下午三点评审\n', 'utf8');

  const cancelled = await setBulletMark(file, { line: 0, text: '下午三点评审', mark: '-' });
  assert.equal(cancelled.after, '- [-e] 下午三点评审');

  const restored = await setBulletMark(file, { line: 0, text: '下午三点评审', mark: 'e' });
  assert.equal(restored.after, 'o 下午三点评审', '恢复成事件');
});


test('已经是这个状态时不写文件，也不报成改过了', async () => {
  const file = path.join(tmpDir, 'marks-same.md');
  await fs.writeFile(file, '- [x] 写周报\n', 'utf8');
  const before = await fs.stat(file);

  const again = await setBulletMark(file, { line: 0, text: '写周报', mark: 'x' });
  assert.equal(again.changed, false);
  const after = await fs.stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, '没有变化就不动磁盘');
});


test('行号偏了按内容找回；找不到或两条一样就拒绝，绝不乱改', async () => {
  const file = path.join(tmpDir, 'marks-stale.md');
  await fs.writeFile(file, '# 笔记\n\n- [ ] 写周报\n- 整理收件箱\n', 'utf8');

  // 行号给错（文件在外部被改过），但内容对得上：找回来。它是笔记，划去记成 [-n]
  const found = await setBulletMark(file, { line: 0, text: '整理收件箱', mark: '-' });
  assert.equal(found.changed, true);
  assert.equal(found.after, '- [-n] 整理收件箱');

  await assert.rejects(() => setBulletMark(file, { line: 1, text: '不存在的事', mark: 'x' }), /找不到这一条/);
  await assert.rejects(() => setBulletMark(file, { line: 1, text: '写周报', mark: '?' }), /不支持的标记/);
  await assert.rejects(() => setBulletMark(file, { line: 1, text: '  ', mark: 'x' }), /没有可比对的内容/);
});


test('两条一模一样的条目：宁可拒绝也不猜（返回明确错误）', async () => {
  const file = path.join(tmpDir, 'marks-dup.md');
  await fs.writeFile(file, '开头\n\n- [ ] 买牛奶\n\n- [ ] 买牛奶\n', 'utf8');

  await assert.rejects(() => setBulletMark(file, { line: 1, text: '买牛奶', mark: 'x' }), /一样的条目/);
  assert.equal(await fs.readFile(file, 'utf8'), '开头\n\n- [ ] 买牛奶\n\n- [ ] 买牛奶\n', '拒绝时文件完全不动');
});


test('段落、标题、空行都不是条目：不给它们打标记', async () => {
  const file = path.join(tmpDir, 'marks-plain.md');
  const original = '# 标题\n\n这是一段普通文字\n';
  await fs.writeFile(file, original, 'utf8');

  for (const target of [
    { line: 2, text: '这是一段普通文字' },
    { line: 0, text: '# 标题' },
    { line: 1, text: '开头' }
  ]) {
    await assert.rejects(() => setBulletMark(file, { ...target, mark: 'x' }), /不是条目|找不到这一条/, JSON.stringify(target));
  }

  assert.equal(await fs.readFile(file, 'utf8'), original, '拒绝时一个字都不动');
});


test('locateBullet 只认条目行', () => {
  const lines = ['# 标题', '- [ ] 写周报', '普通文字', 'o 开会'];
  assert.equal(locateBullet(lines, '写周报'), 1);
  assert.equal(locateBullet(lines, '开会'), 3, '事件也算条目');
  assert.throws(() => locateBullet(lines, '普通文字'), /找不到这一条/);
});


/* ---------------- 迁移 / 推迟（moveBullet） ---------------- */

/** 带小节骨架的目标日记，与 ensure* 用户的真实模板一致 */
function emptySheet(title) {
  return `# ${title}\n\n## 任务\n\n## 笔记\n`;
}

function readSection(content, label) {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^\s*#{1,6}\s/.test(l) && l.trim().replace(/[#\s]/g, '') === label);
  if (start === -1) return [];
  const out = [];
  for (let i = start + (lines[start + 1] === '' ? 2 : 1); i < lines.length; i++) {
    if (/^\s*#{1,6}\s/.test(lines[i])) break;
    if (lines[i].trim() !== '') out.push(lines[i]);
  }
  return out;
}

test('moveBullet 迁移：原文就地标 [>]，目标任务的「任务」小节补一条待办', async () => {
  const src = path.join(tmpDir, 'mv-src.md');
  const dest = path.join(tmpDir, 'mv-dest.md');
  await fs.writeFile(src, '- [ ] 写周报\n', 'utf8');
  await fs.writeFile(dest, emptySheet('月度记录'));

  const result = await moveBullet(src, dest, { text: '写周报', mode: 'migrate' });
  assert.equal(result.changed, true);
  assert.equal(result.after, '- [>] 写周报', '原文留在文件里，只是换标记');
  assert.equal(result.destChanged, true);

  assert.equal(await fs.readFile(src, 'utf8'), '- [>] 写周报\n', '源文件一行不少');
  const destText = await fs.readFile(dest, 'utf8');
  assert.deepEqual(readSection(destText, '任务'), ['- [ ] 写周报'], '目标任务的「任务」小节里多了一条待办');
  assert.notEqual(destText, emptySheet('月度记录'), '目标日记真的被写入');
});

test('moveBullet 的推迟：原文标 [<]，目的地是明天的日记', async () => {
  const src = path.join(tmpDir, 'pp-src.md');
  const dest = path.join(tmpDir, 'pp-dest.md');
  await fs.writeFile(src, '- [ ] 买牛奶\n- [!] 优先改稿\n', 'utf8');
  await fs.writeFile(dest, emptySheet('2026-10-14 星期三'));

  const result = await moveBullet(src, dest, { text: '买牛奶', mode: 'postpone' });
  assert.equal(result.after, '- [<] 买牛奶');
  assert.deepEqual(readSection(await fs.readFile(dest, 'utf8'), '任务'), ['- [ ] 买牛奶']);

  // 优先标志两头都不可丢：[!] → [...!]，目标里仍是 [!]
  const result2 = await moveBullet(src, dest, { text: '优先改稿', mode: 'postpone' });
  assert.equal(result2.after, '- [<!] 优先改稿', '推迟也保留优先标志');
  assert.deepEqual(readSection(await fs.readFile(dest, 'utf8'), '任务'), ['- [ ] 买牛奶', '- [!] 优先改稿']);
});

test('moveBullet 笔记与事件同样能迁，类型与所带的修饰符原样保留', async () => {
  const src = path.join(tmpDir, 'ne-src.md');
  const dest = path.join(tmpDir, 'ne-dest.md');
  await fs.writeFile(src, '- 整理收件箱\no 10:30 例会\n- [n!] 优先笔记\n', 'utf8');
  await fs.writeFile(dest, emptySheet('未来记录'));

  const note = await moveBullet(src, dest, { text: '整理收件箱', mode: 'migrate' });
  assert.equal(note.after, '- [>] 整理收件箱');

  const event = await moveBullet(src, dest, { text: '10:30 例会', mode: 'migrate' });
  assert.equal(event.after, '- [>] 10:30 例会', '事件也要能找到正文（text 带时间，与界面一致）');

  const priority = await moveBullet(src, dest, { text: '优先笔记', mode: 'migrate' });
  assert.equal(priority.after, '- [>!] 优先笔记');

  const destText = await fs.readFile(dest, 'utf8');
  assert.deepEqual(readSection(destText, '笔记'), [
    '- 整理收件箱',
    'o 10:30 例会',
    '- [n!] 优先笔记'
  ], '笔记/事件归到「笔记」小节，优先标志保留');
});

test('moveBullet：已迁移的源行拒绝再迁；取消迁移后可重迁且目标不重复', async () => {
  const src = path.join(tmpDir, 'dup-src.md');
  const dest = path.join(tmpDir, 'dup-dest.md');
  await fs.writeFile(src, '- [ ] 迁移教程\n', 'utf8');
  await fs.writeFile(dest, emptySheet('月度记录'));

  await moveBullet(src, dest, { text: '迁移教程', mode: 'migrate' });
  assert.equal((await fs.readFile(src, 'utf8')).includes('- [>] 迁移教程'), true);

  // 已迁移（[>]）的条目不能再从原地迁，先取消迁移
  await assert.rejects(
    () => moveBullet(src, dest, { text: '迁移教程', mode: 'migrate' }),
    /不能继续迁移.*取消迁移/
  );

  // 取消迁移：恢复为普通待办
  const restored = await setBulletMark(src, { text: '迁移教程', mark: ' ' });
  assert.match(restored.after, /^- \[ \] 迁移教程$/);

  // 重新迁移：同一件事（目标里已有一份），不会重复加
  const again = await moveBullet(src, dest, { text: '迁移教程', mode: 'migrate' });
  assert.equal(again.changed, true, '源行恢复成 [>]');
  assert.equal(again.destChanged, false, '目标已有一份，不重复加（去重）');
  assert.deepEqual(readSection(await fs.readFile(dest, 'utf8'), '任务'), ['- [ ] 迁移教程']);
});

test('moveBullet：目标日志里的副本再迁一次 = 重新迁移旧项目', async () => {
  const src = path.join(tmpDir, 'dup-src.md');
  const dest = path.join(tmpDir, 'dup-dest.md');
  await fs.writeFile(src, '- [>] 迁移教程\n', 'utf8');
  await fs.writeFile(dest, `# 月度记录\n\n## 任务\n\n- [ ] 迁移教程\n\n## 笔记\n`, 'utf8');

  // 在月度记录里，那份副本是一个普通的新条目：迁去未来记录不受「已迁移」限制
  const future = path.join(tmpDir, 'future.md');
  await fs.writeFile(future, emptySheet('未来记录'));
  const remigrate = await moveBullet(dest, future, { text: '迁移教程', mode: 'migrate' });
  assert.equal(remigrate.changed, true, '月度记录里那一行就地标 [>]');
  assert.equal(readSection(await fs.readFile(future, 'utf8'), '任务').join(''), '- [ ] 迁移教程', '未来记录按待办重开一份');
});

test('moveBullet：已划去/已完成的源行也坚决不迁', async () => {
  const src = path.join(tmpDir, 'blocked-src.md');
  const dest = path.join(tmpDir, 'blocked-dest.md');
  await fs.writeFile(src, '- [-] 旧待办\n- [x] 提交报告\n', 'utf8');
  await fs.writeFile(dest, emptySheet('未来记录'));
  const original = await fs.readFile(src, 'utf8');

  await assert.rejects(() => moveBullet(src, dest, { text: '旧待办', mode: 'migrate' }), /已划去/);
  await assert.rejects(() => moveBullet(src, dest, { text: '提交报告', mode: 'migrate' }), /已完成/);
  assert.equal(await fs.readFile(src, 'utf8'), original, '拒绝时源文件一行不动');
  assert.equal(await fs.readFile(dest, 'utf8'), emptySheet('未来记录'), '拒绝时目标也不写');
});

test('moveBullet 找不到/未知类型时坚决不动文件', async () => {
  const src = path.join(tmpDir, 'miss-src.md');
  const dest = path.join(tmpDir, 'miss-dest.md');
  const original = '- [ ] 写周报\n';
  await fs.writeFile(src, original, 'utf8');
  await fs.writeFile(dest, emptySheet('未来记录'));

  await assert.rejects(() => moveBullet(src, dest, { text: '不存在的条目' }), /找不到这一条/);
  assert.equal(await fs.readFile(src, 'utf8'), original, '失败时源文件不动');
  assert.equal(await fs.readFile(dest, 'utf8'), emptySheet('未来记录'), '失败时目标也不写');
});

test('isInsideDirectory 只认子路径', () => {
  const journals = path.join(tmpDir, 'journals');
  assert.equal(isInsideDirectory(path.join(journals, '2026-10-07.md'), journals), true);
  assert.equal(isInsideDirectory(path.join(journals, 'sub', 'a.md'), journals), true);
  assert.equal(isInsideDirectory(journals, journals), false, '目录本身不算');
  assert.equal(isInsideDirectory(path.join(tmpDir, 'other.md'), journals), false);
  assert.equal(isInsideDirectory(path.join(tmpDir, 'journals-evil', 'a.md'), journals), false, '前缀相同但不是子目录');
  assert.equal(isInsideDirectory(null, journals), false);
});
