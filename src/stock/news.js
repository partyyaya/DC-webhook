/**
 * 股票新聞規則：組出給 AI 的搜尋提示詞與輸出 JSON Schema，並檢查、整理 AI 的回覆。
 *
 * 每天請 AI 以即時網路搜尋，找出發送前 24 小時內的：
 *   - tw：台股新聞，最多 N 則（設定檔 news.twCount，預設 3）
 *   - us：美股新聞，最多 N 則（設定檔 news.usCount，預設 3）
 * 每個市場的股票清單（news.twStocks、news.usStocks）每檔至少 1 則，選該股票最重要的新聞；
 * 篇數少於股票數量時依股票順序只取前幾檔；還有剩餘名額時只放重要新聞，不足寧缺勿濫。
 * 股票清單為空時，改選該市場最重要的新聞（大盤、權值股、政策等）。
 * 篇數設為 0 的市場不搜尋：提示詞與 JSON Schema 都不包含該市場。
 * 篇數與股票清單由 config.js 讀取後傳入；想調整撰寫規則，修改 buildNewsPrompt() 即可。
 */
import { MAX_NEWS_COUNT, newsItemSchema, normalizeNewsItem, selectByPriority } from '../shared/news.js';
import { formatInZone } from '../shared/schedule.js';
import { normalizeSymbol, parseSymbols } from '../shared/symbols.js';

export { MAX_NEWS_COUNT };

// 市場設定，順序即為提示詞與 Discord 訊息的順序
export const MARKETS = [
  {
    key: 'tw',
    name: '台股',
    stocksKey: 'twStocks',
    countKey: 'twCount',
    codeRule: '台股代號（例如 2330、0050、00878，不加 .TW）',
    overview: '加權指數與櫃買指數走勢、外資與投信買賣超、權值股動態、央行與金管會政策、重大公司公告',
    important: '股價大幅波動或漲跌停、月營收與財報、法說會與財測、重大投資或併購、主管機關處分、除權息與股利政策',
    sources: '經濟日報、工商時報、中央社、鉅亨網、MoneyDJ，或公開資訊觀測站、公司公告',
  },
  {
    key: 'us',
    name: '美股',
    stocksKey: 'usStocks',
    countKey: 'usCount',
    codeRule: '美股代號（大寫，例如 AAPL、NVDA、BRK.B）',
    overview: '道瓊、標普 500 與那斯達克指數走勢、聯準會利率與經濟數據對股市的影響、大型科技股、重要財報',
    important: '股價大幅波動、財報與財測、重大產品發表、併購、裁員或管理層異動、監管與訴訟',
    sources: 'Reuters、Bloomberg、CNBC、WSJ、AP、MarketWatch，或公司公告、SEC 文件',
  },
];

const marketOf = (key) => MARKETS.find((market) => market.key === key);

/** 篇數大於 0、需要搜尋的市場。 */
export function enabledMarkets(news) {
  return MARKETS.filter((market) => news[market.countKey] > 0);
}

/**
 * 解析設定檔的股票清單，例如「2330,2317,0050」；順序即為優先順序，重複的股票只保留第一次。可以是空的。
 * 代號格式規則見 shared/symbols.js。
 *
 * @param {'tw' | 'us'} marketKey 市場
 * @param {string} text 逗號分隔的代號
 * @param {string} [name] 錯誤訊息使用的欄位名稱
 * @returns {string[]} 整理後的代號
 */
export function parseStockCodes(marketKey, text, name = `news.${marketOf(marketKey).stocksKey}`) {
  return parseSymbols(marketKey, text, name);
}

/**
 * 新聞資料的 JSON 格式（JSON Schema），要求 AI 的回覆必須符合；只包含需要搜尋的市場。
 *
 * @param {object} news 新聞設定（twCount、usCount）
 * @returns {object}
 */
export function buildNewsSchema(news) {
  const markets = enabledMarkets(news);
  const items = newsItemSchema({ stocks: { type: 'array', items: { type: 'string' } } });
  return {
    type: 'object',
    properties: Object.fromEntries(markets.map((market) => [market.key, { type: 'array', items }])),
    required: markets.map((market) => market.key),
    additionalProperties: false,
  };
}

/**
 * 組出要交給 AI 的搜尋提示詞。
 *
 * @param {object} options
 * @param {Date} options.from 新聞發布時間範圍的開始
 * @param {Date} options.to 新聞發布時間範圍的結束（通常為本次執行時間）
 * @param {string} options.timeZone 顯示時間用的時區
 * @param {string[]} options.twStocks 台股清單，依優先順序排列
 * @param {string[]} options.usStocks 美股清單，依優先順序排列
 * @param {number} options.twCount 台股新聞篇數上限，0 代表不搜尋
 * @param {number} options.usCount 美股新聞篇數上限，0 代表不搜尋
 * @returns {string}
 */
export function buildNewsPrompt({ from, to, timeZone, ...news }) {
  const markets = enabledMarkets(news);
  const numerals = ['一', '二', '三'];
  const sections = markets.flatMap((market, index) => [
    `${numerals[index]}、${market.key}：${market.name}新聞，最多 ${news[market.countKey]} 則`,
    ...marketRules(market, news[market.countKey], news[market.stocksKey]),
    `- stocks：新聞主要涉及的${market.codeRule}；${market.name}大盤或整體市場新聞沒有特定個股時填空陣列。`,
    `- 優先採用可信來源，例如 ${market.sources}。`,
    '',
  ]);
  return [
    '你是財經新聞編輯。請使用網路搜尋，找出下列時間範圍內發布的股市新聞，以繁體中文（台灣用語）整理，填入指定的 JSON 欄位。',
    '',
    `時間範圍：${formatInZone(from, timeZone)} ～ ${formatInZone(to, timeZone)}（時區 ${timeZone}）`,
    '',
    ...sections,
    '每則新聞的欄位：',
    '- title：繁體中文標題，可翻譯原文標題，不超過 60 字；提到個股時寫出公司名稱。',
    '- summary：繁體中文摘要，2～3 句、不超過 150 字，保留關鍵數字、股價、漲跌幅與日期。',
    '- source：新聞來源媒體名稱，例如經濟日報、Reuters、CNBC。',
    '- url：新聞原文網址，必須是搜尋時實際看到的完整網址，不要自行編造或改寫。',
    `- publishedAt：發布時間，換算成 ${timeZone} 時區，格式為 YYYY-MM-DD HH:MM；無法確認時填空字串。`,
    '',
    '共同規則：',
    '- 只採用時間範圍內發布的新聞，不要用舊聞充數；除了上述每檔股票至少 1 則以外，不要用不重要的新聞補滿篇數，找不到足夠篇數時只填實際找到的數量。',
    `- 同一事件只選一則${markets.length > 1 ? `，${markets.map((market) => market.key).join(' 與 ')} 之間也不要重複` : ''}。`,
    '- 只根據搜尋到的內容撰寫，不要臆測或加入新聞沒有的資訊，也不要提供投資建議或買賣推薦。',
    '- 這是搜尋與整理工作，不需要執行任何指令或讀寫檔案。',
  ].join('\n');
}

/**
 * 單一市場的挑選規則：
 *   - 沒有股票清單時，選該市場最重要的新聞。
 *   - 清單內的股票每檔至少 1 則；篇數少於股票數量時依順序只取前幾檔；篇數多於股票數量時，剩餘名額只放重要新聞。
 *
 * @param {object} market 市場設定
 * @param {number} count 篇數上限
 * @param {string[]} stocks 股票清單，依優先順序排列
 * @returns {string[]} 提示詞的規則行
 */
function marketRules(market, count, stocks) {
  if (stocks.length === 0) {
    return [
      `- 選出最重要的${market.name}新聞，例如${market.overview}。`,
      '- 依重要性由高到低排序。',
    ];
  }
  const covered = stocks.slice(0, count);
  const rules = [
    '- 依下列股票優先順序搜尋與挑選，數字越小越優先（請先確認每個代號對應的公司或 ETF 名稱）：',
    ...stocks.map((code, index) => `  ${index + 1}. ${code}`),
    `- ${covered.join('、')} 每檔股票至少 1 則：選該股票在時間範圍內最重要的新聞。`,
  ];
  if (count < stocks.length) {
    rules.push(`- 篇數上限 ${count} 則少於股票數量，依優先順序只選前 ${count} 檔股票，每檔 1 則；前面的股票在時間範圍內完全沒有相關新聞時，才由下一檔股票遞補。`);
  } else {
    rules.push('- 某檔股票在時間範圍內完全沒有相關新聞時才跳過，不要用其他股票的新聞冒充。');
  }
  if (count > stocks.length) {
    rules.push(
      `- 上列股票各 1 則之後，剩下的 ${count - stocks.length} 個名額只放真正重要的新聞，可以是上列股票的第 2 則，或其他個股、${market.name}大盤的新聞；沒有重要新聞就空著，不要用不重要的新聞補滿。`,
      `- 重要新聞例如${market.important}；例行盤勢評論、目標價預測、廣告或公關稿不算重要。`,
    );
  }
  rules.push('- 依上述股票優先順序排列；同一檔股票有多則時，依重要性由高到低排列。');
  return rules;
}

/**
 * 解析並檢查 AI 回覆的新聞 JSON。
 *   - 缺少標題或網址不是 http(s) 的新聞直接捨棄；不同市場中重複的網址只保留第一次出現。
 *   - 每個市場依股票清單的順序挑選與排列（規則見 shared/news.js 的 selectByPriority()），取設定篇數。
 *   - 篇數為 0 的市場不檢查也不採用，即使 AI 有回覆。
 *   - 所有市場都沒有任何新聞時拋錯，讓這次不刪除前一次的新聞、也不發送。
 *
 * @param {string} text AI 的回覆
 * @param {object} news 新聞設定（twStocks、usStocks、twCount、usCount）
 * @returns {{tw: object[], us: object[]}}
 */
export function parseNews(text, news) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('AI 回覆的新聞資料不是有效的 JSON');
  }
  const markets = enabledMarkets(news);
  if (!data || typeof data !== 'object' || markets.some((market) => !Array.isArray(data[market.key]))) {
    throw new Error('AI 回覆的新聞資料格式不符');
  }

  const seenUrls = new Set();
  const result = Object.fromEntries(MARKETS.map((market) => [market.key, []]));
  for (const market of markets) {
    const items = data[market.key]
      .map((item) => normalizeItem(item, market))
      .filter((item) => {
        if (!item || seenUrls.has(item.url)) return false;
        seenUrls.add(item.url);
        return true;
      });
    result[market.key] = selectByPriority(items, {
      priority: news[market.stocksKey], count: news[market.countKey], codesOf: (item) => item.stocks,
    });
  }

  if (Object.values(result).every((list) => list.length === 0)) {
    throw new Error('AI 沒有找到任何符合時間範圍的新聞');
  }
  return result;
}

/**
 * 整理單則新聞：共用欄位見 shared/news.js 的 normalizeNewsItem()，再整理 stocks（統一代號格式、去除重複）。
 *
 * @param {object} item AI 回覆的單則新聞
 * @param {object} market 市場設定
 * @returns {object | null}
 */
function normalizeItem(item, market) {
  const news = normalizeNewsItem(item);
  if (!news) return null;
  const stocks = (Array.isArray(item.stocks) ? item.stocks : [])
    .filter((code) => typeof code === 'string' && code.trim())
    .map((code) => normalizeSymbol(market.key, code));
  return { ...news, stocks: [...new Set(stocks)] };
}
