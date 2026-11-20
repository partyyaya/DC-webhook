/**
 * 行情資料：取得 K 線與 AUTO 的候選標的，並計算技術指標。全部是免費、不需要 API key 的公開資料。
 *
 *   虛擬貨幣（USDT 交易對）：優先使用 Binance 現貨 API，失敗（例如地區限制、沒有該交易對）時依序改用 Bybit、Bitget 現貨 API
 *   台股、美股：Yahoo Finance（日線直接取得；4H 線由 1 小時 K 線依每個交易日的開盤時間合併，與 TradingView 相同）
 *   台股名稱與上市／上櫃：證交所與櫃買中心 OpenAPI
 *
 * 只使用已收盤的 K 線計算指標；尚未收盤的最後一根只用來取得現價。
 *
 * AUTO 的候選標的（各取前 AUTO_CANDIDATES 名，再由 AI 挑選）：
 *   虛擬貨幣：24 小時成交額最大的 USDT 交易對（Binance，失敗時依序改用 Bybit、Bitget），排除穩定幣、包裝幣與貴金屬代幣
 *   台股：前一交易日成交金額最大的上市櫃普通股（不含 ETF）
 *   美股：Yahoo Finance「Most Actives」中成交金額最大、股價 5 美元以上的股票
 */
import { analyzeCandles } from './indicators.js';
import { AUTO_CANDIDATES, INTERVALS, isMarketEnabled, MARKETS } from './markets.js';
import { logError } from '../shared/log.js';
import { normalizeSymbol, SYMBOL_RULES } from '../shared/symbols.js';

const URLS = {
  binance: 'https://api.binance.com',
  bybit: 'https://api.bybit.com',
  bitget: 'https://api.bitget.com',
  yahoo: 'https://query1.finance.yahoo.com',
  twse: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  tpex: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
};
// Yahoo Finance 沒有 User-Agent 會回覆 429
const USER_AGENT = 'Mozilla/5.0 (compatible; dcwebhook/1.0)';
// 每個標的取得的 K 線數量：EMA200 需要足夠的歷史資料才會收斂
const CANDLE_LIMIT = 500;
// Yahoo Finance 的資料範圍：日線約 500 根；4H 與 1H 由 1 小時 K 線合併，約 500 根以上
const YAHOO_RANGES = { '1d': '2y', '4h': '1y', '1h': '6mo' };
const HOUR_MS = 60 * 60 * 1000;
// 同時取得 K 線的標的數量，避免被行情網站限制頻率
const CONCURRENCY = 4;
// 被限制頻率（429）、伺服器錯誤或連線失敗時，隔一段時間重試一次
const RETRY_DELAY_MS = 2000;
// AUTO 排除的幣：穩定幣、法幣、包裝幣與貴金屬代幣，不適合做技術分析的單
const EXCLUDED_COINS = new Set([
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'BUSD', 'USDE', 'PYUSD', 'USD1', 'XUSD', 'BFUSD', 'RLUSD', 'USDS', 'FRAX', 'GUSD', 'USDD',
  'EUR', 'EURI', 'AEUR', 'EURC', 'TRY', 'BRL', 'WBTC', 'WBETH', 'BETH', 'STETH', 'PAXG', 'XAUT',
]);

/**
 * 取得 JSON。HTTP 錯誤時拋出含狀態碼與原因的錯誤；429、5xx 與連線失敗時重試一次。
 *
 * @param {string} url 網址
 * @param {object} [options]
 * @param {number} [options.timeoutMs=20000] 逾時時間
 * @returns {Promise<any>}
 */
export async function getJson(url, { timeoutMs = 20_000 } = {}) {
  try {
    return await requestJson(url, timeoutMs);
  } catch (err) {
    if (!err.retryable) throw err;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return requestJson(url, timeoutMs);
  }
}

async function requestJson(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const error = new Error(err.name === 'TimeoutError' ? `連線逾時（${Math.round(timeoutMs / 1000)} 秒）` : `連線失敗：${err.cause?.code ?? err.message}`);
    error.retryable = true;
    throw error;
  }
  const body = await response.text();
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {
    // 不是 JSON 的回應（例如錯誤頁面）
  }
  if (!response.ok) {
    const detail = data?.msg ?? data?.retMsg ?? data?.chart?.error?.description ?? data?.finance?.error?.description;
    const error = new Error(`HTTP ${response.status}${detail ? `（${detail}）` : ''}`);
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  if (data === null) throw new Error('回應不是 JSON');
  return data;
}

/** 只保留已收盤的 K 線，並以最後一根（可能尚未收盤）的收盤價作為現價。 */
function closedCandles(all, now) {
  return all.filter((candle) => candle.closeTime <= now);
}

// ---- 虛擬貨幣 ----

async function binanceCandles(pair, interval, { timeoutMs }) {
  const rows = await getJson(`${URLS.binance}/api/v3/klines?symbol=${pair}&interval=${INTERVALS[interval].binance}&limit=${CANDLE_LIMIT}`, { timeoutMs });
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('沒有 K 線資料');
  // [開盤時間, 開, 高, 低, 收, 成交量, 收盤時間（最後 1 毫秒）, ...]
  return rows.map((row) => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
    closeTime: Number(row[6]) + 1,
  }));
}

async function bybitCandles(pair, interval, { timeoutMs }) {
  const data = await getJson(`${URLS.bybit}/v5/market/kline?category=spot&symbol=${pair}&interval=${INTERVALS[interval].bybit}&limit=${CANDLE_LIMIT}`, { timeoutMs });
  if (data?.retCode !== 0) throw new Error(data?.retMsg || `retCode ${data?.retCode}`);
  const rows = data.result?.list;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('沒有 K 線資料');
  // 新到舊排列：[開盤時間, 開, 高, 低, 收, 成交量, 成交額]
  return rows.map((row) => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
    closeTime: Number(row[0]) + INTERVALS[interval].ms,
  })).sort((a, b) => a.time - b.time);
}

/** Bitget 公開行情 API：成功時 code 為 '00000'。 */
async function bitgetData(path, timeoutMs) {
  const data = await getJson(`${URLS.bitget}/api/v2/spot/market/${path}`, { timeoutMs });
  if (data?.code !== '00000') throw new Error(data?.msg || `code ${data?.code}`);
  return data.data;
}

async function bitgetCandles(pair, interval, { timeoutMs }) {
  const granularity = INTERVALS[interval].bitget;
  let rows = await bitgetData(`candles?symbol=${pair}&granularity=${granularity}&limit=${CANDLE_LIMIT}`, timeoutMs);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('沒有 K 線資料');
  // 日線一次最多 300 根：不足時以歷史 K 線往前補（一次最多 200 根）；補不到時沿用已取得的資料
  if (rows.length < CANDLE_LIMIT) {
    const first = Number(rows[0][0]);
    const older = await bitgetData(`history-candles?symbol=${pair}&granularity=${granularity}&endTime=${first}&limit=${Math.min(200, CANDLE_LIMIT - rows.length)}`, timeoutMs)
      .catch(() => []);
    rows = [...(Array.isArray(older) ? older : []).filter((row) => Number(row[0]) < first), ...rows];
  }
  // 舊到新排列：[開盤時間, 開, 高, 低, 收, 成交量, USDT 成交額, 成交額]
  return rows.map((row) => ({
    time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
    closeTime: Number(row[0]) + INTERVALS[interval].ms,
  })).sort((a, b) => a.time - b.time);
}

/**
 * 取得虛擬貨幣的 K 線：優先 Binance，失敗時依序改用 Bybit、Bitget。
 *
 * @param {string} symbol 幣種代號，例如 BTC（使用 BTCUSDT 交易對）
 * @param {'1d' | '4h' | '1h'} interval K 線週期
 * @param {object} options
 * @param {number} options.now 目前時間（毫秒），判斷 K 線是否已收盤
 * @param {number} [options.timeoutMs] 每個請求的逾時時間
 * @returns {Promise<{source: string, ticker: string, candles: object[], price: number, priceTime: number}>}
 */
export async function fetchCryptoCandles(symbol, interval, { now, timeoutMs }) {
  const pair = `${symbol}USDT`;
  const errors = [];
  for (const [source, load] of [['Binance', binanceCandles], ['Bybit', bybitCandles], ['Bitget', bitgetCandles]]) {
    try {
      const all = await load(pair, interval, { timeoutMs });
      return { source, ticker: pair, candles: closedCandles(all, now), price: all.at(-1).close, priceTime: now };
    } catch (err) {
      errors.push(`${source}：${err.message}`);
    }
  }
  throw new Error(`無法取得 ${pair} 的 K 線（${errors.join('；')}）`);
}

// ---- 台股、美股（Yahoo Finance） ----

/**
 * 取得股票的 K 線。台股依上市（.TW）或上櫃（.TWO）查詢，不確定時兩者都試；美股類別股使用 BRK-B 格式。
 *
 * @param {'tw' | 'us'} market 市場
 * @param {string} symbol 代號
 * @param {'1d' | '4h' | '1h'} interval K 線週期
 * @param {object} options
 * @param {number} options.now 目前時間（毫秒）
 * @param {number} [options.timeoutMs] 每個請求的逾時時間
 * @param {'twse' | 'tpex'} [options.exchange] 台股的上市或上櫃（未知時先試上市）
 * @returns {Promise<{source: string, ticker: string, candles: object[], price: number, priceTime: number}>}
 */
export async function fetchStockCandles(market, symbol, interval, { now, timeoutMs, exchange }) {
  const tickers = market === 'us'
    ? [symbol.replace('.', '-')]
    : exchange === 'tpex' ? [`${symbol}.TWO`, `${symbol}.TW`] : [`${symbol}.TW`, `${symbol}.TWO`];
  const errors = [];
  for (const ticker of tickers) {
    try {
      return await yahooCandles(ticker, interval, { now, timeoutMs });
    } catch (err) {
      errors.push(`${ticker}：${err.message}`);
      // 找不到代號才試下一個後綴；其他錯誤（例如被限制頻率）直接放棄
      if (err.status !== 404) break;
    }
  }
  throw new Error(`無法從 Yahoo Finance 取得 ${symbol} 的 K 線（${errors.join('；')}）`);
}

async function yahooCandles(ticker, interval, { now, timeoutMs }) {
  const daily = interval === '1d';
  const url = `${URLS.yahoo}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${daily ? '1d' : '60m'}&range=${YAHOO_RANGES[interval]}&includePrePost=false`;
  const data = await getJson(url, { timeoutMs });
  const result = data?.chart?.result?.[0];
  const notFound = (message) => Object.assign(new Error(message), { status: 404 });
  if (!result) throw notFound(data?.chart?.error?.description ?? '沒有資料');
  const { meta = {}, timestamp = [], indicators } = result;
  const quote = indicators?.quote?.[0] ?? {};
  const bars = timestamp
    .map((time, i) => ({
      time: time * 1000, open: quote.open?.[i], high: quote.high?.[i], low: quote.low?.[i], close: quote.close?.[i], volume: quote.volume?.[i] ?? 0,
    }))
    .filter((bar) => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
  if (bars.length === 0) throw notFound('沒有 K 線資料');

  const all = daily ? yahooDaily(bars, meta) : yahooIntraday(bars, meta, interval);
  if (all.length === 0) throw new Error('沒有交易時段內的 K 線資料');
  return {
    source: 'Yahoo Finance',
    ticker,
    candles: closedCandles(all, now),
    price: Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : all.at(-1).close,
    priceTime: Number.isFinite(meta.regularMarketTime) ? meta.regularMarketTime * 1000 : all.at(-1).time,
  };
}

/** 日線：屬於目前（或今天）交易時段的那一根，在收盤後才算已收盤；之前的都已收盤。 */
function yahooDaily(bars, meta) {
  const regular = meta.currentTradingPeriod?.regular;
  if (!regular) return bars.map((bar) => ({ ...bar, closeTime: bar.time }));
  const start = regular.start * 1000;
  const end = regular.end * 1000;
  // 日線的時間是交易日的開盤時間；保留半天的誤差
  return bars.map((bar) => ({ ...bar, closeTime: bar.time >= start - 12 * HOUR_MS && bar.time < end ? end : bar.time }));
}

/**
 * 1 小時 K 線：去掉交易時段以外的資料（例如收盤時附加的零成交量 K 線），每根在 1 小時後或收盤時收盤。
 * 4H：同一個交易日內從開盤起每 4 根合併，最後一根到收盤為止（例如台股 09:00、13:00 兩根）。
 */
function yahooIntraday(bars, meta, interval) {
  const sessions = tradingSessions(meta, bars);
  const hourly = bars
    .map((bar) => ({ ...bar, session: sessions.find((session) => bar.time >= session.start && bar.time < session.end) }))
    .filter((bar) => bar.session);
  if (interval === '1h') {
    return hourly.map(({ session, ...bar }) => ({ ...bar, closeTime: Math.min(bar.time + HOUR_MS, session.end) }));
  }

  const span = INTERVALS[interval].ms;
  const groups = new Map();
  for (const { session, ...bar } of hourly) {
    const start = session.start + Math.floor((bar.time - session.start) / span) * span;
    const group = groups.get(start);
    if (!group) {
      groups.set(start, { ...bar, time: start, closeTime: Math.min(start + span, session.end) });
      continue;
    }
    group.high = Math.max(group.high, bar.high);
    group.low = Math.min(group.low, bar.low);
    group.close = bar.close;
    group.volume += bar.volume;
  }
  return [...groups.values()];
}

/**
 * 每個交易日的正常交易時段。Yahoo Finance 沒有提供時，依交易所當地日期分組，
 * 以當天第一根的時間為開盤、最後一根加 1 小時為收盤。
 *
 * @returns {{start: number, end: number}[]}
 */
function tradingSessions(meta, bars) {
  const periods = [
    ...(Array.isArray(meta.tradingPeriods) ? meta.tradingPeriods.flat() : []),
    meta.currentTradingPeriod?.regular,
  ].filter((period) => Number.isFinite(period?.start) && Number.isFinite(period?.end));
  const sessions = [...new Map(periods.map((period) => [period.start, { start: period.start * 1000, end: period.end * 1000 }])).values()];
  if (sessions.length > 0) return sessions.sort((a, b) => a.start - b.start);

  const offset = (meta.gmtoffset ?? 0) * 1000;
  const days = new Map();
  for (const bar of bars) {
    const day = Math.floor((bar.time + offset) / (24 * HOUR_MS));
    const session = days.get(day) ?? { start: bar.time, end: bar.time };
    session.end = bar.time + HOUR_MS;
    days.set(day, session);
  }
  return [...days.values()];
}

// ---- 台股清單與 AUTO 候選 ----

/** 股票名稱去掉空白與證交所標示用的結尾星號，例如「國巨*」→「國巨」。 */
const cleanName = (value) => String(value ?? '').trim().replace(/\*+$/, '');

/**
 * 取得上市與上櫃股票的代號、名稱與前一交易日成交金額（證交所、櫃買中心 OpenAPI）。
 * 其中一個來源失敗時仍回傳另一個的資料；兩者都失敗才拋錯。
 *
 * @returns {Promise<{symbol: string, name: string, exchange: 'twse' | 'tpex', tradeValue: number}[]>}
 */
export async function fetchTwStockList({ timeoutMs } = {}) {
  const [twse, tpex] = await Promise.allSettled([getJson(URLS.twse, { timeoutMs }), getJson(URLS.tpex, { timeoutMs })]);
  if (twse.status === 'rejected' && tpex.status === 'rejected') {
    throw new Error(`無法取得台股清單（證交所：${twse.reason.message}；櫃買中心：${tpex.reason.message}）`);
  }
  const rows = (result) => (result.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []);
  return [
    ...rows(twse).map((row) => ({ symbol: String(row.Code ?? '').trim(), name: cleanName(row.Name), exchange: 'twse', tradeValue: Number(row.TradeValue) || 0 })),
    ...rows(tpex).map((row) => ({
      symbol: String(row.SecuritiesCompanyCode ?? '').trim(), name: cleanName(row.CompanyName), exchange: 'tpex', tradeValue: Number(row.TransactionAmount) || 0,
    })),
  ].filter((row) => row.symbol);
}

/**
 * 取得 AUTO 的候選標的，依成交金額由大到小排列。
 *
 * @param {'crypto' | 'tw' | 'us'} market 市場
 * @param {object} [options]
 * @param {number} [options.limit=AUTO_CANDIDATES] 候選數量
 * @param {number} [options.timeoutMs] 每個請求的逾時時間
 * @param {object[] | null} [options.twList] 已取得的台股清單（台股使用）
 * @returns {Promise<{symbol: string, name?: string, exchange?: string}[]>}
 */
export async function fetchAutoCandidates(market, { limit = AUTO_CANDIDATES, timeoutMs, twList } = {}) {
  if (market === 'crypto') return cryptoCandidates(limit, timeoutMs);
  if (market === 'tw') return twCandidates(twList ?? (await fetchTwStockList({ timeoutMs })), limit);
  return usCandidates(limit, timeoutMs);
}

async function cryptoCandidates(limit, timeoutMs) {
  const sources = [
    ['Binance', async () => (await getJson(`${URLS.binance}/api/v3/ticker/24hr?type=MINI`, { timeoutMs })).map((row) => ({
      pair: row.symbol, last: Number(row.lastPrice), high: Number(row.highPrice), low: Number(row.lowPrice), turnover: Number(row.quoteVolume),
    }))],
    ['Bybit', async () => {
      const data = await getJson(`${URLS.bybit}/v5/market/tickers?category=spot`, { timeoutMs });
      if (data?.retCode !== 0) throw new Error(data?.retMsg || `retCode ${data?.retCode}`);
      return data.result.list.map((row) => ({
        pair: row.symbol, last: Number(row.lastPrice), high: Number(row.highPrice24h), low: Number(row.lowPrice24h), turnover: Number(row.turnover24h),
      }));
    }],
    ['Bitget', async () => (await bitgetData('tickers', timeoutMs)).map((row) => ({
      pair: row.symbol, last: Number(row.lastPr), high: Number(row.high24h), low: Number(row.low24h), turnover: Number(row.usdtVolume),
    }))],
  ];
  const errors = [];
  for (const [source, load] of sources) {
    try {
      return pickCoins(await load(), limit);
    } catch (err) {
      errors.push(`${source}：${err.message}`);
    }
  }
  throw new Error(`無法取得虛擬貨幣成交額排行（${errors.join('；')}）`);
}

/** USDT 交易對依 24 小時成交額排序，排除穩定幣等（24 小時內價格都在 1 美元附近的也視為穩定幣）。 */
function pickCoins(rows, limit) {
  const pegged = (row) => row.low > 0 && row.high / row.low < 1.01 && Math.abs(row.last - 1) < 0.03;
  return rows
    .filter((row) => typeof row.pair === 'string' && row.pair.endsWith('USDT'))
    .map((row) => ({ ...row, symbol: row.pair.slice(0, -4) }))
    .filter((row) => SYMBOL_RULES.crypto.pattern.test(row.symbol) && !EXCLUDED_COINS.has(row.symbol) && !pegged(row) && row.turnover > 0)
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, limit)
    .map(({ symbol }) => ({ symbol }));
}

/** 上市櫃普通股（4 位數、非 0 開頭，不含 ETF）依前一交易日成交金額排序。 */
function twCandidates(list, limit) {
  return list
    .filter((row) => /^[1-9]\d{3}$/.test(row.symbol) && row.tradeValue > 0)
    .sort((a, b) => b.tradeValue - a.tradeValue)
    .slice(0, limit)
    .map(({ symbol, name, exchange }) => ({ symbol, name, exchange }));
}

/** Yahoo Finance 成交量最大的股票中，股價 5 美元以上的依成交金額排序。 */
async function usCandidates(limit, timeoutMs) {
  const data = await getJson(`${URLS.yahoo}/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100`, { timeoutMs });
  const quotes = data?.finance?.result?.[0]?.quotes;
  if (!Array.isArray(quotes)) throw new Error('Yahoo Finance 熱門股清單格式不符');
  return quotes
    .filter((quote) => quote.quoteType === 'EQUITY' && typeof quote.symbol === 'string' && quote.regularMarketPrice >= 5)
    .map((quote) => ({ symbol: normalizeSymbol('us', quote.symbol), turnover: quote.regularMarketPrice * (quote.regularMarketVolume ?? 0) }))
    .filter((quote) => SYMBOL_RULES.us.pattern.test(quote.symbol))
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, limit)
    .map(({ symbol }) => ({ symbol }));
}

// ---- 整理所有市場的資料 ----

/** 依序處理，同時最多 limit 個。 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * 取得每個要分析的市場的行情資料並計算指標。單一標的失敗不影響其他標的。
 *
 * @param {object} markets 設定檔的市場設定：{crypto, tw, us}，每個為 {auto, symbols, interval}
 * @param {object} options
 * @param {number} options.now 目前時間（毫秒）
 * @param {number} [options.timeoutMs] 每個請求的逾時時間
 * @returns {Promise<object[]>} 每個市場：
 *   items    成功取得資料的標的 {symbol, name, source, ticker, price, priceTime, snapshot}
 *   errors   指定的標的中無法取得資料的 {symbol, message}（會顯示在 Discord）
 *   failure  AUTO 無法取得候選標的、或所有候選都失敗時的原因（會顯示在 Discord）
 *   candidates AUTO 的候選數量
 */
export async function prepareMarkets(markets, { now, timeoutMs }) {
  const enabled = MARKETS.filter((market) => markets[market.key] && isMarketEnabled(markets[market.key]));
  // 台股名稱與上市／上櫃；取得失敗時只顯示代號，並依序嘗試上市與上櫃
  let twList = null;
  if (enabled.some((market) => market.key === 'tw')) {
    twList = await fetchTwStockList({ timeoutMs }).catch((err) => {
      logError(`[台股] 無法取得股票名稱清單，只顯示代號：${err.message}`);
      return null;
    });
  }

  const result = [];
  for (const market of enabled) {
    const { auto, symbols, interval } = markets[market.key];
    const entry = { key: market.key, interval, auto, candidates: 0, items: [], errors: [], failure: null };
    result.push(entry);

    let targets;
    if (auto) {
      try {
        if (market.key === 'tw' && !twList) throw new Error('無法取得台股清單');
        targets = await fetchAutoCandidates(market.key, { timeoutMs, twList });
        if (targets.length === 0) throw new Error('沒有候選標的');
      } catch (err) {
        entry.failure = `無法取得 AUTO 的候選標的：${err.message}`;
        logError(`[${market.name}] ${entry.failure}`);
        continue;
      }
      entry.candidates = targets.length;
    } else {
      const info = (symbol) => twList?.find((row) => row.symbol === symbol);
      targets = symbols.map((symbol) => ({ symbol, name: info(symbol)?.name ?? '', exchange: info(symbol)?.exchange }));
    }

    const loaded = await mapLimit(targets, CONCURRENCY, async (target) => {
      try {
        const data = market.key === 'crypto'
          ? await fetchCryptoCandles(target.symbol, interval, { now, timeoutMs })
          : await fetchStockCandles(market.key, target.symbol, interval, { now, timeoutMs, exchange: target.exchange });
        const { candles, ...rest } = data;
        return { item: { symbol: target.symbol, name: target.name ?? '', ...rest, snapshot: analyzeCandles(candles) } };
      } catch (err) {
        logError(`[${market.name} ${target.symbol}] ${err.message}`);
        return { error: { symbol: target.symbol, message: err.message } };
      }
    });
    entry.items = loaded.filter((row) => row.item).map((row) => row.item);
    const errors = loaded.filter((row) => row.error).map((row) => row.error);
    // AUTO 的候選失敗只記錄在終端機；全部失敗時才顯示在 Discord
    if (!auto) entry.errors = errors;
    else if (entry.items.length === 0) entry.failure = `所有候選標的都無法取得行情資料（${errors[0]?.message ?? '未知原因'}）`;
  }
  return result;
}
