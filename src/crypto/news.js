/**
 * Crypto 新聞規則：組出給 AI 的搜尋提示詞與輸出 JSON Schema，並檢查、整理 AI 的回覆。
 *
 * 每天請 AI 以即時網路搜尋，找出發送前 24 小時內的：
 *   - economy：美國經濟新聞，最重要的 N 則（設定檔 news.economyCount，預設 3）
 *   - crypto：虛擬貨幣新聞，最多 N 則（設定檔 news.coinCount，預設 3）；
 *     news.priorityCoins 的每個幣種至少 1 則（預設 BTC → ADA → ETH），選該幣種最重要的新聞；
 *     篇數少於幣種數量時依幣種順序只取前幾個；還有剩餘名額時只放重要新聞，不足寧缺勿濫
 * 篇數與優先幣種由 config.js 讀取後傳入；想調整撰寫規則，修改 buildNewsPrompt() 即可。
 */
import { newsItemSchema, normalizeNewsItem, selectByPriority } from '../shared/news.js';
import { formatInZone } from '../shared/schedule.js';

export { MAX_NEWS_COUNT } from '../shared/news.js';

// 常見幣種的中文或全名，寫進提示詞幫助 AI 辨識；不在表內的幣種只寫代號
const COIN_NAMES = {
  BTC: '比特幣', ETH: '以太坊', ADA: 'Cardano', SOL: 'Solana', XRP: 'XRP', DOGE: '狗狗幣', BNB: 'BNB',
  DOT: 'Polkadot', AVAX: 'Avalanche', LINK: 'Chainlink', LTC: '萊特幣', TRX: 'TRON', USDT: '泰達幣', USDC: 'USD Coin',
  SNEK: 'Cardano 生態迷因幣 Snek', MIDNIGHT: 'Midnight Network，Cardano 的隱私夥伴鏈，代幣 NIGHT',
};

// 幣種全名換成代號：設定檔或 AI 回覆寫全名時，才能正確判斷優先順序
const COIN_ALIASES = {
  BITCOIN: 'BTC', ETHEREUM: 'ETH', ETHER: 'ETH', CARDANO: 'ADA', SOLANA: 'SOL', RIPPLE: 'XRP',
  DOGECOIN: 'DOGE', POLKADOT: 'DOT', AVALANCHE: 'AVAX', CHAINLINK: 'LINK', LITECOIN: 'LTC', TETHER: 'USDT',
  NIGHT: 'MIDNIGHT', // Midnight Network 的代幣代號為 NIGHT，統一成設定檔常用的 MIDNIGHT
};

/** 幣種名稱轉成大寫代號，例如 btc → BTC、Cardano → ADA。 */
function toCoinCode(value) {
  const code = value.trim().toUpperCase();
  return COIN_ALIASES[code] ?? code;
}

/**
 * 解析設定檔的 news.priorityCoins，例如「BTC,ADA,ETH」；順序即為優先順序，重複的幣種只保留第一次。
 *
 * @param {string} text 原始字串
 * @param {string} [name] 錯誤訊息使用的環境變數名稱
 * @returns {string[]} 大寫幣種代號
 */
export function parseCoins(text, name = 'news.priorityCoins') {
  const coins = String(text).split(',').map((part) => part.trim()).filter(Boolean).map(toCoinCode);
  if (coins.length === 0 || coins.some((coin) => !/^[A-Z0-9]{2,10}$/.test(coin))) {
    throw new Error(`${name} 格式錯誤：「${text}」，請使用逗號分隔的幣種代號，例如 BTC,ADA,ETH`);
  }
  return [...new Set(coins)];
}

// 新聞資料的 JSON 格式（JSON Schema），要求 AI 的回覆必須符合
export const NEWS_SCHEMA = {
  type: 'object',
  properties: {
    economy: { type: 'array', items: newsItemSchema() },
    crypto: { type: 'array', items: newsItemSchema({ coins: { type: 'array', items: { type: 'string' } } }) },
  },
  required: ['economy', 'crypto'],
  additionalProperties: false,
};

/**
 * 組出要交給 AI 的搜尋提示詞。
 *
 * @param {object} options
 * @param {Date} options.from 新聞發布時間範圍的開始
 * @param {Date} options.to 新聞發布時間範圍的結束（通常為本次執行時間）
 * @param {string} options.timeZone 顯示時間用的時區
 * @param {number} options.economyCount 美國經濟新聞篇數
 * @param {number} options.coinCount 虛擬貨幣新聞篇數
 * @param {string[]} options.priorityCoins 優先幣種，依優先順序排列
 * @returns {string}
 */
export function buildNewsPrompt({ from, to, timeZone, economyCount, coinCount, priorityCoins }) {
  const coinList = priorityCoins.map((coin, index) => `  ${index + 1}. ${coin}${COIN_NAMES[coin] && COIN_NAMES[coin] !== coin ? `（${COIN_NAMES[coin]}）` : ''}`);
  return [
    '你是財經新聞編輯。請使用網路搜尋，找出下列時間範圍內發布的新聞，以繁體中文（台灣用語）整理，填入指定的 JSON 欄位。',
    '',
    `時間範圍：${formatInZone(from, timeZone)} ～ ${formatInZone(to, timeZone)}（時區 ${timeZone}）`,
    '',
    `一、economy：美國經濟新聞，最重要的 ${economyCount} 則`,
    '- 以影響美國經濟或金融市場的新聞為主，例如聯準會（Fed）利率決策與官員談話、CPI／PCE 等通膨數據、就業報告、GDP、零售銷售、美債殖利率、美股大盤、財政與關稅政策。',
    '- 依重要性由高到低排序。',
    '',
    `二、crypto：虛擬貨幣新聞，最多 ${coinCount} 則`,
    '- 依下列幣種優先順序搜尋與挑選，數字越小越優先：',
    ...coinList,
    ...cryptoRules(coinCount, priorityCoins),
    '- 依上述幣種優先順序排列；同一幣種有多則時，依重要性由高到低排列。',
    '- coins：新聞主要涉及的幣種代號（大寫，例如 BTC、ADA、ETH、SOL）；整體市場新聞沒有特定幣種時填空陣列。',
    '',
    '每則新聞的欄位：',
    '- title：繁體中文標題，可翻譯原文標題，不超過 60 字。',
    '- summary：繁體中文摘要，2～3 句、不超過 150 字，保留關鍵數字、價格、漲跌幅與日期。',
    '- source：新聞來源媒體名稱，例如 Reuters、CNBC、CoinDesk。',
    '- url：新聞原文網址，必須是搜尋時實際看到的完整網址，不要自行編造或改寫。',
    `- publishedAt：發布時間，換算成 ${timeZone} 時區，格式為 YYYY-MM-DD HH:MM；無法確認時填空字串。`,
    '',
    '共同規則：',
    '- 只採用時間範圍內發布的新聞，不要用舊聞充數；除了上述每個幣種至少 1 則以外，不要用不重要的新聞補滿篇數，找不到足夠篇數時只填實際找到的數量。',
    '- 同一事件只選一則，economy 與 crypto 之間也不要重複。',
    '- 優先採用可信的主要媒體或官方來源，例如 Reuters、Bloomberg、CNBC、WSJ、AP、CoinDesk、The Block 或官方公告。',
    '- 只根據搜尋到的內容撰寫，不要臆測或加入新聞沒有的資訊，也不要提供投資建議。',
    '- 這是搜尋與整理工作，不需要執行任何指令或讀寫檔案。',
  ].join('\n');
}

/**
 * 虛擬貨幣新聞的挑選規則：清單內的幣種每個至少 1 則；篇數少於幣種數量時依順序只取前幾個幣種；
 * 篇數多於幣種數量時，剩餘名額只放重要新聞。
 *
 * @param {number} coinCount 虛擬貨幣新聞篇數上限
 * @param {string[]} priorityCoins 優先幣種，依優先順序排列
 * @returns {string[]} 提示詞的規則行
 */
function cryptoRules(coinCount, priorityCoins) {
  const covered = priorityCoins.slice(0, coinCount);
  const rules = [`- ${covered.join('、')} 每個幣種至少 1 則：選該幣種在時間範圍內最重要的新聞。`];
  if (coinCount < priorityCoins.length) {
    rules.push(`- 篇數上限 ${coinCount} 則少於幣種數量，依優先順序只選前 ${coinCount} 個幣種，每個幣種 1 則；前面的幣種在時間範圍內完全沒有相關新聞時，才由下一個幣種遞補。`);
  } else {
    rules.push('- 某個幣種在時間範圍內完全沒有相關新聞時才跳過，不要用其他幣種的新聞冒充。');
  }
  if (coinCount > priorityCoins.length) {
    rules.push(
      `- 上列幣種各 1 則之後，剩下的 ${coinCount - priorityCoins.length} 個名額只放真正重要的新聞，可以是上列幣種的第 2 則，或其他幣種、整體市場的新聞；沒有重要新聞就空著，不要用不重要的新聞補滿。`,
      '- 重要新聞例如價格大幅波動、ETF 資金流向、監管與法規、重大技術升級、交易所或專案的重大事件；例行行情評論、價格預測、廣告或公關稿不算重要。',
    );
  }
  return rules;
}

/**
 * 解析並檢查 AI 回覆的新聞 JSON。
 *   - 缺少標題或網址不是 http(s) 的新聞直接捨棄；兩個分類中重複的網址只保留第一次出現。
 *   - 虛擬貨幣新聞依 priorityCoins 的順序排列（同時涉及多個幣種時，以最優先的幣種計算），
 *     不涉及優先幣種的新聞排在最後；同一順位維持 AI 的重要性順序。
 *   - 先依幣種順序，替每個優先幣種選 1 則（以該幣種為代表幣種、排最前面的新聞；沒有時改選有提到該幣種的新聞），
 *     篇數用完就停止，所以篇數少於幣種數量時只會選到前面的幣種。
 *   - 還有名額時，再依排列順序補上 AI 回覆的其他新聞（AI 只會在剩餘名額放重要新聞）。
 *   - 兩個分類都沒有任何新聞時拋錯，讓這次不刪除前一次的新聞、也不發送。
 *
 * @param {string} text AI 的回覆
 * @param {{economyCount: number, coinCount: number, priorityCoins: string[]}} options 篇數與優先幣種
 * @returns {{economy: object[], crypto: object[]}}
 */
export function parseNews(text, { economyCount, coinCount, priorityCoins }) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('AI 回覆的新聞資料不是有效的 JSON');
  }
  if (!data || !Array.isArray(data.economy) || !Array.isArray(data.crypto)) {
    throw new Error('AI 回覆的新聞資料格式不符');
  }

  const seenUrls = new Set();
  const clean = (list, withCoins) => list
    .map((item) => normalizeItem(item, withCoins))
    .filter((item) => {
      if (!item || seenUrls.has(item.url)) return false;
      seenUrls.add(item.url);
      return true;
    });

  const economy = clean(data.economy, false).slice(0, economyCount);
  const crypto = selectByPriority(clean(data.crypto, true), { priority: priorityCoins, count: coinCount, codesOf: (item) => item.coins });

  if (economy.length === 0 && crypto.length === 0) {
    throw new Error('AI 沒有找到任何符合時間範圍的新聞');
  }
  return { economy, crypto };
}

/**
 * 整理單則新聞：共用欄位見 shared/news.js 的 normalizeNewsItem()；標題為空或網址無效時回傳 null。
 *
 * @param {object} item AI 回覆的單則新聞
 * @param {boolean} withCoins 是否整理 coins 欄位（虛擬貨幣新聞）
 * @returns {object | null}
 */
function normalizeItem(item, withCoins) {
  const news = normalizeNewsItem(item);
  if (!news) return null;
  if (withCoins) {
    const coins = (Array.isArray(item.coins) ? item.coins : [])
      .filter((coin) => typeof coin === 'string' && coin.trim())
      .map(toCoinCode);
    news.coins = [...new Set(coins)];
  }
  return news;
}
