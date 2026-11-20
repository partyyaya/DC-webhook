/**
 * 單次執行入口：立即執行一次「取得行情與指標 → AI 判斷是否做單 → 刪除前一次的訊息 → 發送最新的技術分析」後就結束，
 * 不受排程星期與時間限制。對應的指令：
 *   npm run signal                 立即分析並發送一次（會先刪除前一次的技術分析訊息）
 *   npm run signal:preview         預覽模式，只分析並印出內容，不刪除、不發送、不寫紀錄
 *
 * 結束碼：0 = 成功；1 = 發生錯誤
 */
import { parseArgs } from 'node:util';
import { logError } from '../shared/log.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
  },
});

try {
  // 在 try 裡才載入主流程（連帶載入 config.js）：設定有誤時只顯示原因，而不是一大段錯誤堆疊
  const { runOnce } = await import('./run.js');
  await runOnce({ dryRun: values['dry-run'] });
} catch (err) {
  logError(`執行失敗：${err.message}`);
  process.exitCode = 1;
}
