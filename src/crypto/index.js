/**
 * 單次執行入口：立即執行一次「搜尋新聞 → 刪除前一次的新聞 → 發送今天的新聞」後就結束，不受排程星期與時間限制。
 * 對應的指令：
 *   npm run crypto                今天尚未發送時執行一次（已發送過則略過）
 *   npm run crypto:preview        預覽模式，只搜尋並印出內容，不刪除、不發送、不寫紀錄
 *   npm run crypto -- --force     今天已發送過仍重新發送（會先刪除目前的新聞訊息）
 *
 * 結束碼：0 = 成功或今天已發送過；1 = 發生錯誤
 */
import { parseArgs } from 'node:util';
import { logError } from '../shared/log.js';

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  },
});

try {
  // 在 try 裡才載入主流程（連帶載入 config.js）：環境變數設定有誤時只顯示原因，而不是一大段錯誤堆疊
  const { runDaily } = await import('./run.js');
  await runDaily({ dryRun: values['dry-run'], force: values.force });
} catch (err) {
  logError(`執行失敗：${err.message}`);
  process.exitCode = 1;
}
