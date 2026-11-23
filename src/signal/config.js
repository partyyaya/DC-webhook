/**
 * 技術指標設定模組：讀取主題設定檔 env/signal.js（範例見 env/signal.example.js）與共用的 env/.env.shared。
 * 各欄位的說明與預設值請參考 docs/signal.md 的「設定參考」章節。
 */
import path from 'node:path';
import { isMarketEnabled, MARKETS, MAX_SYMBOLS, parseMarketSymbols, SIGNAL_INTERVAL } from './markets.js';
import { logError } from '../shared/log.js';
import { aiSettingsFromEnv } from '../shared/ai.js';
import { createSchedule } from '../shared/schedule.js';
import { loadProjectEnv, ROOT_DIR } from '../shared/env.js';
import { parseWebhookTargets } from '../shared/targets.js';
import { boolean, filePath, integer, listText, loadTopicConfig, section, text } from '../shared/topic-config.js';

loadProjectEnv();

const { file: configFile, label, values } = await loadTopicConfig('signal');
const settings = section(values, ['webhooks', 'schedule', 'markets', 'aiTimeoutMs', 'files'], label);
const at = (key) => `${label} 的 ${key}`;
const schedule = section(settings.schedule, ['days', 'start', 'end', 'intervalMinutes', 'timeZone'], at('schedule'));
const marketSettings = section(settings.markets, MARKETS.map((market) => market.key), at('markets'));
const files = section(settings.files, ['state', 'discordMessages'], at('files'));

// 每個市場的標的（代號清單或 AUTO；空的代表不分析）與是否可以做空；K 線固定使用日線
const markets = Object.fromEntries(MARKETS.map((market) => {
  const where = at(`markets.${market.key}`);
  const value = section(marketSettings[market.key], ['symbols', 'allowShort'], where);
  const symbolsKey = `${where}.symbols`;
  // 超過 MAX_SYMBOLS 個時只取前面的，略過的在終端機提醒
  const { dropped, ...parsed } = parseMarketSymbols(market.key, listText(value.symbols, market.defaultSymbols, symbolsKey), symbolsKey);
  if (dropped.length > 0) logError(`${symbolsKey} 超過 ${MAX_SYMBOLS} 個，只分析前 ${MAX_SYMBOLS} 個，略過：${dropped.join('、')}`);
  return [market.key, {
    ...parsed,
    interval: SIGNAL_INTERVAL,
    allowShort: boolean(value.allowShort, true, `${where}.allowShort`),
  }];
}));
if (!Object.values(markets).some(isMarketEnabled)) {
  throw new Error(`${at('markets')} 至少要有一個市場的 symbols 填寫代號或 AUTO`);
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
      profileFile: path.resolve(ROOT_DIR, `data/signal/webhook-profiles/${target.webhookId}.json`),
    },
  })),
  // 每日紀錄：每個 Webhook 最後完成發送的日期，以及目前在 Discord 上、下次要先刪除的訊息 ID
  stateFile: filePath(files.state, 'data/signal/state.json', at('files.state')),
  // 每則 Discord 訊息的新增、修改、刪除紀錄
  discordMessagesFile: filePath(files.discordMessages, 'data/signal/discord-messages.jsonl', at('files.discordMessages')),
  markets,
  // 呼叫 Discord 與行情網站時，每個 HTTP 請求的逾時時間
  httpTimeoutMs: 30_000,
  // AI 判斷：使用的 AI（Codex 或 Claude）、執行檔與模型為共用設定（env/.env.shared）；
  // 指標已由程式計算，不需要網路搜尋，逾時時間在主題設定檔另外設定
  ai: {
    ...aiSettingsFromEnv(),
    timeoutMs: integer(settings.aiTimeoutMs, 10 * 60 * 1000, at('aiTimeoutMs')),
    webSearch: false,
  },
  // npm run signal:schedule 常駐模式的排程：預設每天 09:10～22:40，每 60 分鐘分析一次（09:10、10:10、…、22:10，台灣時間）
  schedule: createSchedule({
    days: listText(schedule.days, '1-7', at('schedule.days')),
    start: text(schedule.start, '09:10', at('schedule.start')),
    end: text(schedule.end, '22:40', at('schedule.end')),
    intervalMinutes: integer(schedule.intervalMinutes, 60, at('schedule.intervalMinutes')),
    timeZone: text(schedule.timeZone, 'Asia/Taipei', at('schedule.timeZone')),
  }, { names: { days: at('schedule.days'), start: at('schedule.start'), end: at('schedule.end'), timeZone: at('schedule.timeZone') } }),
};
