/**
 * Artale 設定模組：讀取主題設定檔 env/artale.js（範例見 env/artale.example.js）與共用的 env/.env.shared。
 * 各欄位的說明與預設值請參考 docs/artale.md 的「設定參考」章節。
 */
import path from 'node:path';
import { parseCategories } from './client.js';
import { createSchedule } from '../shared/schedule.js';
import { loadProjectEnv, positiveIntFromEnv, ROOT_DIR } from '../shared/env.js';
import { parseWebhookTargets } from '../shared/targets.js';
import { filePath, integer, listText, loadTopicConfig, section, text } from '../shared/topic-config.js';

// 由共用 env.js 取得專案根目錄，用來組出狀態檔的絕對路徑，不受 Artale 模組所在位置與目前執行目錄影響。
export { ROOT_DIR };

loadProjectEnv();

const { file: configFile, label, values } = await loadTopicConfig('artale');
const settings = section(values, ['webhooks', 'newsCategories', 'schedule', 'files'], label);
const at = (key) => `${label} 的 ${key}`;
const schedule = section(settings.schedule, ['days', 'start', 'end', 'intervalMinutes', 'timeZone'], at('schedule'));
const files = section(settings.files, ['state', 'discordMessages'], at('files'));


export const config = {
  // 設定檔位置（不存在時為 null，全部使用預設值且沒有 Webhook）
  configFile,
  // 預設檢查「維護」、「更新」與「購物商場」，發送優先順序由 run.js 固定
  newsCategories: parseCategories(listText(settings.newsCategories, 'maintenance,update,bm', at('newsCategories')), at('newsCategories')),
  // 要發送的 Webhook 清單（正式發送至少一個，在 run.js / scheduler.js 檢查）；以 Webhook ID 區分，name 只用於紀錄輸出。
  // 名稱與頭像的記錄依 Webhook ID 分開存放，不與其他主題共用
  targets: parseWebhookTargets(settings.webhooks, at('webhooks')).map((target) => ({
    ...target,
    // 每個 Webhook 自己的名稱與頭像變更提醒設定（webhooks[].webhookProfile），加上記錄檔位置
    webhookProfile: {
      ...target.webhookProfile,
      profileFile: path.resolve(ROOT_DIR, `data/artale/webhook-profiles/${target.webhookId}.json`),
    },
  })),
  // 已發送公告版本的紀錄檔（依 Webhook 分開記錄）
  stateFile: filePath(files.state, 'data/artale/state.json', at('files.state')),
  // 每則 Discord 訊息的新增、修改、刪除紀錄，與公告去重紀錄分開儲存
  discordMessagesFile: filePath(files.discordMessages, 'data/artale/discord-messages.jsonl', at('files.discordMessages')),
  // 抓官網與呼叫 Discord 時，每個 HTTP 請求的逾時時間
  httpTimeoutMs: 30_000,
  // Codex CLI：執行檔、模型與摘要逾時時間為共用設定（env/.env.shared）
  codex: {
    bin: process.env.CODEX_BIN || 'codex',
    model: process.env.CODEX_MODEL || '',
    timeoutMs: positiveIntFromEnv('CODEX_TIMEOUT_MS', 5 * 60 * 1000),
  },
  // npm run artale:schedule 常駐模式的排程：預設每週二 08:20～17:20，每 60 分鐘檢查一次（台灣時間）
  schedule: createSchedule({
    days: listText(schedule.days, '2', at('schedule.days')),
    start: text(schedule.start, '08:20', at('schedule.start')),
    end: text(schedule.end, '17:20', at('schedule.end')),
    intervalMinutes: integer(schedule.intervalMinutes, 60, at('schedule.intervalMinutes')),
    timeZone: text(schedule.timeZone, 'Asia/Taipei', at('schedule.timeZone')),
  }, { names: { days: at('schedule.days'), start: at('schedule.start'), end: at('schedule.end'), timeZone: at('schedule.timeZone') } }),
};
