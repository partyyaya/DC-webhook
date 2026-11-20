import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAutoCandidates, fetchCryptoCandles, fetchStockCandles, fetchTwStockList } from '../../src/signal/market-data.js';

const HOUR = 3_600_000;
const at = (text) => Date.parse(text);

/** 模擬 fetch：handler(url) 回傳 [狀態碼, 內容]；記錄每次請求。 */
function mockFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, headers: options.headers });
    const [status, body] = await handler(url);
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

const bar = (time, close, volume = 10) => ({ time, open: close - 1, high: close + 2, low: close - 2, close, volume });

/** Yahoo Finance 的 chart 回應。 */
function yahooChart(bars, meta = {}) {
  return {
    chart: {
      result: [{
        meta: { regularMarketPrice: bars.at(-1).close, regularMarketTime: bars.at(-1).time / 1000, ...meta },
        timestamp: bars.map((item) => item.time / 1000),
        indicators: { quote: [Object.fromEntries(['open', 'high', 'low', 'close', 'volume'].map((key) => [key, bars.map((item) => item[key])]))] },
      }],
      error: null,
    },
  };
}
const notFound = [404, { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }];
const session = (start, end) => ({ start: at(start) / 1000, end: at(end) / 1000 });

test('虛擬貨幣優先使用 Binance：只保留已收盤的 K 線，現價取最後一根', async (t) => {
  const calls = mockFetch(t, () => [200, [
    [at('2026-11-20T00:00Z'), '100', '110', '90', '105', '12.5', at('2026-11-20T03:59:59.999Z'), '0'],
    [at('2026-11-20T04:00Z'), '105', '108', '101', '107', '3', at('2026-11-20T07:59:59.999Z'), '0'],
  ]]);
  const result = await fetchCryptoCandles('BTC', '4h', { now: at('2026-11-20T05:00Z') });
  assert.deepEqual(result, {
    source: 'Binance', ticker: 'BTCUSDT', price: 107, priceTime: at('2026-11-20T05:00Z'),
    candles: [{ time: at('2026-11-20T00:00Z'), open: 100, high: 110, low: 90, close: 105, volume: 12.5, closeTime: at('2026-11-20T04:00Z') }],
  });
  assert.equal(calls[0].url.href, 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=500');
  assert.match(calls[0].headers['user-agent'], /Mozilla/);
});

test('Binance 失敗時改用 Bybit（新到舊排列）；全部失敗時說明各自的原因', async (t) => {
  mockFetch(t, (url) => (url.hostname === 'api.binance.com'
    ? [400, { code: -1121, msg: 'Invalid symbol.' }]
    : [200, { retCode: 0, result: { list: [[String(at('2026-11-20T00:00Z')), '2', '3', '1', '2.5', '9', '0'], [String(at('2026-11-19T00:00Z')), '1', '2', '0.5', '2', '8', '0']] } }]));
  const result = await fetchCryptoCandles('ABC', '1d', { now: at('2026-11-20T12:00Z') });
  assert.equal(result.source, 'Bybit');
  assert.deepEqual(result.candles.map((candle) => [candle.time, candle.closeTime]), [[at('2026-11-19T00:00Z'), at('2026-11-20T00:00Z')]]);
  assert.equal(result.price, 2.5);

  t.mock.restoreAll();
  mockFetch(t, (url) => ({
    'api.binance.com': [400, { code: -1121, msg: 'Invalid symbol.' }],
    'api.bybit.com': [200, { retCode: 10001, retMsg: 'Not supported symbols' }],
    'api.bitget.com': [400, { code: '40034', msg: 'Parameter XYZUSDT does not exist' }],
  })[url.hostname]);
  await assert.rejects(fetchCryptoCandles('XYZ', '1d', { now: Date.now() }),
    /無法取得 XYZUSDT 的 K 線（Binance：HTTP 400（Invalid symbol\.）；Bybit：Not supported symbols；Bitget：HTTP 400（Parameter XYZUSDT does not exist））/);
});

test('Binance、Bybit 都沒有的交易對改用 Bitget；日線不足 500 根時以歷史 K 線往前補', async (t) => {
  const day = 86_400_000;
  const row = (time, close) => [String(time), String(close), String(close * 1.1), String(close * 0.9), String(close), '1000', '1', '1'];
  const start = at('2026-11-17T00:00Z');
  const calls = mockFetch(t, (url) => {
    if (url.hostname === 'api.binance.com') return [400, { code: -1121, msg: 'Invalid symbol.' }];
    if (url.hostname === 'api.bybit.com') return [200, { retCode: 10001, retMsg: 'Not supported symbols' }];
    if (url.pathname.endsWith('/history-candles')) return [200, { code: '00000', data: [row(start - 2 * day, 0.0003), row(start - day, 0.00035), row(start, 0.0004)] }];
    return [200, { code: '00000', data: [0.0004, 0.00041, 0.00042, 0.00043].map((close, i) => row(start + i * day, close)) }];
  });
  const result = await fetchCryptoCandles('SNEK', '1d', { now: at('2026-11-20T08:00Z') });
  assert.equal(result.source, 'Bitget');
  assert.equal(result.ticker, 'SNEKUSDT');
  assert.deepEqual(result.candles.map((candle) => candle.close), [0.0003, 0.00035, 0.0004, 0.00041, 0.00042], '補上前 2 根、去掉重複的一根與尚未收盤的今天');
  assert.equal(result.candles.at(-1).closeTime, at('2026-11-20T00:00Z'));
  assert.equal(result.price, 0.00043);
  const bitget = calls.filter((call) => call.url.hostname === 'api.bitget.com').map((call) => call.url);
  assert.deepEqual(bitget.map((url) => url.pathname), ['/api/v2/spot/market/candles', '/api/v2/spot/market/history-candles']);
  assert.deepEqual(Object.fromEntries(bitget[0].searchParams), { symbol: 'SNEKUSDT', granularity: '1Dutc', limit: '500' });
  assert.deepEqual(Object.fromEntries(bitget[1].searchParams), { symbol: 'SNEKUSDT', granularity: '1Dutc', endTime: String(start), limit: '200' });
});

test('台股找不到上市代號時改查上櫃；交易時段中的當天日線不算已收盤', async (t) => {
  const bars = [bar(at('2026-11-19T01:00Z'), 100), bar(at('2026-11-20T01:00Z'), 98)];
  const regular = session('2026-11-20T01:00Z', '2026-11-20T05:30Z');
  const calls = mockFetch(t, (url) => (url.pathname.endsWith('6488.TW') ? notFound : [200, yahooChart(bars, { currentTradingPeriod: { regular } })]));
  const during = await fetchStockCandles('tw', '6488', '1d', { now: at('2026-11-20T03:00Z') });
  assert.deepEqual(calls.map((call) => call.url.pathname.split('/').at(-1)), ['6488.TW', '6488.TWO']);
  assert.equal(calls[1].url.search, '?interval=1d&range=2y&includePrePost=false');
  assert.equal(during.ticker, '6488.TWO');
  assert.deepEqual(during.candles.map((candle) => candle.close), [100]);
  assert.equal(during.price, 98);

  const after = await fetchStockCandles('tw', '6488', '1d', { now: at('2026-11-20T06:00Z'), exchange: 'tpex' });
  assert.deepEqual(after.candles.map((candle) => candle.close), [100, 98]);
  assert.equal(calls.at(-1).url.pathname.split('/').at(-1), '6488.TWO', '已知上櫃時直接查 .TWO');
});

test('4H 線由 1 小時 K 線依交易日開盤時間合併，去掉收盤時附加的 K 線，未走完的一根不算', async (t) => {
  // 台股 09:00～13:30：09、10、11、12 點合併為一根，13 點單獨一根（到 13:30 收盤）
  const day = (date) => [1, 2, 3, 4, 5].map((hour, i) => bar(at(`${date}T0${hour}:00Z`), 100 + i, 10 + i));
  const bars = [...day('2026-11-19'), { ...bar(at('2026-11-19T05:30Z'), 104), volume: 0 }, ...day('2026-11-20').slice(0, 3)];
  const tradingPeriods = [[session('2026-11-19T01:00Z', '2026-11-19T05:30Z')], [session('2026-11-20T01:00Z', '2026-11-20T05:30Z')]];
  const calls = mockFetch(t, () => [200, yahooChart(bars, { tradingPeriods, currentTradingPeriod: { regular: tradingPeriods[1][0] } })]);
  const result = await fetchStockCandles('tw', '2330', '4h', { now: at('2026-11-20T04:00Z') });
  assert.equal(calls[0].url.search, '?interval=60m&range=1y&includePrePost=false');
  assert.deepEqual(result.candles, [
    { time: at('2026-11-19T01:00Z'), open: 99, high: 105, low: 98, close: 103, volume: 46, closeTime: at('2026-11-19T05:00Z') },
    { time: at('2026-11-19T05:00Z'), open: 103, high: 106, low: 102, close: 104, volume: 14, closeTime: at('2026-11-19T05:30Z') },
  ]);

  const hourly = await fetchStockCandles('tw', '2330', '1h', { now: at('2026-11-20T03:30Z') });
  assert.deepEqual(hourly.candles.map((candle) => candle.closeTime).slice(-3), [at('2026-11-19T05:30Z'), at('2026-11-20T02:00Z'), at('2026-11-20T03:00Z')]);
  assert.equal(calls.at(-1).url.search, '?interval=60m&range=6mo&includePrePost=false');
});

test('美股類別股以 BRK-B 查詢；被限制頻率等錯誤不再嘗試其他代號', async (t) => {
  const calls = mockFetch(t, () => [200, yahooChart([bar(at('2026-11-18T14:30Z'), 500)], { currentTradingPeriod: { regular: session('2026-11-20T14:30Z', '2026-11-20T21:00Z') } })]);
  const result = await fetchStockCandles('us', 'BRK.B', '1d', { now: at('2026-11-20T00:00Z') });
  assert.equal(calls[0].url.pathname, '/v8/finance/chart/BRK-B');
  assert.equal(result.candles.length, 1);

  t.mock.restoreAll();
  const failed = mockFetch(t, () => [403, {}]);
  await assert.rejects(fetchStockCandles('tw', '2330', '1d', { now: Date.now() }), /無法從 Yahoo Finance 取得 2330 的 K 線（2330\.TW：HTTP 403）/);
  assert.equal(failed.length, 1);
});

test('AUTO 虛擬貨幣：USDT 交易對依成交額排序，排除穩定幣與價格固定在 1 美元的幣；Binance 失敗時依序改用 Bybit、Bitget', async (t) => {
  const ticker = (symbol, quoteVolume, lastPrice = '10', highPrice = '11', lowPrice = '9') => ({ symbol, quoteVolume, lastPrice, highPrice, lowPrice });
  mockFetch(t, () => [200, [
    ticker('ETHUSDT', '500'), ticker('BTCUSDT', '900'), ticker('ETHBTC', '9999'), ticker('USDCUSDT', '800', '1', '1.001', '0.999'),
    ticker('NEWUSDUSDT', '700', '1.0001', '1.002', '0.998'), ticker('DOGEUSDT', '0'), ticker('SOLUSDT', '300'),
  ]]);
  assert.deepEqual(await fetchAutoCandidates('crypto', { limit: 2 }), [{ symbol: 'BTC' }, { symbol: 'ETH' }]);
  assert.deepEqual(await fetchAutoCandidates('crypto'), [{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'SOL' }]);

  t.mock.restoreAll();
  mockFetch(t, (url) => (url.hostname === 'api.binance.com'
    ? [451, { msg: 'Service unavailable from a restricted location' }]
    : [200, { retCode: 0, result: { list: [{ symbol: 'XRPUSDT', lastPrice: '2', highPrice24h: '2.2', lowPrice24h: '1.8', turnover24h: '100' }] } }]));
  assert.deepEqual(await fetchAutoCandidates('crypto'), [{ symbol: 'XRP' }]);

  t.mock.restoreAll();
  mockFetch(t, (url) => (url.hostname === 'api.bitget.com'
    ? [200, { code: '00000', data: [{ symbol: 'SNEKUSDT', lastPr: '0.0004', high24h: '0.00043', low24h: '0.0004', usdtVolume: '30000' }] }]
    : [403, {}]));
  assert.deepEqual(await fetchAutoCandidates('crypto'), [{ symbol: 'SNEK' }], 'Binance、Bybit 都失敗時改用 Bitget');
});

test('AUTO 台股：合併上市與上櫃，只取普通股並依成交金額排序；名稱去掉結尾的星號', async (t) => {
  mockFetch(t, (url) => (url.hostname === 'openapi.twse.com.tw'
    ? [200, [{ Code: '2330', Name: '台積電', TradeValue: '900' }, { Code: '0050', Name: '元大台灣50', TradeValue: '9999' }, { Code: '2327', Name: '國巨*', TradeValue: '300' }]]
    : [200, [{ SecuritiesCompanyCode: '6488', CompanyName: '環球晶', TransactionAmount: '500' }, { SecuritiesCompanyCode: '030001', CompanyName: '權證', TransactionAmount: '99999' }]]));
  const list = await fetchTwStockList();
  assert.deepEqual(list.find((row) => row.symbol === '2327'), { symbol: '2327', name: '國巨', exchange: 'twse', tradeValue: 300 });
  assert.deepEqual(await fetchAutoCandidates('tw', { twList: list }), [
    { symbol: '2330', name: '台積電', exchange: 'twse' }, { symbol: '6488', name: '環球晶', exchange: 'tpex' }, { symbol: '2327', name: '國巨', exchange: 'twse' },
  ]);

  // 其中一個來源失敗時仍可使用另一個；兩者都失敗才拋錯
  t.mock.restoreAll();
  mockFetch(t, (url) => (url.hostname === 'openapi.twse.com.tw' ? [500, {}] : [200, [{ SecuritiesCompanyCode: '6488', CompanyName: '環球晶', TransactionAmount: '1' }]]));
  t.mock.method(globalThis, 'setTimeout', (resolve) => resolve());
  assert.deepEqual((await fetchTwStockList()).map((row) => row.symbol), ['6488']);
  t.mock.restoreAll();
  mockFetch(t, () => [404, {}]);
  await assert.rejects(fetchTwStockList(), /無法取得台股清單（證交所：HTTP 404；櫃買中心：HTTP 404）/);
});

test('AUTO 美股：Most Actives 中股價 5 美元以上的股票依成交金額排序', async (t) => {
  const quote = (symbol, regularMarketPrice, regularMarketVolume, quoteType = 'EQUITY') => ({ symbol, regularMarketPrice, regularMarketVolume, quoteType });
  const calls = mockFetch(t, () => [200, { finance: { result: [{ quotes: [
    quote('NIO', 2.6, 900), quote('NVDA', 150, 300), quote('AAPL', 350, 200), quote('SPY', 600, 500, 'ETF'), quote('BRK-B', 500, 10),
  ] }] } }]);
  assert.deepEqual(await fetchAutoCandidates('us'), [{ symbol: 'AAPL' }, { symbol: 'NVDA' }, { symbol: 'BRK.B' }]);
  assert.equal(calls[0].url.searchParams.get('scrIds'), 'most_actives');
});
