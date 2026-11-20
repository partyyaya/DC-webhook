/**
 * 常駐排程入口（npm run signal:schedule）：在指定星期的開始～結束時間內，每隔固定分鐘分析一次，
 * 每次先刪除前一次的技術分析訊息，再發送最新的分析。與 Artale 的排程相同，以 days、start、end、intervalMinutes 設定；
 * 預設每天 09:10～22:40、每 60 分鐘一次（09:10、10:10、…、22:10），以台灣時間計算。
 *
 *   - 啟動時若在排程時段內，先分析一次；時段外則等到下一個排程時間。
 *   - 執行失敗時記錄錯誤，等下一個排程時間再執行（前一次的訊息保留在頻道上）。
 *   - 電腦睡眠到時段結束後才喚醒時，略過錯過的那次。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { log, logError } from '../shared/log.js';
import { describeSchedule, formatInZone, isWithinSchedule, nextRunTime } from '../shared/schedule.js';

// 載入設定與主流程。設定有誤時，只顯示原因並結束，而不是一大段錯誤堆疊
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

/** 執行一次分析與發送；失敗時記錄錯誤，等下一個排程時間再執行。 */
async function run() {
  try {
    await runOnce();
  } catch (err) {
    logError(`執行失敗，等下一個排程時間再執行：${err.message}`);
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

if (isWithinSchedule(new Date(), schedule)) {
  log('目前在排程時段內，先分析一次。');
  await run();
}

// 主迴圈：算出下一次執行時間 → 等到該時間 → 執行，一直重複。
// 每次執行完才計算下一次，所以不會有兩次執行同時進行的情況。
for (;;) {
  const next = nextRunTime(new Date(), schedule);
  log(`下次分析時間：${formatInZone(next, schedule.timeZone)}`);
  await sleepUntil(next);

  // 電腦睡眠到排程時段結束後才喚醒時，略過這次，避免在時段外發送
  if (!isWithinSchedule(new Date(), schedule)) {
    log('已錯過這次的排程時間（電腦可能曾進入睡眠），略過。');
    continue;
  }
  await run();
}
