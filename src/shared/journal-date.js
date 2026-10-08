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

  return { dateKey, dailyFileName, weekdayLabel, dateLabel, timeLabel, parseDateKey, WEEKDAYS };
});
