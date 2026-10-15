'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 插件扫描：plugins/ 文件夹下的每个子文件夹就是一个插件。
 * 插件清单 plugin.json 里声明的自定义子弹会被 bullet-parser 登记成新类型（详见 docs/插件教程.md）。
 *
 *   plugins/
 *     example-progress/
 *       plugin.json        ← 插件清单（id/name/bullets）
 *
 * 清单损坏、字段非法的插件不加载，也不影响别的插件（错误会带在结果里报告）。
 */

const MANIFEST_NAME = 'plugin.json';

/** 一个自定义子弹字段的最小校验；返回 null 表示这条没法用 */
function normalizeBullet(raw, pluginId) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const kind = String(raw.kind || '').toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(kind)) return null;

  return {
    kind,
    marks: Array.isArray(raw.marks) ? raw.marks.map(String).slice(0, 6) : [],
    native: Array.isArray(raw.native) ? raw.native.map(String).slice(0, 6) : [],
    glyph: String(raw.glyph || (Array.isArray(raw.native) && raw.native[0]) || '?').slice(0, 3),
    label: String(raw.label || kind).slice(0, 20),
    cls: String(raw.cls || '').slice(0, 32),
    symbol: String(raw.symbol || '').slice(0, 12) || undefined,
    taskLike: raw.taskLike === false ? false : true,
    color: /^#[0-9a-fA-F]{3,8}$/.test(String(raw.color || '')) ? raw.color : null,
    plugin: pluginId
  };
}

/**
 * 扫描 plugins 目录。
 * @param {string} pluginsDir
 * @param {{ readdirSync?: Function, readFileSync?: Function }} [fileSystem] 测试可注入
 * @returns {{ dir: string, plugins: Array<{ id, name, description, bullets }>, errors: Array<{ plugin, error }> }}
 */
function listPlugins(pluginsDir, fileSystem = fs) {
  const resolved = path.resolve(pluginsDir);
  const plugins = [];
  const errors = [];

  let entries = [];
  try {
    entries = fileSystem.readdirSync(resolved, { withFileTypes: true });
  } catch {
    return { dir: resolved, plugins, errors }; // 没有插件目录 = 没有插件，不算错误
  }

  for (const entry of entries) {
    // 只认「文件夹 = 插件」：文件夹里的 plugin.json 是清单（文件里的教程/文档不算插件）
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(resolved, entry.name, MANIFEST_NAME);
    let manifestRaw;
    try {
      manifestRaw = fileSystem.readFileSync(manifestPath, 'utf8');
    } catch {
      continue; // 这个文件夹不带清单，不当插件
    }

    try {
      const parsed = JSON.parse(manifestRaw);
      // id 缺省/非法时回落到文件夹名：文件夹名合法就用它（比整个插件失效友好）
      const rawId = String(parsed.id || '').toLowerCase();
      const id = /^[a-z0-9-]{1,32}$/.test(rawId) ? rawId : entry.name.toLowerCase();
      if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error('id 只能是小写字母/数字/连字符（1-32 位）');

      const rawBullets = Array.isArray(parsed.bullets) ? parsed.bullets : [];
      const bullets = rawBullets
        .map((bullet) => normalizeBullet(bullet, id))
        .filter(Boolean);

      plugins.push({
        id,
        name: String(parsed.name || id).slice(0, 40),
        description: String(parsed.description || '').slice(0, 200),
        path: path.dirname(manifestPath),
        bullets
      });
    } catch (err) {
      errors.push({ plugin: entry.name, error: `插件清单不可用：${err.message}` });
    }
  }

  // 稳定顺序：id 字母序
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  return { dir: resolved, plugins, errors };
}

module.exports = { listPlugins, MANIFEST_NAME };
