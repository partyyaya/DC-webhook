import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../../src/crypto/config.js';
import { runDaily } from '../../src/crypto/run.js';
import { loadDigestState, saveDigestState } from '../../src/crypto/state.js';
import { listPosts } from '../../src/shared/posts.js';

const HOOK = 'https://discord.com/api/webhooks/555555555555555555/cryptoToken';
const taipei = (text) => new Date(`${text.replace(' ', 'T')}:00+08:00`);
const NEWS = {
  economy: [{ title: '聯準會維持利率', summary: '摘要', source: 'Reuters', url: 'https://example.com/fed', publishedAt: '2026-11-18 03:00' }],
  crypto: [{ title: '比特幣反彈', summary: '摘要', source: 'CoinDesk', url: 'https://example.com/btc', publishedAt: '2026-11-18 06:00', coins: ['BTC'] }],
};

/**
 * 建立測試環境：假的 Codex CLI（回覆 reply.json 的內容，內容為 FAIL 時以結束碼 1 失敗）與假的 Discord。
 * deleteStatus：依訊息 ID 指定刪除的 HTTP 狀態；failPostAt：第幾次新增失敗。
 */
async function setup(t, { deleteStatus = {}, failPostAt } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-crypto-'));
  const original = { ...config };
  t.after(async () => { Object.assign(config, original); await rm(dir, { recursive: true, force: true }); });
  const replyFile = path.join(dir, 'reply.json');
  const argsFile = path.join(dir, 'codex-args.json');
  const bin = path.join(dir, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const reply = fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8');
process.stdin.resume();
process.stdin.on('end', () => {
  if (reply === 'FAIL') { process.stderr.write('quota exceeded'); process.exit(1); }
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], reply);
});
`, { mode: 0o755 });
  await writeFile(replyFile, JSON.stringify(NEWS));
  Object.assign(config, {
    discordWebhookUrl: HOOK, stateFile: path.join(dir, 'state.json'), discordMessagesFile: path.join(dir, 'posts.jsonl'),
    codex: { bin, timeoutMs: 10_000, webSearch: true },
    news: { economyCount: 3, coinCount: 3, priorityCoins: ['BTC', 'ADA', 'ETH'] },
    schedule: { ...original.schedule, timeZone: 'Asia/Taipei' },
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});

  const calls = [];
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    assert.equal(url.hostname, 'discord.com');
    if (options.method === 'DELETE') {
      const id = url.pathname.split('/').at(-1);
      calls.push(`DELETE ${id}`);
      const status = deleteStatus[id] ?? 204;
      return status === 204 ? new Response(null, { status }) : new Response('{"code":10008}', { status });
    }
    posts++;
    const payload = JSON.parse(options.body);
    calls.push(`POST ${payload.content}`);
    if (posts === failPostAt) return new Response('{"code":50035}', { status: 400 });
    return new Response(JSON.stringify({ id: String(900 + posts), channel_id: '333' }));
  });
  return {
    calls,
    setReply: (text) => writeFile(replyFile, text),
    codexArgs: async () => JSON.parse(await readFile(argsFile, 'utf8')),
  };
}

test('預覽只搜尋並印出內容，不刪除、不發送、不寫紀錄', async (t) => {
  const { calls } = await setup(t);
  await saveDigestState(config.stateFile, { completedDate: '2026-11-17', messageIds: ['100'] });
  const before = await readFile(config.stateFile, 'utf8');
  const result = await runDaily({ dryRun: true, now: taipei('2026-11-18 08:00') });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(config.stateFile, 'utf8'), before);
});

test('第一次發送兩則訊息並記錄；同一天再執行略過，--force 先刪除目前的訊息再重發', async (t) => {
  const { calls, codexArgs } = await setup(t);
  const now = taipei('2026-11-18 08:00');
  assert.equal((await runDaily({ now })).status, 'sent');
  assert.deepEqual(calls, ['POST ## 🇺🇸 美國經濟新聞｜2026-11-18（週三）', 'POST ## 🪙 虛擬貨幣新聞｜2026-11-18（週三）']);
  assert.deepEqual(await loadDigestState(config.stateFile), { completedDate: '2026-11-18', messageIds: ['901', '902'] });
  const args = await codexArgs();
  assert.equal(args[args.indexOf('-c') + 1], 'web_search="live"');
  assert.ok(args.includes('--output-schema'));

  // 同一天（台灣時間 23:59）不重複發送，也不呼叫 Codex
  calls.length = 0;
  assert.equal((await runDaily({ now: taipei('2026-11-18 23:59') })).status, 'skipped');
  assert.deepEqual(calls, []);

  await runDaily({ now, force: true });
  assert.deepEqual(calls.slice(0, 2), ['DELETE 901', 'DELETE 902']);
  assert.equal(calls.length, 4);
  assert.deepEqual((await loadDigestState(config.stateFile)).messageIds, ['903', '904']);
});

test('隔天先刪除前一天的訊息再發送；已不存在（404）的訊息略過', async (t) => {
  const { calls } = await setup(t, { deleteStatus: { 100: 404 } });
  await saveDigestState(config.stateFile, { completedDate: '2026-11-17', messageIds: ['100', '101'] });
  await runDaily({ now: taipei('2026-11-18 08:00') });
  assert.deepEqual(calls.map((call) => call.split(' ')[0]), ['DELETE', 'DELETE', 'POST', 'POST']);
  assert.deepEqual(calls.slice(0, 2), ['DELETE 100', 'DELETE 101']);
  assert.deepEqual(await loadDigestState(config.stateFile), { completedDate: '2026-11-18', messageIds: ['901', '902'] });
  const records = await listPosts(config.discordMessagesFile);
  assert.equal(records.find((record) => record.messageId === '101').status, 'deleted');
  assert.equal(records.find((record) => record.messageId === '100'), undefined);
});

test('Codex 失敗或沒有新聞時，不刪除前一天的新聞', async (t) => {
  const { calls, setReply } = await setup(t);
  const state = { completedDate: '2026-11-17', messageIds: ['100'] };
  await saveDigestState(config.stateFile, state);
  await setReply('FAIL');
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /Codex CLI 執行失敗[\s\S]*quota exceeded/);
  await setReply('{"economy":[],"crypto":[]}');
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /沒有找到任何/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await loadDigestState(config.stateFile), state);
});

test('刪除失敗時不發送今天的新聞，紀錄只移除已刪除的訊息', async (t) => {
  const { calls } = await setup(t, { deleteStatus: { 101: 500 } });
  await saveDigestState(config.stateFile, { completedDate: '2026-11-17', messageIds: ['100', '101'] });
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /刪除前一次的新聞訊息 101 失敗，未發送今天的新聞/);
  assert.deepEqual(calls, ['DELETE 100', 'DELETE 101']);
  assert.deepEqual(await loadDigestState(config.stateFile), { completedDate: '2026-11-17', messageIds: ['101'] });
});

test('發送中途失敗時記錄已發出的訊息，重試會先刪除再完整重發', async (t) => {
  const { calls } = await setup(t, { failPostAt: 2 });
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /HTTP 400/);
  assert.deepEqual(await loadDigestState(config.stateFile), { completedDate: null, messageIds: ['901'] });

  calls.length = 0;
  await runDaily({ now: taipei('2026-11-18 08:30') });
  assert.deepEqual(calls.map((call) => call.split(' ')[0]), ['DELETE', 'POST', 'POST']);
  assert.equal(calls[0], 'DELETE 901');
  assert.deepEqual(await loadDigestState(config.stateFile), { completedDate: '2026-11-18', messageIds: ['903', '904'] });
});

test('沒有設定 Webhook 時正式執行拋錯，預覽不需要 Webhook', async (t) => {
  await setup(t);
  config.discordWebhookUrl = '';
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /CRYPTO_DISCORD_WEBHOOK_URL/);
  assert.equal((await runDaily({ dryRun: true, now: taipei('2026-11-18 08:00') })).status, 'dry-run');
});
