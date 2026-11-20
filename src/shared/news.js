/**
 * 每日新聞的共用工具（Crypto、股票等主題共用）：新聞欄位的 JSON Schema、整理 AI 回覆的單則新聞、
 * 依優先清單挑選新聞，以及組成 Discord 訊息。各主題的搜尋規則與分類由自己的 news.js 決定。
 */

// 每類新聞最多篇數：每個分類發成一則 Discord 訊息，一則訊息最多 10 張卡片
export const MAX_NEWS_COUNT = 10;

// 每則新聞共用的欄位
const ITEM_PROPERTIES = {
  title: { type: 'string' },
  summary: { type: 'string' },
  source: { type: 'string' },
  url: { type: 'string' },
  publishedAt: { type: 'string' },
};

/**
 * 單則新聞的 JSON Schema：共用欄位加上主題自己的欄位（例如 coins、stocks），全部必填。
 *
 * @param {object} [extra] 額外欄位
 * @returns {object}
 */
export function newsItemSchema(extra = {}) {
  const properties = { ...ITEM_PROPERTIES, ...extra };
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

/**
 * 整理單則新聞的共用欄位：去除多餘空白並限制長度；標題為空或網址無效時回傳 null。
 * 長度上限確保一則訊息放滿 10 張卡片時，文字總量仍在 Discord 的 6000 字限制內。
 *
 * @param {object} item AI 回覆的單則新聞
 * @returns {{title: string, summary: string, source: string, url: string, publishedAt: string} | null}
 */
export function normalizeNewsItem(item) {
  const text = (value, max) => (typeof value === 'string' ? truncate(value.replace(/\s+/g, ' ').trim(), max) : '');
  const title = text(item?.title, 100);
  const url = typeof item?.url === 'string' ? item.url.trim() : '';
  if (!title || !isHttpUrl(url)) return null;
  return {
    title,
    summary: text(item.summary, 300),
    source: text(item.source, 50),
    url,
    publishedAt: text(item.publishedAt, 30),
  };
}

/**
 * 依優先清單挑選並排列新聞（例如優先幣種、優先股票）：
 *   - 依優先清單排列（同時涉及多個項目時，以最優先的項目計算），不涉及清單項目的新聞排在最後；同一順位維持原本的順序。
 *   - 先依清單順序，替每個項目選 1 則（以該項目為代表、排最前面的新聞；沒有時改選有提到該項目的新聞），
 *     篇數用完就停止，所以篇數少於項目數量時只會選到前面的項目。
 *   - 還有名額時，再依排列順序補上其他新聞。
 *   - 清單為空時，就是依原本順序取前 count 則。
 *
 * @param {object[]} items 已整理的新聞，依重要性排列
 * @param {object} options
 * @param {string[]} options.priority 優先清單，依優先順序排列
 * @param {number} options.count 篇數上限
 * @param {(item: object) => string[]} options.codesOf 取得新聞涉及的項目代號
 * @returns {object[]}
 */
export function selectByPriority(items, { priority, count, codesOf }) {
  // 順位：涉及的項目中，在優先清單裡最前面的位置；都不在清單內則排最後
  const rank = (item) => Math.min(...codesOf(item).map((code) => priority.indexOf(code)).filter((index) => index >= 0), priority.length);
  // 代表項目：涉及的項目中最優先的一個
  const main = (item) => priority[rank(item)];
  const sorted = [...items].sort((a, b) => rank(a) - rank(b));

  // 1. 依清單順序，每個項目先選 1 則，篇數用完就停止
  const picked = new Set();
  for (const code of priority) {
    if (picked.size >= count) break;
    const available = sorted.filter((item) => !picked.has(item));
    const choice = available.find((item) => main(item) === code) ?? available.find((item) => codesOf(item).includes(code));
    if (choice) picked.add(choice);
  }
  // 2. 還有名額時，依排列順序補上其他新聞
  for (const item of sorted) {
    if (picked.size >= count) break;
    picked.add(item);
  }
  return sorted.filter((item) => picked.has(item));
}

/**
 * 組出 Discord 訊息：每個分類一則訊息，標題放在訊息文字，每篇新聞一張卡片（標題可點擊開啟原文）；
 * 沒有新聞的分類不發送。
 *
 * @param {Record<string, object[]>} news 各分類的新聞
 * @param {object} options
 * @param {Array<{key: string, heading: string, color: number, codesKey?: string}>} options.sections
 *   分類順序、訊息標題、卡片顏色；codesKey 為要顯示在卡片底部的代號欄位（例如 coins、stocks）
 * @param {string} options.dateLabel 訊息標題的日期，例如「2026-11-18（週三）」
 * @returns {Array<{content: string, embeds: object[]}>}
 */
export function buildNewsMessages(news, { sections, dateLabel }) {
  return sections.filter((section) => news[section.key]?.length > 0).map((section) => ({
    content: `## ${section.heading}｜${dateLabel}`,
    embeds: news[section.key].map((item, index) => {
      // 卡片底部：代號、來源、發布時間，沒有的項目省略
      const codes = section.codesKey ? item[section.codesKey]?.join('・') : '';
      const footer = [codes, item.source, item.publishedAt].filter(Boolean).join('｜');
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

/** 確認是 http(s) 網址，避免把無效或其他協定的連結放進 Discord 卡片。 */
function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** 超過長度時截斷並加上「…」。 */
export function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
