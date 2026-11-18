/**
 * Artale 排版模組：把公告與摘要組成 Discord embed（卡片樣式訊息）。
 *
 * 在頻道中顯示的樣子：
 *   - 版本更新：一張卡片，包含標題（可點擊開啟官網公告）、項目之間空一行的摘要內文與底部說明。
 *   - 維護：一張公告卡片，內文只顯示維護時間。
 *   - 購物商場：先一張公告標題卡片，接著每個商品「先圖片卡片、再文字卡片」，
 *     最後是「其他異動」卡片；底部說明放在最後一張文字卡片。
 *     卡片太多時會拆成好幾則訊息依序發送。
 *     （Discord 卡片的大圖固定顯示在文字下方，所以圖片要放在獨立的卡片才能排在文字前面）
 *   - 各分類獨立發送，透過公告標題連至官網，內文不重複附上公告網址。
 */

// Discord embed 的長度上限：標題 256 字、內文 4096 字，超過會被 Discord 拒絕
const TITLE_LIMIT = 256;
const DESCRIPTION_LIMIT = 4096;
// 一則 Discord 訊息的上限：最多 10 張卡片，所有卡片的文字合計不超過 6000 字
const MAX_EMBEDS_PER_MESSAGE = 10;
const MAX_CHARS_PER_MESSAGE = 6000;
// embed 左側色條的顏色（橘色）
const EMBED_COLOR = 0xff9900;
// 依比對結果加在標題前面的標籤；強制重發（unchanged）時使用預設的【公告】
const LABELS = { new: '【新公告】', updated: '【公告更新】' };
// allowed_mentions.parse 設為空陣列：即使摘要裡出現 @everyone、@here，也不會真的通知所有人
const NO_MENTIONS = { parse: [] };

/**
 * 組出要發送的所有 Discord 訊息，依摘要的型態選擇格式。
 *
 * @param {object} announcement 公告資料
 * @param {string | {products: object[], otherChanges: string[]}} summary
 *   文字摘要（版本更新或維護時間）或購物商場的商品資料（見 summarize.js 的 parseShopSummary）
 * @param {'new' | 'updated' | 'unchanged'} kind 比對結果
 * @returns {object[]} 依序發送的 Discord Webhook 請求內容（每個元素是一則訊息）
 */
export function buildDiscordMessages(announcement, summary, kind) {
  return typeof summary === 'string'
    ? [buildDiscordPayload(announcement, summary, kind)]
    : buildShopMessages(announcement, summary, kind);
}

/**
 * 組出公告卡片：標題、連結、顏色與底部文字，不顯示分類及發布時間。
 *
 * @param {object} announcement 公告資料（title、url、category、publishedAt、thumbnail）
 * @param {'new' | 'updated' | 'unchanged'} kind 比對結果，決定標題標籤
 * @returns {object} Discord embed
 */
function buildHeaderEmbed(announcement, kind) {
  return {
    title: truncate(`${LABELS[kind] ?? '【公告】'}${announcement.title}`, TITLE_LIMIT),
    url: announcement.url,
    color: EMBED_COLOR,
    footer: { text: '摘要由 Codex 自動產生，詳細內容請以官方公告為準' },
  };
}

/**
 * 組出版本更新或維護公告的訊息：一張公告卡片，內文為文字摘要或維護時間。
 *
 * @param {object} announcement 公告資料（title、url、category、publishedAt、thumbnail）
 * @param {string} summary Codex 產生的摘要
 * @param {'new' | 'updated' | 'unchanged'} kind 比對結果，決定標題標籤
 * @returns {object} Discord Webhook 的請求內容
 */
export function buildDiscordPayload(announcement, summary, kind) {
  // 統一頂層項目間的空白，即使 Codex 未依格式輸出也保留一行間距。
  const spacedSummary = summary.replace(/\r\n?/g, '\n').replace(/\n(?:[ \t]*\n)*(?=- )/g, '\n\n');
  const embed = {
    ...buildHeaderEmbed(announcement, kind),
    description: truncate(spacedSummary, DESCRIPTION_LIMIT),
  };
  return { allowed_mentions: NO_MENTIONS, embeds: [embed] };
}

/**
 * 組出購物商場公告的訊息：公告卡片 → 每個商品「先圖片、再文字」→ 其他異動。
 * 超過單則訊息的卡片數或字數上限時，拆成多則訊息；同一個商品的圖片與文字卡片不會被拆開。
 *
 * @param {object} announcement 公告資料
 * @param {{products: object[], otherChanges: string[]}} shop 購物商場的商品資料
 * @param {'new' | 'updated' | 'unchanged'} kind 比對結果
 * @returns {object[]} 依序發送的 Discord Webhook 請求內容
 */
export function buildShopMessages(announcement, { products, otherChanges }, kind) {
  // 公告只有下架、刪除等已排除內容時，連公告卡片也不發送。
  if (products.length === 0 && otherChanges.length === 0) return [];

  // 公告卡片；公告內容被修改時在卡片內文註明
  const { footer, ...header } = buildHeaderEmbed(announcement, kind);
  if (kind === 'updated') header.description = '（公告已更新）';

  // 每個商品先圖片、再文字；購買條件、可購買次數與販售時間依序放在文字卡片最後
  const groups = products.map((product) => {
    const descriptionLimit = DESCRIPTION_LIMIT;
    const lines = [
      `- **內容物：**${product.contents.length > 0 ? product.contents.join('、') : '公告未列出'}`,
      ...product.links.map((link) => `[${link.text.replace(/[[\]]/g, '')}](${link.url})`),
    ];
    const purchaseDetails = truncate([
      ['購買條件', product.purchaseConditions],
      ['可購買次數', product.purchaseLimit],
      ['販售時間', product.salePeriod],
    ]
      .filter(([, value]) => typeof value === 'string' && value.trim() && value.trim() !== '公告未註明')
      .map(([label, value]) => `- **${label}：**${value.trim()}`)
      .join('\n'), descriptionLimit - 2);
    const suffix = purchaseDetails ? `\n${purchaseDetails}` : '';
    const textEmbed = {
      color: EMBED_COLOR,
      title: truncate(`${product.name}｜${product.price}`, TITLE_LIMIT),
      // 預留購買資訊的空間，避免內容物太長時把它們截掉
      description: `${truncate(lines.join('\n'), descriptionLimit - suffix.length)}${suffix}`,
    };
    return product.image ? [{ color: EMBED_COLOR, image: { url: product.image } }, textEmbed] : [textEmbed];
  });

  // 販售以外的異動放在最後一張卡片
  if (otherChanges.length > 0) {
    groups.push([
      {
        color: EMBED_COLOR,
        title: '其他異動',
        description: truncate(otherChanges.map((change) => `- ${change}`).join('\n'), DESCRIPTION_LIMIT),
      },
    ]);
  }

  // 摘要說明放在整篇最後一張文字卡片，先加入再計算分頁的字數限制。
  groups.at(-1).at(-1).footer = footer;

  // 依序把每組卡片裝進訊息；放不下（超過 10 張或 6000 字）就開始下一則訊息
  const messages = [];
  let current = [header];
  for (const group of groups) {
    const candidate = [...current, ...group];
    if (candidate.length > MAX_EMBEDS_PER_MESSAGE || totalLength(candidate) > MAX_CHARS_PER_MESSAGE) {
      messages.push(current);
      current = group;
    } else {
      current = candidate;
    }
  }
  messages.push(current);

  return messages.map((embeds) => ({ allowed_mentions: NO_MENTIONS, embeds }));
}

/**
 * 計算多張卡片的文字總長度（Discord 以標題、內文、欄位、底部文字合計 6000 字為上限）。
 *
 * @param {object[]} embeds
 * @returns {number}
 */
function totalLength(embeds) {
  return embeds.reduce(
    (sum, embed) =>
      sum +
      (embed.title?.length ?? 0) +
      (embed.description?.length ?? 0) +
      (embed.footer?.text?.length ?? 0) +
      (embed.fields ?? []).reduce((n, field) => n + field.name.length + field.value.length, 0),
    0,
  );
}

/**
 * 把官網的發布時間（「2026.11.17 08:13」或「2026.11.17」）轉成 Discord 需要的 ISO 8601 格式。
 * 官網顯示的時間為台灣時間（GMT+8）
 *
 * @param {string} publishedAt 官網格式的發布時間
 * @returns {string | undefined} ISO 時間字串；格式不符時回傳 undefined
 */
export function toIsoTimestamp(publishedAt) {
  const match = publishedAt?.match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!match) return undefined;
  // 沒有時分時當作當天 00:00
  const [, year, month, day, hour = '00', minute = '00'] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`).toISOString();
}

/**
 * 文字超過長度上限時截斷，並在結尾加上「…」。
 *
 * @param {string} text 原始文字
 * @param {number} limit 長度上限
 * @returns {string}
 */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

