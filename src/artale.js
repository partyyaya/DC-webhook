/**
 * Artale 官網公告模組：抓取公告列表與內文頁，解析出最新一篇公告的完整資料。
 *
 * 官網（artale.live）是用 Next.js 製作的：
 *   - 公告列表的 HTML 直接包含每一筆公告的連結、標題、日期，可以直接解析。
 *   - 內文頁的正文不在 HTML 裡，而是以 Lexical 編輯器的 JSON 格式藏在
 *     頁面的 self.__next_f.push(...) 資料中，需要先取出再轉成文字（見 lexical.js）。
 *
 * 解析過程中任何一步出錯（找不到資料、格式不符、轉換不完整），都會拋出 ContentParseError，
 * 代表官網結構可能改變了，主流程會因此停止且不發送任何訊息（見 errors.js）。
 */
import { ContentParseError } from './errors.js';
import { findMissingText, lexicalToMarkdown } from './lexical.js';

// 模擬一般瀏覽器的 User-Agent，避免被網站當成機器人擋下
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// 常見的 HTML 具名實體對照表（例如 &amp; → &），供 decodeHtml() 使用
const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// 官網公告列表的網址（繁體中文版）
const NEWS_BASE_URL = 'https://artale.live/tw/news';

// 官網的公告分類：網址參數 → 中文名稱。all 代表「全部」分頁（網址不帶分類參數）
export const NEWS_CATEGORIES = {
  all: '全部',
  update: '更新',
  event: '活動',
  bm: '購物商場',
  maintenance: '維護',
  sanction: '制裁',
};

/**
 * 解析 ARTALE_NEWS_CATEGORIES 設定，例如「update,bm」。
 * 會去除空白、轉小寫、移除重複；出現不認得的分類時拋錯並列出可用的值。
 *
 * @param {string} text 逗號分隔的分類字串
 * @returns {string[]} 分類代碼陣列，例如 ['update', 'bm']
 */
export function parseCategories(text) {
  const categories = [
    ...new Set(
      String(text)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const unknown = categories.filter((category) => !(category in NEWS_CATEGORIES));
  if (categories.length === 0 || unknown.length > 0) {
    const valid = Object.entries(NEWS_CATEGORIES)
      .map(([code, name]) => `${code}（${name}）`)
      .join('、');
    throw new Error(`ARTALE_NEWS_CATEGORIES 設定錯誤：「${text}」，可用的分類為 ${valid}`);
  }
  return categories;
}

/**
 * 取得某個分類的公告列表網址。
 *
 * @param {string} category 分類代碼，例如 update、bm、all
 * @returns {string} 例如 https://artale.live/tw/news?category=bm
 */
export function categoryUrl(category) {
  return category === 'all' ? NEWS_BASE_URL : `${NEWS_BASE_URL}?category=${encodeURIComponent(category)}`;
}

/**
 * 取得最新的一篇公告（含全文）。這是本模組對外的主要入口。
 *
 * 流程：抓列表第一頁 → 依日期挑出最新的候選公告 → 逐篇抓內文頁 → 以發布時間（含時分）選出最新一篇。
 *
 * @param {object} options
 * @param {string} options.newsUrl 公告列表網址
 * @param {number} options.timeoutMs 每個 HTTP 請求的逾時時間
 * @returns {Promise<object>} 公告資料：id、url、title、date、category、pinned、publishedAt、thumbnail、content
 */
export async function fetchLatestAnnouncement({ newsUrl, timeoutMs }) {
  // 抓公告列表並解析出每一筆公告（解析失敗會拋出 ContentParseError）
  const items = parseNewsList(await fetchHtml(newsUrl, timeoutMs), newsUrl);

  // 逐篇抓取候選公告的內文頁（依序抓取，避免同時對官網發出太多請求）
  const announcements = [];
  for (const item of newestCandidates(items)) {
    announcements.push(await fetchAnnouncement(item, timeoutMs));
  }

  // 發布時間格式為「YYYY.MM.DD HH:mm」，可以直接用字串比較大小，取最晚的一篇
  return announcements.reduce((latest, current) => (current.publishedAt > latest.publishedAt ? current : latest));
}

/**
 * 抓取單篇公告的內文頁，並解析成完整的公告資料。
 *
 * @param {object} item 從公告列表解析出的單筆資料（至少要有 id 與 url）
 * @param {number} timeoutMs HTTP 請求逾時時間
 * @returns {Promise<object>} 補上 publishedAt、thumbnail、content 的公告資料
 */
export async function fetchAnnouncement(item, timeoutMs) {
  return parseAnnouncementPage(await fetchHtml(item.url, timeoutMs), item);
}

/**
 * 以 GET 取得網頁 HTML。超過逾時時間或 HTTP 狀態碼不是 2xx 時拋錯。
 *
 * @param {string} url 網址
 * @param {number} timeoutMs 逾時時間
 * @returns {Promise<string>} HTML 原始碼
 */
async function fetchHtml(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, 'accept-language': 'zh-TW,zh;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`取得 ${url} 失敗：HTTP ${res.status}`);
  return res.text();
}

/**
 * 解析公告列表頁的 HTML，取出每一筆公告的基本資料。
 *
 * 官網列表中每一筆公告的 HTML 結構大致如下：
 *   <a href="/tw/news/{公告ID}" class="row">
 *     <div class="notice-badges">[置頂標記] <span class="tag tag-update">更新</span></div>
 *     <span class="title">標題</span><span class="date">2026.11.17</span>
 *   </a>
 *
 * 解析不到任何公告，或有公告缺少標題、日期格式不是 YYYY.MM.DD 時，拋出 ContentParseError。
 *
 * @param {string} html 列表頁 HTML
 * @param {string} baseUrl 列表頁網址，用來把相對連結轉成完整網址
 * @returns {Array<{id: string, url: string, title: string, date: string, category: string, pinned: boolean}>}
 */
export function parseNewsList(html, baseUrl) {
  const items = [];
  // 找出頁面上所有 <a> 連結，再篩選出 class 含 "row" 且連到 /news/{ID} 的公告連結
  for (const [, attrs, inner] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (!/\bclass="[^"]*\brow\b/.test(attrs)) continue;
    const href = attrs.match(/\bhref="([^"]+)"/)?.[1];
    const id = href?.match(/\/news\/([^/?#]+)$/)?.[1];
    if (!id) continue;

    // 從連結內部取出標題、日期、分類標籤，並判斷是否為置頂公告
    items.push({
      id,
      url: new URL(decodeHtml(href), baseUrl).href,
      title: spanText(inner, 'title'),
      date: spanText(inner, 'date'),
      category: cleanText(inner.match(/<span class="tag\b[^"]*">([\s\S]*?)<\/span>/)?.[1] ?? ''),
      pinned: inner.includes('notice-pin'),
    });
  }

  // 驗證解析結果：一筆都沒有，或有任何一筆缺少標題、日期格式不符，都視為網站結構已改變
  if (items.length === 0) {
    throw new ContentParseError(`公告列表 ${baseUrl} 解析不到任何公告，網站結構可能已變更`);
  }
  const broken = items.filter((item) => !item.title || !/^\d{4}\.\d{2}\.\d{2}$/.test(item.date));
  if (broken.length > 0) {
    throw new ContentParseError(
      `公告列表 ${baseUrl} 有 ${broken.length} 筆公告缺少標題或日期格式不符（例如 ID ${broken[0].id}），網站結構可能已變更`,
    );
  }
  return items;
}

/**
 * 從公告列表中挑出「日期最新」的公告作為候選（可能不只一篇）。
 *
 * 置頂的舊公告會排在列表最前面，且列表只顯示日期（YYYY.MM.DD），
 * 因此先挑出日期最新的幾篇，再由內文頁含時分的發布時間決定最新一篇。
 *
 * @param {Array<{date: string}>} items 公告列表
 * @returns {Array<object>} 日期等於最新日期的所有公告（保持原本順序）
 */
export function newestCandidates(items) {
  const newestDate = items.reduce((max, item) => (item.date > max ? item.date : max), '');
  return items.filter((item) => item.date === newestDate);
}

/**
 * 解析單篇公告的內文頁 HTML，取出標題、發布時間、縮圖與正文。
 *
 * 以下任一情況都會拋出 ContentParseError，避免把錯誤的內容送去摘要與發送：
 *   - 找不到正文資料、正文格式不符，或轉換過程出錯
 *   - 轉換後的正文是空的，或原始正文中有文字沒出現在轉換結果裡（轉換不完整）
 *   - 最後取得的標題是空的，或發布時間格式不是 YYYY.MM.DD
 *
 * @param {string} html 內文頁 HTML
 * @param {object} item 從列表解析出的資料，內文頁缺少的欄位會用它補上
 * @returns {object} 合併列表資料與內文頁資料後的完整公告
 */
export function parseAnnouncementPage(html, item) {
  // 正文：從 Next.js 資料中取出 Lexical JSON，確認格式後再轉成 Markdown 文字
  const doc = extractLexicalDocument(extractFlightPayload(html));
  if (doc?.root?.type !== 'root' || !Array.isArray(doc.root.children)) {
    throw new ContentParseError(`公告 ${item.id} 的內文資料格式不符，網站結構可能已變更`);
  }
  let content;
  try {
    content = lexicalToMarkdown(doc);
  } catch (err) {
    throw new ContentParseError(`公告 ${item.id} 內文轉換失敗：${err.message}`, { cause: err });
  }

  // 驗證轉換結果：不能是空的，且原始正文的每段文字都要出現在轉換結果中
  if (!content) throw new ContentParseError(`公告 ${item.id} 解析不到內文，網站結構可能已變更`);
  const missing = findMissingText(doc, content);
  if (missing.length > 0) {
    throw new ContentParseError(
      `公告 ${item.id} 內文轉換不完整，有 ${missing.length} 段文字遺漏（例如「${missing[0].slice(0, 30)}」），官網可能使用了新的內容格式`,
    );
  }

  // 文章標頭區塊（含標題 h1 與發布時間），以及文章裡的第一張圖片（公告縮圖）
  const head = html.match(/<header class="article-head">([\s\S]*?)<\/header>/)?.[1] ?? '';
  const thumbnail = html.match(/<article\b[\s\S]*?<img\b[^>]*\bsrc="([^"]+)"/)?.[1];

  // 內文頁的標題與發布時間（含時分）較完整，優先使用；取不到時退回列表上的資料
  const announcement = {
    ...item,
    title: cleanText(head.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '') || item.title,
    publishedAt: cleanText(head.match(/class="article-meta"><span>([\s\S]*?)<\/span>/)?.[1] ?? '') || item.date,
    thumbnail: thumbnail ? decodeHtml(thumbnail) : undefined,
    content,
  };

  // 驗證最後的標題與發布時間
  if (!announcement.title) {
    throw new ContentParseError(`公告 ${item.id} 解析不到標題，網站結構可能已變更`);
  }
  if (!/^\d{4}\.\d{2}\.\d{2}/.test(announcement.publishedAt ?? '')) {
    throw new ContentParseError(
      `公告 ${item.id} 的發布時間格式不符（「${announcement.publishedAt ?? ''}」），網站結構可能已變更`,
    );
  }
  return announcement;
}

/**
 * 取出 Next.js 頁面中所有 self.__next_f.push([1, "..."]) 的資料並串接成一個字串。
 * 同一份資料可能被拆在好幾個 <script> 裡，所以要全部接起來才是完整內容。
 *
 * @param {string} html 內文頁 HTML
 * @returns {string} 串接後的 Next.js 頁面資料
 */
export function extractFlightPayload(html) {
  let payload = '';
  for (const [, json] of html.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)<\/script>/g)) {
    // 每段的格式為 [類型, 資料]，只有類型 1 是頁面資料字串；格式不符代表網站結構改變
    let chunk;
    try {
      chunk = JSON.parse(json);
    } catch (err) {
      throw new ContentParseError(`內文頁的 Next.js 資料格式不符：${err.message}`, { cause: err });
    }
    const [type, data] = chunk;
    if (type === 1 && typeof data === 'string') payload += data;
  }
  return payload;
}

/**
 * 從 Next.js 頁面資料中找出公告正文的 Lexical JSON（以 {"root": 開頭的物件）並解析。
 *
 * @param {string} payload extractFlightPayload() 的結果
 * @returns {object} Lexical 文件物件，格式為 { root: { children: [...] } }
 */
export function extractLexicalDocument(payload) {
  const start = payload.indexOf('{"root":');
  if (start === -1) throw new ContentParseError('找不到公告內文資料（Lexical JSON），網站結構可能已變更');
  try {
    return JSON.parse(payload.slice(start, findJsonEnd(payload, start)));
  } catch (err) {
    if (err instanceof ContentParseError) throw err;
    throw new ContentParseError(`公告內文資料（Lexical JSON）無法解析：${err.message}`, { cause: err });
  }
}

/**
 * 從指定位置開始，找出一個 JSON 物件的結尾位置。
 * JSON 後面緊接著其他資料，無法直接 JSON.parse 整段，所以逐字計算大括號／中括號的層數，
 * 回到第 0 層時就是結尾；字串內的括號與跳脫字元（\"）不列入計算。
 *
 * @param {string} text 包含 JSON 的字串
 * @param {number} start JSON 物件開頭（{）的位置
 * @returns {number} JSON 物件結尾的下一個位置，可直接用於 text.slice(start, end)
 */
function findJsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      // 在字串內：遇到反斜線就跳過下一個字元，遇到引號代表字串結束
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new ContentParseError('公告內文 JSON 不完整，網站結構可能已變更');
}

/**
 * 取出指定 class 的 <span> 內的純文字，例如 <span class="title">…</span>。
 *
 * @param {string} html 要搜尋的 HTML 片段
 * @param {string} className span 的 class 名稱
 * @returns {string} 純文字，找不到時回傳空字串
 */
function spanText(html, className) {
  return cleanText(html.match(new RegExp(`<span class="${className}">([\\s\\S]*?)</span>`))?.[1] ?? '');
}

/**
 * 把 HTML 片段轉成乾淨的純文字：移除標籤、還原 HTML 實體、把連續空白合併成一個空格。
 *
 * @param {string} html HTML 片段
 * @returns {string}
 */
function cleanText(html) {
  return decodeHtml(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 還原 HTML 實體，例如 &amp; → &、&#39; → '、&#x27; → '。
 *
 * @param {string} text 含 HTML 實體的文字
 * @returns {string}
 */
export function decodeHtml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    // 數字實體：&#十進位; 或 &#x十六進位;
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    // 具名實體：查對照表，不認得的保持原樣
    return HTML_ENTITIES[code.toLowerCase()] ?? match;
  });
}
