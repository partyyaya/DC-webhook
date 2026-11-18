import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../src/config.js';
import { listPosts } from '../src/posts.js';
import { runOnce } from '../src/run.js';
import { loadState, saveState } from '../src/state.js';

async function setup(t, category, summary, { failSecond = false, content = '公告內容', titles = {}, contents = {}, publishedTimes = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-run-'));
  const original = { ...config };
  t.after(async () => { Object.assign(config, original); await rm(dir, { recursive: true, force: true }); });
  const bin = path.join(dir, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const replies = ${JSON.stringify(summary)};
const schemaIndex = args.indexOf('--output-schema');
const schema = schemaIndex >= 0 ? JSON.parse(fs.readFileSync(args[schemaIndex + 1], 'utf8')) : null;
const category = schema?.properties.periods ? 'maintenance' : schema?.properties.products ? 'bm' : 'update';
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], typeof replies === 'string' ? replies : replies[category]));
`, { mode: 0o755 });
  Object.assign(config, {
    newsCategories: Array.isArray(category) ? [...category] : [category], discordWebhookUrl: 'https://discord.com/api/webhooks/111/testToken',
    stateFile: path.join(dir, 'state.json'), discordMessagesFile: path.join(dir, 'posts.jsonl'),
    codex: { bin, timeoutMs: 10_000 },
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const posts = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'discord.com') {
      assert.equal(options.method, 'POST');
      posts.push(JSON.parse(options.body));
      if (failSecond && posts.length === 2) return new Response('{"code":50035}', { status: 400 });
      return new Response(JSON.stringify({ id: String(900000000000000000n + BigInt(posts.length)), channel_id: '333' }));
    }
    assert.equal(url.hostname, 'artale.live');
    if (url.pathname === '/tw/news') {
      const id = Array.isArray(category) ? url.searchParams.get('category') : 'latest';
      const title = titles[id] ?? (Array.isArray(category) ? `11/24（二）${id}公告` : '測試公告');
      return new Response(`<a class="row" href="/tw/news/${id}"><span class="tag">更新</span><span class="title">${title}</span><span class="date">2026.11.17</span></a>`);
    }
    assert.match(url.pathname, /^\/tw\/news\/(?:latest|update|maintenance|bm|event)$/);
    const id = url.pathname.split('/').at(-1);
    const doc = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: contents[id] ?? content }] }] } };
    const flight = `20:I[490575,[],"LexicalRenderer"]\n21:T1a2b,${JSON.stringify(doc)}9:["$","div",null,{}]\n`;
    const head = publishedTimes[id] ? `<header class="article-head"><div class="article-meta"><span>${publishedTimes[id]}</span></div></header>` : '';
    return new Response(`${head}<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`);
  });
  return { posts };
}

test('公告預覽不寫任何紀錄，正式發送保存訊息 ID，去重仍正常', async (t) => {
  const { posts } = await setup(t, 'update', '- 更新項目');
  await runOnce({ dryRun: true, force: true });
  assert.equal(posts.length, 0);
  await assert.rejects(access(config.discordMessagesFile), { code: 'ENOENT' });
  await assert.rejects(access(config.stateFile), { code: 'ENOENT' });
  await runOnce();
  const [record] = await listPosts(config.discordMessagesFile);
  assert.equal(record.messageId, '900000000000000001');
  assert.equal(record.announcementId, 'latest');
  assert.equal(record.category, 'update');
  assert.equal((await loadState(config.stateFile)).notified.length, 1);
  assert.equal(posts[0].embeds[0].url, 'https://artale.live/tw/news/latest');
  const [result] = await runOnce();
  assert.equal(result.status, 'unchanged');
  assert.equal(posts.length, 1);
});

test('商城拆分後中途發送失敗，已成功的訊息仍有可撤回的 ID，公告不標示完成', async (t) => {
  const products = Array.from({ length: 8 }, (_, i) => ({
    name: `禮包${i}`, price: '800 WC', contents: ['道具'], image: `https://cdn.example/${i}.png`, links: [],
    purchaseConditions: '', purchaseLimit: '', salePeriod: '',
  }));
  const { posts } = await setup(t, 'bm', JSON.stringify({ products, otherChanges: [] }), {
    failSecond: true, content: products.map(({ image }) => image).join(' '),
  });
  await assert.rejects(runOnce(), /分類檢查失敗/);
  assert.equal(posts.length, 2);
  const records = await listPosts(config.discordMessagesFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].messageId, '900000000000000001');
  assert.equal(records[0].category, 'bm');
  await assert.rejects(access(config.stateFile), { code: 'ENOENT' });
});

test('維護公告發布一則訊息，內文只有維護時間並記錄為 maintenance', async (t) => {
  const { posts } = await setup(t, 'maintenance', JSON.stringify({ periods: ['11/24 07:00～12:00（GMT+8）'] }), {
    content: '維護時間：11/24 07:00～12:00（GMT+8）。另有補償與遊戲更新項目。',
  });
  await runOnce();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].embeds[0].description, '維護時間：11/24 07:00～12:00（GMT+8）');
  assert.equal(posts[0].embeds[0].url, 'https://artale.live/tw/news/latest');
  assert.equal((await listPosts(config.discordMessagesFile))[0].category, 'maintenance');
  assert.equal((await loadState(config.stateFile)).notified.length, 1);
});

test('維護摘要失敗的預覽不顯示公告全文，正式模式不發送或記錄', async (t) => {
  const { posts } = await setup(t, 'maintenance', 'invalid', { content: '補償獎勵與更新項目不應顯示' });
  const [preview] = await runOnce({ dryRun: true, force: true });
  assert.equal(preview.messages[0].embeds[0].description, '維護時間：尚未取得（預覽模式）');
  await assert.rejects(runOnce(), /分類檢查失敗/);
  assert.equal(posts.length, 0);
  await assert.rejects(access(config.discordMessagesFile), { code: 'ENOENT' });
  await assert.rejects(access(config.stateFile), { code: 'ENOENT' });
});

const replies = {
  maintenance: JSON.stringify({ periods: ['11/24 07:00～12:00'] }),
  update: '- 版本更新項目',
  bm: JSON.stringify({ products: [{ name: '禮包', price: '800 WC', contents: ['道具'], image: null, links: [],
    purchaseConditions: '', purchaseLimit: '', salePeriod: '' }], otherChanges: [] }),
};

test('三個及兩個分類同時有更新時，依維護、版本更新、商城順序發送，未更新的分類略過', async (t) => {
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies);
  const results = await runOnce();
  assert.deepEqual(results.map(result => result.category), ['maintenance', 'update', 'bm']);
  assert.deepEqual(posts.map(post => post.embeds[0].url), [
    'https://artale.live/tw/news/maintenance', 'https://artale.live/tw/news/update', 'https://artale.live/tw/news/bm',
  ]);

  // 保留維護的版本紀錄，模擬這輪只有版本更新與商城有需通知的內容。
  const state = await loadState(config.stateFile);
  await saveState(config.stateFile, { notified: state.notified.filter(version => version.id === 'maintenance') });
  posts.length = 0;
  const next = await runOnce();
  assert.equal(next.find(result => result.category === 'maintenance').status, 'unchanged');
  assert.deepEqual(posts.map(post => post.embeds[0].url), ['https://artale.live/tw/news/update', 'https://artale.live/tw/news/bm']);
});

test('版本更新發布較晚時只略過維護，強制重發也不發過期維護', async (t) => {
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies, {
    titles: { maintenance: '11/17（二）維護公告', update: '11/17（二）更新公告' },
    publishedTimes: { maintenance: '2026.11.16 15:59', update: '2026.11.17 08:13' },
  });
  const results = await runOnce({ force: true });
  assert.equal(results.find(result => result.category === 'maintenance').status, 'outdated');
  assert.deepEqual(posts.map(post => post.embeds[0].url), ['https://artale.live/tw/news/update', 'https://artale.live/tw/news/bm']);
  assert.ok((await loadState(config.stateFile)).notified.every(version => version.id !== 'maintenance'));
  assert.ok((await listPosts(config.discordMessagesFile)).every(post => post.category !== 'maintenance'));
});

test('只檢查維護時也讀取版本更新作發布時間比對，但不發送版本更新公告', async (t) => {
  const titles = { maintenance: '11/17（二）維護公告', update: '11/17（二）更新公告' };
  const publishedTimes = { maintenance: '2026.11.17 07:00', update: '2026.11.16 15:59' };
  const { posts } = await setup(t, ['maintenance'], replies, { titles, publishedTimes });
  await runOnce();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].embeds[0].url, 'https://artale.live/tw/news/maintenance');
  publishedTimes.update = '2026.11.17 08:13';
  const [result] = await runOnce({ force: true });
  assert.equal(result.status, 'outdated');
  assert.equal(posts.length, 1);
});

test('同一天發布時也比較時分，不因維護標題日期較早而略過新維護公告', async (t) => {
  const publishedTimes = { maintenance: '2026.11.17 08:13', update: '2026.11.17 08:00' };
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies, {
    titles: { maintenance: '11/17 維護公告', update: '11/24 更新公告' }, publishedTimes,
  });
  const first = await runOnce();
  assert.equal(first.find(result => result.category === 'maintenance').status, 'sent');
  assert.equal(posts.length, 3);
  publishedTimes.update = '2026.11.17 08:14';
  posts.length = 0;
  const second = await runOnce({ force: true });
  assert.equal(second.find(result => result.category === 'maintenance').status, 'outdated');
  assert.deepEqual(posts.map(post => post.embeds[0].url), ['https://artale.live/tw/news/update', 'https://artale.live/tw/news/bm']);
});

test('版本更新來源讀取失敗時暫緩維護，商城仍可正常發布', async (t) => {
  const { posts } = await setup(t, ['maintenance', 'bm'], replies);
  const fetchFixture = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'artale.live' && url.searchParams.get('category') === 'update') {
      return new Response('暫時無法讀取', { status: 503 });
    }
    return fetchFixture(input, options);
  });
  await assert.rejects(runOnce(), /分類檢查失敗/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].embeds[0].url, 'https://artale.live/tw/news/bm');
});
