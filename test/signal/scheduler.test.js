import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const REPLY = { crypto: [{ symbol: 'BTC', action: 'wait', entry: 0, takeProfit: 0, stopLoss: 0, reason: '趨勢不明', note: '' }] };

/**
 * 以假的時間、行情、Discord 與 Codex 執行常駐排程，發送 stopAfterPosts 則訊息後，在下一次等待時結束。
 * 每次分析發送 2 則訊息（虛擬貨幣與免責聲明）。failFirstCodex：第一次呼叫 Codex 失敗。
 */
async function runScheduler(t, { time, stopAfterPosts, failFirstCodex = false }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-signal-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'fake-codex');
  const marker = path.join(dir, 'codex-called');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const first = !fs.existsSync(${JSON.stringify(marker)});
fs.appendFileSync(${JSON.stringify(marker)}, 'x');
process.stdin.resume();
process.stdin.on('end', () => {
  if (${failFirstCodex} && first) { process.stderr.write('temporary failure'); process.exit(1); }
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(REPLY))});
});
`, { mode: 0o755 });
  const preload = path.join(dir, 'preload.mjs');
  await writeFile(preload, `
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
const RealDate = Date;
const DAY = 86_400_000;
let currentTime = RealDate.parse(${JSON.stringify(time)});
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [currentTime])); }
  static now() { return currentTime; }
};
const calls = [];
let posts = 0;
process.on('exit', () => console.log('ENTRY_RESULT=' + JSON.stringify({ calls })));
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === 'api.binance.com') {
    // 到今天為止的 120 根日線（今天這根尚未收盤）
    const today = Math.floor(currentTime / DAY) * DAY;
    const rows = Array.from({ length: 120 }, (_, i) => {
      const open = today - (119 - i) * DAY;
      const close = 100 + Math.sin(i / 5) * 3;
      return [open, String(close), String(close + 1), String(close - 1), String(close), '10', open + DAY - 1, '0'];
    });
    return new Response(JSON.stringify(rows));
  }
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
  const configFile = path.join(dir, 'signal-config.js');
  await writeFile(configFile, `export default ${JSON.stringify({
    webhooks: [{ url: 'https://discord.com/api/webhooks/555/testToken' }],
    schedule: { days: '1-7', start: '08:05', end: '20:05', intervalMinutes: 240, timeZone: 'Asia/Taipei' },
    markets: { crypto: { symbols: ['BTC'] }, tw: { symbols: [] }, us: { symbols: [] } },
    aiTimeoutMs: 10000,
    files: { state: path.join(dir, 'state.json'), discordMessages: path.join(dir, 'posts.jsonl') },
  })};`);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', preload,
    fileURLToPath(new URL('../../src/signal/scheduler.js', import.meta.url))], {
    timeout: 20_000,
    env: { ...process.env, AI_PROVIDER: 'codex', CODEX_BIN: bin, SIGNAL_CONFIG_FILE: configFile },
  });
  const { calls } = JSON.parse(stdout.match(/ENTRY_RESULT=(.+)/)[1]);
  return { calls, stdout, stderr };
}

test('啟動時在時段內先分析一次，之後每隔設定的分鐘數先刪除前一次的訊息再發送', async (t) => {
  const { calls, stdout } = await runScheduler(t, { time: '2026-11-18T10:00:00+08:00', stopAfterPosts: 4 });
  assert.match(stdout, /每天 08:05～20:05，每 240 分鐘/);
  assert.match(stdout, /下次分析時間：2026-11-18（週三）12:05/);
  assert.deepEqual(calls.map((call) => call.action), ['POST', 'POST', 'DELETE 901', 'DELETE 902', 'POST', 'POST']);
  assert.equal(calls[0].at, '2026-11-18T02:00:00.000Z');
  assert.equal(calls[2].at, '2026-11-18T04:05:00.000Z');
});

test('啟動時在時段外不分析，等到開始時間', async (t) => {
  const { calls } = await runScheduler(t, { time: '2026-11-18T06:00:00+08:00', stopAfterPosts: 2 });
  assert.deepEqual(calls.map((call) => call.action), ['POST', 'POST']);
  assert.equal(calls[0].at, '2026-11-18T00:05:00.000Z');
});

test('執行失敗時等下一個排程時間再執行', async (t) => {
  const { calls, stderr } = await runScheduler(t, { time: '2026-11-18T10:00:00+08:00', stopAfterPosts: 2, failFirstCodex: true });
  assert.match(stderr, /執行失敗，等下一個排程時間再執行/);
  assert.deepEqual(calls.map((call) => call.action), ['POST', 'POST']);
  assert.equal(calls[0].at, '2026-11-18T04:05:00.000Z');
});
