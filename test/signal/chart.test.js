import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeCandles } from '../../src/signal/indicators.js';
import { buildChartSvg, buildSignalCharts } from '../../src/signal/chart.js';

function fixture({ count = 500, flat = false } = {}) {
  const candles = Array.from({ length: count }, (_, i) => {
    const close = flat ? 100 : 90 + i * 0.1 + Math.sin(i / 8) * 4;
    return {
      time: Date.parse('2025-07-01T00:00Z') + i * 86_400_000,
      open: close - (flat ? 0 : 0.8), high: close + (flat ? 0 : 2), low: close - (flat ? 0 : 1.5), close, volume: flat ? 0 : 1000 + i,
    };
  });
  const price = candles.at(-1).close;
  const item = { symbol: 'BTC', ticker: 'BTCUSDT', source: 'Binance', price, priceTime: candles.at(-1).time, candles, snapshot: analyzeCandles(candles) };
  const signal = {
    symbol: 'BTC', name: '', action: 'trade', direction: 'long', entryType: 'limit', entry: price - 2, takeProfit: price + 10,
    stopLoss: price - 7, price, riskReward: 2.1, reason: '均線向上，等待回檔支撐。', note: '跌破止損則撤單。',
  };
  return { item, signal };
}

const options = { now: new Date('2026-11-23T04:00Z'), timeZone: 'Asia/Taipei' };
const market = (extra = {}) => ({ key: 'crypto', includeChart: true, signals: [], autoSignals: [], ...extra });

test('蠟燭圖包含所有指標與價位，顯示120根但使用完整歷史；文字須跳脫 XML', () => {
  const { item, signal } = fixture();
  signal.reason = '<script>alert("bad")</script> & 趨勢';
  const svg = buildChartSvg(signal, item, { ...options, market: 'crypto' });
  for (const label of ['蠟燭圖', 'EMA20', 'EMA50', 'EMA200', 'MACD(12,26,9)', 'RSI(14)', 'ADX(14)', '+DI', '−DI', 'ATR(14)', '成交量', '成交額', '費波那契', '近20根高', '近20根低', '進場', '止盈', '止損', '限價・待觸發', '量比', '近5根斜率', '現價時間']) assert.ok(svg.includes(label), label);
  assert.match(svg, /顯示最近 120 根，指標以完整 500 根計算/);
  assert.match(svg, /&lt;script&gt;alert\(&quot;bad&quot;\)&lt;\/script&gt; &amp; 趨勢/);
  assert.doesNotMatch(svg, /<script>|NaN|Infinity/);
  assert.match(svg, /成本後 R\/R 1:2.1/);
});

test('只有開啟市場的可做單標的出圖，包含 AUTO 做空；PNG 可解碼且尺寸正確', async () => {
  const { item, signal } = fixture();
  const short = { ...signal, symbol: 'ETH', direction: 'short', entryType: 'market', takeProfit: signal.stopLoss, stopLoss: signal.takeProfit };
  const results = [
    market({ signals: [signal, { ...signal, symbol: 'WAIT', action: 'wait' }], autoSignals: [short] }),
    market({ key: 'tw', includeChart: false, signals: [{ ...signal, symbol: '2330' }] }),
  ];
  const plan = [{ key: 'crypto', items: [item], autoItems: [{ ...item, symbol: 'ETH' }] }];
  const charts = await buildSignalCharts(results, plan, options);
  assert.deepEqual([...charts.keys()], ['crypto:BTC', 'crypto:ETH']);
  for (const chart of charts.values()) {
    assert.equal(chart.contentType, 'image/png');
    assert.deepEqual([...chart.data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(chart.data.readUInt32BE(16), 1600);
    assert.equal(chart.data.readUInt32BE(20), 2100);
    assert.ok(chart.data.byteLength < 1_000_000);
  }
});

test('歷史不足 EMA200、零成交量與平盤時仍可繪圖，缺值顯示 N/A', async () => {
  const { item, signal } = fixture({ count: 60, flat: true });
  const svg = buildChartSvg(signal, item, { ...options, market: 'crypto' });
  assert.match(svg, /EMA200 N\/A/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  const charts = await buildSignalCharts([market({ signals: [signal] })], [{ key: 'crypto', items: [item], autoItems: [] }], options);
  assert.equal(charts.size, 1);
});

test('單張圖失敗只記錄提醒，不中止其餘訊號', async (t) => {
  const { item, signal } = fixture();
  const errors = [];
  t.mock.method(console, 'error', (message) => errors.push(message));
  const charts = await buildSignalCharts([market({ signals: [signal] })], [{ key: 'crypto', items: [{ ...item, candles: [] }], autoItems: [] }], options);
  assert.equal(charts.size, 0);
  assert.match(errors.join('\n'), /圖片解說產生失敗，本次只發送文字/);
});
