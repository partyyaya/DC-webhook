/**
 * 做單建議規則：把每個標的的行情與技術指標整理成給 AI 的提示詞與輸出 JSON Schema，並檢查、整理 AI 的回覆。
 *
 * 指標由程式計算（indicators.js），AI 只負責綜合判斷，不需要網路搜尋：
 *   - 不開槓桿：只考慮現貨買進（做多）
 *   - 是否做單：可以（trade）／觀望（wait）；可以時給進場、止盈、止損價位
 *   - 原因必填；其他事項（例如撤單條件）選填
 * 指定代號的市場每個標的都回覆；AUTO 的市場由 AI 從候選中挑選最多 AUTO_MAX_PICKS 個可以做單的標的。
 * 想調整判斷規則，修改 buildSignalPrompt() 即可。
 */
import { FIB_LOOKBACK } from './indicators.js';
import { AUTO_MAX_PICKS, INTERVALS, marketOf } from './markets.js';
import { truncate } from '../shared/news.js';
import { formatDateInZone, formatInZone } from '../shared/schedule.js';
import { normalizeSymbol } from '../shared/symbols.js';

// 原因與其他事項的長度上限：確保一則訊息放滿 10 張卡片時，文字總量仍在 Discord 的 6000 字限制內
export const REASON_MAX = 260;
export const NOTE_MAX = 100;
// 進場價與現價最多相差的比例，超過視為不合理
const MAX_ENTRY_GAP = 0.2;

// 單一標的的建議
const SIGNAL_SCHEMA = {
  type: 'object',
  properties: {
    symbol: { type: 'string' },
    action: { type: 'string', enum: ['trade', 'wait'] },
    entry: { type: 'number' },
    takeProfit: { type: 'number' },
    stopLoss: { type: 'number' },
    reason: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['symbol', 'action', 'entry', 'takeProfit', 'stopLoss', 'reason', 'note'],
  additionalProperties: false,
};

/**
 * 價格的小數位數：約 5 位有效數字，例如 62345 → 0 位、145.98 → 2 位、0.0001234 → 8 位。
 *
 * @param {number} reference 參考價格（通常為現價）
 * @returns {number}
 */
export function priceDecimals(reference) {
  if (!Number.isFinite(reference) || reference <= 0) return 2;
  return Math.min(10, Math.max(0, 4 - Math.floor(Math.log10(reference))));
}

/** 以參考價格的小數位數格式化，去掉結尾多餘的 0，例如 2000.0 → 2000；四捨五入後為 0 的負數顯示為 0。 */
export function formatPrice(value, reference = value, extraDecimals = 0) {
  const fixed = value.toFixed(priceDecimals(reference) + extraDecimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  return trimmed === '-0' ? '0' : trimmed;
}

const roundPrice = (value, reference) => Number(value.toFixed(priceDecimals(reference)));
const formatVolume = (value) => (value >= 1000 ? String(Math.round(value)) : formatPrice(value, 1));
const fixed1 = (value) => (value === null || value === undefined ? '資料不足' : value.toFixed(1));

/** 有成功取得行情資料、需要交給 AI 判斷的市場。 */
const analyzableMarkets = (plan) => plan.filter((market) => market.items.length > 0);

/**
 * 做單建議的 JSON 格式（JSON Schema），要求 AI 的回覆必須符合；只包含有資料的市場。
 *
 * @param {object[]} plan prepareMarkets() 的結果
 * @returns {object}
 */
export function buildSignalSchema(plan) {
  const markets = analyzableMarkets(plan);
  return {
    type: 'object',
    properties: Object.fromEntries(markets.map((market) => [market.key, { type: 'array', items: SIGNAL_SCHEMA }])),
    required: markets.map((market) => market.key),
    additionalProperties: false,
  };
}

/**
 * 單一標的的行情與指標，例如：
 *   ### BTC
 *   - 資料：Binance BTCUSDT，日線，共 499 根已收盤 K 線
 *   - 現價：61944（2026-11-20（週五）08:05）
 *   ...
 */
function describeItem(item, { interval, timeZone }) {
  const s = item.snapshot;
  const price = (value) => (value === null || value === undefined ? '資料不足' : formatPrice(value, item.price));
  const indicator = (value) => (value === null || value === undefined ? '資料不足' : formatPrice(value, item.price, 2));
  const barTime = (time) => (interval === '1d' ? formatDateInZone(new Date(time), timeZone) : formatInZone(new Date(time), timeZone));
  const close = s.last.close;

  const { ema20, ema50, ema200 } = s.ema;
  const position = [['EMA20', ema20], ['EMA50', ema50], ['EMA200', ema200]]
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${close >= value ? '高於' : '低於'} ${name}`)
    .join('、');
  const order = ema200 === null
    ? `EMA20 ${ema20 >= ema50 ? '>' : '<'} EMA50`
    : `EMA20 ${ema20 >= ema50 ? '>' : '<'} EMA50 ${ema50 >= ema200 ? '>' : '<'} EMA200`;

  const { cross } = s.macd;
  const crossText = cross
    ? `${cross.barsAgo === 0 ? '最後一根' : `${cross.barsAgo} 根前`}出現${cross.type === 'golden' ? '黃金交叉' : '死亡交叉'}`
    : '近 10 根沒有交叉';

  const fib = s.fibonacci;
  const swing = fib.trend === 'up'
    ? `上升波段：低點 ${price(fib.low.price)}（${barTime(fib.low.time)}）→ 高點 ${price(fib.high.price)}（${barTime(fib.high.time)}）`
    : `下降波段：高點 ${price(fib.high.price)}（${barTime(fib.high.time)}）→ 低點 ${price(fib.low.price)}（${barTime(fib.low.time)}）`;
  const levels = (list) => list.map((level) => `${level.ratio}＝${price(level.price)}`).join('、');
  const fibLevels = fib.trend === 'up'
    ? `回撤位（回檔支撐）${levels(fib.retracements)}；延伸位（上方目標）${levels(fib.extensions)}`
    : `回撤位（反彈阻力）${levels(fib.retracements)}${fib.extensions.length > 0 ? `；延伸位（下方目標）${levels(fib.extensions)}` : ''}`;

  return [
    `### ${item.symbol}${item.name ? `（${item.name}）` : ''}`,
    `- 資料：${item.source} ${item.ticker}，${INTERVALS[interval].label}，共 ${s.count} 根已收盤 K 線`,
    `- 現價：${price(item.price)}（${formatInZone(new Date(item.priceTime), timeZone)}）`,
    '- 最近 5 根已收盤 K 線（開盤時間：開／高／低／收／量）：',
    ...s.recent.map((candle) => `  ${barTime(candle.time)}：${price(candle.open)}／${price(candle.high)}／${price(candle.low)}／${price(candle.close)}／${formatVolume(candle.volume)}`),
    `- EMA20／EMA50／EMA200：${price(ema20)}／${price(ema50)}／${price(ema200)}；最後收盤價${position}；${order}`,
    `- MACD(12,26,9)：DIF ${indicator(s.macd.macd)}，訊號線 ${indicator(s.macd.signal)}，柱狀體 ${indicator(s.macd.histogram)}（前一根 ${indicator(s.macd.prevHistogram)}）；${crossText}`,
    `- RSI(14)：${fixed1(s.rsi.value)}（前一根 ${fixed1(s.rsi.prev)}）`,
    `- ADX(14)：${fixed1(s.adx.adx)}（前一根 ${fixed1(s.adx.prev)}），+DI ${fixed1(s.adx.plusDI)}，−DI ${fixed1(s.adx.minusDI)}`,
    `- ATR(14)：${price(s.atr)}（現價的 ${((s.atr / item.price) * 100).toFixed(2)}%）`,
    `- 成交量：最後一根 ${formatVolume(s.volume.last)}，前 20 根平均 ${formatVolume(s.volume.average)}${s.volume.ratio === null ? '' : `，為平均的 ${s.volume.ratio.toFixed(2)} 倍`}`,
    `- 近 20 根最高／最低：${price(s.range20.high)}／${price(s.range20.low)}`,
    `- 費波那契（近 ${Math.min(FIB_LOOKBACK, s.count)} 根的${swing}）：${fibLevels}`,
  ].join('\n');
}

/**
 * 組出要交給 AI 的提示詞。
 *
 * @param {object[]} plan prepareMarkets() 的結果
 * @param {object} options
 * @param {Date} options.now 本次執行時間
 * @param {string} options.timeZone 顯示時間用的時區
 * @returns {string}
 */
export function buildSignalPrompt(plan, { now, timeZone }) {
  const numerals = ['一', '二', '三'];
  const sections = analyzableMarkets(plan).flatMap((market, index) => {
    const info = marketOf(market.key);
    const rules = market.auto
      ? [
        `- 以下 ${market.items.length} 個是${info.autoUniverse}的標的，作為候選。請從中挑選符合上述做單條件的標的，最多 ${AUTO_MAX_PICKS} 個，action 一律填 "trade"，依把握度由高到低排列。`,
        `- ${AUTO_MAX_PICKS} 個是上限而不是目標：符合條件的只有 1、2 個就只填 1、2 個；找不到符合條件的標的，或市場整體偏空、訊號不明確而不適合做單時，直接回傳空陣列，不要為了湊數勉強挑選。`,
        ...(market.key === 'crypto' ? ['- 候選中若有追蹤股票或 ETF 價格的代幣化股票（例如名稱是股票代號加 B 的 NVDAB、SOXLB），不要挑選。'] : []),
      ]
      : [`- 每個標的都要回覆一筆，依序為：${market.items.map((item) => item.symbol).join('、')}。`];
    return [
      `${numerals[index]}、${market.key}：${info.name}，${INTERVALS[market.interval].label}，價格單位：${info.unitNote}`,
      ...rules,
      '',
      ...market.items.map((item) => `${describeItem(item, { interval: market.interval, timeZone })}\n`),
    ];
  });

  return [
    `你是專業的技術分析交易員。以下是 ${formatInZone(now, timeZone)}（時區 ${timeZone}）取得的行情資料與技術指標，由程式依交易所的 K 線計算，數值正確，請直接採用，不需要上網搜尋或重新計算。`,
    '請綜合 EMA、MACD、RSI、ADX、ATR、費波那契與成交量，判斷每個標的現在是否適合做單，填入指定的 JSON 欄位。',
    '',
    '做單條件：',
    '- 不開槓桿：只考慮現貨買進（做多），不放空，也不使用期貨、合約或融資融券。',
    '- 只有在趨勢（EMA 排列、ADX 與 ±DI）、動能（MACD、RSI）與成交量多數支持上漲，且風險報酬比（止盈 − 進場）÷（進場 − 止損）至少 1.5 時，action 才填 "trade"（可以做單）；條件不足、訊號互相矛盾、RSI 過熱或處於明顯下跌趨勢時填 "wait"（觀望）。',
    '- entry（進場價）：現價附近，或回檔到支撐（EMA、費波那契回撤位、近期低點）的限價買進價格；最近一根 K 線是已收盤的 K 線，請以現價評估進場價是否合理。',
    '- stopLoss（止損）：低於進場價，設在關鍵支撐下方，並參考 ATR（一般距離進場價 1～2 倍 ATR），避免被正常波動掃出場。',
    '- takeProfit（止盈）：高於進場價，參考前高、阻力位或費波那契延伸位。',
    '- 價位必須符合「止損 < 進場 < 止盈」，小數位數與該標的的資料相同；價格單位與該市場相同：虛擬貨幣與美股為美元，台股為新台幣。',
    '- 觀望時 entry、takeProfit、stopLoss 都填 0。',
    `- 持有時間與 K 線週期相符：${[...new Set(analyzableMarkets(plan).map((market) => market.interval))].map((key) => `${INTERVALS[key].label}約${INTERVALS[key].holding}`).join('，')}。`,
    '',
    '各欄位：',
    '- symbol：與資料標題相同的代號，例如 BTC、2330、NVDA。',
    '- reason：用繁體中文（台灣用語）說明判斷原因，引用具體的指標數值，80～200 字。',
    '- note：其他事項（選填），例如撤單條件「若…，則直接撤單」或需要留意的關鍵價位，不超過 60 字；沒有就填空字串。',
    '',
    ...sections,
    '這是分析工作，不需要執行任何指令或讀寫檔案。',
  ].join('\n');
}

/**
 * 解析並檢查 AI 回覆的做單建議。
 *   - 指定代號的市場：依設定的順序，每個標的一筆；AI 沒有回覆的標的顯示為觀望。
 *   - AUTO 的市場：只採用候選中、action 為 trade 的標的，依 AI 的順序最多 AUTO_MAX_PICKS 個。
 *   - 可以做單但價位不合理（不是正數、不符合「止損 < 進場 < 止盈」、進場價與現價相差超過 20%）時改為觀望
 *     （AUTO 則捨棄），並在原因中註明。
 *   - 價位依現價的小數位數四捨五入；原因與其他事項限制長度。
 *
 * @param {string} text AI 的回覆
 * @param {object[]} plan prepareMarkets() 的結果
 * @returns {object[]} 每個市場：plan 的欄位加上 signals（做單建議）與 warnings（記錄到終端機的提醒）
 */
export function parseSignals(text, plan) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('AI 回覆的做單建議不是有效的 JSON');
  }
  if (!data || typeof data !== 'object' || analyzableMarkets(plan).some((market) => !Array.isArray(data[market.key]))) {
    throw new Error('AI 回覆的做單建議格式不符');
  }

  return plan.map(({ items, ...market }) => {
    const warnings = [];
    // AI 的回覆依代號整理；同一個代號只採用第一筆
    const replies = new Map();
    for (const reply of items.length > 0 ? data[market.key] : []) {
      if (typeof reply?.symbol !== 'string') continue;
      const symbol = normalizeSymbol(market.key, reply.symbol);
      if (!replies.has(symbol)) replies.set(symbol, reply);
    }

    let signals;
    if (market.auto) {
      signals = [...replies]
        .map(([symbol, reply]) => {
          const item = items.find((candidate) => candidate.symbol === symbol);
          if (!item) warnings.push(`AI 挑選的 ${symbol} 不在候選中，已略過`);
          return item ? normalizeSignal(reply, item, warnings) : null;
        })
        .filter((signal) => signal?.action === 'trade')
        .slice(0, AUTO_MAX_PICKS);
    } else {
      signals = items.map((item) => {
        if (replies.has(item.symbol)) return normalizeSignal(replies.get(item.symbol), item, warnings);
        warnings.push(`AI 沒有回覆 ${item.symbol} 的分析，顯示為觀望`);
        return { ...baseSignal(item), action: 'wait', reason: 'AI 沒有回覆這個標的的分析。', note: '' };
      });
    }
    return { ...market, signals, warnings };
  });
}

const cleanText = (value, max) => (typeof value === 'string' ? truncate(value.replace(/\s+/g, ' ').trim(), max) : '');

/** 建議中來自行情資料的欄位。 */
function baseSignal(item) {
  return { symbol: item.symbol, name: item.name ?? '', price: item.price, source: item.source, ticker: item.ticker };
}

/** 整理單一標的的建議；可以做單但價位不合理時改為觀望。 */
function normalizeSignal(reply, item, warnings) {
  const reason = cleanText(reply.reason, REASON_MAX) || 'AI 沒有提供原因。';
  const base = { ...baseSignal(item), reason, note: cleanText(reply.note, NOTE_MAX) };
  if (reply.action !== 'trade') return { ...base, action: 'wait' };

  const [entry, takeProfit, stopLoss] = [reply.entry, reply.takeProfit, reply.stopLoss]
    .map((value) => (Number.isFinite(value) ? roundPrice(value, item.price) : Number.NaN));
  const problem = checkPrices({ entry, takeProfit, stopLoss, price: item.price });
  if (problem) {
    warnings.push(`${item.symbol} 的價位不合理（${problem}），改為觀望`);
    const suffix = `（AI 給出的價位不合理：${problem}，改為觀望）`;
    return { ...base, action: 'wait', reason: `${truncate(reason, REASON_MAX - suffix.length)}${suffix}` };
  }
  return { ...base, action: 'trade', entry, takeProfit, stopLoss };
}

/** 檢查做單價位，有問題時回傳原因。 */
function checkPrices({ entry, takeProfit, stopLoss, price }) {
  if (![entry, takeProfit, stopLoss].every((value) => Number.isFinite(value) && value > 0)) return '價位必須大於 0';
  const text = (value) => formatPrice(value, price);
  if (!(stopLoss < entry && entry < takeProfit)) return `止損 ${text(stopLoss)}、進場 ${text(entry)}、止盈 ${text(takeProfit)} 不符合止損 < 進場 < 止盈`;
  if (Math.abs(entry - price) / price > MAX_ENTRY_GAP) return `進場 ${text(entry)} 與現價 ${text(price)} 相差超過 ${MAX_ENTRY_GAP * 100}%`;
  return null;
}
