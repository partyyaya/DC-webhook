import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../../src/stock/config.js';
import { runDaily } from '../../src/stock/run.js';
import { loadDigestState } from '../../src/shared/digest-state.js';

// 共用的每日流程（刪除、重試、多個 Webhook、舊紀錄轉換）已在 test/crypto/run.test.js 測試；這裡只測股票的部分。
const A = '777777777777777777';
const taipei = (text) => new Date(`${text.replace(' ', 'T')}:00+08:00`);
const NEWS = {
  tw: [{ title: '台積電法說會', summary: '摘要', source: '經濟日報', url: 'https://example.com/tsmc', publishedAt: '2026-11-19 14:00', stocks: ['2330.TW'] }],
  us: [{ title: '輝達財報', summary: '摘要', source: 'Reuters', url: 'https://example.com/nvda', publishedAt: '2026-11-20 05:30', stocks: ['nvda'] }],
};

/**
 * 建立測試環境：假的 Codex CLI（回覆 reply.json，並記錄參數與提示詞）與假的 Discord。
 * news 為覆寫的新聞設定（篇數、股票清單）。
 */
async function setup(t, news = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-stock-'));
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
  const reply = ${JSON.stringify(NEWS)};
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(Object.fromEntries(schema.required.map((key) => [key, reply[key]]))));
});
`, { mode: 0o755 });
  Object.assign(config, {
    targets: [{ name: '', webhookId: A, url: `https://discord.com/api/webhooks/${A}/token`, webhookProfile: {} }],
    stateFile: path.join(dir, 'state.json'), discordMessagesFile: path.join(dir, 'posts.jsonl'),
    ai: { provider: 'codex', bin, timeoutMs: 10_000, webSearch: true },
    news: { twStocks: ['2330', '2317'], usStocks: ['NVDA'], twCount: 3, usCount: 3, ...news },
    schedule: { ...original.schedule, timeZone: 'Asia/Taipei' },
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    assert.equal(new URL(input).hostname, 'discord.com');
    posts.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ id: String(900 + posts.length), channel_id: '333' }));
  });
  return { posts, codexCall: async () => JSON.parse(await readFile(logFile, 'utf8')) };
}

test('以網路搜尋取得台股與美股新聞，各發一則訊息並記錄，代號統一格式', async (t) => {
  const { posts, codexCall } = await setup(t);
  assert.equal((await runDaily({ now: taipei('2026-11-20 08:00') })).status, 'sent');
  assert.deepEqual(posts.map((post) => post.content), ['## 🇹🇼 台股新聞｜2026-11-20（週五）', '## 🇺🇸 美股新聞｜2026-11-20（週五）']);
  assert.equal(posts[0].embeds[0].footer.text, '2330｜經濟日報｜2026-11-19 14:00');
  assert.equal(posts[1].embeds[0].footer.text, 'NVDA｜Reuters｜2026-11-20 05:30');
  assert.deepEqual((await loadDigestState(config.stateFile)).targets, { [A]: { completedDate: '2026-11-20', messageIds: ['901', '902'] } });

  const { args, input, schema } = await codexCall();
  assert.equal(args[args.indexOf('-c') + 1], 'web_search="live"');
  assert.deepEqual(schema.required, ['tw', 'us']);
  assert.match(input, /2026-11-19（週四）08:00 ～ 2026-11-20（週五）08:00/);
  assert.match(input, /2330、2317 每檔股票至少 1 則/);
});

test('台股篇數為 0 時只搜尋與發送美股', async (t) => {
  const { posts, codexCall } = await setup(t, { twCount: 0 });
  const result = await runDaily({ dryRun: true, now: taipei('2026-11-20 08:00') });
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(result.messages.map((message) => message.content), ['## 🇺🇸 美股新聞｜2026-11-20（週五）']);
  assert.deepEqual(posts, [], '預覽不發送');
  const { input, schema } = await codexCall();
  assert.deepEqual(schema.required, ['us']);
  assert.doesNotMatch(input, /台股/);
});

test('沒有設定 Webhook 時正式執行拋錯並指出 env/stock.js', async (t) => {
  await setup(t);
  config.targets = [];
  await assert.rejects(runDaily({ now: taipei('2026-11-20 08:00') }), /env\/stock\.js 的 webhooks/);
});
