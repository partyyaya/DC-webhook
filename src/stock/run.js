/**
 * 主流程模組：完成一次每日股票新聞發送。共用的每日流程（多個 Webhook、先刪除前一次的新聞再發送、紀錄）
 * 見 ../shared/daily-digest.js；這裡只負責股票的新聞內容：
 *   以 AI（Codex 或 Claude）網路搜尋發送前 24 小時的台股與美股新聞（news.js），再組成 Discord 訊息（format.js）。
 *   篇數設為 0 的市場不搜尋、不發送。
 *
 * index.js（單次執行）與 scheduler.js（常駐排程）都是呼叫這裡的 runDaily()。
 */
import { config } from './config.js';
import { buildDiscordMessages } from './format.js';
import { buildNewsPrompt, buildNewsSchema, enabledMarkets, MARKETS, parseNews } from './news.js';
import { aiLabel, summarizeWithAi } from '../shared/ai.js';
import { createDailyDigest } from '../shared/daily-digest.js';
import { log } from '../shared/log.js';
import { formatDateInZone, formatInZone } from '../shared/schedule.js';

/** 紀錄輸出用的篇數與股票設定，例如「台股最多 3 則（2330 → 2317）、美股不搜尋」。 */
function describeNews(news) {
  return MARKETS.map((market) => {
    const count = news[market.countKey];
    if (count === 0) return `${market.name}不搜尋`;
    const stocks = news[market.stocksKey];
    return `${market.name}最多 ${count} 則（${stocks.length > 0 ? stocks.join(' → ') : '大盤與重要個股'}）`;
  }).join('、');
}

export const { assertTargets, loadState, isAllCompleted, runDaily } = createDailyDigest({
  topic: 'stock',
  config,
  // 以 AI 搜尋並整理新聞（所有 Webhook 共用同一份新聞）
  async collect({ from, to, timeZone }) {
    log(`以 ${aiLabel(config.ai.provider)} 搜尋新聞：${formatInZone(from, timeZone)} ～ ${formatInZone(to, timeZone)}（時區 ${timeZone}），約需數分鐘…`);
    log(`篇數：${describeNews(config.news)}`);
    const prompt = buildNewsPrompt({ from, to, timeZone, ...config.news });
    const reply = await summarizeWithAi(prompt, { ...config.ai, schema: buildNewsSchema(config.news) });
    const news = parseNews(reply, config.news);
    const markets = enabledMarkets(config.news);
    log(`取得${markets.map((market) => `${market.name}新聞 ${news[market.key].length} 則`).join('、')}：`);
    for (const market of markets) {
      for (const item of news[market.key]) log(`  [${market.name}${item.stocks.length > 0 ? ` ${item.stocks.join('・')}` : ''}] ${item.title}`);
    }
    return { news, messages: buildDiscordMessages(news, { dateLabel: formatDateInZone(to, timeZone) }) };
  },
});
