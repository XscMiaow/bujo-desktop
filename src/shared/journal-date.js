/**
 * 日期工具（主进程与渲染层共用）：日记文件名、中文星期、时间标签
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.JournalDate = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  function pad(value) {
    return String(value).padStart(2, '0');
  }

  /** 2026-10-07 */
  function dateKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** 2026-10-07.md */
  function dailyFileName(date) {
    return `${dateKey(date)}.md`;
  }

  /** 星期三 */
  function weekdayLabel(date) {
    return `星期${WEEKDAYS[date.getDay()]}`;
  }

  /** 2026-10-07 星期三 */
  function dateLabel(date) {
    return `${dateKey(date)} ${weekdayLabel(date)}`;
  }

  /** 14:32 */
  function timeLabel(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  /** 解析 YYYY-MM-DD 为本地时间的 Date（避免被当成 UTC 而算错星期） */
  function parseDateKey(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  /* ---------------- 年 / 月 文件夹（嵌套的日记目录结构） ---------------- */

  /** 2026 */
  function yearKey(date) {
    return String(date.getFullYear());
  }

  /** 2026-10 */
  function monthKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  }

  /** 年文件夹名：2026 */
  function yearFolderName(date) {
    return yearKey(date);
  }

  /** 月文件夹名：2026-10 */
  function monthFolderName(date) {
    return monthKey(date);
  }

  /** 年度（未来）记录固定文件名；一年一篇，放在年文件夹里（英文命名；旧中文文件名仍会被识别） */
  const FUTURE_RECORD_FILE = 'Future Log.md';
  /** 月度记录固定文件名；一月一篇，放在月文件夹里（英文命名；旧中文文件名仍会被识别） */
  const MONTHLY_RECORD_FILE = 'Monthly Log.md';

  /** 解析 '2026-10' 为这个月 1 号的本地时间 Date，不合法时返回 null */
  function parseMonthKey(text) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(text || ''));
    if (!match) return null;
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return new Date(Number(match[1]), month - 1, 1);
  }

  /** 解析 '2026' 为这年 1 月 1 日的本地时间 Date，不合法时返回 null */
  function parseYearKey(text) {
    if (!/^\d{4}$/.test(String(text || ''))) return null;
    return new Date(Number(text), 0, 1);
  }

  /** 2026 年 10 月（英文：Oct 2026；模板与侧边栏副标题共用） */
  function monthLabel(date) {
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  }

  /** 2026 */
  function yearLabel(date) {
    return String(date.getFullYear());
  }

  return {
    dateKey,
    dailyFileName,
    weekdayLabel,
    dateLabel,
    timeLabel,
    parseDateKey,
    yearKey,
    monthKey,
    yearFolderName,
    monthFolderName,
    FUTURE_RECORD_FILE,
    MONTHLY_RECORD_FILE,
    parseMonthKey,
    parseYearKey,
    monthLabel,
    yearLabel,
    WEEKDAYS
  };
});
