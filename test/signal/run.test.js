import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadDigestState } from '../../src/shared/digest-state.js';

// 不讀取本機的 env/signal.js：指定一個不存在的設定檔，全部使用預設值，Webhook 等由各測試設定
process.env.SIGNAL_CONFIG_FILE = path.join(os.tmpdir(), 'dcwebhook-signal-test-no-config.js');
const { config } = await import('../../src/signal/config.js');
const { runOnce } = await import('../../src/signal/run.js');

// 共用的每日流程（刪除、重試、多個 Webhook、舊紀錄轉換）已在 test/crypto/run.test.js 測試；這裡只測技術指標的部分。
const A = '777777777777777777';
const DAY = 86_400_000;
const NOW = new Date('2026-11-20T08:05:00+08:00');
// AI 的回覆：BTC 現價進場、2330 限價進場、NVDA 觀望；依 Schema 只回覆需要的市場
const REPLY = {
  crypto: [{ symbol: 'BTC', action: 'trade', direction: 'long', entryType: 'market', entry: 97.2, takeProfit: 106, stopLoss: 93, reason: 'BTC 站上均線', note: '若跌破 93，則直接撤單' }],
  tw: [{ symbol: '2330', action: 'trade', direction: 'long', entryType: 'limit', entry: 102, takeProfit: 112, stopLoss: 99, reason: '2330 量價齊揚', note: '' }],
  us: [{ symbol: 'NVDA', action: 'wait', direction: 'none', entryType: 'none', entry: 0, takeProfit: 0, stopLoss: 0, reason: 'NVDA 趨勢不明', note: '' }],
};

// 虛擬貨幣：120 根日線，收盤價在 100 附近，現價約 97.28；最後一根（今天）尚未收盤
const days = Array.from({ length: 121 }, (_, i) => Date.parse('2026-11-20T00:00Z') - (120 - i) * DAY);
const closeAt = (i) => 100 + Math.sin(i / 5) * 3;
const binanceRows = days.map((time, i) => [time, String(closeAt(i) - 0.5), String(closeAt(i) + 1), String(closeAt(i) - 1), String(closeAt(i)), '10', time + DAY - 1, '0']);
// 股票：到昨天為止的 120 根日線（台股 09:00 開盤），今天尚未開盤；trend 為 up 時穩定上漲到約 104，down 時下跌
const stockDays = days.slice(0, -1);
const yahooChart = (trend) => {
  const closes = stockDays.map((_, i) => (trend === 'up' ? 80 + i * 0.2 : 110 - i * 0.2));
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: Number(closes.at(-1).toFixed(1)) + 0.2, regularMarketTime: Date.parse('2026-11-19T05:30Z') / 1000,
          currentTradingPeriod: { regular: { start: Date.parse('2026-11-20T01:00Z') / 1000, end: Date.parse('2026-11-20T05:30Z') / 1000 } },
        },
        timestamp: stockDays.map((time) => time / 1000 + 3600),
        indicators: {
          quote: [{ open: closes, high: closes.map((c) => c + 1), low: closes.map((c) => c - 1), close: closes, volume: closes.map(() => 1000) }],
          adjclose: [{ adjclose: closes }],
        },
      }],
    },
  };
};

/**
 * 建立測試環境：假的 Codex CLI（回覆 REPLY，並記錄參數與提示詞）、假的行情網站與 Discord。
 * markets 為覆寫的市場設定；failMarketData 為 true 時所有行情網站都回覆錯誤；stockTrend 為股票 K 線的走勢（up／down）。
 */
async function setup(t, { markets = {}, failMarketData = false, stockTrend = 'up' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-signal-'));
  const original = { ...config };
  t.after(async () => { Object.assign(config, original); await rm(dir, { recursive: true, force: true }); });
  const logFile = path.join(dir, 'codex-log.json');
  const bin = path.join(dir, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8'));
  fs.writeFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, input, schema }));
  const reply = ${JSON.stringify(REPLY)};
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(Object.fromEntries(schema.required.map((key) => [key, reply[key]]))));
});
`, { mode: 0o755 });
  Object.assign(config, {
    targets: [{ name: '', webhookId: A, url: `https://discord.com/api/webhooks/${A}/token`, webhookProfile: {} }],
    stateFile: path.join(dir, 'state.json'), discordMessagesFile: path.join(dir, 'posts.jsonl'),
    ai: { provider: 'codex', bin, timeoutMs: 10_000, webSearch: false },
    markets: {
      crypto: { auto: false, symbols: ['BTC', 'ETH'], interval: '1d', allowShort: true },
      tw: { auto: true, symbols: [], interval: '1d' },
      us: { auto: false, symbols: ['NVDA'], interval: '1d' },
      ...markets,
    },
    schedule: { ...original.schedule, timeZone: 'Asia/Taipei' },
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const posts = [];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.hostname === 'discord.com') {
      posts.push(JSON.parse(options.body));
      return json({ id: String(900 + posts.length), channel_id: '333' });
    }
    requests.push(`${url.hostname}${url.pathname}${url.searchParams.get('symbol') ? `?${url.searchParams.get('symbol')}` : ''}`);
    if (failMarketData) return json({ msg: 'Invalid symbol.' }, 400);
    // 永續合約清單：Binance 有 BTCUSDT、Bybit 有 BTCUSDT、Bitget 有 ETHUSDT
    if (url.hostname === 'fapi.binance.com') return json([{ symbol: 'BTCUSDT', price: '1' }]);
    if (url.searchParams.get('category') === 'linear') return json({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT' }] } });
    if (url.pathname === '/api/v2/mix/market/tickers') return json({ code: '00000', data: [{ symbol: 'ETHUSDT' }] });
    if (url.hostname === 'api.binance.com') return url.searchParams.get('symbol') === 'BTCUSDT' ? json(binanceRows) : json({ code: -1121, msg: 'Invalid symbol.' }, 400);
    if (url.hostname === 'api.bybit.com') return json({ retCode: 10001, retMsg: 'Not supported symbols' });
    if (url.hostname === 'api.bitget.com') return json({ code: '40034', msg: `Parameter ${url.searchParams.get('symbol')} does not exist` }, 400);
    if (url.hostname === 'openapi.twse.com.tw') return json([{ Code: '2330', Name: '台積電', TradeValue: '100' }, { Code: '0050', Name: '元大台灣50', TradeValue: '999' }]);
    if (url.hostname === 'www.tpex.org.tw') return json([]);
    if (url.pathname.startsWith('/v8/finance/chart/')) return json(yahooChart(stockTrend));
    throw new Error(`未預期的請求：${url.href}`);
  });
  return { posts, requests, codexCall: async () => JSON.parse(await readFile(logFile, 'utf8')), codexCalled: () => existsSync(logFile) };
}

test('取得行情並計算指標，由 AI 判斷是否做單；每個市場一則訊息，最後附上免責聲明', async (t) => {
  const { posts, requests, codexCall } = await setup(t);
  assert.equal((await runOnce({ now: NOW })).status, 'sent');

  assert.deepEqual(posts.map((post) => post.content?.split('\n')[0]), [
    '## 🪙 虛擬貨幣技術分析｜2026-11-20（週五）', '## 🇹🇼 台股技術分析｜2026-11-20（週五）', '## 🇺🇸 美股技術分析｜2026-11-20（週五）', undefined,
  ]);
  assert.equal(posts[3].embeds[0].description, '⚠️ **此通知為 AI 自動生成，不構成投資建議**', '免責聲明為最後一張卡片');
  // 紀錄的標題取自訊息文字；只有卡片時取自卡片
  const titles = (await readFile(config.discordMessagesFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).title);
  assert.deepEqual(titles.slice(-2), ['🇺🇸 美股技術分析｜2026-11-20（週五）', '⚠️ 此通知為 AI 自動生成，不構成投資建議']);
  const [crypto, tw, us] = posts;
  assert.equal(crypto.embeds[0].description, [
    '🏷️ **標的**：**BTC**，**是否做單**：🟢 **做多**', '💰 **進場（現價）**：`97.2`，**風險報酬比**：1:1.9',
    '🎯 **止盈**：`106`（+9.1%），**止損**：`93`（-4.3%）', '📊 **原因**：BTC 站上均線', '📝 **注意事項**：若跌破 93，則直接撤單',
  ].join('\n'));
  assert.match(crypto.embeds[1].description, /^🏷️ \*\*標的\*\*：\*\*ETH\*\*\n❌ \*\*原因\*\*：無法取得行情資料，本次略過：無法取得 ETHUSDT 的 K 線（Binance：HTTP 400（Invalid symbol\.）；Bybit：Not supported symbols；Bitget：HTTP 400（Parameter ETHUSDT does not exist））/);
  assert.match(tw.content, /AUTO：從上市櫃普通股中前一交易日成交金額最大的 1 個標的中篩選出趨勢向上的 1 個，由 AI 挑選最多 3 個/);
  assert.match(tw.embeds[0].description,
    /^🏷️ \*\*標的\*\*：\*\*2330 台積電\*\*，\*\*是否做單\*\*：🟢 \*\*做多\*\*\n💰 \*\*進場（限價・待觸發）\*\*：`102`，\*\*風險報酬比\*\*：1:2\.5\n🎯 \*\*止盈\*\*：`112`（\+9\.8%），\*\*止損\*\*：`99`（-2\.9%）\n/);
  assert.equal(tw.embeds[0].footer.text, '現價 104 新台幣・資料來源：Yahoo Finance 2330.TW');
  assert.equal(us.embeds[0].footer.text, '現價 104 美元・資料來源：Yahoo Finance NVDA');
  assert.equal(us.embeds[0].description, '🏷️ **標的**：**NVDA**，**是否做單**：⚪ **觀望**\n📊 **原因**：NVDA 趨勢不明');
  assert.deepEqual((await loadDigestState(config.stateFile)).targets, { [A]: { completedDate: '2026-11-20', messageIds: ['901', '902', '903', '904'] } });

  // 行情：虛擬貨幣依序試 Binance、Bybit、Bitget，並取得三家的永續合約清單（可以做空）；台股 AUTO 只取普通股（不含 0050），已知上市時直接查 .TW
  assert.deepEqual(requests.filter((request) => !request.includes('openapi') && !request.includes('tpex')).sort(), [
    'api.binance.com/api/v3/klines?BTCUSDT', 'api.binance.com/api/v3/klines?ETHUSDT', 'api.bitget.com/api/v2/mix/market/tickers',
    'api.bitget.com/api/v2/spot/market/candles?ETHUSDT', 'api.bybit.com/v5/market/kline?ETHUSDT', 'api.bybit.com/v5/market/tickers',
    'fapi.binance.com/fapi/v1/ticker/price',
    'query1.finance.yahoo.com/v8/finance/chart/2330.TW', 'query1.finance.yahoo.com/v8/finance/chart/NVDA',
  ]);

  // AI：不使用網路搜尋；Schema 包含三個市場；提示詞包含指標與候選規則
  const { args, input, schema } = await codexCall();
  assert.ok(!args.includes('web_search="live"'), '指標已由程式計算，不需要網路搜尋');
  assert.deepEqual(schema.required, ['crypto', 'tw', 'us']);
  assert.match(input, /一、crypto：虛擬貨幣，日線，價格單位：美元（USDT 交易對），可以做多或做空（做空方式：USDT 永續合約 1 倍放空）/);
  assert.match(input, /### BTC\n- 資料：Binance BTCUSDT，日線，共 120 根已收盤 K 線\n- 做空：可（有 USDT 永續合約）\n/);
  assert.match(input, /二、tw：台股，日線，價格單位：新台幣，只能做多/);
  assert.match(input, /### 2330（台積電）\n- 資料：Yahoo Finance 2330\.TW，日線（還原權息）/);
  assert.match(input, /以下 1 個是從上市櫃普通股中前一交易日成交金額最大的 1 個標的中，由程式篩選出趨勢向上/);
  assert.doesNotMatch(input, /### ETH/);
});

test('每次執行都發送：同一天再次執行時先刪除前一次的訊息，再發送最新的分析', async (t) => {
  const { posts } = await setup(t, { markets: { tw: { auto: false, symbols: [], interval: '1d' }, us: { auto: false, symbols: [], interval: '1d' } } });
  const deleted = [];
  const send = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    if (options.method === 'DELETE') {
      deleted.push(new URL(input).pathname.split('/').at(-1));
      return new Response(null, { status: 204 });
    }
    return send(input, options);
  });
  assert.equal((await runOnce({ now: NOW })).status, 'sent');
  assert.equal((await runOnce({ now: new Date(NOW.getTime() + 4 * 3_600_000) })).status, 'sent');
  assert.deepEqual(deleted, ['901', '902']);
  assert.equal(posts.length, 4);
  assert.deepEqual((await loadDigestState(config.stateFile)).targets, { [A]: { completedDate: '2026-11-20', messageIds: ['903', '904'] } });
});

test('AUTO 的候選都沒有通過趨勢篩選時，不呼叫 AI，顯示沒有符合做單條件的標的', async (t) => {
  const only = { crypto: { auto: false, symbols: [], interval: '1d' }, us: { auto: false, symbols: [], interval: '1d' } };
  const { posts, codexCalled } = await setup(t, { markets: only, stockTrend: 'down' });
  assert.equal((await runOnce({ now: NOW })).status, 'sent');
  assert.equal(codexCalled(), false);
  assert.match(posts[0].content, /AUTO：從上市櫃普通股中前一交易日成交金額最大的 1 個標的中篩選出趨勢向上的 0 個/);
  assert.deepEqual(posts[0].embeds, [{ description: '💤 目前沒有符合做單條件的標的，或市場不適合做單，建議觀望。', color: 0x95a5a6 }]);
  assert.equal(posts.length, 2, '台股與免責聲明');
});

test('不分析的市場不取得資料也不發送；所有標的都無法取得行情時拋錯，不呼叫 AI、不發送', async (t) => {
  const disabled = { tw: { auto: false, symbols: [], interval: '1d' }, us: { auto: false, symbols: [], interval: '1d' } };
  const { posts, requests, codexCalled } = await setup(t, { markets: disabled, failMarketData: true });
  await assert.rejects(runOnce({ now: NOW }), /所有標的都無法取得行情資料，本次不發送/);
  assert.deepEqual(posts, []);
  assert.equal(codexCalled(), false);
  assert.ok(requests.every((request) => /^(api|fapi)\./.test(request)), '只取得虛擬貨幣的資料（現貨 K 線與永續合約清單）');
});

test('預覽模式只印出內容；沒有設定 Webhook 時正式執行拋錯並指出 env/signal.js', async (t) => {
  const { posts } = await setup(t, { markets: { tw: { auto: false, symbols: [], interval: '1d' } } });
  const result = await runOnce({ dryRun: true, now: NOW });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.messages.length, 3);
  assert.deepEqual(posts, []);

  config.targets = [];
  await assert.rejects(runOnce({ now: NOW }), /env\/signal\.js 的 webhooks/);
});
