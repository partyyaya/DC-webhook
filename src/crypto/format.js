/**
 * Crypto 訊息排版：把整理好的新聞組成 Discord 訊息。
 * 每個分類一則訊息：標題放在訊息文字，每篇新聞一張卡片（標題可點擊開啟原文）。
 */
import { truncate } from './news.js';

// 分類順序、訊息標題與卡片顏色
export const SECTIONS = [
  { key: 'economy', heading: '🇺🇸 美國經濟新聞', color: 0x1f6feb },
  { key: 'crypto', heading: '🪙 虛擬貨幣新聞', color: 0xf7931a },
];

/**
 * 組出 Discord 訊息；沒有新聞的分類不發送。
 *
 * @param {{economy: object[], crypto: object[]}} news parseNews() 的結果
 * @param {{dateLabel: string}} options dateLabel 為訊息標題的日期，例如「2026-11-18（週三）」
 * @returns {Array<{content: string, embeds: object[]}>}
 */
export function buildDiscordMessages(news, { dateLabel }) {
  return SECTIONS.filter((section) => news[section.key]?.length > 0).map((section) => ({
    content: `## ${section.heading}｜${dateLabel}`,
    embeds: news[section.key].map((item, index) => {
      // 卡片底部：幣種、來源、發布時間，沒有的項目省略
      const footer = [item.coins?.join('・'), item.source, item.publishedAt].filter(Boolean).join('｜');
      return {
        title: truncate(`${index + 1}. ${item.title}`, 256),
        url: item.url,
        color: section.color,
        ...(item.summary ? { description: item.summary } : {}),
        ...(footer ? { footer: { text: truncate(footer, 100) } } : {}),
      };
    }),
  }));
}
