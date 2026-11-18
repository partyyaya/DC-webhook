/**
 * Crypto 設定模組：讀取 env/.env.crypto、共用環境檔與系統環境變數。
 * 每日新聞流程從這裡取得設定；手動 Webhook 入口只讀取自己的必要設定。
 */
import path from 'node:path';
import { MAX_NEWS_COUNT, parseCoins } from './news.js';
import { createSchedule, parseTime } from '../shared/schedule.js';
import { loadProjectEnv, positiveIntFromEnv, ROOT_DIR } from '../shared/env.js';

loadProjectEnv('crypto');

/** 讀取新聞篇數：1～MAX_NEWS_COUNT 的整數（每類新聞發成一則訊息，一則訊息最多 10 張卡片）。 */
function newsCountFromEnv(name, fallback) {
  const count = positiveIntFromEnv(name, fallback);
  if (count > MAX_NEWS_COUNT) throw new Error(`環境變數 ${name} 不能超過 ${MAX_NEWS_COUNT}，目前為「${count}」`);
  return count;
}

// 每日發送時間：先用正確的變數名稱驗證格式，錯誤訊息才會指出 CRYPTO_SCHEDULE_TIME
const scheduleTime = process.env.CRYPTO_SCHEDULE_TIME || '08:00';
parseTime(scheduleTime, 'CRYPTO_SCHEDULE_TIME');

// Crypto 使用的設定值，各欄位的說明與預設值請參考 docs/crypto.md 的「設定參考」章節。
export const config = {
  // Discord Webhook 網址（必填，在 run.js / scheduler.js 檢查）
  discordWebhookUrl: process.env.CRYPTO_DISCORD_WEBHOOK_URL || '',
  // 每日新聞紀錄：最後完成發送的日期，以及目前在 Discord 上、下次要先刪除的新聞訊息 ID
  stateFile: path.resolve(ROOT_DIR, process.env.CRYPTO_STATE_FILE || 'data/crypto/state.json'),
  // 每則 Discord 訊息的新增、修改、刪除紀錄
  discordMessagesFile: path.resolve(ROOT_DIR, process.env.CRYPTO_DISCORD_MESSAGES_FILE || 'data/crypto/discord-messages.jsonl'),
  // 新聞篇數與優先幣種：幣種的填寫順序就是搜尋與排列的優先順序
  news: {
    economyCount: newsCountFromEnv('CRYPTO_ECONOMY_NEWS_COUNT', 3),
    coinCount: newsCountFromEnv('CRYPTO_COIN_NEWS_COUNT', 3),
    priorityCoins: parseCoins(process.env.CRYPTO_PRIORITY_COINS || 'BTC,ADA,ETH'),
  },
  // 呼叫 Discord 時，每個 HTTP 請求的逾時時間
  httpTimeoutMs: 30_000,
  // Codex CLI 相關設定：需要即時網路搜尋，搜尋與整理較久，逾時時間與共用摘要分開設定
  codex: {
    bin: process.env.CODEX_BIN || 'codex',
    model: process.env.CODEX_MODEL || '',
    timeoutMs: positiveIntFromEnv('CRYPTO_CODEX_TIMEOUT_MS', 10 * 60 * 1000),
    webSearch: true,
  },
  // npm run crypto:schedule 常駐模式的排程：預設每天 08:00 發送一次（台灣時間）
  schedule: createSchedule({
    days: process.env.CRYPTO_SCHEDULE_DAYS || '1-7',
    start: scheduleTime,
    end: scheduleTime,
    intervalMinutes: 24 * 60,
    timeZone: process.env.CRYPTO_SCHEDULE_TIMEZONE || 'Asia/Taipei',
  }, { envPrefix: 'CRYPTO_' }),
};
