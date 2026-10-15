'use strict';

/**
 * 界面 i18n 助手（locales/ 文件夹里的 zh-CN.js / en.js 等语言包 + 这里的组长）。
 *
 * - 字典由 index.html 先于本文件加载（window.I18N_ZH / window.I18N_EN settings…）；
 * - I18n.setLocale(id) 切换当前语言并存到 localStorage（下次启动先用它，拿到设置后再校正）；
 * - 取词 I18n.t(key, params)：当前语言的字典 → 缺键回落中文 → 再缺就原样返回 key；
 * - 静态界面文案：html 里写 data-i18n="key" / data-i18n-title="key"，applyStatic() 一次填好。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.I18n = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  var STORAGE_KEY = 'bujo.locale';
  var DEFAULT_LOCALE = 'zh-CN';

  var dicts = {};       // 语言 id → 字典（新语言的映射表也在这里登记一行）
  var locale = DEFAULT_LOCALE;
  var listeners = [];   // setLocale 时通知（渲染层重画界面）
  var self_ = null;     // 全局对象缓存（collectDicts 里取，读字典用）

  /** 语言包全局变量 → 语言 id（新语包文件在 index.html 加载后在这里注册） */
  var DICT_GLOBALS = {
    I18N_ZH: ['zh', 'zh-CN'],
    I18N_EN: ['en']
  };

  function collectDicts() {
    dicts = {};
    // 注意：不能用 var self —— 函数作用域声明会遮蔽全局，typeof 变成 undefined
    var scope = typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : null;
    self_ = scope;
    if (!scope) return;
    Object.keys(DICT_GLOBALS).forEach(function (globalKey) {
      var ids = DICT_GLOBALS[globalKey];
      var dict = self[globalKey];
      if (dict && typeof dict === 'object') {
        ids.forEach(function (id) { dicts[id.toLowerCase()] = dict; });
      }
    });
  }

  /** 用 {name} 占位符替换参数 */
  function interpolate(template, params) {
    if (!params) return template;
    return String(template).replace(/\{(\w+)\}/g, function (_, name) {
      return params[name] !== undefined && params[name] !== null ? String(params[name]) : '{' + name + '}';
    });
  }

  /**
   * 取词。找不到键时回落到默认中文，都没有就显示 key 本身（清晰可见的缺失，不静默吞掉）。
   * @param {string} key
   * @param {Record<string, string|number>} [params] 占位符参数
   */
  function t(key, params) {
    var current = dicts[locale] || {};
    var fallback = dicts[DEFAULT_LOCALE] || {};
    var template = current[key] !== undefined ? current[key] : fallback[key];
    if (template === undefined) return key;
    return interpolate(template, params);
  }

  /** 有没有这个语言包（界面下拉的启用依据之一） */
  function hasLocale(id) {
    return Boolean(dicts[String(id || '').toLowerCase()]);
  }

  function availableLocales() {
    return Object.keys(dicts);
  }

  /** 切换语言：写 localStorage 并通知监听者；语言包缺失时保持默认中文 */
  function setLocale(id, options) {
    id = String(id || '').toLowerCase();
    if (!dicts[id]) id = DEFAULT_LOCALE;
    var changed = id !== locale;
    locale = id;
    if (changed || (options && options.force)) {
      try {
        localStorage.setItem(STORAGE_KEY, locale);
      } catch { /* 存不了只影响记忆，本次界面正常 */ }
      applyStatic();
      listeners.slice().forEach(function (listener) {
        try { listener(locale); } catch { /* 单个监听坏不影响其它 */ }
      });
    }
    return locale;
  }

  /** 读记忆里的语言（还没有设置文件时先用它） */
  function rememberedLocale() {
    try {
      return localStorage.getItem(STORAGE_KEY) || DEFAULT_LOCALE;
    } catch {
      return DEFAULT_LOCALE;
    }
  }

  /** 静态文案：[data-i18n] → textContent；[data-i18n-title] → title；[data-i18n-aria] → aria-label；
   *  [data-i18n-placeholder] → placeholder；[data-i18n-html] → innerHTML（换行转 <br>，段落性文案用） */
  function applyStatic(rootElement) {
    var root = rootElement || document;
    root.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    root.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    root.querySelectorAll('[data-i18n-html]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html')).replace(/\n/g, '<br />');
    });
  }

  /** 语言变化订阅：返回取消订阅函数 */
  function onChange(listener) {
    listeners.push(listener);
    return function () {
      listeners = listeners.filter(function (item) { return item !== listener; });
    };
  }

  function getLocale() {
    return locale;
  }

  collectDicts();
  locale = rememberedLocale().toLowerCase(); // 字典键统一小写（zh-CN 与 zh-cn 等价）
  if (!dicts[locale]) locale = DEFAULT_LOCALE.toLowerCase();

  return { t, setLocale, getLocale, hasLocale, availableLocales, rememberedLocale, applyStatic, onChange };
});
