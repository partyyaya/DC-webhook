/** 以官網發布時間比較公告新舊，不採用標題日期或內文的維護時段。 */
export function getPublishedTime(announcement) {
  const value = announcement?.publishedAt || announcement?.date;
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC 會自動進位，需避免把 2/30 或 24:00 誤判成有效發布時間。
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return undefined;
  // 官網以台灣時間（GMT+8）顯示；只提供日期時視為當日 00:00。
  return date.getTime() - 8 * 60 * 60 * 1000;
}
