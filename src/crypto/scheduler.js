/**
 * 常駐排程入口（npm run crypto:schedule）：每天在指定時間發送一次新聞，預設每天 08:00（台灣時間）。
 * 排程在 env/crypto.js 的 schedule 調整（days、time、timeZone）。
 *
 *   - 補發：啟動時或電腦睡眠喚醒後，若「今天的發送時間已過、但今天還沒發送完成」，立即發送一次。
 *     只補當天，不補前幾天。
 *   - 重試：發送失敗時隔 RETRY_MINUTES 分鐘再試，同一天最多 MAX_ATTEMPTS_PER_DAY 次，之後等隔天的排程。
 *   - 是否已發送以紀錄檔（data/crypto/state.json）中每個 Webhook 的 completedDate 判斷，重新啟動也不會重複發送；
 *     有多個 Webhook 時，全部完成才算今天已發送，重試時只處理尚未完成的 Webhook。
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { log, logError } from '../shared/log.js';
import { dateKeyInZone, describeSchedule, formatInZone, latestRunTimeToday, nextRunTime } from '../shared/schedule.js';

// 發送失敗後的重試間隔，以及同一天最多嘗試的次數（每次都會重新呼叫 Codex 搜尋）
const RETRY_MINUTES = 30;
const MAX_ATTEMPTS_PER_DAY = 3;

// 載入設定與主流程。環境變數設定有誤時，只顯示原因並結束，而不是一大段錯誤堆疊
let config;
let run;
try {
  ({ config } = await import('./config.js'));
  run = await import('./run.js');
} catch (err) {
  logError(`設定錯誤，排程不啟動：${err.message}`);
  process.exit(1);
}

// 啟動前先確認 Webhook 已設定，沒設定就直接結束，避免每次排程都失敗
try {
  run.assertTargets();
} catch (err) {
  logError(`${err.message}，排程不啟動。`);
  process.exit(1);
}

const { schedule } = config;

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

/**
 * 今天是否所有 Webhook 都已發送完成。紀錄檔損壞時無法判斷，停止排程等人工處理，避免每次都失敗或重複發送。
 *
 * @param {string} today 今天的日期（YYYY-MM-DD）
 * @returns {Promise<boolean>}
 */
async function isCompleted(today) {
  try {
    return run.isAllCompleted(await run.loadState(), today);
  } catch (err) {
    logError(`${err.message}，排程已停止。修正或移除紀錄檔後，請重新執行 npm run crypto:schedule。`);
    process.exit(1);
  }
}

log(`排程模式啟動：${describeSchedule(schedule)}；共 ${config.targets.length} 個 Webhook；當天時間已過但尚未發送時會立即補發。`);

// 主迴圈：判斷今天是否需要發送 → 發送（失敗時稍後重試）→ 等到下一次排程時間，一直重複。
// 每次發送完才計算下一次，所以不會有兩次發送同時進行的情況。
let attemptDate = null;
let attempts = 0;
for (;;) {
  const now = new Date();
  const today = dateKeyInZone(now, schedule.timeZone);
  if (attemptDate !== today) {
    attemptDate = today;
    attempts = 0;
  }

  // 今天的發送時間已過、尚未完成、還有嘗試次數 → 立即發送
  if (latestRunTimeToday(now, schedule) && attempts < MAX_ATTEMPTS_PER_DAY && !(await isCompleted(today))) {
    attempts++;
    try {
      await run.runDaily();
      continue;
    } catch (err) {
      logError(`執行失敗（今天第 ${attempts} 次）：${err.message}`);
    }
    const retryAt = new Date(Date.now() + RETRY_MINUTES * 60_000);
    if (attempts < MAX_ATTEMPTS_PER_DAY && dateKeyInZone(retryAt, schedule.timeZone) === today) {
      log(`${RETRY_MINUTES} 分鐘後重試：${formatInZone(retryAt, schedule.timeZone)}`);
      await sleepUntil(retryAt);
      continue;
    }
    logError('今天不再重試，等待下一次排程；也可以修正問題後執行 npm run crypto 手動發送。');
  }

  const next = nextRunTime(new Date(), schedule);
  log(`下次發送時間：${formatInZone(next, schedule.timeZone)}`);
  await sleepUntil(next);
}
