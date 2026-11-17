/**
 * 單次執行入口：執行一次「抓公告 → 比對 → 摘要 → 發送 → 記錄」後就結束。
 * 對應的指令：
 *   npm start                執行一次完整檢查
 *   npm run dry-run          預覽模式，不發送也不寫紀錄
 *   npm start -- --force     忽略比對結果，強制重新發送
 * crontab 每小時呼叫的也是這支程式。
 *
 * 結束碼：0 = 成功；1 = 一般錯誤（下次執行會再試）；2 = 內容轉譯錯誤（官網結構可能改變，未發送任何訊息）
 */
import { parseArgs } from 'node:util';
import { ContentParseError } from './errors.js';
import { logError } from './log.js';

// 解析命令列參數：--dry-run 與 --force 兩個開關
const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

// 執行一次主流程；失敗時印出錯誤並以非 0 結束碼結束，讓 cron 等外部工具知道這次執行失敗
try {
  // 在 try 裡才載入主流程（連帶載入 config.js）：環境變數設定有誤時，
  // 錯誤會在這裡被接住並只顯示原因，而不是一大段錯誤堆疊
  const { runOnce } = await import('./run.js');
  await runOnce({ dryRun: values['dry-run'], force: values.force });
} catch (err) {
  if (err instanceof ContentParseError) {
    // 內容轉譯錯誤：run.js 已在發送前停止，這次沒有任何訊息被發到 Discord
    logError(`內容轉譯錯誤，已停止，未發送任何訊息到 Discord：${err.message}`);
    logError('官網的網頁結構可能已改變，請檢查 src/artale.js 的解析規則。');
    process.exitCode = 2;
  } else {
    logError(`執行失敗：${err.message}`);
    process.exitCode = 1;
  }
}
