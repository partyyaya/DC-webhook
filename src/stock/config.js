/**
 * 股票設定模組：讀取主題設定檔 env/stock.js（範例見 env/stock.example.js）與共用的 env/.env.shared。
 * 各欄位的說明與預設值請參考 docs/stock.md 的「設定參考」章節。
 */
import path from 'node:path';
import { MAX_NEWS_COUNT, parseStockCodes } from './news.js';
import { aiSettingsFromEnv } from '../shared/ai.js';
import { createSchedule } from '../shared/schedule.js';
import { loadProjectEnv, ROOT_DIR } from '../shared/env.js';
import { parseWebhookTargets } from '../shared/targets.js';
import { filePath, integer, listText, loadTopicConfig, section, text } from '../shared/topic-config.js';

loadProjectEnv();

const { file: configFile, label, values } = await loadTopicConfig('stock');
const settings = section(values, ['webhooks', 'schedule', 'news', 'aiTimeoutMs', 'files'], label);
const at = (key) => `${label} 的 ${key}`;
const schedule = section(settings.schedule, ['days', 'time', 'timeZone'], at('schedule'));
const news = section(settings.news, ['twStocks', 'usStocks', 'twCount', 'usCount'], at('news'));
const files = section(settings.files, ['state', 'discordMessages'], at('files'));

const scheduleTime = text(schedule.time, '08:00', at('schedule.time'));

// 新聞篇數與股票清單：清單的填寫順序就是搜尋與排列的優先順序；篇數 0 代表不搜尋該市場
const newsSettings = {
  twStocks: parseStockCodes('tw', listText(news.twStocks, '2330,2317,2454', at('news.twStocks')), at('news.twStocks')),
  usStocks: parseStockCodes('us', listText(news.usStocks, 'NVDA,AAPL,MSFT', at('news.usStocks')), at('news.usStocks')),
  twCount: integer(news.twCount, 3, at('news.twCount'), { min: 0, max: MAX_NEWS_COUNT }),
  usCount: integer(news.usCount, 3, at('news.usCount'), { min: 0, max: MAX_NEWS_COUNT }),
};
if (newsSettings.twCount === 0 && newsSettings.usCount === 0) {
  throw new Error(`${at('news')} 的 twCount 與 usCount 不能都是 0，至少要搜尋一種股票的新聞`);
}

export const config = {
  // 設定檔位置（不存在時為 null，全部使用預設值且沒有 Webhook）
  configFile,
  // 要發送的 Webhook 清單（至少一個，在 run.js / scheduler.js 檢查）；以 Webhook ID 區分，name 只用於紀錄輸出。
  // 名稱與頭像的記錄依 Webhook ID 分開存放，不與其他主題共用
  targets: parseWebhookTargets(settings.webhooks, at('webhooks')).map((target) => ({
    ...target,
    // 每個 Webhook 自己的名稱與頭像變更提醒設定（webhooks[].webhookProfile），加上記錄檔位置
    webhookProfile: {
      ...target.webhookProfile,
      profileFile: path.resolve(ROOT_DIR, `data/stock/webhook-profiles/${target.webhookId}.json`),
    },
  })),
  // 每日新聞紀錄：每個 Webhook 最後完成發送的日期，以及目前在 Discord 上、下次要先刪除的新聞訊息 ID
  stateFile: filePath(files.state, 'data/stock/state.json', at('files.state')),
  // 每則 Discord 訊息的新增、修改、刪除紀錄
  discordMessagesFile: filePath(files.discordMessages, 'data/stock/discord-messages.jsonl', at('files.discordMessages')),
  news: newsSettings,
  // 呼叫 Discord 時，每個 HTTP 請求的逾時時間
  httpTimeoutMs: 30_000,
  // AI 摘要：使用的 AI（Codex 或 Claude）、執行檔與模型為共用設定（env/.env.shared）；
  // 需要網路搜尋，逾時時間在主題設定檔另外設定
  ai: {
    ...aiSettingsFromEnv(),
    timeoutMs: integer(settings.aiTimeoutMs, 10 * 60 * 1000, at('aiTimeoutMs')),
    webSearch: true,
  },
  // npm run stock:schedule 常駐模式的排程：預設每天 08:00 發送一次（台灣時間）
  schedule: createSchedule({
    days: listText(schedule.days, '1-7', at('schedule.days')),
    start: scheduleTime,
    end: scheduleTime,
    intervalMinutes: 24 * 60,
    timeZone: text(schedule.timeZone, 'Asia/Taipei', at('schedule.timeZone')),
  }, { names: { days: at('schedule.days'), start: at('schedule.time'), end: at('schedule.time'), timeZone: at('schedule.timeZone') } }),
};
