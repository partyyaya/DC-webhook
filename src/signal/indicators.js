/**
 * 技術指標計算：輸入依時間排序、已收盤的 K 線，計算與 TradingView 預設參數相同的指標。
 *   - EMA 20／50／200：以前 N 根收盤價的簡單平均起算
 *   - MACD(12, 26, 9)：DIF = EMA12 − EMA26，訊號線 = DIF 的 EMA9，柱狀體 = DIF − 訊號線
 *   - RSI(14)、ATR(14)、ADX(14)（含 +DI、−DI）：Wilder 平滑（RMA）
 *   - 費波那契：近 FIB_LOOKBACK 根 K 線的最高點與最低點之間的回撤與延伸位
 *   - 成交量：最後一根與前 20 根平均的比值
 *
 * K 線格式：{ time, open, high, low, close, volume }，time 為開盤時間（毫秒）。
 * 尚無足夠資料計算的位置為 null。
 */

// 計算指標最少需要的已收盤 K 線數量（EMA50、MACD 訊號線、ADX 都需要數十根才穩定）
export const MIN_CANDLES = 60;
// 費波那契波段的取樣範圍
export const FIB_LOOKBACK = 120;
export const FIB_RETRACEMENTS = [0.236, 0.382, 0.5, 0.618, 0.786];
export const FIB_EXTENSIONS = [1.272, 1.618];
// MACD 交叉的回溯範圍
const CROSS_LOOKBACK = 10;
const VOLUME_PERIOD = 20;

/**
 * 從第一個非 null 的值開始，以前 period 個值的簡單平均起算，之後逐筆平滑。
 *
 * @param {(number | null)[]} values 數列，開頭可以是 null
 * @param {number} period 期數
 * @param {(prev: number, value: number) => number} step 平滑公式
 * @returns {(number | null)[]}
 */
function smooth(values, period, step) {
  const result = new Array(values.length).fill(null);
  const first = values.findIndex((value) => value !== null);
  if (first < 0 || values.length - first < period) return result;
  let prev = values.slice(first, first + period).reduce((sum, value) => sum + value, 0) / period;
  result[first + period - 1] = prev;
  for (let i = first + period; i < values.length; i++) {
    prev = step(prev, values[i]);
    result[i] = prev;
  }
  return result;
}

/** 指數移動平均（EMA）。 */
export function ema(values, period) {
  const k = 2 / (period + 1);
  return smooth(values, period, (prev, value) => value * k + prev * (1 - k));
}

/** Wilder 平滑移動平均（RMA），用於 RSI、ATR、ADX。 */
export function rma(values, period) {
  return smooth(values, period, (prev, value) => (prev * (period - 1) + value) / period);
}

/**
 * MACD。
 *
 * @returns {{macd: (number|null)[], signal: (number|null)[], histogram: (number|null)[]}}
 */
export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const line = closes.map((_, i) => (fastEma[i] === null || slowEma[i] === null ? null : fastEma[i] - slowEma[i]));
  const signal = ema(line, signalPeriod);
  const histogram = line.map((value, i) => (value === null || signal[i] === null ? null : value - signal[i]));
  return { macd: line, signal, histogram };
}

/** 相對強弱指標（RSI）：平均跌幅為 0 時為 100，平均漲幅為 0 時為 0。 */
export function rsi(closes, period = 14) {
  const changes = closes.map((close, i) => (i === 0 ? null : close - closes[i - 1]));
  const gains = rma(changes.map((change) => (change === null ? null : Math.max(change, 0))), period);
  const losses = rma(changes.map((change) => (change === null ? null : Math.max(-change, 0))), period);
  return gains.map((gain, i) => {
    if (gain === null) return null;
    if (losses[i] === 0) return 100;
    if (gain === 0) return 0;
    return 100 - 100 / (1 + gain / losses[i]);
  });
}

/**
 * 真實波幅（TR）：max(最高 − 最低, |最高 − 前收|, |最低 − 前收|)。
 * firstBar 為 true 時第一根以「最高 − 最低」計算（ATR 使用），否則為 null（ADX 使用）。
 */
function trueRanges(candles, firstBar) {
  return candles.map((candle, i) => {
    if (i === 0) return firstBar ? candle.high - candle.low : null;
    const prevClose = candles[i - 1].close;
    return Math.max(candle.high - candle.low, Math.abs(candle.high - prevClose), Math.abs(candle.low - prevClose));
  });
}

/** 平均真實波幅（ATR）。 */
export function atr(candles, period = 14) {
  return rma(trueRanges(candles, true), period);
}

/**
 * 平均趨向指標（ADX）與 +DI、−DI。
 *
 * @returns {{adx: (number|null)[], plusDI: (number|null)[], minusDI: (number|null)[]}}
 */
export function adx(candles, period = 14) {
  const plusDM = candles.map((candle, i) => {
    if (i === 0) return null;
    const up = candle.high - candles[i - 1].high;
    const down = candles[i - 1].low - candle.low;
    return up > down && up > 0 ? up : 0;
  });
  const minusDM = candles.map((candle, i) => {
    if (i === 0) return null;
    const up = candle.high - candles[i - 1].high;
    const down = candles[i - 1].low - candle.low;
    return down > up && down > 0 ? down : 0;
  });
  const tr = rma(trueRanges(candles, false), period);
  const plusSmooth = rma(plusDM, period);
  const minusSmooth = rma(minusDM, period);
  const di = (smoothed, i) => (tr[i] === null ? null : tr[i] === 0 ? 0 : (100 * smoothed[i]) / tr[i]);
  const plusDI = candles.map((_, i) => di(plusSmooth, i));
  const minusDI = candles.map((_, i) => di(minusSmooth, i));
  const dx = candles.map((_, i) => {
    if (plusDI[i] === null) return null;
    const sum = plusDI[i] + minusDI[i];
    return Math.abs(plusDI[i] - minusDI[i]) / (sum === 0 ? 1 : sum);
  });
  return { adx: rma(dx, period).map((value) => (value === null ? null : value * 100)), plusDI, minusDI };
}

/**
 * 費波那契回撤與延伸：取近 lookback 根的最高點與最低點。
 *   - 上升波段（低點在前）：回撤位 = 高點 − 區間 × 比例（回檔支撐），延伸位 = 低點 + 區間 × 比例（上方目標）
 *   - 下降波段（高點在前）：回撤位 = 低點 + 區間 × 比例（反彈阻力），延伸位 = 高點 − 區間 × 比例（下方目標）
 *
 * @returns {{trend: 'up' | 'down', high: {price: number, time: number}, low: {price: number, time: number},
 *   retracements: {ratio: number, price: number}[], extensions: {ratio: number, price: number}[]}}
 */
export function fibonacci(candles, lookback = FIB_LOOKBACK) {
  const recent = candles.slice(-lookback);
  let high = recent[0];
  let low = recent[0];
  for (const candle of recent) {
    if (candle.high >= high.high) high = candle;
    if (candle.low <= low.low) low = candle;
  }
  const trend = low.time <= high.time ? 'up' : 'down';
  const range = high.high - low.low;
  const level = (ratio, base, sign) => ({ ratio, price: base + sign * range * ratio });
  return {
    trend,
    high: { price: high.high, time: high.time },
    low: { price: low.low, time: low.time },
    retracements: FIB_RETRACEMENTS.map((ratio) => (trend === 'up' ? level(ratio, high.high, -1) : level(ratio, low.low, 1))),
    // 下降波段跌幅很大時，下方延伸位可能小於 0，不列出
    extensions: FIB_EXTENSIONS.map((ratio) => (trend === 'up' ? level(ratio, low.low, 1) : level(ratio, high.high, -1)))
      .filter((extension) => extension.price > 0),
  };
}

/** 最近一次 MACD 交叉：在回溯範圍內找最後一次 DIF 穿越訊號線，沒有則為 null。 */
function lastCross({ macd: line, signal }, lookback = CROSS_LOOKBACK) {
  const last = line.length - 1;
  for (let i = last; i > last - lookback && i > 0; i--) {
    if ([line[i], signal[i], line[i - 1], signal[i - 1]].includes(null)) return null;
    const now = Math.sign(line[i] - signal[i]);
    const before = Math.sign(line[i - 1] - signal[i - 1]);
    if (now !== 0 && now !== before) return { type: now > 0 ? 'golden' : 'dead', barsAgo: last - i };
  }
  return null;
}

/**
 * 計算一個標的的所有指標，取最後一根已收盤 K 線的數值（部分指標附上前一根，供判斷方向）。
 *
 * @param {object[]} candles 依時間排序的已收盤 K 線
 * @returns {object} 指標快照
 */
export function analyzeCandles(candles) {
  if (candles.length < MIN_CANDLES) {
    throw new Error(`已收盤的 K 線只有 ${candles.length} 根，至少需要 ${MIN_CANDLES} 根才能計算指標`);
  }
  const closes = candles.map((candle) => candle.close);
  const last = candles.length - 1;
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const macdResult = macd(closes);
  const rsiValues = rsi(closes);
  const atrValues = atr(candles);
  const adxResult = adx(candles);
  const recent20 = candles.slice(-20);
  const previousVolumes = candles.slice(-1 - VOLUME_PERIOD, -1).map((candle) => candle.volume);
  const averageVolume = previousVolumes.reduce((sum, value) => sum + value, 0) / previousVolumes.length;

  return {
    count: candles.length,
    last: candles[last],
    recent: candles.slice(-5),
    ema: { ema20: ema20[last], ema50: ema50[last], ema200: ema200[last] },
    macd: {
      macd: macdResult.macd[last],
      signal: macdResult.signal[last],
      histogram: macdResult.histogram[last],
      prevHistogram: macdResult.histogram[last - 1],
      cross: lastCross(macdResult),
    },
    rsi: { value: rsiValues[last], prev: rsiValues[last - 1] },
    adx: { adx: adxResult.adx[last], prev: adxResult.adx[last - 1], plusDI: adxResult.plusDI[last], minusDI: adxResult.minusDI[last] },
    atr: atrValues[last],
    volume: { last: candles[last].volume, average: averageVolume, ratio: averageVolume > 0 ? candles[last].volume / averageVolume : null },
    range20: { high: Math.max(...recent20.map((candle) => candle.high)), low: Math.min(...recent20.map((candle) => candle.low)) },
    fibonacci: fibonacci(candles),
  };
}
