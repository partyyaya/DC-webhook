/**
 * 股票訊息排版：把整理好的新聞組成 Discord 訊息。
 * 共用標題與日期放在最上方，各市場一則訊息、每篇新聞一張卡片（標題可點擊開啟原文），版面見 shared/news.js。
 */
import { buildNewsMessages } from '../shared/news.js';

// 市場順序、訊息標題、卡片顏色，卡片底部顯示新聞涉及的股票代號
export const SECTIONS = [
  { key: 'tw', heading: '🇹🇼 台股新聞', color: 0xe63946, codesKey: 'stocks' },
  { key: 'us', heading: '🇺🇸 美股新聞', color: 0x1f6feb, codesKey: 'stocks' },
];

/**
 * 組出 Discord 訊息；沒有新聞（或不搜尋）的市場不發送。
 *
 * @param {{tw: object[], us: object[]}} news parseNews() 的結果
 * @param {{dateLabel: string}} options dateLabel 為訊息標題的日期，例如「2026-11-18（週三）」
 * @returns {Array<{content: string, embeds: object[]}>}
 */
export function buildDiscordMessages(news, { dateLabel }) {
  return buildNewsMessages(news, { heading: '股票新聞', sections: SECTIONS, dateLabel });
}
