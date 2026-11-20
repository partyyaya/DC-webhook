/**
 * 交易標的代號規則（股票、技術指標等主題共用）：統一代號格式並檢查是否有效。
 *   - crypto：虛擬貨幣，以 USDT 交易對計價，例如 BTC、ETH（BTCUSDT、btc/usdt 都會轉成 BTC）
 *   - tw：台股，例如 2330、0050、00878（2330.TW、6488.TWO 會去掉後綴）
 *   - us：美股，例如 NVDA、BRK.B（$nvda、brk-b 會轉成 NVDA、BRK.B）
 */
export const SYMBOL_RULES = {
  crypto: {
    name: '虛擬貨幣',
    example: 'BTC,ETH,ADA',
    // 轉成大寫，去掉開頭的 $ 與結尾的 USDT 交易對，例如 btc/usdt → BTC
    normalize: (value) => value.trim().toUpperCase().replace(/^\$/, '').replace(/[/_-]?USDT$/, ''),
    // 英文字母與數字，例如 BTC、1INCH、1000SATS
    pattern: /^[A-Z0-9]{1,15}$/,
  },
  tw: {
    name: '台股',
    example: '2330,2317,0050',
    hint: '；0 開頭的代號（例如 0050）請加引號寫成文字',
    // 代號轉成大寫並去掉 .TW／.TWO 後綴，例如 2330.TW → 2330
    normalize: (value) => value.trim().toUpperCase().replace(/\.TWO?$/, ''),
    // 4～6 位數字，可能帶一個英文字母（例如 0050、00878、00679B、2881A）
    pattern: /^\d{4,6}[A-Z]?$/,
  },
  us: {
    name: '美股',
    example: 'NVDA,AAPL,MSFT',
    // 代號轉成大寫，去掉開頭的 $，類別股統一用點號，例如 brk-b → BRK.B
    normalize: (value) => value.trim().toUpperCase().replace(/^\$/, '').replace('-', '.'),
    pattern: /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/,
  },
};

/**
 * 統一單一代號的格式（不檢查是否有效），例如整理 AI 回覆的代號。
 *
 * @param {'crypto' | 'tw' | 'us'} kind 市場
 * @param {string} value 代號
 * @returns {string}
 */
export function normalizeSymbol(kind, value) {
  return SYMBOL_RULES[kind].normalize(String(value));
}

/**
 * 解析設定檔的代號清單，例如「2330,2317,0050」；順序保留，重複的代號只保留第一次。可以是空的。
 *
 * @param {'crypto' | 'tw' | 'us'} kind 市場
 * @param {string} text 逗號分隔的代號
 * @param {string} name 錯誤訊息使用的欄位名稱
 * @returns {string[]} 整理後的代號
 */
export function parseSymbols(kind, text, name) {
  const rule = SYMBOL_RULES[kind];
  const codes = String(text).split(',').map((part) => part.trim()).filter(Boolean).map(rule.normalize);
  if (codes.some((code) => !rule.pattern.test(code))) {
    throw new Error(`${name} 格式錯誤：「${text}」，請使用逗號分隔的${rule.name}代號，例如 ${rule.example}${rule.hint ?? ''}`);
  }
  return [...new Set(codes)];
}
