/**
 * 技術指標主題的市場、K 線週期與標的清單規則。
 *   - crypto：虛擬貨幣，USDT 交易對（Binance、Bybit、Bitget），價格單位為美元
 *   - tw：台股（上市、上櫃），價格單位為新台幣
 *   - us：美股，價格單位為美元
 * 每個市場可以填多個代號，或填 AUTO 交給 AI 從成交最熱絡的標的中挑選；清單留空代表不分析該市場。
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
    defaultSymbols: 'BTC,ETH',
    autoUniverse: '過去 24 小時成交額最大',
  },
  {
    key: 'tw',
    name: '台股',
    heading: '🇹🇼 台股',
    currency: '新台幣',
    unitNote: '新台幣',
    defaultSymbols: '2330,2345',
    autoUniverse: '上市櫃普通股中前一交易日成交金額最大',
  },
  {
    key: 'us',
    name: '美股',
    heading: '🇺🇸 美股',
    currency: '美元',
    unitNote: '美元',
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
