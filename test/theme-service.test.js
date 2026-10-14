'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const { listThemes, isValidThemeId, BASE_CSS_NAME } = require('../src/main/theme-service.js');

test('listThemes：base.css 之外每个 .css 都是一个主题，顺序稳定', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-themes-'));
  await fs.writeFile(path.join(dir, 'base.css'), '/* 布局基底，不是主题 */\n');
  await fs.writeFile(path.join(dir, 'light.css'), ':root{--bg:#fff}\n');
  await fs.writeFile(path.join(dir, 'dark.css'), ':root{--bg:#111}\n');
  await fs.writeFile(path.join(dir, 'warm-paper.css'), ':root{--bg:#f8f2e8}\n');
  // 不是 css 与子目录里的文件都不算
  await fs.writeFile(path.join(dir, 'notes.txt'), 'x');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'nested.css'), ':root{}');

  const result = listThemes(dir);
  assert.equal(result.dir, path.resolve(dir));
  assert.deepEqual(
    result.themes.map((theme) => theme.id),
    ['dark', 'light', 'warm-paper'],
    '内置在前（dark→light），其余按 id 排序'
  );
  assert.deepEqual(result.themes, [
    { id: 'dark', label: '深色' },
    { id: 'light', label: '浅色' },
    { id: 'warm-paper', label: 'warm-paper' }
  ]);
});

test('listThemes：空目录/不存在/坏文件名都安全回落', async () => {
  const missing = listThemes(path.join(os.tmpdir(), 'bujo-themes-不存在-987'));
  assert.deepEqual(missing.themes, [], '目录不存在 → 空列表，界面回落默认深色');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bujo-themes-empty-'));
  const empty = listThemes(dir);
  assert.deepEqual(empty.themes, []);

  await fs.writeFile(path.join(dir, 'base.css'), 'x');
  await fs.writeFile(path.join(dir, '只有中文名.css'), 'x');
  await fs.writeFile(path.join(dir, 'toonameplease-0123456789-012345.css'), 'x');
  await fs.writeFile(path.join(dir, '.css'), 'x');
  const guarded = listThemes(dir);
  assert.deepEqual(guarded.themes, [], 'base.css、非法文件名、空 id 都不是一个主题');
  assert.equal(BASE_CSS_NAME, 'base.css');
});

test('isValidThemeId：主题设置只认短小写写法', () => {
  assert.equal(isValidThemeId('dark'), true);
  assert.equal(isValidThemeId('light'), true);
  assert.equal(isValidThemeId('warm-paper'), true);
  assert.equal(isValidThemeId('Dark'), false);
  assert.equal(isValidThemeId('has space'), false);
  assert.equal(isValidThemeId('../escape'), false);
  assert.equal(isValidThemeId(''), false);
  assert.equal(isValidThemeId(null), false);
  assert.equal(isValidThemeId('a'.repeat(30)), false);
});
