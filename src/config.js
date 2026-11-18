/**
 * 設定模組：負責讀取 .env 檔與環境變數，整理成全專案共用的 config 物件。
 * 公告流程從這裡取得設定；手動 Webhook 入口只讀取自己的必要設定。
 */
import path from 'node:path';
import { parseCategories } from './artale.js';
import { createSchedule } from './schedule.js';
import { loadProjectEnv, ROOT_DIR } from './env.js';

// 專案根目錄（src 的上一層），用來組出 .env 與狀態檔的絕對路徑，
// 這樣不論從哪個目錄執行（例如 cron），路徑都不會跑掉。
export { ROOT_DIR };

// 若專案根目錄有 .env 檔就載入；系統環境變數中已存在的同名設定會優先，不會被 .env 覆蓋。
loadProjectEnv();

/**
 * 讀取一個「正整數」型態的環境變數。
 * 沒有設定時回傳預設值；設定了但不是正整數時直接拋錯，避免帶著錯誤設定繼續執行。
 *
 * @param {string} name 環境變數名稱
 * @param {number} fallback 未設定時使用的預設值
 * @returns {number}
 */
function positiveIntFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`環境變數 ${name} 必須是正整數，目前為「${raw}」`);
  }
  return value;
}

// 全專案共用的設定值，各欄位的說明與預設值請參考 README 的「環境變數」章節。
export const config = {
  // 預設檢查「維護」、「更新」與「購物商場」，發送優先順序由 run.js 固定
  newsCategories: parseCategories(process.env.ARTALE_NEWS_CATEGORIES || 'maintenance,update,bm'),
  // Discord Webhook 網址（必填，在 run.js / scheduler.js 檢查）
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  // 已發送公告版本的紀錄檔，相對路徑以專案根目錄為準
  stateFile: path.resolve(ROOT_DIR, process.env.STATE_FILE || 'data/state.json'),
  // 每則 Discord 訊息的新增、修改、刪除紀錄，與公告去重紀錄分開儲存
  discordMessagesFile: path.resolve(ROOT_DIR, process.env.DISCORD_MESSAGES_FILE || 'data/discord-messages.jsonl'),
  // 抓官網與呼叫 Discord 時，每個 HTTP 請求的逾時時間
  httpTimeoutMs: 30_000,
  // Codex CLI 相關設定：執行檔、模型、逾時時間
  codex: {
    bin: process.env.CODEX_BIN || 'codex',
    model: process.env.CODEX_MODEL || '',
    timeoutMs: positiveIntFromEnv('CODEX_TIMEOUT_MS', 5 * 60 * 1000),
  },
  // npm run schedule 常駐模式的排程：預設每週二 08:20～17:20，每 60 分鐘檢查一次（台灣時間）
  schedule: createSchedule({
    days: process.env.SCHEDULE_DAYS || '2',
    start: process.env.SCHEDULE_START || '08:20',
    end: process.env.SCHEDULE_END || '17:20',
    intervalMinutes: positiveIntFromEnv('CHECK_INTERVAL_MINUTES', 60),
    timeZone: process.env.SCHEDULE_TIMEZONE || 'Asia/Taipei',
  }),
};
