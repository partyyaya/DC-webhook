import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hashAnnouncement } from '../../src/artale/state.js';

// categories 為設定檔的 newsCategories；列表頁只有一篇 2026-11-16 的舊公告（已通知過、內容未變），不論分類都回覆同一份列表。
async function runEntry(t, { entry = 'index.js', args = [], time = '2026-11-17T09:20:00+08:00', stopAfter = 1, categories = ['update'] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const historyFile = path.join(dir, 'posts.jsonl');
  const title = '舊公告';
  const content = '舊公告內容';
  await writeFile(stateFile, JSON.stringify({ notified: [{ id: 'old', hash: hashAnnouncement({ title, content }) }] }));
  const doc = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: content }] }] } };
  const flight = `20:I[490575,[],"LexicalRenderer"]\n21:T1a2b,${JSON.stringify(doc)}9:["$","div",null,{}]\n`;
  const detail = `<header class="article-head"><h1>${title}</h1><div class="article-meta"><span>2026.11.16 08:00</span></div></header><script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`;
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
const pages = [];
const details = [];
const categories = [];
let discordRequests = 0;
process.on('exit', () => console.log('ENTRY_RESULT=' + JSON.stringify({ pages, details, categories, discordRequests })));
globalThis.fetch = async input => {
  const url = new URL(input);
  if (url.hostname === 'discord.com') { discordRequests++; throw new Error('測試不應呼叫 Discord'); }
  if (url.pathname === '/tw/news') {
    const page = Number(url.searchParams.get('page') || 1);
    categories.push(url.searchParams.get('category'));
    pages.push(page);
    if (page !== 1) throw new Error('不應讀取第二頁');
    return new Response('<a class="row" href="/tw/news/old"><span class="tag">更新</span><span class="title">舊公告</span><span class="date">2026.11.16</span></a><a href="?category=update&amp;page=2">2</a>');
  }
  details.push(url.pathname);
  return new Response(${JSON.stringify(detail)});
};
timers.setTimeout = async ms => {
  if (pages.length >= ${stopAfter}) process.exit(0);
  currentTime += ms;
};
syncBuiltinESMExports();
`);
  const configFile = path.join(dir, 'artale-config.js');
  await writeFile(configFile, `export default ${JSON.stringify({
    webhooks: [{ url: 'https://discord.com/api/webhooks/111/testToken' }],
    newsCategories: categories,
    schedule: { days: '2', start: '08:20', end: '17:20', intervalMinutes: 60, timeZone: 'Asia/Taipei' },
    files: { state: stateFile, discordMessages: historyFile },
  })};`);
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', preload,
    fileURLToPath(new URL(`../../src/artale/${entry}`, import.meta.url)), ...args], {
    timeout: 10_000,
    env: { ...process.env, ARTALE_CONFIG_FILE: configFile, AI_PROVIDER: 'codex', CODEX_BIN: '/missing-codex', AI_TIMEOUT_MS: '1000' },
  });
  const result = JSON.parse(stdout.match(/^ENTRY_RESULT=(.+)$/m)[1]);
  assert.equal(result.discordRequests, 0);
  await assert.rejects(access(historyFile), { code: 'ENOENT' });
  return result;
}

test('單次執行及預覽啟動時比對第一頁舊公告，既有版本不重發', async t => {
  for (const args of [[], ['--dry-run']]) {
    const result = await runEntry(t, { args });
    assert.deepEqual(result.pages, [1]);
    assert.deepEqual(result.details, ['/tw/news/old']);
  }
});

test('單次執行加 --category 時只處理指定分類，不修改設定檔；分類錯誤時明確失敗', async t => {
  assert.deepEqual((await runEntry(t, { args: ['--dry-run', '--force'] })).categories, ['update']);
  assert.deepEqual((await runEntry(t, { args: ['--dry-run', '--force', '--category', 'bm'] })).categories, ['bm']);
  await assert.rejects(runEntry(t, { args: ['--dry-run', '--category', 'shop'] }), (err) => {
    assert.match(err.stderr, /--category 設定錯誤：「shop」/);
    return true;
  });
});

test('單次執行加 --window 時，商城等其他分類維持區間檢查，不讀取區間外正文', async t => {
  const result = await runEntry(t, { args: ['--window'], categories: ['bm'] });
  assert.deepEqual(result.categories, ['bm']);
  assert.deepEqual(result.pages, [1]);
  assert.deepEqual(result.details, []);
});

test('單次執行加 --window 時，版本更新仍比對第一頁最新公告（不限制回溯分鐘數），內容未變不重發', async t => {
  const result = await runEntry(t, { args: ['--window'] });
  assert.deepEqual(result.pages, [1]);
  assert.deepEqual(result.details, ['/tw/news/old']);
});

test('排程在時段外啟動也立即檢查一次第一頁', async t => {
  const result = await runEntry(t, { entry: 'scheduler.js', time: '2026-11-18T09:20:00+08:00' });
  assert.deepEqual(result.pages, [1]);
  assert.deepEqual(result.details, ['/tw/news/old']);
});

test('排程在時段內只做一次啟動檢查，下一輪商城等其他分類恢復區間檢查且仍只讀第一頁', async t => {
  const result = await runEntry(t, { entry: 'scheduler.js', time: '2026-11-17T09:19:59+08:00', stopAfter: 2, categories: ['bm'] });
  assert.deepEqual(result.pages, [1, 1]);
  assert.deepEqual(result.details, ['/tw/news/old'], '只有啟動檢查讀取區間外的舊公告');
});

test('排程每一輪都比對版本更新第一頁最新公告，以偵測舊文更正，且仍只讀第一頁', async t => {
  const result = await runEntry(t, { entry: 'scheduler.js', time: '2026-11-17T09:19:59+08:00', stopAfter: 2 });
  assert.deepEqual(result.pages, [1, 1]);
  assert.deepEqual(result.details, ['/tw/news/old', '/tw/news/old'], '啟動檢查與下一輪都讀取舊公告比對內容');
});
