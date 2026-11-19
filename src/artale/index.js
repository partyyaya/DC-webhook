/**
 * 單次執行入口：執行一次「抓公告 → 比對 → 摘要 → 發送 → 記錄」後就結束。
 * 對應的指令：
 *   npm run artale                執行一次完整檢查
 *   npm run artale:preview          預覽模式，不發送也不寫紀錄
 *   npm run artale -- --force     忽略比對結果，強制重新發送
 *   npm run artale -- --category bm   這次只處理指定分類（逗號分隔），不修改設定檔
 *
 * 結束碼：0 = 成功；1 = 一般錯誤；2 = 內容轉譯錯誤（官網結構可能改變，未發送任何訊息）
 */
import { parseArgs } from 'node:util';
import { ContentParseError } from './errors.js';
import { logError } from '../shared/log.js';

// 預設檢查第一頁全部已發布公告；--window 可模擬後續排程的時間區間檢查。
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    window: { type: 'boolean', default: false },
    category: { type: 'string' },
  },
});

// 執行一次主流程；失敗時印出錯誤並以非 0 結束碼結束，讓 cron 等外部工具知道這次執行失敗
try {
  // 在 try 裡才載入主流程（連帶載入 config.js）：環境變數設定有誤時，
  // 錯誤會在這裡被接住並只顯示原因，而不是一大段錯誤堆疊
  const { runOnce } = await import('./run.js');
  // --category：這次只處理指定分類，覆寫設定檔的 newsCategories
  if (values.category !== undefined) {
    const [{ config }, { parseCategories }] = await Promise.all([import('./config.js'), import('./client.js')]);
    config.newsCategories = parseCategories(values.category, '--category');
  }
  await runOnce({ dryRun: values['dry-run'], force: values.force, startup: !values.window });
} catch (err) {
  if (err instanceof ContentParseError) {
    // 內容轉譯錯誤：run.js 已在發送前停止，這次沒有任何訊息被發到 Discord
    logError(`內容轉譯錯誤，已停止，未發送任何訊息到 Discord：${err.message}`);
    logError('官網的網頁結構可能已改變，請檢查 src/artale/client.js 的解析規則。');
    process.exitCode = 2;
  } else {
    logError(`執行失敗：${err.message}`);
    process.exitCode = 1;
  }
}
