/**
 * 主流程模組：完成一次每日新聞發送。共用的每日流程（多個 Webhook、先刪除前一次的新聞再發送、紀錄）
 * 見 ../shared/daily-digest.js；這裡只負責 Crypto 的新聞內容：
 *   以 AI（Codex 或 Claude）網路搜尋發送前 24 小時的美國經濟與虛擬貨幣新聞（news.js），再組成 Discord 訊息（format.js）。
 *
 * index.js（單次執行）與 scheduler.js（常駐排程）都是呼叫這裡的 runDaily()。
 */
import { config } from './config.js';
import { buildDiscordMessages } from './format.js';
import { buildNewsPrompt, NEWS_SCHEMA, parseNews } from './news.js';
import { aiLabel, summarizeWithAi } from '../shared/ai.js';
import { createDailyDigest } from '../shared/daily-digest.js';
import { log } from '../shared/log.js';
import { formatDateInZone, formatInZone } from '../shared/schedule.js';

export const { assertTargets, loadState, isAllCompleted, runDaily } = createDailyDigest({
  topic: 'crypto',
  config,
  // 以 AI 搜尋並整理新聞（所有 Webhook 共用同一份新聞）
  async collect({ from, to, timeZone }) {
    log(`以 ${aiLabel(config.ai.provider)} 搜尋新聞：${formatInZone(from, timeZone)} ～ ${formatInZone(to, timeZone)}（時區 ${timeZone}），約需數分鐘…`);
    log(`篇數：美國經濟 ${config.news.economyCount} 則、虛擬貨幣最多 ${config.news.coinCount} 則；幣種優先順序：${config.news.priorityCoins.join(' → ')}`);
    const prompt = buildNewsPrompt({ from, to, timeZone, ...config.news });
    const reply = await summarizeWithAi(prompt, { ...config.ai, schema: NEWS_SCHEMA });
    const news = parseNews(reply, config.news);
    log(`取得美國經濟新聞 ${news.economy.length} 則、虛擬貨幣新聞 ${news.crypto.length} 則：`);
    for (const item of news.economy) log(`  [美國經濟] ${item.title}`);
    for (const item of news.crypto) log(`  [${item.coins.join('・') || '整體市場'}] ${item.title}`);
    return { news, messages: buildDiscordMessages(news, { dateLabel: formatDateInZone(to, timeZone) }) };
  },
});
