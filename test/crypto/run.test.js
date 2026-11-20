import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../../src/crypto/config.js';
import { runDaily } from '../../src/crypto/run.js';
import { loadDigestState, saveDigestState } from '../../src/shared/digest-state.js';
import { listPosts } from '../../src/shared/posts.js';

const A = '555555555555555555';
const B = '666666666666666666';
const LABEL = { [A]: 'A', [B]: 'B' };
const taipei = (text) => new Date(`${text.replace(' ', 'T')}:00+08:00`);
const NEWS = {
  economy: [{ title: '聯準會維持利率', summary: '摘要', source: 'Reuters', url: 'https://example.com/fed', publishedAt: '2026-11-18 03:00' }],
  crypto: [{ title: '比特幣反彈', summary: '摘要', source: 'CoinDesk', url: 'https://example.com/btc', publishedAt: '2026-11-18 06:00', coins: ['BTC'] }],
};
const ECONOMY = (date) => `## 🇺🇸 美國經濟新聞｜${date}`;
const CRYPTO = (date) => `## 🪙 虛擬貨幣新聞｜${date}`;

/** 組出 config.targets 中的一個 Webhook；profile 為名稱與頭像變更提醒的設定。 */
const target = (webhookId, { name = '', profile = {} } = {}) => ({
  name, webhookId, url: `https://discord.com/api/webhooks/${webhookId}/token${LABEL[webhookId]}`,
  webhookProfile: { personaPrompt: '', avatarMessage: '', nameMessage: '', ...profile },
});
const entries = async () => (await loadDigestState(config.stateFile)).targets;

/**
 * 建立測試環境：假的 Codex CLI（回覆 reply.json 的內容，內容為 FAIL 時以結束碼 1 失敗）與假的 Discord。
 * 呼叫紀錄格式為「方法 Webhook代號 內容」，例如「POST A ## 🇺🇸 …」、「DELETE B 901」。
 * deleteStatus：依訊息 ID 指定刪除的 HTTP 狀態；failPostAt：第幾次新增失敗；failHooks：新增一律失敗的 Webhook。
 */
async function setup(t, { targets = [target(A)], deleteStatus = {}, failPostAt, failHooks = new Set(), profile } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-crypto-'));
  const original = { ...config };
  t.after(async () => { Object.assign(config, original); await rm(dir, { recursive: true, force: true }); });
  const replyFile = path.join(dir, 'reply.json');
  const argsFile = path.join(dir, 'codex-args.json');
  const countFile = path.join(dir, 'codex-count');
  const bin = path.join(dir, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
fs.appendFileSync(${JSON.stringify(countFile)}, 'x');
const reply = fs.readFileSync(${JSON.stringify(replyFile)}, 'utf8');
process.stdin.resume();
process.stdin.on('end', () => {
  if (reply === 'FAIL') { process.stderr.write('quota exceeded'); process.exit(1); }
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], reply);
});
`, { mode: 0o755 });
  await writeFile(replyFile, JSON.stringify(NEWS));
  Object.assign(config, {
    targets, stateFile: path.join(dir, 'state.json'), discordMessagesFile: path.join(dir, 'posts.jsonl'),
    ai: { provider: 'codex', bin, timeoutMs: 10_000, webSearch: true },
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
    const webhookId = url.pathname.match(/\/webhooks\/(\d+)\//)[1];
    const hook = LABEL[webhookId];
    if (options.method === 'GET') {
      calls.push(`GET ${hook}`);
      return new Response(JSON.stringify({ id: webhookId, ...profile }));
    }
    if (options.method === 'DELETE') {
      const id = url.pathname.split('/').at(-1);
      calls.push(`DELETE ${hook} ${id}`);
      const status = deleteStatus[id] ?? 204;
      return status === 204 ? new Response(null, { status }) : new Response('{"code":10008}', { status });
    }
    posts++;
    calls.push(`POST ${hook} ${JSON.parse(options.body).content}`);
    if (posts === failPostAt || failHooks.has(webhookId)) return new Response('{"code":10015}', { status: 404 });
    return new Response(JSON.stringify({ id: String(900 + posts), channel_id: '333' }));
  });
  return {
    calls,
    setReply: (text) => writeFile(replyFile, text),
    codexArgs: async () => JSON.parse(await readFile(argsFile, 'utf8')),
    codexCount: () => readFile(countFile, 'utf8').then((text) => text.length, () => 0),
  };
}

test('預覽只搜尋並印出內容，不刪除、不發送、不寫紀錄', async (t) => {
  const { calls } = await setup(t);
  await saveDigestState(config.stateFile, { targets: { [A]: { completedDate: '2026-11-17', messageIds: ['100'] } } });
  const before = await readFile(config.stateFile, 'utf8');
  const result = await runDaily({ dryRun: true, now: taipei('2026-11-18 08:00') });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.messages.length, 2);
  assert.deepEqual(calls, []);
  assert.equal(await readFile(config.stateFile, 'utf8'), before);
});

test('第一次發送兩則訊息並記錄；同一天再執行略過，--force 先刪除目前的訊息再重發', async (t) => {
  const { calls, codexArgs, codexCount } = await setup(t);
  const now = taipei('2026-11-18 08:00');
  assert.equal((await runDaily({ now })).status, 'sent');
  assert.deepEqual(calls, [`POST A ${ECONOMY('2026-11-18（週三）')}`, `POST A ${CRYPTO('2026-11-18（週三）')}`]);
  assert.deepEqual(await entries(), { [A]: { completedDate: '2026-11-18', messageIds: ['901', '902'] } });
  const args = await codexArgs();
  assert.equal(args[args.indexOf('-c') + 1], 'web_search="live"');
  assert.ok(args.includes('--output-schema'));

  // 同一天（台灣時間 23:59）不重複發送，也不呼叫 Codex
  calls.length = 0;
  assert.equal((await runDaily({ now: taipei('2026-11-18 23:59') })).status, 'skipped');
  assert.deepEqual(calls, []);
  assert.equal(await codexCount(), 1);

  await runDaily({ now, force: true });
  assert.deepEqual(calls.slice(0, 2), ['DELETE A 901', 'DELETE A 902']);
  assert.equal(calls.length, 4);
  assert.deepEqual((await entries())[A].messageIds, ['903', '904']);
});

test('隔天先刪除前一天的訊息再發送；已不存在（404）的訊息略過', async (t) => {
  const { calls } = await setup(t, { deleteStatus: { 100: 404 } });
  await saveDigestState(config.stateFile, { targets: { [A]: { completedDate: '2026-11-17', messageIds: ['100', '101'] } } });
  await runDaily({ now: taipei('2026-11-18 08:00') });
  assert.deepEqual(calls.map((call) => call.split(' ')[0]), ['DELETE', 'DELETE', 'POST', 'POST']);
  assert.deepEqual(calls.slice(0, 2), ['DELETE A 100', 'DELETE A 101']);
  assert.deepEqual(await entries(), { [A]: { completedDate: '2026-11-18', messageIds: ['901', '902'] } });
  const records = await listPosts(config.discordMessagesFile);
  assert.equal(records.find((record) => record.messageId === '101').status, 'deleted');
  assert.equal(records.find((record) => record.messageId === '100'), undefined);
});

test('Codex 失敗或沒有新聞時，不刪除前一天的新聞', async (t) => {
  const { calls, setReply } = await setup(t);
  const state = { targets: { [A]: { completedDate: '2026-11-17', messageIds: ['100'] } } };
  await saveDigestState(config.stateFile, state);
  await setReply('FAIL');
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /Codex CLI 執行失敗[\s\S]*quota exceeded/);
  await setReply('{"economy":[],"crypto":[]}');
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /沒有找到任何/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await entries(), state.targets);
});

test('刪除失敗時不發送今天的新聞，紀錄只移除已刪除的訊息', async (t) => {
  const { calls } = await setup(t, { deleteStatus: { 101: 500 } });
  await saveDigestState(config.stateFile, { targets: { [A]: { completedDate: '2026-11-17', messageIds: ['100', '101'] } } });
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /Webhook 555555555555555555 發送失敗/);
  assert.deepEqual(calls, ['DELETE A 100', 'DELETE A 101']);
  assert.deepEqual(await entries(), { [A]: { completedDate: '2026-11-17', messageIds: ['101'] } });
});

test('發送中途失敗時記錄已發出的訊息，重試會先刪除再完整重發', async (t) => {
  const { calls } = await setup(t, { failPostAt: 2 });
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /發送失敗/);
  assert.deepEqual(await entries(), { [A]: { completedDate: null, messageIds: ['901'] } });

  calls.length = 0;
  await runDaily({ now: taipei('2026-11-18 08:30') });
  assert.deepEqual(calls.map((call) => call.split(' ')[0]), ['DELETE', 'POST', 'POST']);
  assert.equal(calls[0], 'DELETE A 901');
  assert.deepEqual(await entries(), { [A]: { completedDate: '2026-11-18', messageIds: ['903', '904'] } });
});

test('多個 Webhook：新聞只搜尋一次，各自發送、各自記錄，隔天各自刪除自己前一天的訊息', async (t) => {
  const { calls, codexCount } = await setup(t, { targets: [target(A, { name: '自己' }), target(B, { name: '朋友' })] });
  await runDaily({ now: taipei('2026-11-18 08:00') });
  assert.equal(await codexCount(), 1);
  assert.deepEqual(calls.map((call) => call.split(' ').slice(0, 2).join(' ')), ['POST A', 'POST A', 'POST B', 'POST B']);
  assert.deepEqual(await entries(), {
    [A]: { completedDate: '2026-11-18', messageIds: ['901', '902'] },
    [B]: { completedDate: '2026-11-18', messageIds: ['903', '904'] },
  });

  calls.length = 0;
  await runDaily({ now: taipei('2026-11-19 08:00') });
  assert.equal(await codexCount(), 2);
  assert.deepEqual(calls.map((call) => call.split(' ').slice(0, 3).join(' ')), [
    'DELETE A 901', 'DELETE A 902', `POST A ##`, `POST A ##`, 'DELETE B 903', 'DELETE B 904', `POST B ##`, `POST B ##`,
  ]);
});

test('多個 Webhook：其中一個失敗不影響其他，重試時只處理尚未完成的 Webhook', async (t) => {
  const failHooks = new Set([B]);
  const { calls } = await setup(t, { targets: [target(A), target(B, { name: '朋友' })], failHooks });
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /朋友（666666666666666666） 發送失敗/);
  assert.deepEqual((await entries())[A], { completedDate: '2026-11-18', messageIds: ['901', '902'] });
  assert.equal((await entries())[B], undefined, '第一則就失敗，沒有任何已發出的訊息需要記錄');

  failHooks.clear();
  calls.length = 0;
  await runDaily({ now: taipei('2026-11-18 08:30') });
  assert.ok(calls.every((call) => call.split(' ')[1] === 'B'), '已完成的 Webhook 不重發');
  assert.equal((await entries())[B].completedDate, '2026-11-18');
});

test('舊版單一 Webhook 紀錄：依發文紀錄找出原本的 Webhook，轉成新格式後照常刪除', async (t) => {
  const { calls } = await setup(t, { targets: [target(A), target(B)] });
  await writeFile(config.stateFile, JSON.stringify({ completedDate: '2026-11-17', messageIds: ['100', '101'] }));
  await writeFile(config.discordMessagesFile, ['100', '101']
    .map((messageId) => JSON.stringify({ action: 'create', webhookId: B, messageId, at: '2026-11-17T00:00:00.000Z' })).join('\n'));
  await runDaily({ now: taipei('2026-11-18 08:00') });
  assert.deepEqual(calls.filter((call) => call.startsWith('DELETE')), ['DELETE B 100', 'DELETE B 101']);
  const saved = JSON.parse(await readFile(config.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['targets']);
  assert.deepEqual(saved.targets[B].completedDate, '2026-11-18');
});

test('舊版紀錄在發文紀錄中找不到時，歸給清單中的第一個 Webhook；同一天已完成則不重發', async (t) => {
  const { calls, codexCount } = await setup(t);
  await writeFile(config.stateFile, JSON.stringify({ completedDate: '2026-11-18', messageIds: ['100'] }));
  assert.equal((await runDaily({ now: taipei('2026-11-18 09:00') })).status, 'skipped');
  assert.deepEqual(calls, []);
  assert.equal(await codexCount(), 0);
  assert.deepEqual(JSON.parse(await readFile(config.stateFile, 'utf8')),
    { targets: { [A]: { completedDate: '2026-11-18', messageIds: ['100'] } } });
});

test('設定提醒文字時，先檢查 Webhook 名稱與頭像，變更提醒在新聞之前發送且之後不會被刪除', async (t) => {
  const profile = { name: 'Bot', avatar: 'a1' };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-crypto-profile-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const withProfile = target(A, { profile: { avatarMessage: '換頭像了', nameMessage: '改名為 {name}', profileFile: path.join(dir, 'a.json') } });
  const { calls } = await setup(t, { targets: [withProfile, target(B)], profile });
  await runDaily({ dryRun: true, now: taipei('2026-11-18 08:00') });
  assert.deepEqual(calls, [], '預覽不檢查 Webhook');

  await runDaily({ now: taipei('2026-11-18 08:00') });
  assert.deepEqual(calls.filter((call) => call.startsWith('GET')), ['GET A'], '沒有設定提醒的 Webhook 不檢查');

  // 隔天名稱與頭像都被更換：先發兩行提醒，再刪除前一天的新聞並發送
  Object.assign(profile, { name: 'New Bot', avatar: 'a2' });
  calls.length = 0;
  await runDaily({ now: taipei('2026-11-19 08:00') });
  assert.deepEqual(calls.slice(0, 6), ['GET A', 'POST A 換頭像了\n改名為 New Bot', 'DELETE A 901', 'DELETE A 902',
    `POST A ${ECONOMY('2026-11-19（週四）')}`, `POST A ${CRYPTO('2026-11-19（週四）')}`]);
  assert.deepEqual((await entries())[A].messageIds, ['906', '907']);
});

test('沒有設定 Webhook 時正式執行拋錯，預覽不需要 Webhook', async (t) => {
  await setup(t, { targets: [] });
  await assert.rejects(runDaily({ now: taipei('2026-11-18 08:00') }), /env\/crypto\.js 的 webhooks/);
  assert.equal((await runDaily({ dryRun: true, now: taipei('2026-11-18 08:00') })).status, 'dry-run');
});
