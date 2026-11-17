/**
 * 排程時間模組：解析排程相關的環境變數，並計算「下一次檢查時間」、判斷「現在是否在排程時段內」。
 *
 * 排程設定由以下環境變數組成（在 config.js 讀取）：
 *   SCHEDULE_DAYS           星期幾，1～7（1=週一、7=週日），可用逗號與範圍，例如 2、1-5、2,4
 *   SCHEDULE_START          每天開始檢查的時間（HH:MM）
 *   SCHEDULE_END            每天最後一次檢查的時間（HH:MM）
 *   CHECK_INTERVAL_MINUTES  檢查間隔（分鐘）
 *   SCHEDULE_TIMEZONE       計算時間用的時區
 *
 * 例如每週二、08:20～17:20、間隔 60 分鐘，檢查時間為 08:20、09:20、…、17:20，共 10 次。
 * 所有時間都以 SCHEDULE_TIMEZONE 計算，與執行程式的電腦時區設定無關。
 */

// 星期的中文名稱，索引與 JavaScript 的 getUTCDay() 相同（0=週日、1=週一 … 6=週六）
const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

// 依時區快取 Intl.DateTimeFormat，避免每次換算時間都重新建立
const formatters = new Map();

/**
 * 把環境變數的原始字串解析並驗證成排程設定物件。設定有誤時拋出說明清楚的錯誤。
 *
 * @param {object} raw
 * @param {string} raw.days SCHEDULE_DAYS 原始字串
 * @param {string} raw.start SCHEDULE_START 原始字串
 * @param {string} raw.end SCHEDULE_END 原始字串
 * @param {number} raw.intervalMinutes 檢查間隔（分鐘）
 * @param {string} raw.timeZone 時區名稱
 * @returns {{days: Set<number>, start: number, end: number, intervalMinutes: number, timeZone: string}}
 *   days 為 0～6 的星期集合（0=週日）；start、end 為「當天第幾分鐘」（08:20 → 500）
 */
export function createSchedule({ days, start, end, intervalMinutes, timeZone }) {
  const schedule = {
    days: parseDays(days),
    start: parseTime(start, 'SCHEDULE_START'),
    end: parseTime(end, 'SCHEDULE_END'),
    intervalMinutes,
    timeZone: validateTimeZone(timeZone),
  };
  if (schedule.start > schedule.end) {
    throw new Error(`SCHEDULE_START（${start}）不能晚於 SCHEDULE_END（${end}），目前不支援跨越午夜的時段`);
  }
  return schedule;
}

/**
 * 解析 SCHEDULE_DAYS，例如「2」「1-5」「2,4」「1-3,6」。
 * 1～6 為週一～週六，7 或 0 都代表週日。
 *
 * @param {string} text 原始字串
 * @returns {Set<number>} 0～6 的星期集合（0=週日，與 getUTCDay() 相同）
 */
export function parseDays(text) {
  const formatError = new Error(`SCHEDULE_DAYS 格式錯誤：「${text}」，請使用 1～7（1=週一、7=週日），例如 2、1-5 或 2,4`);
  const days = new Set();

  // 以逗號分隔，每一段可以是單一數字（2）或範圍（1-5）
  for (const part of String(text).split(',').map((s) => s.trim()).filter(Boolean)) {
    const match = part.match(/^(\d)(?:-(\d))?$/);
    if (!match) throw formatError;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from > 7 || to > 7 || from > to) throw formatError;
    // 7 % 7 = 0，讓 7 與 0 都對應到週日
    for (let day = from; day <= to; day++) days.add(day % 7);
  }

  if (days.size === 0) throw formatError;
  return days;
}

/**
 * 解析 24 小時制的「HH:MM」時間。
 *
 * @param {string} text 原始字串，例如 08:20
 * @param {string} name 環境變數名稱，用於錯誤訊息
 * @returns {number} 當天第幾分鐘，例如 08:20 → 500
 */
export function parseTime(text, name) {
  const match = String(text).trim().match(/^(\d{1,2}):(\d{2})$/);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) {
    throw new Error(`${name} 格式錯誤：「${text}」，請使用 24 小時制 HH:MM，例如 08:20`);
  }
  return hour * 60 + minute;
}

/**
 * 確認時區名稱有效（例如 Asia/Taipei、UTC），無效時拋錯。
 *
 * @param {string} timeZone 時區名稱
 * @returns {string} 原本的時區名稱
 */
function validateTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    throw new Error(`SCHEDULE_TIMEZONE 不是有效的時區：「${timeZone}」，例如 Asia/Taipei`);
  }
}

/**
 * 計算下一次檢查的時間（一定晚於 now）。
 * 從今天開始往後找 8 天（含下週的同一天），依序檢查每一天是否為排程星期，
 * 再從開始時間起每隔 intervalMinutes 產生檢查時間，直到結束時間為止，回傳第一個晚於 now 的時間。
 *
 * @param {Date} now 目前時間
 * @param {object} schedule createSchedule() 的結果
 * @returns {Date} 下一次檢查的時間
 */
export function nextRunTime(now, { days, start, end, intervalMinutes, timeZone }) {
  // 以排程時區的「今天」為起點
  const today = zonedParts(now, timeZone);

  for (let offset = 0; offset <= 7; offset++) {
    // 用 UTC 做純日期加減，取得往後第 offset 天的年月日與星期（不受時區影響）
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!days.has(date.getUTCDay())) continue;

    // 這一天的每一個檢查時間點，換算成實際時間後與 now 比較
    for (let minutes = start; minutes <= end; minutes += intervalMinutes) {
      const runAt = zonedTimeToDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minutes, timeZone);
      if (runAt > now) return runAt;
    }
  }

  // createSchedule() 保證至少有一個星期，所以 8 天內一定找得到
  throw new Error('找不到下一次排程時間，請確認排程設定');
}

/**
 * 判斷某個時間是否落在排程時段內（排程星期的開始～結束時間之間，以分鐘為單位比較）。
 * 用於：啟動時決定要不要先檢查一次，以及電腦睡眠喚醒後判斷是否已錯過時段。
 *
 * @param {Date} date 要判斷的時間
 * @param {object} schedule createSchedule() 的結果
 * @returns {boolean}
 */
export function isWithinSchedule(date, { days, start, end, timeZone }) {
  const parts = zonedParts(date, timeZone);
  const minutes = parts.hour * 60 + parts.minute;
  return days.has(weekdayOf(parts)) && minutes >= start && minutes <= end;
}

/**
 * 把排程設定轉成易讀的中文說明，例如「每週二 08:20～17:20，每 60 分鐘檢查一次（時區 Asia/Taipei）」。
 *
 * @param {object} schedule createSchedule() 的結果
 * @returns {string}
 */
export function describeSchedule({ days, start, end, intervalMinutes, timeZone }) {
  // 依週一到週日的順序列出星期
  const dayText = [1, 2, 3, 4, 5, 6, 0]
    .filter((day) => days.has(day))
    .map((day) => `週${WEEKDAY_NAMES[day]}`)
    .join('、');
  return `每${dayText} ${formatMinutes(start)}～${formatMinutes(end)}，每 ${intervalMinutes} 分鐘檢查一次（時區 ${timeZone}）`;
}

/**
 * 以指定時區格式化時間，例如「2026-11-24（週二）08:20」，用於紀錄輸出。
 *
 * @param {Date} date 要格式化的時間
 * @param {string} timeZone 時區名稱
 * @returns {string}
 */
export function formatInZone(date, timeZone) {
  const parts = zonedParts(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}（週${WEEKDAY_NAMES[weekdayOf(parts)]}）${pad(parts.hour)}:${pad(parts.minute)}`;
}

/**
 * 取得某個時間在指定時區的年、月、日、時、分、秒。
 *
 * @param {Date} date 時間
 * @param {string} timeZone 時區名稱
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number}}
 */
function zonedParts(date, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }

  // formatToParts 會回傳 [{type: 'year', value: '2026'}, ...]，轉成 { year: 2026, ... }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, Number(value)]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/**
 * 由年月日算出星期幾。
 *
 * @param {{year: number, month: number, day: number}} parts
 * @returns {number} 0～6（0=週日）
 */
function weekdayOf({ year, month, day }) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * 把「指定時區的某天某時某分」換算成實際的時間點（Date）。
 * 做法：先把牆上時間當成 UTC，再減去該時區與 UTC 的時差；
 * 為了處理有日光節約時間的時區，用換算後的時間點再算一次時差修正。
 *
 * @param {number} year 年
 * @param {number} month 月（1～12）
 * @param {number} day 日
 * @param {number} minutes 當天第幾分鐘
 * @param {string} timeZone 時區名稱
 * @returns {Date}
 */
function zonedTimeToDate(year, month, day, minutes, timeZone) {
  const wallClock = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let instant = wallClock - timeZoneOffsetMs(new Date(wallClock), timeZone);
  instant = wallClock - timeZoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/**
 * 計算某個時間點上，指定時區與 UTC 的時差（毫秒），例如 Asia/Taipei 為 +8 小時。
 *
 * @param {Date} date 時間點
 * @param {string} timeZone 時區名稱
 * @returns {number}
 */
function timeZoneOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * 把「當天第幾分鐘」轉回「HH:MM」，例如 500 → 08:20。
 *
 * @param {number} minutes
 * @returns {string}
 */
function formatMinutes(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
