/**
 * 做單建議規則：把每個標的的行情與技術指標整理成給 AI 的提示詞與輸出 JSON Schema，並檢查、整理 AI 的回覆。
 *
 * 指標由程式計算（indicators.js），AI 只負責綜合判斷，不需要網路搜尋。判斷順序：
 *   1. 趨勢（必要條件，決定方向）：EMA 排列與斜率、ADX 與 ±DI；趨勢向上考慮做多、向下考慮做空（市場可做空時）
 *   2. 動能與量能（確認）：MACD、RSI、成交量與成交額
 *   3. 價位：進場（現價或限價）、止損、止盈
 * 一律不開槓桿：做多為現貨買進；做空時虛擬貨幣以 USDT 永續合約 1 倍、股票以融券放空。交易優勢不明確時觀望。
 * 指定代號的市場每個標的都回覆；AUTO 的市場由 AI 從通過趨勢篩選的候選中挑選最多 AUTO_MAX_PICKS 個。
 *
 * AI 的回覆由程式再檢查一次：能否做空、價位對齊最小跳動單位、價位順序（做多止損 < 進場 < 止盈，做空相反）、
 * 現價／限價與進場價是否相符，並扣除交易成本後計算風險報酬比，不足 MIN_RISK_REWARD 時改為觀望。
 * 想調整判斷規則，修改 buildSignalPrompt() 即可。
 */
import { FIB_LOOKBACK, isDowntrend, isUptrend } from './indicators.js';
import { AUTO_MAX_PICKS, INTERVALS, MARKET_ENTRY_GAP, marketOf, MIN_RISK_REWARD, tickSize, tradingCosts } from './markets.js';
import { truncate } from '../shared/news.js';
import { formatDateInZone, formatInZone } from '../shared/schedule.js';
import { normalizeSymbol } from '../shared/symbols.js';

// 原因與注意事項的長度上限：確保一則訊息放滿 10 張卡片時，文字總量仍在 Discord 的 6000 字限制內
export const REASON_MAX = 250;
export const NOTE_MAX = 100;
// 限價進場價與現價最多相差的比例，超過視為不合理
const MAX_ENTRY_GAP = 0.2;

// 單一標的的建議
const SIGNAL_SCHEMA = {
  type: 'object',
  properties: {
    symbol: { type: 'string' },
    action: { type: 'string', enum: ['trade', 'wait'] },
    direction: { type: 'string', enum: ['long', 'short', 'none'] },
    entryType: { type: 'string', enum: ['market', 'limit', 'none'] },
    entry: { type: 'number' },
    takeProfit: { type: 'number' },
    stopLoss: { type: 'number' },
    reason: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['symbol', 'action', 'direction', 'entryType', 'entry', 'takeProfit', 'stopLoss', 'reason', 'note'],
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

/**
 * 價位對齊最小跳動單位（台股、美股）；虛擬貨幣依現價的位數四捨五入。
 *
 * @param {number} value 價位
 * @param {string} market 市場
 * @param {string} symbol 代號
 * @param {number} reference 現價
 * @returns {number}
 */
export function roundPrice(value, market, symbol, reference) {
  const tick = tickSize(market, symbol, value);
  if (!tick) return Number(value.toFixed(priceDecimals(reference)));
  const decimals = Math.max(0, -Math.floor(Math.log10(tick)) + 1);
  return Number((Math.round(value / tick) * tick).toFixed(decimals));
}

/**
 * 扣除交易成本後的風險報酬比（獲利 ÷ 虧損）。
 *   做多：進場成本 = 進場價 ×（1 + 進場成本）；出場淨額 = 出場價 ×（1 − 出場成本）
 *   做空：放空淨額 = 進場價 ×（1 − 進場成本）；回補成本 = 出場價 ×（1 + 出場成本）
 *
 * @param {{entry: number, takeProfit: number, stopLoss: number}} prices 價位
 * @param {{open: number, close: number}} costs 進場、出場的成本比例（tradingCosts()）
 * @param {'long' | 'short'} [direction='long'] 做多或做空
 * @returns {number}
 */
export function riskReward({ entry, takeProfit, stopLoss }, costs, direction = 'long') {
  if (direction === 'short') {
    const received = entry * (1 - costs.open);
    return (received - takeProfit * (1 + costs.close)) / (stopLoss * (1 + costs.close) - received);
  }
  const paid = entry * (1 + costs.open);
  return (takeProfit * (1 - costs.close) - paid) / (paid - stopLoss * (1 - costs.close));
}

const formatVolume = (value) => (value >= 1000 ? String(Math.round(value)) : formatPrice(value, 1));
const fixed1 = (value) => (value === null || value === undefined ? '資料不足' : value.toFixed(1));
/** 金額以萬、億表示，例如 125000000 → 1.25 億。 */
const formatAmount = (value) => {
  if (value >= 1e8) return `${(value / 1e8).toFixed(2)} 億`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)} 萬`;
  return String(Math.round(value));
};

// 提示詞中每個標的能否做空的說明
const SHORTABLE_TEXT = {
  crypto: { yes: '可（有 USDT 永續合約）', no: '不可（沒有 USDT 永續合約，只能做多或觀望）', unknown: '無法確認是否有 USDT 永續合約' },
  tw: { yes: '可（可融券）', no: '不可（非融券標的或停止融券，只能做多或觀望）', unknown: '無法確認是否可融券' },
  us: { yes: '可', no: '不可', unknown: '需自行確認券商是否可借券' },
};

/** 需要交給 AI 判斷的市場（有標的的市場；AUTO 為通過趨勢篩選的候選）。 */
const analyzableMarkets = (plan) => plan.filter((market) => market.items.length > 0);

/**
 * 做單建議的 JSON 格式（JSON Schema），要求 AI 的回覆必須符合；只包含需要判斷的市場。
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
function describeItem(item, { market, interval, timeZone, auto, allowShort }) {
  const s = item.snapshot;
  const { currency } = marketOf(market);
  const price = (value) => (value === null || value === undefined ? '資料不足' : formatPrice(value, item.price));
  const indicator = (value) => (value === null || value === undefined ? '資料不足' : formatPrice(value, item.price, 2));
  const barTime = (time) => (interval === '1d' ? formatDateInZone(new Date(time), timeZone) : formatInZone(new Date(time), timeZone));
  const close = s.last.close;

  const { ema20, ema50, ema200, ema50Slope } = s.ema;
  const position = [['EMA20', ema20], ['EMA50', ema50], ['EMA200', ema200]]
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${close >= value ? '高於' : '低於'} ${name}`)
    .join('、');
  const order = ema200 === null
    ? `EMA20 ${ema20 >= ema50 ? '>' : '<'} EMA50`
    : `EMA20 ${ema20 >= ema50 ? '>' : '<'} EMA50 ${ema50 >= ema200 ? '>' : '<'} EMA200`;
  const slope = ema50Slope === null
    ? ''
    : `；EMA50 較 5 根前 ${ema50Slope >= 0 ? '+' : ''}${ema50Slope.toFixed(2)}%（${ema50Slope > 0.1 ? '向上' : ema50Slope < -0.1 ? '向下' : '走平'}）`;

  const { cross } = s.macd;
  const crossText = cross
    ? `${cross.barsAgo === 0 ? '最後一根' : `${cross.barsAgo} 根前`}出現${cross.type === 'golden' ? '黃金交叉' : '死亡交叉'}`
    : '近 10 根沒有交叉';

  const { upAverage, downAverage } = s.volume;
  const upDown = upAverage === null || downAverage === null
    ? ''
    : `；近 20 根上漲日平均 ${formatVolume(upAverage)}、下跌日平均 ${formatVolume(downAverage)}`;

  const fib = s.fibonacci;
  const swing = fib.trend === 'up'
    ? `上升波段：低點 ${price(fib.low.price)}（${barTime(fib.low.time)}）→ 高點 ${price(fib.high.price)}（${barTime(fib.high.time)}）`
    : `下降波段：高點 ${price(fib.high.price)}（${barTime(fib.high.time)}）→ 低點 ${price(fib.low.price)}（${barTime(fib.low.time)}）`;
  const levels = (list) => list.map((level) => `${level.ratio}＝${price(level.price)}`).join('、');
  const fibLevels = fib.trend === 'up'
    ? `回撤位（回檔支撐）${levels(fib.retracements)}；延伸位（上方目標）${levels(fib.extensions)}`
    : `回撤位（反彈阻力）${levels(fib.retracements)}${fib.extensions.length > 0 ? `；延伸位（下方目標）${levels(fib.extensions)}` : ''}`;

  const notes = [];
  if (auto) notes.push(`- 趨勢篩選：${isUptrend(s) ? '向上（評估做多）' : isDowntrend(s) ? '向下（評估做空）' : '不明確'}`);
  if (allowShort) notes.push(`- 做空：${SHORTABLE_TEXT[market][item.shortable == null ? 'unknown' : item.shortable ? 'yes' : 'no']}`);

  return [
    `### ${item.symbol}${item.name ? `（${item.name}）` : ''}`,
    `- 資料：${item.source} ${item.ticker}，${INTERVALS[interval].label}${item.adjusted ? '（還原權息）' : ''}，共 ${s.count} 根已收盤 K 線`,
    ...notes,
    `- 現價：${price(item.price)}（${formatInZone(new Date(item.priceTime), timeZone)}）`,
    '- 最近 5 根已收盤 K 線（開盤時間：開／高／低／收／量）：',
    ...s.recent.map((candle) => `  ${barTime(candle.time)}：${price(candle.open)}／${price(candle.high)}／${price(candle.low)}／${price(candle.close)}／${formatVolume(candle.volume)}`),
    `- EMA20／EMA50／EMA200：${price(ema20)}／${price(ema50)}／${price(ema200)}；最後收盤價${position}；${order}${slope}`,
    `- MACD(12,26,9)：DIF ${indicator(s.macd.macd)}，訊號線 ${indicator(s.macd.signal)}；柱狀體最近 5 根 ${s.macd.recentHistogram.map(indicator).join('／')}；${crossText}`,
    `- RSI(14) 最近 5 根：${s.rsi.recent.map(fixed1).join('／')}`,
    `- ADX(14)：${fixed1(s.adx.adx)}（前一根 ${fixed1(s.adx.prev)}），+DI ${fixed1(s.adx.plusDI)}，−DI ${fixed1(s.adx.minusDI)}`,
    `- ATR(14)：${price(s.atr)}（現價的 ${((s.atr / item.price) * 100).toFixed(2)}%）`,
    `- 成交量：最後一根 ${formatVolume(s.volume.last)}，前 20 根平均 ${formatVolume(s.volume.average)}${s.volume.ratio === null ? '' : `，為平均的 ${s.volume.ratio.toFixed(2)} 倍`}${upDown}`,
    `- 成交額：最後一根約 ${formatAmount(s.turnover.last)} ${currency}，前 20 根平均約 ${formatAmount(s.turnover.average)} ${currency}`,
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
  const markets = analyzableMarkets(plan);
  const anyShort = markets.some((market) => market.allowShort);
  const sections = markets.flatMap((market, index) => {
    const info = marketOf(market.key);
    const filter = market.allowShort
      ? '趨勢明確（向上：收盤價高於 EMA50 且 EMA20 > EMA50；向下：收盤價低於 EMA50 且 EMA20 < EMA50）'
      : '趨勢向上（收盤價高於 EMA50，且 EMA20 > EMA50）';
    const rules = market.auto
      ? [
        `- 以下 ${market.items.length} 個是從${info.autoUniverse}的 ${market.candidates} 個標的中，由程式篩選出${filter}的候選。請從中挑選符合上述規則的標的，最多 ${AUTO_MAX_PICKS} 個，action 一律填 "trade"，依把握度由高到低排列。`,
        `- ${AUTO_MAX_PICKS} 個是上限而不是目標：符合條件的只有 1、2 個就只填 1、2 個；找不到符合條件的標的，或市場整體不適合做單、訊號不明確時，直接回傳空陣列，不要為了湊數勉強挑選。`,
        ...(market.key === 'crypto' ? ['- 候選中若有追蹤股票或 ETF 價格的代幣化股票（例如名稱是股票代號加 B 的 NVDAB、SOXLB），不要挑選。'] : []),
      ]
      : [`- 每個標的都要回覆一筆，依序為：${market.items.map((item) => item.symbol).join('、')}。`];
    return [
      `${numerals[index]}、${market.key}：${info.name}，${INTERVALS[market.interval].label}，價格單位：${info.unitNote}，`
        + `${market.allowShort ? `可以做多或做空（做空方式：${info.shortMethod}）` : '只能做多'}`,
      ...rules,
      '',
      ...market.items.map((item) => `${describeItem(item, { market: market.key, interval: market.interval, timeZone, auto: market.auto, allowShort: market.allowShort })}\n`),
    ];
  });
  const holding = [...new Set(markets.map((market) => market.interval))].map((key) => `${INTERVALS[key].label}約${INTERVALS[key].holding}`).join('，');
  const gap = `${MARKET_ENTRY_GAP * 100}%`;

  return [
    `你是重視風險控管的技術分析交易員。以下是 ${formatInZone(now, timeZone)}（時區 ${timeZone}）取得的行情資料與技術指標，由程式依交易所已收盤的 K 線計算，數值正確，請直接採用，不需要上網搜尋或重新計算。`,
    `請依下列規則判斷每個標的現在是否適合做單${anyShort ? '（做多或做空）' : ''}，填入指定的 JSON 欄位。原則是優先保護資金：交易優勢不明確時一律觀望，不要為了產生建議而勉強判定可以做單。`,
    '',
    '交易限制：',
    anyShort
      ? '- 一律不開槓桿（1 倍）：做多為現貨買進；做空只限標示「可以做多或做空」的市場，虛擬貨幣以 USDT 永續合約 1 倍放空，股票以融券放空，不使用其他槓桿或融資。'
      : '- 只考慮現貨買進（做多），不放空，也不使用槓桿、期貨、永續合約或融資融券。',
    ...(anyShort ? ['- 標的標示「做空：不可」時只能做多或觀望；標示無法確認時，做空前要在 note 提醒自行確認能否放空。'] : []),
    '',
    '判斷順序：',
    '1. 趨勢（必要條件，決定方向）',
    '   - 以 EMA20、EMA50、EMA200 判斷短、中、長期趨勢，以 ADX 與 ±DI 評估趨勢強弱與方向；ADX > 25 是趨勢確認的參考，不是絕對門檻。',
    '   - 做多：優先考慮收盤價在 EMA50 之上、EMA20 > EMA50 且 EMA50 向上、+DI > −DI 的行情；中長期趨勢明顯偏空時不做多。',
    ...(anyShort ? [
      '   - 做空：優先考慮收盤價在 EMA50 之下、EMA20 < EMA50 且 EMA50 向下、−DI > +DI 的行情；中長期趨勢明顯偏多時不做空。',
      '   - 均線糾結、ADX 偏低且 ±DI 接近等趨勢不明確的情況，觀望。',
    ] : []),
    '2. 動能與量能（確認）',
    '   - MACD 看動能方向、柱狀體的變化與可能的背離；RSI 看動能、過熱與超賣。',
    anyShort
      ? '   - 做多時 RSI > 70、做空時 RSI < 30 不直接判定觀望，但要檢查是否已過度追價或追空；超賣不代表會反彈，超買也不代表會回落。'
      : '   - RSI > 70 不直接判定觀望，但要檢查是否已過度追價；RSI 超賣不代表會反彈，仍要有止跌訊號。',
    anyShort
      ? '   - 做多優先選擇上漲日量能較大、回檔量縮的行情；做空優先選擇下跌日量能較大、反彈量縮的行情。成交量不足、訊號互相矛盾或突破、跌破缺乏確認時觀望。'
      : '   - 優先選擇上漲日量能較大、回檔時量縮的行情；成交量不足、訊號互相矛盾或突破缺乏確認時觀望。',
    '   - EMA 與 MACD 都由收盤價計算，彼此高度相關，不要當成各自獨立的確認訊號。',
    '   - 成交額過低（流動性不足、滑價風險高）時觀望。',
    '3. 價位（先確認有合理的交易機會，再決定價位）',
    anyShort
      ? `   - 進場：現價附近立即進場時 entryType 填 "market"，進場價與現價相差 ${gap} 以內；等待更好的價位時填 "limit"，做多等回檔到支撐（進場價低於現價），做空等反彈到壓力（進場價高於現價），屬於尚未觸發的掛單。價格已遠離合理進場區時不要追價或追空，直接觀望。`
      : `   - 進場：現價附近立即買進時 entryType 填 "market"，進場價與現價相差 ${gap} 以內；等回檔到支撐（EMA、費波那契回撤位、前高轉支撐）再買進時填 "limit"，進場價低於現價，屬於尚未觸發的掛單。價格已遠離合理進場區時不要追價，直接觀望。`,
    anyShort
      ? '   - 止損：做多設在近期波段低點或支撐之下，做空設在近期波段高點或壓力之上；ATR 的 1～2 倍只作為波動空間的參考，不強制套用。不可為了提高風險報酬比而把止損縮小，合理止損太遠時觀望。'
      : '   - 止損：低於進場價，優先設在近期波段低點、支撐或交易結構失效的位置之下；ATR 的 1～2 倍只作為波動空間的參考，不強制套用。不可為了提高風險報酬比而把止損縮小，合理止損太遠時觀望。',
    anyShort
      ? '   - 止盈：做多參考近期前高、主要阻力與費波那契上方延伸位；做空參考近期前低、主要支撐與費波那契下方延伸位；不可為了湊風險報酬比而虛構止盈位置。'
      : '   - 止盈：高於進場價，優先參考近期前高、主要阻力與費波那契延伸位；不可為了湊風險報酬比而虛構止盈位置。',
    `   - 風險報酬比 = |止盈 − 進場| ÷ |進場 − 止損|，優先尋找 2 以上的機會，最低 ${MIN_RISK_REWARD}；最近的有效支撐或阻力使風險報酬比不足時觀望。程式會扣除手續費、稅與滑價後重新計算，不足 ${MIN_RISK_REWARD} 會改為觀望。`,
    `   - 持有時間與 K 線週期相符：${holding}。`,
    '4. 只有趨勢符合、動能與量能沒有重大矛盾、有客觀合理的進場、止損與止盈位置，且風險報酬比足夠時，action 才填 "trade"；否則填 "wait"。',
    '',
    '各欄位：',
    '- symbol：與資料標題相同的代號，例如 BTC、2330、NVDA。',
    '- action："trade"（可以做單）或 "wait"（觀望）。',
    anyShort ? '- direction："long"（做多）或 "short"（做空）；觀望時填 "none"。' : '- direction：做多填 "long"；觀望時填 "none"。',
    '- entryType："market"（現價進場）或 "limit"（限價，等待更好的價位）；觀望時填 "none"。',
    anyShort
      ? '- entry、takeProfit、stopLoss：做多必須「止損 < 進場 < 止盈」，做空必須「止盈 < 進場 < 止損」；小數位數與該標的的資料相同；價格單位與該市場相同：虛擬貨幣與美股為美元，台股為新台幣。觀望時都填 0。'
      : '- entry、takeProfit、stopLoss：必須符合「止損 < 進場 < 止盈」，小數位數與該標的的資料相同；價格單位與該市場相同：虛擬貨幣與美股為美元，台股為新台幣。觀望時都填 0。',
    '- reason：用繁體中文（台灣用語），依趨勢、動能與量能、價位的順序說明判斷原因，引用具體的指標數值，80～200 字。',
    anyShort
      ? '- note：注意事項，不超過 60 字。可以做單時寫出失效條件，例如做多「若跌破 X，則直接撤單」、做空「若站上 X，則直接撤單」；限價單可加上取消條件，例如「5 個交易日內未成交則取消」。觀望時可寫需要留意的關鍵價位；沒有就填空字串。'
      : '- note：注意事項，不超過 60 字。可以做單時寫出失效條件，例如「若跌破 X，則直接撤單」；限價單可加上取消條件，例如「5 個交易日內未成交則取消」。觀望時可寫需要留意的關鍵價位；沒有就填空字串。',
    '',
    '以下依市場列出行情資料：',
    '',
    ...sections,
    '這是分析工作，不需要執行任何指令或讀寫檔案。',
  ].join('\n');
}

/**
 * 解析並檢查 AI 回覆的做單建議。
 *   - 指定代號的市場：依設定的順序，每個標的一筆；AI 沒有回覆的標的顯示為觀望。
 *   - AUTO 的市場：只採用候選中、action 為 trade 的標的，依 AI 的順序最多 AUTO_MAX_PICKS 個。
 *   - 可以做單時由程式檢查能否做空與價位（見 checkSignal()），不通過時改為觀望（AUTO 則捨棄），並在原因中註明。
 *   - 原因與注意事項限制長度。
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
          return item ? normalizeSignal(reply, item, market, warnings) : null;
        })
        .filter((signal) => signal?.action === 'trade')
        .slice(0, AUTO_MAX_PICKS);
    } else {
      signals = items.map((item) => {
        if (replies.has(item.symbol)) return normalizeSignal(replies.get(item.symbol), item, market, warnings);
        warnings.push(`AI 沒有回覆 ${item.symbol} 的分析，顯示為觀望`);
        return { ...baseSignal(item), action: 'wait', reason: 'AI 沒有回覆這個標的的分析。', note: '' };
      });
    }
    // analyzed：交給 AI 判斷的標的數量（AUTO 為通過趨勢篩選的候選數量）
    return { ...market, analyzed: items.length, signals, warnings };
  });
}

const cleanText = (value, max) => (typeof value === 'string' ? truncate(value.replace(/\s+/g, ' ').trim(), max) : '');

/** 建議中來自行情資料的欄位。 */
function baseSignal(item) {
  return { symbol: item.symbol, name: item.name ?? '', price: item.price, source: item.source, ticker: item.ticker };
}

/**
 * 做單方向：以 AI 回覆的 direction 為準；沒有填時依止盈在進場價的上方或下方判斷。
 *
 * @returns {'long' | 'short'}
 */
function directionOf(reply) {
  if (reply.direction === 'long' || reply.direction === 'short') return reply.direction;
  return Number(reply.takeProfit) < Number(reply.entry) ? 'short' : 'long';
}

/** 整理單一標的的建議；可以做單但檢查不通過時改為觀望。 */
function normalizeSignal(reply, item, market, warnings) {
  const reason = cleanText(reply.reason, REASON_MAX) || 'AI 沒有提供原因。';
  const base = { ...baseSignal(item), reason, note: cleanText(reply.note, NOTE_MAX) };
  if (reply.action !== 'trade') return { ...base, action: 'wait' };

  const direction = directionOf(reply);
  const [entry, takeProfit, stopLoss] = [reply.entry, reply.takeProfit, reply.stopLoss]
    .map((value) => (Number.isFinite(value) && value > 0 ? roundPrice(value, market.key, item.symbol, item.price) : Number.NaN));
  const checked = direction === 'short' && !market.allowShort
    ? { problem: '這個市場未開放做空' }
    : direction === 'short' && item.shortable === false
      ? { problem: SHORT_UNAVAILABLE[market.key] }
      : checkSignal({ entry, takeProfit, stopLoss, entryType: reply.entryType, direction }, { market: market.key, symbol: item.symbol, price: item.price });
  if (checked.problem) {
    warnings.push(`${item.symbol} 的價位檢查未通過（${checked.problem}），改為觀望`);
    const suffix = `（價位檢查未通過：${checked.problem}，改為觀望）`;
    return { ...base, action: 'wait', reason: `${truncate(reason, REASON_MAX - suffix.length)}${suffix}` };
  }
  return { ...base, action: 'trade', direction, entryType: checked.entryType, entry, takeProfit, stopLoss, riskReward: checked.riskReward };
}

// 無法放空時的說明
const SHORT_UNAVAILABLE = {
  crypto: '沒有 USDT 永續合約，無法做空',
  tw: '非融券標的或停止融券，無法做空',
  us: '無法放空',
};

/**
 * 檢查做單價位，並決定進場方式與風險報酬比。做空時方向相反（以 sign 換算）：
 *   - 價位必須大於 0；做多止損 < 進場 < 止盈，做空止盈 < 進場 < 止損。
 *   - 往不利方向（做多高於現價、做空低於現價）超過 MARKET_ENTRY_GAP 視為追價／追空；
 *     在現價 ± MARKET_ENTRY_GAP 以內為現價進場（AI 標示限價且在有利方向時維持限價），
 *     往有利方向更遠為限價單，最多 MAX_ENTRY_GAP。
 *   - 扣除交易成本後的風險報酬比必須至少 MIN_RISK_REWARD。
 *
 * @returns {{problem?: string, entryType?: 'market' | 'limit', riskReward?: number}}
 */
function checkSignal({ entry, takeProfit, stopLoss, entryType, direction }, { market, symbol, price }) {
  if (![entry, takeProfit, stopLoss].every(Number.isFinite)) return { problem: '價位必須大於 0' };
  const text = (value) => formatPrice(value, price);
  const short = direction === 'short';
  if (short ? !(takeProfit < entry && entry < stopLoss) : !(stopLoss < entry && entry < takeProfit)) {
    return {
      problem: short
        ? `止盈 ${text(takeProfit)}、進場 ${text(entry)}、止損 ${text(stopLoss)} 不符合做空的止盈 < 進場 < 止損`
        : `止損 ${text(stopLoss)}、進場 ${text(entry)}、止盈 ${text(takeProfit)} 不符合止損 < 進場 < 止盈`,
    };
  }
  // 往不利方向的偏離：做多為高於現價、做空為低於現價
  const adverse = ((entry - price) / price) * (short ? -1 : 1);
  const [worse, better] = short ? ['低於', '高於'] : ['高於', '低於'];
  if (adverse > MARKET_ENTRY_GAP) {
    return { problem: `進場 ${text(entry)} ${worse}現價 ${text(price)} 超過 ${MARKET_ENTRY_GAP * 100}%，屬於${short ? '追空' : '追價'}` };
  }
  if (adverse < -MAX_ENTRY_GAP) return { problem: `進場 ${text(entry)} ${better}現價 ${text(price)} 超過 ${MAX_ENTRY_GAP * 100}%` };
  const type = (entryType === 'limit' && adverse < 0) || adverse < -MARKET_ENTRY_GAP ? 'limit' : 'market';
  const ratio = riskReward({ entry, takeProfit, stopLoss }, tradingCosts(market, symbol, direction), direction);
  if (ratio < MIN_RISK_REWARD) return { problem: `扣除交易成本後風險報酬比 1:${ratio.toFixed(2)}，低於 1:${MIN_RISK_REWARD}` };
  return { entryType: type, riskReward: ratio };
}
