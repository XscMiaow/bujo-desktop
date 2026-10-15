'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { listPlugins, MANIFEST_NAME } = require('../src/main/plugin-service.js');

/** 解析器是单例：每个用例前重置插件状态（重新 require 一份干净的） */
function freshParser() {
  delete require.cache[require.resolve('../src/shared/bullet-parser.js')];
  return require('../src/shared/bullet-parser.js');
}

test('listPlugins：带清单的子文件夹是插件，坏清单记录错误，无清单的普通文件夹忽略', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-plugins-'));
  await fs.mkdir(path.join(dir, 'example-progress'));
  await fs.writeFile(
    path.join(dir, 'example-progress', MANIFEST_NAME),
    JSON.stringify({
      id: 'example-progress',
      name: '进行中',
      bullets: [{ kind: 'progress2', marks: ['q'], native: ['◐'], label: '进行中', color: '#f0a868' }]
    })
  );

  await fs.mkdir(path.join(dir, 'broken'));
  await fs.writeFile(path.join(dir, 'broken', MANIFEST_NAME), '{oops');

  await fs.mkdir(path.join(dir, 'not-a-plugin'));
  await fs.writeFile(path.join(dir, 'not-a-plugin', '教程.md'), '# readme');
  await fs.writeFile(path.join(dir, 'loose-file.md'), 'x');

  const result = listPlugins(dir);
  assert.equal(result.plugins.length, 1);
  const plugin = result.plugins[0];
  assert.equal(plugin.id, 'example-progress');
  assert.equal(plugin.name, '进行中');
  assert.equal(plugin.bullets.length, 1);
  assert.equal(plugin.bullets[0].kind, 'progress2');
  assert.equal(plugin.bullets[0].color, '#f0a868');
  assert.equal(plugin.bullets[0].plugin, 'example-progress', '子弹带上来源插件');

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /插件清单不可用/);
  assert.equal(path.basename(result.errors[0].plugin), 'broken');

  // 不存在的目录也不报错
  const empty = listPlugins(path.join(os.tmpdir(), 'bujo-plugins-不存在-445'));
  assert.deepEqual(empty.plugins, []);
  assert.deepEqual(empty.errors, []);
});

test('listPlugins：坏 id 与坏 kind 被拒；多插件按 id 排序', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-plugins-bad-'));
  await fs.mkdir(path.join(dir, 'zz-plugin'));
  await fs.writeFile(
    path.join(dir, 'zz-plugin', MANIFEST_NAME),
    JSON.stringify({ id: 'HAS SPACE', bullets: [{ kind: 'ok2', marks: ['q'] }] })
  );
  await fs.mkdir(path.join(dir, 'aa-plugin'));
  await fs.writeFile(
    path.join(dir, 'aa-plugin', MANIFEST_NAME),
    JSON.stringify({ id: 'aa-plugin', bullets: [{ kind: '好名字!', marks: ['q'] }] })
  );
  await fs.mkdir(path.join(dir, 'mid-plugin'));
  await fs.writeFile(
    path.join(dir, 'mid-plugin', MANIFEST_NAME),
    JSON.stringify({ id: 'mid-plugin', bullets: [{ marks: ['q'] }] }) // 没有 kind → 这条被滤掉
  );

  const result = listPlugins(dir);
  assert.deepEqual(result.plugins.map((p) => p.id), ['aa-plugin', 'mid-plugin', 'zz-plugin']);
  assert.deepEqual(result.plugins[0].bullets, [], 'kind 非法的子弹被滤掉，插件本体还在');
  assert.deepEqual(result.plugins[1].bullets, [], '没有 kind 的子弹也被滤掉');
});

/* ---------------- bullet-parser 的自定义子弹注册 ---------------- */

test('registerCustomBullet：marks 与 native 两种写法都能解析，优先/划去不受影响', () => {
  const P = freshParser();
  // kind 不能叫 progress/total（那是统计键），用 in-progress
  const meta = P.registerCustomBullet({ kind: 'in-progress', marks: ['p'], native: ['◐'], glyph: '◐', label: '进行中', color: '#f0a868' });
  assert.ok(meta);
  assert.equal(meta.cls, 'is-in-progress');
  assert.equal(meta.taskLike, true);

  assert.deepEqual(P.parseBulletLine('- [p] 写周报'), { kind: 'in-progress', text: '写周报', indent: 0 });
  assert.deepEqual(P.parseBulletLine('- [p!] 优先进行中'), { kind: 'in-progress', text: '优先进行中', indent: 0, priority: true });
  assert.deepEqual(P.parseBulletLine('◐ 读论文'), { kind: 'in-progress', text: '读论文', indent: 0 });
  // 内置行为不受影响
  assert.deepEqual(P.parseBulletLine('- [ ] 买牛奶'), { kind: 'task', text: '买牛奶', indent: 0 });
  assert.deepEqual(P.parseBulletLine('o 10:30 例会'), { kind: 'event', text: '10:30 例会', indent: 0 });

  // 统计：自定义 kind 各自计数（native + marks 都算同 kind），同时保留「进度比率」语义
  const stats = P.parseDocument('◐ 读论文\n- [p] 写周报\n- [ ] 买牛奶\n').stats;
  assert.equal(stats.total, 3);
  assert.equal(stats['in-progress'], 2, 'native 与 marks 属同一 kind，一起计数');
  assert.equal(stats.progress, 0, 'progress 槽仍是「完成比率」，不跟自定义 kind 混');

  // getCustomBullets 暴露注册顺序
  assert.equal(P.getCustomBullets().length, 1);
  assert.equal(P.getCustomBullets()[0].kind, 'in-progress');
});

test('registerCustomBullet：非法清单全数拒绝（撞内置、reserved、空写法、跨插撞车）', () => {
  const P = freshParser();
  P.registerCustomBullet({ kind: 'mine', marks: ['q'], native: ['◐'] });
  // 第二个插件再注册同样的 mark/native → 整条拒绝（先到先得）
  assert.equal(P.registerCustomBullet({ kind: 'other', marks: ['q'] }), null);
  assert.equal(P.registerCustomBullet({ kind: 'other2', native: ['◐'] }), null);

  // reserved kind / 内置 kind / 空写法 / 大写 id
  assert.equal(P.registerCustomBullet({ kind: 'progress', marks: ['z'] }), null);
  assert.equal(P.registerCustomBullet({ kind: 'total', marks: ['z'] }), null);
  assert.equal(P.registerCustomBullet({ kind: 'task', marks: ['z'] }), null);
  assert.equal(P.registerCustomBullet({ kind: 'good-id', marks: [' q '] }), null, '空格标记算内置待办，不能抢');
  assert.equal(P.registerCustomBullet({ kind: 'GoodId', marks: ['y'] }).kind, 'goodid', 'kind 会统一下成小写（宽容大小写输入）');
  assert.equal(P.registerCustomBullet({ kind: 'gooder' }), null, 'marks/native 都没有 → 拒');
  assert.equal(P.registerCustomBullet({ kind: 'gooder2', native: ['Jó'] }), null, '超过一个字符的「单符号」不要');
  assert.equal(P.registerCustomBullet({ kind: 'gooder3', native: ['o'] }), null, '与内置事件符号冲突');
  assert.deepEqual(P.parseBulletLine('- [y] 什么都不是'), { kind: 'goodid', text: '什么都不是', indent: 0 }, 'GoodId 已把 y 登记下来，正常生效');
  assert.deepEqual(P.parseBulletLine('- [w] 什么都不是'), { kind: 'note', text: '[w] 什么都不是', indent: 0 }, '未登记的标记不算子弹');
});
