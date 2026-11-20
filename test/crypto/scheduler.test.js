import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const NEWS = {
  economy: [{ title: '聯準會維持利率', summary: '摘要', source: 'Reuters', url: 'https://example.com/fed', publishedAt: '' }],
  crypto: [{ title: '比特幣反彈', summary: '摘要', source: 'CoinDesk', url: 'https://example.com/btc', publishedAt: '', coins: ['BTC'] }],
};

/**
 * 以假的時間、Discord 與 Codex 執行常駐排程，發送 stopAfterPosts 則訊息後，在下一次等待時結束。
 * failFirstCodex：第一次呼叫 Codex 失敗，用來測試重試。
 */
async function runScheduler(t, { time, state, stopAfterPosts, failFirstCodex = false }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-crypto-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  if (state) await writeFile(stateFile, JSON.stringify(state));
  const bin = path.join(dir, 'fake-codex');
  const marker = path.join(dir, 'codex-called');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const first = !fs.existsSync(${JSON.stringify(marker)});
fs.appendFileSync(${JSON.stringify(marker)}, 'x');
process.stdin.resume();
process.stdin.on('end', () => {
  if (${failFirstCodex} && first) { process.stderr.write('temporary failure'); process.exit(1); }
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(NEWS))});
});
`, { mode: 0o755 });
  const preload = path.join(dir, 'preload.mjs');
  await writeFile(preload, `
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
const RealDate = Date;
let currentTime = RealDate.parse(${JSON.stringify(time)});
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [currentTime])); }
  static now() { return currentTime; }
};
const calls = [];
let posts = 0;
process.on('exit', () => console.log('ENTRY_RESULT=' + JSON.stringify({ calls })));
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  const at = new RealDate(currentTime).toISOString();
  if (options.method === 'DELETE') {
    calls.push({ at, action: 'DELETE ' + url.pathname.split('/').at(-1) });
    return new Response(null, { status: 204 });
  }
  posts++;
  calls.push({ at, action: 'POST' });
  return new Response(JSON.stringify({ id: String(900 + posts) }));
};
timers.setTimeout = async ms => {
  if (posts >= ${stopAfterPosts}) process.exit(0);
  currentTime += ms;
};
syncBuiltinESMExports();
`);
  const configFile = path.join(dir, 'crypto-config.js');
  await writeFile(configFile, `export default ${JSON.stringify({
    webhooks: [{ url: 'https://discord.com/api/webhooks/555/testToken' }],
    schedule: { days: '1-7', time: '08:00', timeZone: 'Asia/Taipei' },
    news: { priorityCoins: ['BTC', 'ADA', 'ETH'], economyCount: 3, coinCount: 3 },
    aiTimeoutMs: 10000,
    files: { state: stateFile, discordMessages: path.join(dir, 'posts.jsonl') },
  })};`);
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload,
    fileURLToPath(new URL('../../src/crypto/scheduler.js', import.meta.url))], {
    timeout: 20_000,
    env: { ...process.env, AI_PROVIDER: 'codex', CODEX_BIN: bin, CRYPTO_CONFIG_FILE: configFile },
  });
  const { calls } = JSON.parse(stdout.match(/ENTRY_RESULT=(.+)/)[1]);
  return { calls, stdout };
}

test('啟動時今天時間已過且尚未發送會立即補發，隔天 08:00 先刪除前一天的訊息再發送', async (t) => {
  const { calls, stdout } = await runScheduler(t, { time: '2026-11-18T10:00:00+08:00', stopAfterPosts: 4 });
  assert.match(stdout, /每天 08:00 執行一次（時區 Asia\/Taipei）/);
  assert.match(stdout, /下次發送時間：2026-11-19（週四）08:00/);
  assert.deepEqual(calls.map((call) => call.action), ['POST', 'POST', 'DELETE 901', 'DELETE 902', 'POST', 'POST']);
  assert.equal(calls[0].at, '2026-11-18T02:00:00.000Z');
  assert.equal(calls[2].at, '2026-11-19T00:00:00.000Z');
});

test('今天已發送過，重新啟動不會重發，等到隔天才發送', async (t) => {
  const { calls } = await runScheduler(t, {
    time: '2026-11-18T10:00:00+08:00', state: { completedDate: '2026-11-18', messageIds: ['800'] }, stopAfterPosts: 2,
  });
  assert.deepEqual(calls.map((call) => call.action), ['DELETE 800', 'POST', 'POST']);
  assert.equal(calls[0].at, '2026-11-19T00:00:00.000Z');
});

test('發送失敗時 30 分鐘後重試', async (t) => {
  const { calls, stdout } = await runScheduler(t, { time: '2026-11-18T08:00:00+08:00', stopAfterPosts: 2, failFirstCodex: true });
  assert.match(stdout, /30 分鐘後重試：2026-11-18（週三）08:30/);
  assert.deepEqual(calls.map((call) => call.action), ['POST', 'POST']);
  assert.equal(calls[0].at, '2026-11-18T00:30:00.000Z');
});
