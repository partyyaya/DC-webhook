/**
 * 主流程模組：完成一次技術分析發送。共用的發送流程（多個 Webhook、先刪除前一次的訊息再發送、紀錄）
 * 見 ../shared/daily-digest.js；每次執行都會發送（不限一天一次），執行頻率由 scheduler.js 的排程決定。
 * 這裡只負責技術分析的內容（K 線固定使用日線）：
 *   1. 取得每個標的的 K 線並計算技術指標；AUTO 先取得成交最熱絡的候選標的（market-data.js、indicators.js）
 *   2. 以 AI（Codex 或 Claude）綜合指標判斷是否做單，給出進場、止盈、止損與原因（signals.js）
 *   3. 組成 Discord 訊息，最後附上免責聲明（format.js）
 * 所有標的都無法取得行情資料時拋錯：不刪除前一次的訊息、也不發送。
 *
 * index.js（單次執行）與 scheduler.js（常駐排程）都是呼叫這裡的 runOnce()。
 */
import { config } from './config.js';
import { buildDiscordMessages } from './format.js';
import { prepareMarkets } from './market-data.js';
import { INTERVALS, isMarketEnabled, MARKETS, marketOf } from './markets.js';
import { buildSignalPrompt, buildSignalSchema, formatPrice, parseSignals } from './signals.js';
import { aiLabel, summarizeWithAi } from '../shared/ai.js';
import { createDailyDigest } from '../shared/daily-digest.js';
import { log, logError } from '../shared/log.js';
import { formatDateInZone } from '../shared/schedule.js';

/** 紀錄輸出用的市場設定，例如「虛擬貨幣 日線（BTC、ETH）、台股 日線（AUTO）」。 */
function describeMarkets(markets) {
  return MARKETS.filter((market) => isMarketEnabled(markets[market.key])).map((market) => {
    const { auto, symbols, interval } = markets[market.key];
    return `${market.name} ${INTERVALS[interval].label}（${auto ? 'AUTO' : symbols.join('、')}）`;
  }).join('、');
}

/** 紀錄輸出用的單一建議，例如「做多（現價）：進場 62000、止盈 65000、止損 60000、風險報酬比 1:2.1」。 */
function describeSignal(signal) {
  if (signal.action !== 'trade') return '觀望';
  const price = (value) => formatPrice(value, signal.price);
  return `${signal.direction === 'short' ? '做空' : '做多'}（${signal.entryType === 'limit' ? '限價' : '現價'}）：進場 ${price(signal.entry)}、止盈 ${price(signal.takeProfit)}、`
    + `止損 ${price(signal.stopLoss)}、風險報酬比 1:${signal.riskReward.toFixed(1)}`;
}

export const { assertTargets, runDaily: runOnce } = createDailyDigest({
  topic: 'signal',
  subject: '技術分析',
  oncePerDay: false,
  config,
  async collect({ to, timeZone }) {
    // 步驟 1：取得行情資料並計算技術指標
    log(`取得行情資料並計算技術指標：${describeMarkets(config.markets)}…`);
    const plan = await prepareMarkets(config.markets, { now: to.getTime(), timeoutMs: config.httpTimeoutMs });
    for (const market of plan) {
      const { name } = marketOf(market.key);
      if (market.failure) continue;
      log(market.auto
        ? `[${name}] AUTO 候選 ${market.candidates} 個，取得 ${market.loaded} 個的資料，其中 ${market.items.length} 個${market.allowShort ? '趨勢明確' : '趨勢向上'}`
        : `[${name}] 取得 ${market.loaded} 個標的的資料`);
    }
    if (plan.every((market) => market.loaded === 0)) throw new Error('所有標的都無法取得行情資料，本次不發送（前一次的訊息保留在頻道上）');

    // 步驟 2：交給 AI 判斷是否做單；AUTO 的候選都沒有通過趨勢篩選時，不需要呼叫 AI
    const total = plan.reduce((sum, market) => sum + market.items.length, 0);
    let reply = '{}';
    if (total > 0) {
      log(`以 ${aiLabel(config.ai.provider)} 判斷是否做單：共 ${total} 個標的，約需數分鐘…`);
      reply = await summarizeWithAi(buildSignalPrompt(plan, { now: to, timeZone }), { ...config.ai, schema: buildSignalSchema(plan) });
    } else {
      log('沒有需要交給 AI 判斷的標的（AUTO 的候選都沒有通過趨勢篩選）。');
    }
    const results = parseSignals(reply, plan);
    for (const market of results) {
      const { name } = marketOf(market.key);
      for (const warning of market.warnings) logError(`[${name}] ${warning}`);
      for (const signal of market.signals) log(`  [${name} ${signal.symbol}] ${describeSignal(signal)}`);
      if (market.auto && !market.failure && market.signals.length === 0) log(`  [${name} AUTO] 沒有符合做單條件的標的`);
    }

    // 步驟 3：組成 Discord 訊息（所有 Webhook 共用同一份內容）
    return { news: results, messages: buildDiscordMessages(results, { dateLabel: formatDateInZone(to, timeZone) }) };
  },
});
