/**
 * 組成 Discord 訊息：每個市場一則訊息，每個標的一張卡片（可以做單為綠色、觀望為灰色、無法取得資料為紅色），
 * 最後一則訊息是免責聲明卡片。
 *
 * 訊息標題：
 *   ## 🪙 虛擬貨幣技術分析｜2026-11-20（週五）
 *   -# 🕒 4H 線・💵 價格單位：美元（USDT 交易對）
 *
 * 卡片內容（每行以「圖示 小標題：」開頭，價位以程式碼格式凸顯）：
 *   🏷️ 標的：BTC，是否做單：🟢 可以
 *   💰 進場：62000，止盈：65000（+4.8%），止損：60000（-3.2%）
 *   📊 原因：……
 *   📝 其他事項：若……，則直接撤單      （選填）
 * 可以做單時不顯示現價，避免與進場價混淆；觀望時不顯示進場、止盈、止損，現價顯示在卡片底部。
 * AUTO 沒有挑出任何標的時（找不到符合條件的標的，或市場不適合做單），顯示一張觀望卡片。
 */
import { AUTO_MAX_PICKS, INTERVALS, marketOf } from './markets.js';
import { formatPrice } from './signals.js';
import { truncate } from '../shared/news.js';

export const DISCLAIMER = '此通知為 AI 自動生成，不構成投資建議';
// 最後一則訊息：免責聲明卡片，卡片底部以小字補充說明
export const DISCLAIMER_MESSAGE = {
  embeds: [{
    description: `⚠️ **${DISCLAIMER}**`,
    color: 0xf1c40f,
    footer: { text: '技術指標僅反映過去的價格與成交量，實際交易請自行判斷並控制風險' },
  }],
};
// AUTO 沒有挑出任何標的時顯示（AI 找不到符合條件的標的，或市場不適合做單）
export const NO_PICK_TEXT = '目前沒有符合做單條件的標的，或市場不適合做單，建議觀望。';

const COLORS = { trade: 0x2ecc71, wait: 0x95a5a6, error: 0xe74c3c };
const ACTIONS = { trade: '🟢 **可以**', wait: '⚪ **觀望**' };
// 卡片內容的每一行以「圖示 小標題：」開頭
const item = (icon, label, text) => `${icon} **${label}**：${text}`;
// 一則 Discord 訊息最多 10 張卡片
const MAX_EMBEDS = 10;

/**
 * 組成要發送的 Discord 訊息。
 *
 * @param {object[]} results parseSignals() 的結果
 * @param {object} options
 * @param {string} options.dateLabel 標題中的日期，例如「2026-11-20（週五）」
 * @returns {object[]}
 */
export function buildDiscordMessages(results, { dateLabel }) {
  return [...results.map((market) => buildMarketMessage(market, dateLabel)), DISCLAIMER_MESSAGE];
}

function buildMarketMessage(market, dateLabel) {
  const info = marketOf(market.key);
  const notes = [`🕒 ${INTERVALS[market.interval].label}`, `💵 價格單位：${info.unitNote}`];
  if (market.auto && !market.failure) notes.push(`🤖 AUTO：由 AI 從${info.autoUniverse}的 ${market.candidates} 個標的中挑選最多 ${AUTO_MAX_PICKS} 個`);

  const embeds = market.signals.map((signal) => signalEmbed(signal, info));
  if (market.failure) {
    embeds.push({ description: item('❌', `${info.name} AUTO`, `${truncate(market.failure, 300)}，本次略過。`), color: COLORS.error });
  } else if (market.auto && market.signals.length === 0) {
    embeds.push({ description: `💤 ${NO_PICK_TEXT}`, color: COLORS.wait });
  }
  for (const error of market.errors) {
    embeds.push({
      description: [
        item('🏷️', '標的', `**${error.symbol}**`),
        item('❌', '原因', `無法取得行情資料，本次略過：${truncate(error.message, 200)}`),
      ].join('\n'),
      color: COLORS.error,
    });
  }
  return { content: `## ${info.heading}技術分析｜${dateLabel}\n-# ${notes.join('・')}`, embeds: embeds.slice(0, MAX_EMBEDS) };
}

/** 單一標的的卡片。 */
function signalEmbed(signal, info) {
  const price = (value) => formatPrice(value, signal.price);
  const percent = (value) => {
    const change = ((value - signal.entry) / signal.entry) * 100;
    return `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`;
  };
  const name = signal.name ? `${signal.symbol} ${truncate(signal.name, 20)}` : signal.symbol;
  const trade = signal.action === 'trade';
  const lines = [`${item('🏷️', '標的', `**${name}**`)}，**是否做單**：${ACTIONS[signal.action]}`];
  if (trade) {
    lines.push(`${item('💰', '進場', `\`${price(signal.entry)}\``)}，**止盈**：\`${price(signal.takeProfit)}\`（${percent(signal.takeProfit)}），`
      + `**止損**：\`${price(signal.stopLoss)}\`（${percent(signal.stopLoss)}）`);
  }
  lines.push(item('📊', '原因', signal.reason));
  if (signal.note) lines.push(item('📝', '其他事項', signal.note));
  // 可以做單時只顯示進場價，不顯示現價，避免兩個價位混淆；觀望時在卡片底部顯示現價
  const source = `資料來源：${signal.source} ${signal.ticker}`;
  return {
    description: lines.join('\n'),
    color: COLORS[signal.action],
    footer: { text: trade ? source : `現價 ${price(signal.price)} ${info.currency}・${source}` },
  };
}
