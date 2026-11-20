/**
 * 技術指標主題的市場、K 線週期與標的清單規則。
 *   - crypto：虛擬貨幣，USDT 交易對（Binance、Bybit、Bitget），價格單位為美元
 *   - tw：台股（上市、上櫃），價格單位為新台幣
 *   - us：美股，價格單位為美元
 * 每個市場可以填多個代號，或填 AUTO 交給 AI 從成交最熱絡的標的中挑選；清單留空代表不分析該市場。
 * 一律不開槓桿：做多為現貨買進；做空（allowShort）時虛擬貨幣以 USDT 永續合約 1 倍放空，股票以融券放空。
 * K 線固定使用日線（SIGNAL_INTERVAL）；行情與指標模組仍支援 4h、1h，需要時可在這裡調整。
 */
import { parseSymbols } from '../shared/symbols.js';

// 市場設定，順序即為提示詞與 Discord 訊息的順序
export const MARKETS = [
  {
    key: 'crypto',
    name: '虛擬貨幣',
    heading: '🪙 虛擬貨幣',
    currency: '美元',
    unitNote: '美元（USDT 交易對）',
    shortMethod: 'USDT 永續合約 1 倍放空',
    defaultSymbols: 'BTC,ETH',
    autoUniverse: '過去 24 小時成交額最大',
  },
  {
    key: 'tw',
    name: '台股',
    heading: '🇹🇼 台股',
    currency: '新台幣',
    unitNote: '新台幣',
    shortMethod: '融券放空',
    defaultSymbols: '2330,2345',
    autoUniverse: '上市櫃普通股中前一交易日成交金額最大',
  },
  {
    key: 'us',
    name: '美股',
    heading: '🇺🇸 美股',
    currency: '美元',
    unitNote: '美元',
    shortMethod: '融券放空（需保證金帳戶）',
    defaultSymbols: 'NVDA,AAPL',
    autoUniverse: '最近一個交易日成交金額最大（股價 5 美元以上）',
  },
];

// K 線週期：label 為顯示名稱，holding 為提示詞中建議的持有時間；
// binance、bybit、bitget 為各交易所 API 的週期參數；日線都以 UTC 0 點（台灣 08:00）切換
export const INTERVALS = {
  '1d': { label: '日線', ms: 24 * 60 * 60 * 1000, binance: '1d', bybit: 'D', bitget: '1Dutc', holding: '數天到數週' },
  '4h': { label: '4H 線', ms: 4 * 60 * 60 * 1000, binance: '4h', bybit: '240', bitget: '4h', holding: '一到數天' },
  '1h': { label: '1H 線', ms: 60 * 60 * 1000, binance: '1h', bybit: '60', bitget: '1h', holding: '數小時到一天' },
};

// 技術分析使用的 K 線週期：固定為日線
export const SIGNAL_INTERVAL = '1d';

// 每個市場最多幾個代號：每個市場發成一則 Discord 訊息，一則訊息最多 10 張卡片
export const MAX_SYMBOLS = 10;
// AUTO 時交給 AI 挑選的候選數量，以及最多挑選幾個
export const AUTO_CANDIDATES = 15;
export const AUTO_MAX_PICKS = 3;

// 做單的最低風險報酬比（扣除交易成本後）
export const MIN_RISK_REWARD = 1.5;
// 現價進場：進場價與現價最多相差的比例；超過時視為等待更好價位的限價單（做多高於現價、做空低於現價則視為追價）
export const MARKET_ENTRY_GAP = 0.01;
// 資料過期：最後一根已收盤 K 線的開盤時間距今超過幾天，視為停止更新（股票要涵蓋春節等長假）
export const STALE_DAYS = { crypto: 3, tw: 14, us: 14 };

// 每次買進、賣出各預估的滑價
const SLIPPAGE = 0.0005;

/**
 * 交易成本（佔成交金額的比例），用來計算扣除成本後的風險報酬比；open 為進場時、close 為出場時。
 *   做多（現貨買進、賣出）：
 *     虛擬貨幣：現貨手續費約 0.1%
 *     台股：手續費 0.1425%（未計折扣）；賣出另課證交稅，股票 0.3%、ETF（00 開頭）0.1%
 *     美股：多數券商免手續費
 *   做空（放空、回補）：
 *     虛擬貨幣：永續合約手續費約 0.05%（不含資金費率）
 *     台股：融券賣出為手續費 + 證交稅 + 借券費 0.08%，買進回補為手續費（不含融券利息）
 *     美股：多數券商免手續費（不含借券費）
 * 另外每次進場、出場各加上 SLIPPAGE 的滑價。
 *
 * @param {'crypto' | 'tw' | 'us'} market 市場
 * @param {string} symbol 代號
 * @param {'long' | 'short'} [direction='long'] 做多或做空
 * @returns {{open: number, close: number}}
 */
export function tradingCosts(market, symbol, direction = 'long') {
  const short = direction === 'short';
  if (market === 'crypto') {
    const fee = short ? 0.0005 : 0.001;
    return { open: fee + SLIPPAGE, close: fee + SLIPPAGE };
  }
  if (market === 'tw') {
    const fee = 0.001425;
    const tax = symbol.startsWith('00') ? 0.001 : 0.003;
    return short
      ? { open: fee + tax + 0.0008 + SLIPPAGE, close: fee + SLIPPAGE }
      : { open: fee + SLIPPAGE, close: fee + tax + SLIPPAGE };
  }
  return { open: SLIPPAGE, close: SLIPPAGE };
}

/**
 * 最小跳動單位：台股依價格區間（ETF 另有規定），美股 1 美元以上為 0.01；虛擬貨幣各交易對不同，回傳 null（依現價位數四捨五入）。
 *
 * @param {'crypto' | 'tw' | 'us'} market 市場
 * @param {string} symbol 代號
 * @param {number} price 價格
 * @returns {number | null}
 */
export function tickSize(market, symbol, price) {
  if (market === 'tw') {
    if (symbol.startsWith('00')) return price < 50 ? 0.01 : 0.05;
    if (price < 10) return 0.01;
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 500) return 0.5;
    if (price < 1000) return 1;
    return 5;
  }
  if (market === 'us') return price < 1 ? 0.0001 : 0.01;
  return null;
}

export const marketOf = (key) => MARKETS.find((market) => market.key === key);

/** 有設定代號或 AUTO、需要分析的市場。 */
export const isMarketEnabled = (market) => market.auto || market.symbols.length > 0;

/**
 * 解析市場的標的清單：逗號分隔的代號，或 AUTO（不能與其他代號混用）；可以是空的（不分析該市場）。
 *
 * @param {'crypto' | 'tw' | 'us'} key 市場
 * @param {string} text 逗號分隔的代號或 AUTO
 * @param {string} where 錯誤訊息使用的欄位名稱
 * @returns {{auto: boolean, symbols: string[]}}
 */
export function parseMarketSymbols(key, text, where) {
  const parts = String(text).split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.some((part) => part.toUpperCase() === 'AUTO')) {
    if (parts.length > 1) throw new Error(`${where} 填 AUTO 時不能再加其他代號，目前為「${text}」`);
    return { auto: true, symbols: [] };
  }
  const symbols = parseSymbols(key, text, where);
  if (symbols.length > MAX_SYMBOLS) throw new Error(`${where} 最多 ${MAX_SYMBOLS} 個代號，目前有 ${symbols.length} 個`);
  return { auto: false, symbols };
}
