/**
 * 常駐排程入口（npm run artale:schedule）：
 * 啟動時依分類篇數上限檢查第一頁，之後只在指定星期與時段內，每隔固定分鐘檢查一次。
 * 預設為每週二 08:20～17:20、每 60 分鐘一次（08:20、09:20、…、17:20），以台灣時間計算。
 * 排程在 env/artale.js 的 schedule 調整（days、start、end、intervalMinutes、timeZone），時間計算邏輯在 schedule.js。
 *
 * 發生內容轉譯錯誤（官網結構可能改變）時，排程會立即停止並以結束碼 2 結束，不再繼續輪詢。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { ContentParseError } from './errors.js';
import { log, logError } from '../shared/log.js';
import { describeSchedule, formatInZone, isWithinSchedule, nextRunTime } from '../shared/schedule.js';

// 載入設定與主流程。設定有誤（例如排程、分類格式錯誤）時，只顯示原因並結束，
// 而不是一大段錯誤堆疊
let config;
let runOnce;
let assertTargets;
try {
  ({ config } = await import('./config.js'));
  ({ runOnce, assertTargets } = await import('./run.js'));
} catch (err) {
  logError(`設定錯誤，排程不啟動：${err.message}`);
  process.exit(1);
}

// 啟動前先確認 Webhook 已設定，沒設定就直接結束，避免每次排程都失敗
try {
  assertTargets();
} catch (err) {
  logError(`${err.message}，排程不啟動。`);
  process.exit(1);
}

const { schedule } = config;

/**
 * 執行一次檢查。
 *   - 內容轉譯錯誤：轉出來的內容不可信，停止整個排程程式（不再輪詢），等人工確認官網結構後再重新啟動。
 *   - 其他錯誤：記錄後繼續排程；版本更新重試最新三篇，其他分類仍需在該輪時間範圍內。
 */
async function check(options = {}) {
  try {
    await runOnce(options);
  } catch (err) {
    if (err instanceof ContentParseError) {
      logError(`內容轉譯錯誤，未發送任何訊息到 Discord：${err.message}`);
      logError('官網的網頁結構可能已改變，排程已停止。修正 src/artale/client.js 的解析規則後，請重新執行 npm run artale:schedule。');
      process.exit(2);
    }
    logError(`執行失敗：${err.message}`);
  }
}

/**
 * 等待到指定的時間點。
 * 每次最多等 1 分鐘就重新確認目前時間：電腦睡眠時計時器會暫停，
 * 分段等待才能在喚醒後依實際時間判斷，而不是多等一段睡眠的時間。
 *
 * @param {Date} target 要等到的時間點
 */
async function sleepUntil(target) {
  for (let remaining = target.getTime() - Date.now(); remaining > 0; remaining = target.getTime() - Date.now()) {
    await sleep(Math.min(remaining, 60_000));
  }
}

log(`排程模式啟動：${describeSchedule(schedule)}；共 ${config.targets.length} 個 Webhook`);

// 啟動時不受星期與時段限制；後續版本更新持續比對最新三篇，其他分類套用回溯時間區間。
log('啟動時先檢查一次第一頁公告。');
await check({ startup: true });

// 主迴圈：算出下一次檢查時間 → 等到該時間 → 檢查，一直重複。
// 每次檢查完才計算下一次，所以不會有兩次檢查同時進行的情況。
for (;;) {
  const next = nextRunTime(new Date(), schedule);
  log(`下次檢查時間：${formatInZone(next, schedule.timeZone)}`);
  await sleepUntil(next);

  // 電腦睡眠到排程時段結束後才喚醒時，略過這次，避免在時段外檢查
  if (!isWithinSchedule(new Date(), schedule)) {
    log('已錯過這次的排程時間（電腦可能曾進入睡眠），略過。');
    continue;
  }
  await check();
}
