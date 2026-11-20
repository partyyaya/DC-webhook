import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscordMessages, DISCLAIMER, DISCLAIMER_MESSAGE, NO_PICK_TEXT } from '../../src/signal/format.js';
import { analyzeCandles } from '../../src/signal/indicators.js';
import { parseMarketSymbols, tickSize, tradingCosts } from '../../src/signal/markets.js';
import {
  buildSignalPrompt, buildSignalSchema, formatPrice, NOTE_MAX, parseSignals, REASON_MAX, riskReward, roundPrice,
} from '../../src/signal/signals.js';

const NOW = new Date('2026-11-20T08:05:00+08:00');
const TZ = 'Asia/Taipei';
const DATE = '2026-11-20（週五）';

// 緩步上漲的 K 線，最後收盤價為 price
const snapshotAt = (price) => analyzeCandles(Array.from({ length: 250 }, (_, i) => {
  const close = price * (0.8 + (0.2 * i) / 249);
  return { time: Date.parse('2026-01-01T00:00Z') + i * 86_400_000, open: close, high: close * 1.01, low: close * 0.99, close, volume: 100 + i };
}));
const item = (symbol, price, extra = {}) => ({
  symbol, name: '', source: 'Binance', ticker: `${symbol}USDT`, price, priceTime: NOW.getTime(), snapshot: snapshotAt(price), ...extra,
});
const market = (key, items, extra = {}) => ({ key, interval: '1d', auto: false, candidates: 0, items, errors: [], failure: null, ...extra });
const trade = (symbol, entry, takeProfit, stopLoss, extra = {}) => ({
  symbol, action: 'trade', direction: 'long', entryType: 'market', entry, takeProfit, stopLoss, reason: `${symbol} 多頭排列`, note: '', ...extra,
});
const short = (symbol, entry, takeProfit, stopLoss, extra = {}) => trade(symbol, entry, takeProfit, stopLoss, { direction: 'short', reason: `${symbol} 空頭排列`, ...extra });
const wait = (symbol, extra = {}) => ({
  symbol, action: 'wait', direction: 'none', entryType: 'none', entry: 0, takeProfit: 0, stopLoss: 0, reason: `${symbol} 趨勢偏空`, note: '', ...extra,
});
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const reply = (data) => JSON.stringify(data);

test('標的清單：代號統一格式；AUTO 不分大小寫且不能混用；最多 10 個', () => {
  assert.deepEqual(parseMarketSymbols('crypto', 'btc, ETHUSDT, sol/usdt, BTC', 'markets.crypto.symbols'), { auto: false, symbols: ['BTC', 'ETH', 'SOL'] });
  assert.deepEqual(parseMarketSymbols('tw', 'auto', 'x'), { auto: true, symbols: [] });
  assert.deepEqual(parseMarketSymbols('us', '', 'x'), { auto: false, symbols: [] });
  assert.throws(() => parseMarketSymbols('crypto', 'BTC,AUTO', 'markets.crypto.symbols'), /markets\.crypto\.symbols 填 AUTO 時不能再加其他代號/);
  assert.throws(() => parseMarketSymbols('crypto', '比特幣', 'markets.crypto.symbols'), /markets\.crypto\.symbols 格式錯誤.*BTC,ETH,ADA/);
  assert.throws(() => parseMarketSymbols('us', 'A,B,C,D,E,F,G,H,I,J,K', 'markets.us.symbols'), /最多 10 個代號，目前有 11 個/);
});

test('價格依現價的大小保留約 5 位有效數字', () => {
  assert.equal(formatPrice(62345.678), '62346');
  assert.equal(formatPrice(2000), '2000');
  assert.equal(formatPrice(145.981), '145.98');
  assert.equal(formatPrice(0.000123456), '0.00012346');
  assert.equal(formatPrice(1.5, 62345), '2', '依參考價格的位數');
  assert.equal(formatPrice(-0.0001, 100), '0');
});

test('價位對齊最小跳動單位；風險報酬比扣除手續費、稅與滑價', () => {
  // 台股依價格區間，ETF 另有規定；美股 1 美元以上為 0.01；虛擬貨幣依現價位數
  assert.deepEqual([9.99, 49.9, 99.9, 499, 999, 1000].map((price) => tickSize('tw', '2330', price)), [0.01, 0.05, 0.1, 0.5, 1, 5]);
  assert.deepEqual([tickSize('tw', '0050', 49), tickSize('tw', '0050', 190)], [0.01, 0.05]);
  assert.deepEqual([tickSize('us', 'NVDA', 150), tickSize('us', 'XYZ', 0.5), tickSize('crypto', 'BTC', 62000)], [0.01, 0.0001, null]);
  assert.equal(roundPrice(1987.4, 'tw', '2330', 2000), 1985);
  assert.equal(roundPrice(1982.6, 'tw', '2330', 2000), 1985);
  assert.equal(roundPrice(48.43, 'tw', '2002', 48), 48.45);
  assert.equal(roundPrice(145.987, 'us', 'NVDA', 146), 145.99);
  assert.equal(roundPrice(61800.4, 'crypto', 'BTC', 62000), 61800);

  // 做多：虛擬貨幣現貨 0.1%；台股買進 0.1425%、賣出再加證交稅 0.3%（ETF 0.1%）；美股只有滑價；每次另加滑價 0.05%
  assert.deepEqual(tradingCosts('crypto', 'BTC'), { open: 0.0015, close: 0.0015 });
  near(tradingCosts('tw', '2330').close, 0.004925);
  near(tradingCosts('tw', '0050').close, 0.002925);
  assert.deepEqual(tradingCosts('us', 'NVDA'), { open: 0.0005, close: 0.0005 });
  // 做空：虛擬貨幣永續合約 0.05%；台股融券賣出含證交稅與借券費 0.08%，回補只有手續費
  assert.deepEqual(tradingCosts('crypto', 'BTC', 'short'), { open: 0.001, close: 0.001 });
  near(tradingCosts('tw', '2330', 'short').open, 0.001425 + 0.003 + 0.0008 + 0.0005);
  near(tradingCosts('tw', '2330', 'short').close, 0.001925);
  // 不計成本時 (110 − 100) ÷ (100 − 95) = 2；扣除成本後較低。做空方向相反
  near(riskReward({ entry: 100, takeProfit: 110, stopLoss: 95 }, { open: 0, close: 0 }), 2);
  near(riskReward({ entry: 100, takeProfit: 110, stopLoss: 95 }, tradingCosts('crypto', 'BTC')), (110 * 0.9985 - 100.15) / (100.15 - 95 * 0.9985));
  near(riskReward({ entry: 100, takeProfit: 90, stopLoss: 105 }, { open: 0, close: 0 }, 'short'), 2);
  near(riskReward({ entry: 100, takeProfit: 90, stopLoss: 105 }, { open: 0.001, close: 0.001 }, 'short'), (99.9 - 90 * 1.001) / (105 * 1.001 - 99.9));
});

test('提示詞：依趨勢、動能與量能、價位的順序判斷，價格單位、指定代號的回覆順序與 AUTO 的挑選規則；Schema 只包含有資料的市場', () => {
  const plan = [
    market('crypto', [item('BTC', 62000), item('ETH', 1750)]),
    market('tw', [item('2330', 2000, { name: '台積電', source: 'Yahoo Finance', ticker: '2330.TW', adjusted: true })], { auto: true, candidates: 15 }),
    market('us', [], { errors: [{ symbol: 'NVDA', message: '連線失敗' }] }),
  ];
  const prompt = buildSignalPrompt(plan, { now: NOW, timeZone: TZ });
  assert.match(prompt, /2026-11-20（週五）08:05（時區 Asia\/Taipei）/);
  assert.match(prompt, /只考慮現貨買進（做多），不放空，也不使用槓桿/);
  assert.match(prompt, /交易優勢不明確時一律觀望/);
  assert.match(prompt, /1\. 趨勢（必要條件，決定方向）\n[\s\S]*2\. 動能與量能（確認）\n[\s\S]*3\. 價位/);
  assert.match(prompt, /中長期趨勢明顯偏空時不做多/);
  assert.match(prompt, /RSI > 70 不直接判定觀望，但要檢查是否已過度追價/);
  assert.match(prompt, /EMA 與 MACD 都由收盤價計算，彼此高度相關/);
  assert.match(prompt, /entryType 填 "market"，進場價與現價相差 1% 以內；.*填 "limit"/);
  assert.match(prompt, /不可為了提高風險報酬比而把止損縮小/);
  assert.match(prompt, /優先尋找 2 以上的機會，最低 1\.5；.*程式會扣除手續費、稅與滑價後重新計算/);
  assert.match(prompt, /虛擬貨幣與美股為美元，台股為新台幣/);
  assert.match(prompt, /一、crypto：虛擬貨幣，日線，價格單位：美元（USDT 交易對），只能做多\n- 每個標的都要回覆一筆，依序為：BTC、ETH。/);
  assert.doesNotMatch(prompt, /做空：|可以做多或做空/, '沒有開放做空的市場時，不提做空');
  assert.match(prompt, /- 持有時間與 K 線週期相符：日線約數天到數週。\n/);
  assert.match(prompt, /二、tw：台股，日線，價格單位：新台幣，只能做多\n- 以下 1 個是從上市櫃普通股中前一交易日成交金額最大的 15 個標的中，由程式篩選出趨勢向上（收盤價高於 EMA50，且 EMA20 > EMA50）的候選。請從中挑選符合上述規則的標的，最多 3 個/);
  assert.match(prompt, /3 個是上限而不是目標：符合條件的只有 1、2 個就只填 1、2 個；找不到符合條件的標的，或市場整體不適合做單、訊號不明確時，直接回傳空陣列/);
  assert.doesNotMatch(prompt.slice(prompt.indexOf('一、crypto')), /三、|us：|NVDA/);
  assert.doesNotMatch(prompt.slice(prompt.indexOf('二、tw')), /代幣化股票/, '只有虛擬貨幣的 AUTO 需要排除代幣化股票');

  // 每個標的的行情與指標
  assert.match(prompt, /### 2330（台積電）\n- 資料：Yahoo Finance 2330\.TW，日線（還原權息），共 250 根已收盤 K 線\n- 趨勢篩選：向上（評估做多）\n- 現價：2000（2026-11-20（週五）08:05）/);
  assert.match(prompt, /### BTC\n- 資料：Binance BTCUSDT，日線，共 250 根/);
  for (const pattern of [/EMA20／EMA50／EMA200：.*最後收盤價高於 EMA20、高於 EMA50、高於 EMA200；EMA20 > EMA50 > EMA200；EMA50 較 5 根前 \+[\d.]+%（向上）/,
    /MACD\(12,26,9\)：DIF .*；柱狀體最近 5 根 [^；]+／[^；]+；/, /RSI\(14\) 最近 5 根：[\d.]+／[\d.]+／[\d.]+／[\d.]+／[\d.]+\n/,
    /ADX\(14\)：.*\+DI .*−DI /, /ATR\(14\)：.*（現價的 [\d.]+%）/, /成交量：最後一根 349，前 20 根平均 338\.5，為平均的 1\.03 倍/,
    /成交額：最後一根約 69\.8 萬 新台幣，前 20 根平均約 [\d.]+ 萬 新台幣/, /費波那契（近 120 根的上升波段：.*回撤位（回檔支撐）0\.236＝/]) {
    assert.match(prompt, pattern);
  }

  const schema = buildSignalSchema(plan);
  assert.deepEqual(schema.required, ['crypto', 'tw']);
  assert.deepEqual(schema.properties.crypto.items.required, ['symbol', 'action', 'direction', 'entryType', 'entry', 'takeProfit', 'stopLoss', 'reason', 'note']);
  assert.deepEqual(schema.properties.crypto.items.properties.direction.enum, ['long', 'short', 'none']);
  assert.deepEqual(schema.properties.crypto.items.properties.action.enum, ['trade', 'wait']);
  assert.deepEqual(schema.properties.crypto.items.properties.entryType.enum, ['market', 'limit', 'none']);
});

test('指定代號：依設定順序每個標的一筆；價位依現價位數四捨五入並算出風險報酬比；AI 沒回覆的顯示為觀望', () => {
  const plan = [market('crypto', [item('BTC', 62000), item('ETH', 1750), item('SOL', 72.5)])];
  const [result] = parseSignals(reply({ crypto: [wait('SOL', { note: '等待站回 EMA20' }), trade('btcusdt', 61800.4, 66000.6, 59999.5)] }), plan);
  assert.deepEqual(result.signals.map((signal) => [signal.symbol, signal.action]), [['BTC', 'trade'], ['ETH', 'wait'], ['SOL', 'wait']]);
  const { riskReward: ratio, ...btc } = result.signals[0];
  assert.deepEqual(btc, {
    symbol: 'BTC', name: '', price: 62000, source: 'Binance', ticker: 'BTCUSDT', reason: 'btcusdt 多頭排列', note: '',
    action: 'trade', direction: 'long', entryType: 'market', entry: 61800, takeProfit: 66001, stopLoss: 60000,
  });
  near(ratio, riskReward({ entry: 61800, takeProfit: 66001, stopLoss: 60000 }, tradingCosts('crypto', 'BTC')));
  assert.equal(ratio.toFixed(2), '2.02');
  assert.equal(result.signals[1].reason, 'AI 沒有回覆這個標的的分析。');
  assert.equal(result.signals[2].note, '等待站回 EMA20');
  assert.deepEqual(result.warnings, ['AI 沒有回覆 ETH 的分析，顯示為觀望']);
});

test('價位檢查未通過時改為觀望並註明原因：止損 < 進場 < 止盈、價位大於 0、不追價、限價不離現價太遠、扣除成本後風險報酬比至少 1.5', () => {
  const plan = [market('us', [item('NVDA', 150), item('AAPL', 350), item('MSFT', 500), item('AMD', 100), item('TSLA', 100)])];
  const [result] = parseSignals(reply({ us: [
    trade('NVDA', 150, 140, 145), trade('AAPL', 0, 360, 340), trade('MSFT', 380, 420, 360, { entryType: 'limit', reason: '長'.repeat(REASON_MAX) }),
    trade('AMD', 101.5, 110, 98), trade('TSLA', 100, 103, 98),
  ] }), plan);
  assert.ok(result.signals.every((signal) => signal.action === 'wait' && signal.entry === undefined));
  assert.match(result.signals[0].reason, /NVDA 多頭排列（價位檢查未通過：止損 145、進場 150、止盈 140 不符合止損 < 進場 < 止盈，改為觀望）$/);
  assert.match(result.signals[1].reason, /價位必須大於 0/);
  assert.match(result.signals[2].reason, /進場 380 低於現價 500 超過 20%，改為觀望）$/);
  assert.equal(result.signals[2].reason.length, REASON_MAX);
  assert.match(result.signals[3].reason, /進場 101\.5 高於現價 100 超過 1%，屬於追價，改為觀望）$/);
  // 不計成本時 (103 − 100) ÷ (100 − 98) = 1.5，扣除成本後不足
  assert.match(result.signals[4].reason, /扣除交易成本後風險報酬比 1:1\.38，低於 1:1\.5，改為觀望）$/);
  assert.equal(result.warnings.length, 5);
});

test('進場方式：現價 ±1% 以內為現價進場；AI 標示限價且低於現價、或低於現價超過 1% 為限價', () => {
  const plan = [market('us', ['A', 'B', 'C', 'D'].map((symbol) => item(symbol, 100)))];
  const [result] = parseSignals(reply({ us: [
    trade('A', 99.5, 110, 95), trade('B', 99.5, 110, 95, { entryType: 'limit' }), trade('C', 97, 110, 93), trade('D', 100.5, 110, 95, { entryType: 'limit' }),
  ] }), plan);
  assert.deepEqual(result.signals.map((signal) => signal.entryType), ['market', 'limit', 'limit', 'market']);
});

test('AUTO：只採用候選中可以做單的標的，依 AI 的順序最多 3 個', () => {
  const candidates = ['2330', '2317', '2454', '2308', '3711'].map((symbol) => item(symbol, 1000));
  const plan = [market('tw', candidates, { auto: true, candidates: 5 })];
  const [result] = parseSignals(reply({ tw: [
    trade('2454', 1000, 1100, 950), wait('2330'), trade('9999', 10, 12, 9), trade('2308', 1500, 1600, 1400), trade('2317.TW', 990, 1080, 950),
    trade('3711', 1000, 1100, 950), trade('2454', 1000, 1200, 900),
  ] }), plan);
  assert.deepEqual(result.signals.map((signal) => signal.symbol), ['2454', '2317', '3711']);
  assert.equal(result.signals[0].takeProfit, 1100, '同一個代號只採用第一筆');
  assert.deepEqual(result.warnings, ['AI 挑選的 9999 不在候選中，已略過', '2308 的價位檢查未通過（進場 1500 高於現價 1000 超過 1%，屬於追價），改為觀望']);

  const [none] = parseSignals(reply({ tw: [] }), plan);
  assert.deepEqual(none.signals, []);
});

test('做空：可以做空的市場與標的才採用，價位方向相反（止盈 < 進場 < 止損），反彈到壓力再放空為限價，往下追空則改為觀望', () => {
  const plan = [market('crypto', [
    item('ADA', 0.5, { shortable: true }), item('NIGHT', 0.04, { shortable: true }), item('SNEK', 0.0004, { shortable: false }),
    item('XRP', 2, { shortable: true }), item('SOL', 100, { shortable: true }), item('DOGE', 0.2, { shortable: true }),
  ], { allowShort: true })];
  const [result] = parseSignals(reply({ crypto: [
    short('ADA', 0.5, 0.44, 0.53), short('NIGHT', 0.0412, 0.036, 0.0435, { entryType: 'limit' }), short('SNEK', 0.0004, 0.00035, 0.00043),
    short('XRP', 2, 2.2, 1.9), short('SOL', 97, 85, 103), trade('DOGE', 0.2, 0.18, 0.21, { direction: undefined }),
  ] }), plan);
  const [ada, night, snek, xrp, sol, doge] = result.signals;
  assert.deepEqual([ada.action, ada.direction, ada.entryType], ['trade', 'short', 'market']);
  near(ada.riskReward, riskReward({ entry: 0.5, takeProfit: 0.44, stopLoss: 0.53 }, tradingCosts('crypto', 'ADA', 'short'), 'short'));
  assert.deepEqual([night.direction, night.entryType], ['short', 'limit'], '進場價高於現價 3%：等反彈到壓力再放空');
  assert.match(snek.reason, /價位檢查未通過：沒有 USDT 永續合約，無法做空，改為觀望）$/);
  assert.match(xrp.reason, /止盈 2\.2、進場 2、止損 1\.9 不符合做空的止盈 < 進場 < 止損/);
  assert.match(sol.reason, /進場 97 低於現價 100 超過 1%，屬於追空/);
  assert.deepEqual([doge.action, doge.direction], ['trade', 'short'], '沒有填方向時，止盈低於進場價視為做空');

  // 未開放做空的市場：做空改為觀望
  const [closed] = parseSignals(reply({ crypto: [short('ADA', 0.5, 0.44, 0.53)] }), [market('crypto', [item('ADA', 0.5, { shortable: true })])]);
  assert.match(closed.signals[0].reason, /這個市場未開放做空，改為觀望）$/);
});

test('可以做空時，提示詞說明做空方式與每個標的能否放空；AUTO 候選標示趨勢方向', () => {
  const down = analyzeCandles(Array.from({ length: 250 }, (_, i) => {
    const close = 200 - i * 0.4;
    return { time: Date.parse('2026-01-01T00:00Z') + i * 86_400_000, open: close, high: close * 1.01, low: close * 0.99, close, volume: 100 };
  }));
  const plan = [
    market('crypto', [item('ADA', 0.5, { shortable: true, snapshot: down }), item('SNEK', 0.0004, { shortable: false })], { auto: true, candidates: 15, allowShort: true }),
    market('us', [item('NVDA', 150, { shortable: null })], { allowShort: true }),
  ];
  const prompt = buildSignalPrompt(plan, { now: NOW, timeZone: TZ });
  assert.match(prompt, /一律不開槓桿（1 倍）：做多為現貨買進；做空.*虛擬貨幣以 USDT 永續合約 1 倍放空，股票以融券放空/);
  assert.match(prompt, /做空：優先考慮收盤價在 EMA50 之下、EMA20 < EMA50 且 EMA50 向下、−DI > \+DI/);
  assert.match(prompt, /做空必須「止盈 < 進場 < 止損」/);
  assert.match(prompt, /一、crypto：虛擬貨幣，日線，價格單位：美元（USDT 交易對），可以做多或做空（做空方式：USDT 永續合約 1 倍放空）/);
  assert.match(prompt, /篩選出趨勢明確（向上：收盤價高於 EMA50 且 EMA20 > EMA50；向下：收盤價低於 EMA50 且 EMA20 < EMA50）的候選/);
  assert.match(prompt, /### ADA\n- 資料：.*\n- 趨勢篩選：向下（評估做空）\n- 做空：可（有 USDT 永續合約）\n/);
  assert.match(prompt, /### SNEK\n- 資料：.*\n- 趨勢篩選：向上（評估做多）\n- 做空：不可（沒有 USDT 永續合約，只能做多或觀望）\n/);
  assert.match(prompt, /二、us：美股，日線，價格單位：美元，可以做多或做空（做空方式：融券放空（需保證金帳戶））/);
  assert.match(prompt, /### NVDA\n- 資料：.*\n- 做空：需自行確認券商是否可借券\n/);
});

test('回覆不是 JSON 或缺少有資料的市場時拋錯；沒有資料的市場不要求回覆', () => {
  const plan = [market('crypto', [item('BTC', 62000)]), market('us', [], { failure: '無法取得 AUTO 的候選標的：HTTP 500', auto: true })];
  assert.throws(() => parseSignals('不是 JSON', plan), /不是有效的 JSON/);
  assert.throws(() => parseSignals(reply({ us: [] }), plan), /格式不符/);
  const [, us] = parseSignals(reply({ crypto: [wait('BTC')] }), plan);
  assert.deepEqual(us.signals, []);
  assert.equal(us.failure, '無法取得 AUTO 的候選標的：HTTP 500');
});

test('Discord 訊息：每個市場一則，標題註明 K 線週期與價格單位；可以做單時列出進場方式、風險報酬比、止盈、止損（不顯示現價）；最後一則為免責聲明', () => {
  const plan = [
    market('crypto', [item('BTC', 62000), item('ETH', 1750)], { errors: [{ symbol: 'NOTACOIN', message: '無法取得 NOTACOINUSDT 的 K 線' }] }),
    market('tw', [item('2330', 2000, { name: '台積電', source: 'Yahoo Finance', ticker: '2330.TW' })], { auto: true, candidates: 15 }),
    market('us', [], { auto: true, failure: '無法取得 AUTO 的候選標的：HTTP 500' }),
  ];
  const results = parseSignals(reply({
    crypto: [trade('BTC', 62000, 66000, 60000, { note: '若跌破 60500，則直接撤單' }), wait('ETH')],
    tw: [trade('2330', 1985, 2150, 1900, { entryType: 'limit' })],
  }), plan);
  const messages = buildDiscordMessages(results, { dateLabel: DATE });
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.at(-1), DISCLAIMER_MESSAGE);
  assert.deepEqual(DISCLAIMER_MESSAGE, { embeds: [{
    description: `⚠️ **${DISCLAIMER}**`, color: 0xf1c40f, footer: { text: '技術指標僅反映過去的價格與成交量，實際交易請自行判斷並控制風險' },
  }] });
  assert.equal(DISCLAIMER, '此通知為 AI 自動生成，不構成投資建議');

  const [crypto, tw, us] = messages;
  assert.equal(crypto.content, `## 🪙 虛擬貨幣技術分析｜${DATE}\n-# 🕒 日線・💵 價格單位：美元（USDT 交易對）`);
  assert.deepEqual(crypto.embeds[0], {
    description: [
      '🏷️ **標的**：**BTC**，**是否做單**：🟢 **做多**',
      '💰 **進場（現價）**：`62000`，**風險報酬比**：1:1.7',
      '🎯 **止盈**：`66000`（+6.5%），**止損**：`60000`（-3.2%）',
      '📊 **原因**：BTC 多頭排列',
      '📝 **其他事項**：若跌破 60500，則直接撤單',
    ].join('\n'),
    color: 0x2ecc71,
    footer: { text: '資料來源：Binance BTCUSDT' },
  });
  assert.equal(crypto.embeds[1].description, '🏷️ **標的**：**ETH**，**是否做單**：⚪ **觀望**\n📊 **原因**：ETH 趨勢偏空');
  assert.equal(crypto.embeds[1].color, 0x95a5a6);
  assert.equal(crypto.embeds[1].footer.text, '現價 1750 美元・資料來源：Binance ETHUSDT', '觀望時現價顯示在卡片底部');
  assert.deepEqual(crypto.embeds[2], { description: '🏷️ **標的**：**NOTACOIN**\n❌ **原因**：無法取得行情資料，本次略過：無法取得 NOTACOINUSDT 的 K 線', color: 0xe74c3c });

  assert.equal(tw.content, `## 🇹🇼 台股技術分析｜${DATE}\n-# 🕒 日線・💵 價格單位：新台幣・🤖 AUTO：從上市櫃普通股中前一交易日成交金額最大的 15 個標的中篩選出趨勢向上的 1 個，由 AI 挑選最多 3 個`);
  assert.match(tw.embeds[0].description,
    /^🏷️ \*\*標的\*\*：\*\*2330 台積電\*\*，\*\*是否做單\*\*：🟢 \*\*做多\*\*\n💰 \*\*進場（限價・待觸發）\*\*：`1985`，\*\*風險報酬比\*\*：1:1\.5\n🎯 \*\*止盈\*\*：`2150`（\+8\.3%），\*\*止損\*\*：`1900`（-4\.3%）\n/);
  assert.equal(tw.embeds[0].footer.text, '資料來源：Yahoo Finance 2330.TW');

  assert.equal(us.content, `## 🇺🇸 美股技術分析｜${DATE}\n-# 🕒 日線・💵 價格單位：美元`);
  assert.deepEqual(us.embeds, [{ description: '❌ **美股 AUTO**：無法取得 AUTO 的候選標的：HTTP 500，本次略過。', color: 0xe74c3c }]);

  // 做空：橘色卡片，止盈為下跌、止損為上漲
  const [shortMessage] = buildDiscordMessages(parseSignals(reply({ crypto: [short('ADA', 0.5, 0.44, 0.53)] }),
    [market('crypto', [item('ADA', 0.5, { shortable: true })], { allowShort: true })]), { dateLabel: DATE });
  assert.deepEqual(shortMessage.embeds[0], {
    description: [
      '🏷️ **標的**：**ADA**，**是否做單**：🟠 **做空**',
      '💰 **進場（現價）**：`0.5`，**風險報酬比**：1:1.9',
      '🎯 **止盈**：`0.44`（-12.0%），**止損**：`0.53`（+6.0%）',
      '📊 **原因**：ADA 空頭排列',
    ].join('\n'),
    color: 0xe67e22,
    footer: { text: '資料來源：Binance ADAUSDT' },
  });

  const [noPick] = buildDiscordMessages(parseSignals(reply({ tw: [] }), [plan[1]]), { dateLabel: DATE });
  assert.deepEqual(noPick.embeds, [{ description: `💤 ${NO_PICK_TEXT}`, color: 0x95a5a6 }]);
  assert.equal(NO_PICK_TEXT, '目前沒有符合做單條件的標的，或市場不適合做單，建議觀望。');
});

test('10 個標的且內容都是最長時，仍符合 Discord 每則訊息 10 張卡片、6000 字的限制', () => {
  const symbols = Array.from({ length: 10 }, (_, i) => `COIN${String(i).padStart(9, '0')}`);
  const plan = [market('crypto', symbols.map((symbol) => item(symbol, 0.000012345, { name: '名'.repeat(50) })))];
  const [result] = parseSignals(reply({ crypto: symbols.map((symbol) => trade(symbol, 0.000012345, 0.000099999, 0.000010001, {
    reason: '原'.repeat(1000), note: '注'.repeat(1000),
  })) }), plan);
  assert.ok(result.signals.every((signal) => signal.action === 'trade' && signal.reason.length === REASON_MAX && signal.note.length === NOTE_MAX));
  const [message] = buildDiscordMessages([result], { dateLabel: DATE });
  assert.equal(message.embeds.length, 10);
  const chars = message.embeds.reduce((sum, embed) => sum + embed.description.length + (embed.footer?.text.length ?? 0), 0);
  assert.ok(chars <= 6000, `卡片文字總量 ${chars} 超過 6000`);
});
