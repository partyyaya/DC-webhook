import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscordMessages, DISCLAIMER, DISCLAIMER_MESSAGE, NO_PICK_TEXT } from '../../src/signal/format.js';
import { analyzeCandles } from '../../src/signal/indicators.js';
import { parseMarketSymbols } from '../../src/signal/markets.js';
import { buildSignalPrompt, buildSignalSchema, formatPrice, NOTE_MAX, parseSignals, REASON_MAX } from '../../src/signal/signals.js';

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
const trade = (symbol, entry, takeProfit, stopLoss, extra = {}) => ({ symbol, action: 'trade', entry, takeProfit, stopLoss, reason: `${symbol} 多頭排列`, note: '', ...extra });
const wait = (symbol, extra = {}) => ({ symbol, action: 'wait', entry: 0, takeProfit: 0, stopLoss: 0, reason: `${symbol} 趨勢偏空`, note: '', ...extra });
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

test('提示詞：不開槓桿只做多、價格單位、指定代號的回覆順序與 AUTO 的挑選規則；Schema 只包含有資料的市場', () => {
  const plan = [
    market('crypto', [item('BTC', 62000), item('ETH', 1750)]),
    market('tw', [item('2330', 2000, { name: '台積電', source: 'Yahoo Finance', ticker: '2330.TW' })], { auto: true, candidates: 1 }),
    market('us', [], { errors: [{ symbol: 'NVDA', message: '連線失敗' }] }),
  ];
  const prompt = buildSignalPrompt(plan, { now: NOW, timeZone: TZ });
  assert.match(prompt, /2026-11-20（週五）08:05（時區 Asia\/Taipei）/);
  assert.match(prompt, /不開槓桿：只考慮現貨買進（做多），不放空/);
  assert.match(prompt, /風險報酬比.*至少 1\.5/);
  assert.match(prompt, /虛擬貨幣與美股為美元，台股為新台幣/);
  assert.match(prompt, /一、crypto：虛擬貨幣，日線，價格單位：美元（USDT 交易對）\n- 每個標的都要回覆一筆，依序為：BTC、ETH。/);
  assert.match(prompt, /- 持有時間與 K 線週期相符：日線約數天到數週。\n/);
  assert.match(prompt, /二、tw：台股，日線，價格單位：新台幣\n- 以下 1 個是上市櫃普通股中前一交易日成交金額最大的標的，作為候選。請從中挑選符合上述做單條件的標的，最多 3 個/);
  assert.match(prompt, /3 個是上限而不是目標：符合條件的只有 1、2 個就只填 1、2 個；找不到符合條件的標的，或市場整體偏空、訊號不明確而不適合做單時，直接回傳空陣列/);
  assert.doesNotMatch(prompt.slice(prompt.indexOf('一、crypto')), /三、|us：|NVDA/);
  assert.doesNotMatch(prompt.slice(prompt.indexOf('二、tw')), /代幣化股票/, '只有虛擬貨幣的 AUTO 需要排除代幣化股票');

  // 每個標的的行情與指標
  assert.match(prompt, /### 2330（台積電）\n- 資料：Yahoo Finance 2330\.TW，日線，共 250 根已收盤 K 線\n- 現價：2000（2026-11-20（週五）08:05）/);
  for (const pattern of [/EMA20／EMA50／EMA200：.*最後收盤價高於 EMA20、高於 EMA50、高於 EMA200；EMA20 > EMA50 > EMA200/, /MACD\(12,26,9\)：DIF /, /RSI\(14\)：/,
    /ADX\(14\)：.*\+DI .*−DI /, /ATR\(14\)：.*（現價的 [\d.]+%）/, /成交量：最後一根 349，前 20 根平均 338\.5，為平均的 1\.03 倍/, /費波那契（近 120 根的上升波段：.*回撤位（回檔支撐）0\.236＝/]) {
    assert.match(prompt, pattern);
  }

  const schema = buildSignalSchema(plan);
  assert.deepEqual(schema.required, ['crypto', 'tw']);
  assert.deepEqual(schema.properties.crypto.items.required, ['symbol', 'action', 'entry', 'takeProfit', 'stopLoss', 'reason', 'note']);
  assert.deepEqual(schema.properties.crypto.items.properties.action.enum, ['trade', 'wait']);
});

test('指定代號：依設定順序每個標的一筆；價位依現價位數四捨五入；AI 沒回覆的顯示為觀望', () => {
  const plan = [market('crypto', [item('BTC', 62000), item('ETH', 1750), item('SOL', 72.5)])];
  const [result] = parseSignals(reply({ crypto: [wait('SOL', { note: '等待站回 EMA20' }), trade('btcusdt', 61800.4, 66000.6, 59999.5)] }), plan);
  assert.deepEqual(result.signals.map((signal) => [signal.symbol, signal.action]), [['BTC', 'trade'], ['ETH', 'wait'], ['SOL', 'wait']]);
  assert.deepEqual(result.signals[0], {
    symbol: 'BTC', name: '', price: 62000, source: 'Binance', ticker: 'BTCUSDT', reason: 'btcusdt 多頭排列', note: '',
    action: 'trade', entry: 61800, takeProfit: 66001, stopLoss: 60000,
  });
  assert.equal(result.signals[1].reason, 'AI 沒有回覆這個標的的分析。');
  assert.equal(result.signals[2].note, '等待站回 EMA20');
  assert.deepEqual(result.warnings, ['AI 沒有回覆 ETH 的分析，顯示為觀望']);
});

test('價位不合理時改為觀望並註明原因：不符合止損 < 進場 < 止盈、不是正數、進場價離現價太遠', () => {
  const plan = [market('us', [item('NVDA', 150), item('AAPL', 350), item('MSFT', 500)])];
  const [result] = parseSignals(reply({ us: [
    trade('NVDA', 150, 140, 145), trade('AAPL', 0, 360, 340), trade('MSFT', 380, 420, 360, { reason: '長'.repeat(REASON_MAX) }),
  ] }), plan);
  assert.ok(result.signals.every((signal) => signal.action === 'wait' && signal.entry === undefined));
  assert.match(result.signals[0].reason, /NVDA 多頭排列（AI 給出的價位不合理：止損 145、進場 150、止盈 140 不符合止損 < 進場 < 止盈，改為觀望）$/);
  assert.match(result.signals[1].reason, /價位必須大於 0/);
  assert.match(result.signals[2].reason, /進場 380 與現價 500 相差超過 20%，改為觀望）$/);
  assert.equal(result.signals[2].reason.length, REASON_MAX);
  assert.equal(result.warnings.length, 3);
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
  assert.deepEqual(result.warnings, ['AI 挑選的 9999 不在候選中，已略過', '2308 的價位不合理（進場 1500 與現價 1000 相差超過 20%），改為觀望']);

  const [none] = parseSignals(reply({ tw: [] }), plan);
  assert.deepEqual(none.signals, []);
});

test('回覆不是 JSON 或缺少有資料的市場時拋錯；沒有資料的市場不要求回覆', () => {
  const plan = [market('crypto', [item('BTC', 62000)]), market('us', [], { failure: '無法取得 AUTO 的候選標的：HTTP 500', auto: true })];
  assert.throws(() => parseSignals('不是 JSON', plan), /不是有效的 JSON/);
  assert.throws(() => parseSignals(reply({ us: [] }), plan), /格式不符/);
  const [, us] = parseSignals(reply({ crypto: [wait('BTC')] }), plan);
  assert.deepEqual(us.signals, []);
  assert.equal(us.failure, '無法取得 AUTO 的候選標的：HTTP 500');
});

test('Discord 訊息：每個市場一則，標題註明 K 線週期與價格單位；可以做單時列出進場、止盈、止損（不顯示現價）；最後一則為免責聲明', () => {
  const plan = [
    market('crypto', [item('BTC', 62000), item('ETH', 1750)], { errors: [{ symbol: 'NOTACOIN', message: '無法取得 NOTACOINUSDT 的 K 線' }] }),
    market('tw', [item('2330', 2000, { name: '台積電', source: 'Yahoo Finance', ticker: '2330.TW' })], { auto: true, candidates: 15 }),
    market('us', [], { auto: true, failure: '無法取得 AUTO 的候選標的：HTTP 500' }),
  ];
  const results = parseSignals(reply({
    crypto: [trade('BTC', 62000, 65000, 60000, { note: '若跌破 60500，則直接撤單' }), wait('ETH')],
    tw: [trade('2330', 1985, 2150, 1900)],
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
      '🏷️ **標的**：**BTC**，**是否做單**：🟢 **可以**',
      '💰 **進場**：`62000`，**止盈**：`65000`（+4.8%），**止損**：`60000`（-3.2%）',
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

  assert.equal(tw.content, `## 🇹🇼 台股技術分析｜${DATE}\n-# 🕒 日線・💵 價格單位：新台幣・🤖 AUTO：由 AI 從上市櫃普通股中前一交易日成交金額最大的 15 個標的中挑選最多 3 個`);
  assert.match(tw.embeds[0].description, /^🏷️ \*\*標的\*\*：\*\*2330 台積電\*\*，\*\*是否做單\*\*：🟢 \*\*可以\*\*\n💰 \*\*進場\*\*：`1985`，\*\*止盈\*\*：`2150`（\+8\.3%），\*\*止損\*\*：`1900`（-4\.3%）\n/);
  assert.equal(tw.embeds[0].footer.text, '資料來源：Yahoo Finance 2330.TW');

  assert.equal(us.content, `## 🇺🇸 美股技術分析｜${DATE}\n-# 🕒 日線・💵 價格單位：美元`);
  assert.deepEqual(us.embeds, [{ description: '❌ **美股 AUTO**：無法取得 AUTO 的候選標的：HTTP 500，本次略過。', color: 0xe74c3c }]);

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
