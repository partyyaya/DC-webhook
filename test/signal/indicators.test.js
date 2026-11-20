import assert from 'node:assert/strict';
import test from 'node:test';
import { adx, analyzeCandles, atr, ema, fibonacci, isDowntrend, isUptrend, macd, MIN_CANDLES, rma, rsi } from '../../src/signal/indicators.js';

const close = (a, b) => Math.abs(a - b) < 1e-9;
const assertSeries = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, i) => assert.ok(value === null ? actual[i] === null : close(actual[i], value), `第 ${i} 個：${actual[i]} ≠ ${value}`));
};
// 依收盤價建立 K 線：最高、最低為收盤價 ±1，開盤時間每根相隔 1 小時
const candlesOf = (closes, volume = () => 100) => closes.map((value, i) => ({
  time: i * 3_600_000, open: value, high: value + 1, low: value - 1, close: value, volume: volume(i),
}));

test('EMA 以前 N 根的平均起算；RMA 從第一個有值的位置開始', () => {
  assertSeries(ema([1, 2, 3, 4, 5, 6], 3), [null, null, 2, 3, 4, 5]);
  assertSeries(rma([null, 1, 2, 3, 4], 2), [null, null, 1.5, 2.25, 3.125]);
  assertSeries(ema([1, 2], 3), [null, null]);
});

test('RSI：Wilder 平滑；只漲為 100、只跌為 0', () => {
  // 漲跌交替：前 2 次變化平均漲 0.5、跌 0.5 → 50；再漲 1 → 漲 0.75、跌 0.25 → 75
  assertSeries(rsi([1, 2, 1, 2], 2), [null, null, 50, 75]);
  assert.equal(rsi([1, 2, 3, 4, 5], 2).at(-1), 100);
  assert.equal(rsi([5, 4, 3, 2, 1], 2).at(-1), 0);
});

test('ATR：真實波幅包含跳空缺口', () => {
  // 每根高低差 2、收盤在中間 → ATR = 2
  assert.ok(close(atr(candlesOf([10, 10, 10, 10]), 3).at(-1), 2));
  // 前收 10，下一根跳空到 13～15 → 真實波幅 5
  const gap = [{ high: 11, low: 9, close: 10 }, { high: 15, low: 13, close: 14 }];
  assertSeries(atr(gap, 2), [null, 3.5]);
});

test('ADX：持續上漲時 +DI 為主、ADX 趨近 100', () => {
  // 每根最高、最低都上漲 1，高低差 2 → +DM 1、−DM 0、真實波幅 2
  const rising = Array.from({ length: 60 }, (_, i) => ({ high: i + 2, low: i, close: i + 1 }));
  const result = adx(rising, 14);
  assert.ok(close(result.plusDI.at(-1), 50));
  assert.equal(result.minusDI.at(-1), 0);
  assert.ok(close(result.adx.at(-1), 100));
  assert.equal(result.adx[26], null, '前 2 × 14 根沒有 ADX');
});

test('MACD：等差數列的 EMA 落後 (N − 1) ÷ 2，DIF 固定為 12.5 − 5.5 = 7', () => {
  const closes = Array.from({ length: 60 }, (_, i) => i);
  const result = macd(closes);
  assert.ok(close(result.macd.at(-1), 7));
  assert.ok(close(result.signal.at(-1), 7));
  assert.ok(close(result.histogram.at(-1), 0));
  assert.equal(result.signal[32], null, 'DIF 從第 26 根開始，訊號線從第 34 根開始');
  assert.notEqual(result.signal[33], null);
});

test('費波那契：上升波段由高點往下回撤、往上延伸；下降波段相反，小於 0 的延伸位不列出', () => {
  const swing = (lows, highs) => lows.map((low, i) => ({ time: i, low, high: highs[i], close: low }));
  const up = fibonacci(swing([100, 120, 150, 170, 180], [110, 130, 160, 200, 190]));
  assert.equal(up.trend, 'up');
  assert.deepEqual([up.low, up.high], [{ price: 100, time: 0 }, { price: 200, time: 3 }]);
  assert.ok(close(up.retracements.find((level) => level.ratio === 0.618).price, 138.2));
  assert.ok(close(up.extensions.find((level) => level.ratio === 1.618).price, 261.8));

  const down = fibonacci(swing([150, 120, 100], [200, 160, 130]));
  assert.equal(down.trend, 'down');
  assert.ok(close(down.retracements.find((level) => level.ratio === 0.382).price, 138.2));
  assert.deepEqual(down.extensions.map((level) => Number(level.price.toFixed(1))), [72.8, 38.2]);

  const crash = fibonacci(swing([90, 30], [100, 40]));
  assert.deepEqual(crash.extensions.map((level) => level.ratio), [1.272]);
});

test('指標快照：取最後一根已收盤 K 線的數值，並偵測 MACD 交叉與量能', () => {
  // 盤整 100 根後最後一根大漲且放量 → MACD 黃金交叉、成交量為平均的 3 倍
  const closes = [...Array.from({ length: 249 }, () => 100), 110];
  const snapshot = analyzeCandles(candlesOf(closes, (i) => (i === 249 ? 300 : 100)));
  assert.equal(snapshot.count, 250);
  assert.equal(snapshot.last.close, 110);
  assert.equal(snapshot.recent.length, 5);
  assert.ok(close(snapshot.ema.ema200, 100 + (10 * 2) / 201));
  assert.deepEqual(snapshot.macd.cross, { type: 'golden', barsAgo: 0 });
  assert.equal(snapshot.rsi.value, 100);
  assert.equal(snapshot.volume.ratio, 3);
  assert.deepEqual(snapshot.range20, { high: 111, low: 99 });
  assert.equal(snapshot.fibonacci.trend, 'up');
  // EMA50 較 5 根前上升；最近 5 根的 RSI 與 MACD 柱狀體；近 20 根只有最後一根上漲；成交額為收盤價 × 成交量
  assert.ok(Math.abs(snapshot.ema.ema50Slope - ((10 * 2) / 51)) < 1e-9);
  assert.deepEqual(snapshot.rsi.recent.length, 5);
  assert.equal(snapshot.rsi.recent.at(-1), 100);
  assert.equal(snapshot.macd.recentHistogram.length, 5);
  assert.equal(snapshot.macd.recentHistogram.at(-1), snapshot.macd.histogram);
  assert.equal(snapshot.volume.upAverage, 300);
  assert.equal(snapshot.volume.downAverage, null);
  assert.deepEqual(snapshot.turnover, { last: 33000, average: 10000 });

  // 不足 200 根時沒有 EMA200；不足最低數量時拋錯
  assert.equal(analyzeCandles(candlesOf(closes.slice(-100))).ema.ema200, null);
  assert.throws(() => analyzeCandles(candlesOf(closes.slice(0, MIN_CANDLES - 1))), /只有 59 根，至少需要 60 根/);
});

test('趨勢篩選：向上為收盤價高於 EMA50 且 EMA20 > EMA50，向下為收盤價低於 EMA50 且 EMA20 < EMA50', () => {
  const rising = analyzeCandles(candlesOf(Array.from({ length: 100 }, (_, i) => 100 + i)));
  const falling = analyzeCandles(candlesOf(Array.from({ length: 100 }, (_, i) => 200 - i)));
  // 長期上漲後最後急跌到 EMA50 之下
  const broken = analyzeCandles(candlesOf([...Array.from({ length: 99 }, (_, i) => 100 + i), 120]));
  assert.deepEqual([isUptrend(rising), isUptrend(falling), isUptrend(broken)], [true, false, false]);
  assert.deepEqual([isDowntrend(rising), isDowntrend(falling), isDowntrend(broken)], [false, true, false]);
});
