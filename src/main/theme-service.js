'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 主题（样式）注册表：
 * src/renderer/styles/ 文件夹里的每个 .css（除 base.css 布局基底）都是一个可切换的主题。
 * 加新主题 = 复制 light.css 改 token 值，重启应用就出现在主界面下拉里。
 */

const BASE_CSS_NAME = 'base.css';

/** 内置主题的中文显示名；文件夹里出现其它 .css 就用 ID 兜底展示 */
const THEME_LABELS = {
  dark: '深色',
  light: '浅色'
};

/**
 * 列出目录里的可选主题：[{ id, label }]；目录不存在/为空时返回空的，界面回落到默认深色。
 * @param {string} stylesDir
 * @param {{ readdirSync(name, opts): Array<{ name: string, isFile(): boolean }> }} [fileSystem] 可注入的 fs（测试用）
 * @returns {{ dir: string, themes: Array<{ id: string, label: string }> }}
 */
function listThemes(stylesDir, fileSystem = fs) {
  const themes = [];
  try {
    const entries = fileSystem.readdirSync(stylesDir, { withFileTypes: true });
    const seen = new Set();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.css')) continue;
      const id = entry.name.slice(0, -4);
      if (!id || id === 'base' || seen.has(id) || !/^[a-z0-9-]{1,24}$/i.test(id)) continue;
      seen.add(id);
      themes.push({
        id: id.toLowerCase(),
        label: THEME_LABELS[id] || id
      });
    }
  } catch {
    // 目录读不到（打包后路径变化等）就给空列表：界面回落到 base 自带的外观
  }

  // 顺序稳定：内置先（dark → light），其它的按 id 排在后面
  const priority = { dark: 0, light: 1 };
  themes.sort((a, b) => {
    const pa = Object.prototype.hasOwnProperty.call(priority, a.id) ? priority[a.id] : 99;
    const pb = Object.prototype.hasOwnProperty.call(priority, b.id) ? priority[b.id] : 99;
    return pa - pb || a.id.localeCompare(b.id);
  });

  return { dir: path.resolve(stylesDir), themes };
}

/** 主题 ID 是否合法（只防误写，不必是文件夹里已有的） */
function isValidThemeId(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,24}$/.test(value);
}

module.exports = { listThemes, isValidThemeId, THEME_LABELS, BASE_CSS_NAME };
