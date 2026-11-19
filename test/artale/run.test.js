import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../../src/artale/config.js';
import { listPosts } from '../../src/shared/posts.js';
import { runOnce } from '../../src/artale/run.js';
import { ContentParseError } from '../../src/artale/errors.js';
import { loadState, saveState, targetState } from '../../src/artale/state.js';

const target = (webhookId) => ({
  name: '', webhookId, url: `https://discord.com/api/webhooks/${webhookId}/testToken${webhookId}`,
  webhookProfile: { personaPrompt: '', avatarMessage: '', nameMessage: '' },
});
// 預設使用一個 Webhook（ID 111）；notified() 取得它的已通知版本
const notified = async (webhookId = '111') => targetState(await loadState(config.stateFile), webhookId).notified;

async function setup(t, category, summary, { failSecond = false, content = '公告內容', titles = {}, contents = {}, publishedTimes = {}, entries = {}, targets = [target('111')], failHooks = new Set() } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-run-'));
  const original = { ...config };
  t.after(async () => { Object.assign(config, original); await rm(dir, { recursive: true, force: true }); });
  const bin = path.join(dir, 'fake-codex');
  const countFile = path.join(dir, 'codex-count');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(countFile)}, 'x');
const replies = ${JSON.stringify(summary)};
const schemaIndex = args.indexOf('--output-schema');
const schema = schemaIndex >= 0 ? JSON.parse(fs.readFileSync(args[schemaIndex + 1], 'utf8')) : null;
const category = schema?.properties.periods ? 'maintenance' : schema?.properties.products ? 'bm' : 'update';
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], typeof replies === 'string' ? replies : replies[category]));
`, { mode: 0o755 });
  Object.assign(config, {
    newsCategories: Array.isArray(category) ? [...category] : [category], targets,
    stateFile: path.join(dir, 'state.json'), discordMessagesFile: path.join(dir, 'posts.jsonl'),
    codex: { bin, timeoutMs: 10_000 },
    schedule: { ...original.schedule, intervalMinutes: 60 },
  });
  t.mock.method(Date, 'now', () => Date.parse('2026-11-17T01:20:00Z'));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const posts = [];
  const hooks = [];
  const documents = new Map();
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'discord.com') {
      assert.equal(options.method, 'POST');
      const hook = url.pathname.match(/webhooks\/(\d+)\//)[1];
      posts.push(JSON.parse(options.body));
      hooks.push(hook);
      if ((failSecond && posts.length === 2) || failHooks.has(hook)) return new Response('{"code":50035}', { status: 400 });
      return new Response(JSON.stringify({ id: String(900000000000000000n + BigInt(posts.length)), channel_id: '333' }));
    }
    assert.equal(url.hostname, 'artale.live');
    if (url.pathname === '/tw/news') {
      const selected = url.searchParams.get('category');
      const id = Array.isArray(category) ? selected : 'latest';
      const articles = entries[selected] ?? [{ id }];
      const rows = articles.map(article => {
        documents.set(article.id, article);
        const title = article.title ?? titles[article.id] ?? (Array.isArray(category) ? `11/24（二）${article.id}公告` : '測試公告');
        const date = (article.publishedAt ?? publishedTimes[article.id] ?? '2026.11.17 08:30').slice(0, 10);
        return `<a class="row" href="/tw/news/${article.id}"><span class="tag">更新</span><span class="title">${title}</span><span class="date">${date}</span></a>`;
      }).join('');
      return new Response(rows);
    }
    assert.match(url.pathname, /^\/tw\/news\/[^/]+$/);
    const id = url.pathname.split('/').at(-1);
    const article = documents.get(id) ?? {};
    const doc = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: article.content ?? contents[id] ?? content }] }] } };
    const flight = `20:I[490575,[],"LexicalRenderer"]\n21:T1a2b,${JSON.stringify(doc)}9:["$","div",null,{}]\n`;
    const head = `<header class="article-head"><div class="article-meta"><span>${article.publishedAt ?? publishedTimes[id] ?? '2026.11.17 08:30'}</span></div></header>`;
    return new Response(`${head}<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`);
  });
  const codexCount = () => readFile(countFile, 'utf8').then((text) => text.length, () => 0);
  return { posts, hooks, codexCount };
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
  assert.equal((await notified()).length, 1);
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
  assert.equal((await notified()).length, 1);
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
  await saveState(config.stateFile, { targets: { 111: { notified: (await notified()).filter(version => version.id === 'maintenance') } } });
  posts.length = 0;
  const next = await runOnce();
  assert.equal(next.find(result => result.category === 'maintenance').status, 'unchanged');
  assert.deepEqual(posts.map(post => post.embeds[0].url), ['https://artale.live/tw/news/update', 'https://artale.live/tw/news/bm']);
});

test('版本更新發布較晚時只略過維護，強制重發也不發過期維護', async (t) => {
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies, {
    titles: { maintenance: '11/17（二）維護公告', update: '11/17（二）更新公告' },
    publishedTimes: { maintenance: '2026.11.17 08:25', update: '2026.11.17 08:40' },
  });
  const results = await runOnce({ force: true });
  assert.equal(results.find(result => result.category === 'maintenance').status, 'outdated');
  assert.deepEqual(posts.map(post => post.embeds[0].url), ['https://artale.live/tw/news/update', 'https://artale.live/tw/news/bm']);
  assert.ok((await notified()).every(version => version.id !== 'maintenance'));
  assert.ok((await listPosts(config.discordMessagesFile)).every(post => post.category !== 'maintenance'));
});

test('只檢查維護時也讀取版本更新作發布時間比對，但不發送版本更新公告', async (t) => {
  const titles = { maintenance: '11/17（二）維護公告', update: '11/17（二）更新公告' };
  const publishedTimes = { maintenance: '2026.11.17 08:30', update: '2026.11.16 15:59' };
  const { posts } = await setup(t, ['maintenance'], replies, { titles, publishedTimes });
  await runOnce();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].embeds[0].url, 'https://artale.live/tw/news/maintenance');
  publishedTimes.update = '2026.11.17 08:40';
  const [result] = await runOnce({ force: true });
  assert.equal(result.status, 'outdated');
  assert.equal(posts.length, 1);
});

test('同一天發布時也比較時分，不因維護標題日期較早而略過新維護公告', async (t) => {
  const publishedTimes = { maintenance: '2026.11.17 08:33', update: '2026.11.17 08:30' };
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies, {
    titles: { maintenance: '11/17 維護公告', update: '11/24 更新公告' }, publishedTimes,
  });
  const first = await runOnce();
  assert.equal(first.find(result => result.category === 'maintenance').status, 'sent');
  assert.equal(posts.length, 3);
  publishedTimes.update = '2026.11.17 08:34';
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

test('09:20 檢查 08:20～09:20 內三篇不同公告，依時間發送並逐篇去重及比對修改', async t => {
  const articles = [
    { id: 'future', publishedAt: '2026.11.17 09:21' },
    { id: 'third', publishedAt: '2026.11.17 09:10' },
    { id: 'second', publishedAt: '2026.11.17 08:45' },
    { id: 'first', publishedAt: '2026.11.17 08:20' },
    { id: 'before', publishedAt: '2026.11.17 08:19' },
  ];
  const { posts } = await setup(t, ['update'], replies, { entries: { update: articles } });
  const first = await runOnce();
  assert.deepEqual(first.map(item => item.announcement.id), ['first', 'second', 'third']);
  assert.deepEqual(posts.map(post => post.embeds[0].url.split('/').at(-1)), ['first', 'second', 'third']);
  assert.equal((await notified()).length, 3);
  assert.equal((await listPosts(config.discordMessagesFile)).length, 3);
  const again = await runOnce();
  assert.ok(again.every(item => item.status === 'unchanged'));
  assert.equal(posts.length, 3);
  articles.find(item => item.id === 'second').content = '修改後的版本內容';
  const changed = await runOnce();
  assert.equal(changed.find(item => item.announcement.id === 'second').status, 'sent');
  assert.equal(posts.length, 4);
  assert.match(posts.at(-1).embeds[0].title, /^【公告更新】/);
});

test('檢查範圍使用 ARTALE_CHECK_INTERVAL_MINUTES，不固定為 60 分鐘', async t => {
  const { posts } = await setup(t, ['update'], replies, { entries: { update: [
    { id: 'outside', publishedAt: '2026.11.17 08:49' },
    { id: 'start', publishedAt: '2026.11.17 08:50' },
    { id: 'end', publishedAt: '2026.11.17 09:20' },
  ] } });
  config.schedule.intervalMinutes = 30;
  await runOnce();
  assert.deepEqual(posts.map(post => post.embeds[0].url.split('/').at(-1)), ['start', 'end']);
});

test('區間內沒有公告時 force 也不回退發舊公告、不呼叫摘要或寫入紀錄', async t => {
  const { posts } = await setup(t, ['update'], replies, { entries: { update: [
    { id: 'old', publishedAt: '2026.11.17 08:19' },
    { id: 'future', publishedAt: '2026.11.17 09:21' },
  ] } });
  config.codex.bin = '/missing-codex';
  assert.deepEqual(await runOnce({ force: true }), []);
  assert.equal(posts.length, 0);
  await assert.rejects(access(config.stateFile), { code: 'ENOENT' });
  await assert.rejects(access(config.discordMessagesFile), { code: 'ENOENT' });
});

test('抓取耗時不會改變本輪範圍，所有公告以執行開始時間判斷', async t => {
  const { posts } = await setup(t, ['update'], replies, { entries: { update: [
    { id: 'first', publishedAt: '2026.11.17 08:30' },
    { id: 'second', publishedAt: '2026.11.17 09:10' },
    { id: 'future', publishedAt: '2026.11.17 09:21' },
  ] } });
  const fetchFixture = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    t.mock.method(Date, 'now', () => Date.parse('2026-11-17T02:20:00Z'));
    return fetchFixture(input, options);
  });
  await runOnce();
  assert.deepEqual(posts.map(post => post.embeds[0].url.split('/').at(-1)), ['first', 'second']);
});

test('各分類先套用篇數上限，再依維護、更新、商城順序發送', async t => {
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies, { entries: {
    maintenance: [{ id: 'maintenance-new', publishedAt: '2026.11.17 08:50' }, { id: 'maintenance-old', publishedAt: '2026.11.17 08:25' }],
    update: [{ id: 'update-new', publishedAt: '2026.11.17 08:40' }, { id: 'update-old', publishedAt: '2026.11.17 08:30' }],
    bm: [{ id: 'shop-new', publishedAt: '2026.11.17 09:10' }, { id: 'shop-old', publishedAt: '2026.11.17 08:20' }],
  } });
  const results = await runOnce();
  assert.ok(results.every(item => item.announcement.id !== 'maintenance-old'));
  assert.deepEqual(posts.map(post => post.embeds[0].url.split('/').at(-1)), [
    'maintenance-new', 'update-old', 'update-new', 'shop-new',
  ]);
});

test('同分類任一篇內容轉譯失敗時，整輪不發送其他已抓取的公告', async t => {
  const { posts } = await setup(t, ['bm', 'update'], replies, { entries: { update: [
    { id: 'good', publishedAt: '2026.11.17 08:30' }, { id: 'broken', publishedAt: '2026.11.17 09:00' },
  ] } });
  const fetchFixture = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (input, options) => new URL(input).pathname === '/tw/news/broken'
    ? new Response('<html>缺少正文</html>') : fetchFixture(input, options));
  await assert.rejects(runOnce(), ContentParseError);
  assert.equal(posts.length, 0);
  await assert.rejects(access(config.stateFile), { code: 'ENOENT' });
});

test('其中一篇發送失敗，其他篇仍處理，範圍內重試只補發未完成的公告', async t => {
  const { posts } = await setup(t, ['update'], replies, { failSecond: true, entries: { update: [
    { id: 'first', publishedAt: '2026.11.17 08:30' }, { id: 'second', publishedAt: '2026.11.17 08:40' },
    { id: 'third', publishedAt: '2026.11.17 08:50' },
  ] } });
  await assert.rejects(runOnce(), /分類檢查失敗/);
  assert.equal(posts.length, 3);
  assert.deepEqual((await notified()).map(item => item.id), ['third', 'first']);
  const retry = await runOnce();
  assert.deepEqual(retry.map(item => item.status), ['unchanged', 'sent', 'unchanged']);
  assert.equal(posts.length, 4);
  assert.equal(posts.at(-1).embeds[0].url, 'https://artale.live/tw/news/second');
});

test('啟動檢查包含第一頁舊公告，保留去重與修改比對並排除未來公告', async t => {
  const articles = [
    { id: 'future', publishedAt: '2026.11.17 09:21' },
    { id: 'current', publishedAt: '2026.11.17 08:40' },
    { id: 'old', publishedAt: '2026.11.16 08:00' },
  ];
  const { posts } = await setup(t, ['update'], replies, { entries: { update: articles } });
  const started = await runOnce({ startup: true });
  assert.deepEqual(started.map(item => item.announcement.id), ['old', 'current']);
  assert.equal(posts.length, 2);
  const restarted = await runOnce({ startup: true });
  assert.ok(restarted.every(item => item.status === 'unchanged'));
  assert.equal(posts.length, 2);
  articles.find(item => item.id === 'old').content = '舊公告內文修改';
  const scheduled = await runOnce();
  assert.deepEqual(scheduled.map(item => item.announcement.id), ['current']);
  assert.equal(posts.length, 2);
  await runOnce({ startup: true });
  assert.equal(posts.length, 3);
  assert.match(posts.at(-1).embeds[0].title, /^【公告更新】/);
});

test('啟動檢查即使 force 也維持維護判斷與各分類發送順序', async t => {
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies, {
    publishedTimes: { maintenance: '2026.11.16 07:00', update: '2026.11.16 08:00', bm: '2026.11.16 09:00' },
  });
  const results = await runOnce({ startup: true, force: true });
  assert.equal(results.find(item => item.category === 'maintenance').status, 'outdated');
  assert.deepEqual(posts.map(post => post.embeds[0].url), ['https://artale.live/tw/news/update', 'https://artale.live/tw/news/bm']);
});

test('啟動及區間 force 都只比對維護最新一篇、更新最新三篇與商城最新一篇', async t => {
  const { posts } = await setup(t, ['bm', 'update', 'maintenance'], replies, { entries: {
    maintenance: [{ id: 'maintenance-old', publishedAt: '2026.11.17 08:30' }, { id: 'maintenance-new', publishedAt: '2026.11.17 09:00' }],
    update: [
      { id: 'pinned-old', publishedAt: '2026.11.16 08:00' },
      { id: 'fourth', publishedAt: '2026.11.17 08:20' },
      { id: 'third', publishedAt: '2026.11.17 08:30' },
      { id: 'second', publishedAt: '2026.11.17 08:40' },
      { id: 'first', publishedAt: '2026.11.17 08:50' },
    ],
    bm: [{ id: 'shop-old', publishedAt: '2026.11.17 08:30' }, { id: 'shop-new', publishedAt: '2026.11.17 09:10' }],
  } });
  const expected = ['maintenance-new', 'third', 'second', 'first', 'shop-new'];
  const started = await runOnce({ startup: true });
  assert.deepEqual(started.map(item => item.announcement.id), expected);
  assert.deepEqual(posts.map(post => post.embeds[0].url.split('/').at(-1)), expected);
  posts.length = 0;
  const forcedWindow = await runOnce({ force: true });
  assert.deepEqual(forcedWindow.map(item => item.announcement.id), expected);
  assert.deepEqual(posts.map(post => post.embeds[0].url.split('/').at(-1)), expected);
  posts.length = 0;
  const again = await runOnce({ startup: true });
  assert.ok(again.every(item => item.status === 'unchanged'));
  assert.equal(posts.length, 0);
  assert.ok((await notified()).every(item => expected.includes(item.id)));
});

test('只比對最新維護，最新版本更新較晚時略過，不補發更舊維護', async t => {
  const { posts } = await setup(t, ['maintenance', 'update'], replies, { entries: {
    maintenance: [{ id: 'maintenance-old', publishedAt: '2026.11.17 08:30' }, { id: 'maintenance-new', publishedAt: '2026.11.17 08:50' }],
    update: [{ id: 'update', publishedAt: '2026.11.17 09:00' }],
  } });
  for (const startup of [true, false]) {
    const results = await runOnce({ startup, force: true });
    assert.deepEqual(results.filter(item => item.category === 'maintenance').map(item => [item.announcement.id, item.status]), [
      ['maintenance-new', 'outdated'],
    ]);
  }
  assert.ok(posts.every(post => post.embeds[0].url === 'https://artale.live/tw/news/update'));
});

test('最新維護已通知時不改發未通知的舊維護，只選維護也不發布參考更新', async t => {
  const { posts } = await setup(t, ['maintenance'], replies, { entries: {
    maintenance: [{ id: 'maintenance-old', publishedAt: '2026.11.17 08:30' }, { id: 'maintenance-new', publishedAt: '2026.11.17 08:50' }],
    update: [{ id: 'reference', publishedAt: '2026.11.16 15:59' }],
  } });
  await runOnce({ startup: true });
  const again = await runOnce({ startup: true });
  assert.deepEqual(again.map(item => [item.announcement.id, item.status]), [['maintenance-new', 'unchanged']]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].embeds[0].url, 'https://artale.live/tw/news/maintenance-new');
});

test('多個 Webhook：摘要只產生一次，各自發送並各自記錄已通知的版本', async t => {
  const { posts, hooks } = await setup(t, 'update', '- 更新項目', { targets: [target('111'), target('222')] });
  await runOnce();
  assert.deepEqual(hooks, ['111', '222']);
  assert.deepEqual(posts[0], posts[1]);
  assert.deepEqual((await notified('111')).map(item => item.id), ['latest']);
  assert.deepEqual((await notified('222')).map(item => item.id), ['latest']);
  assert.deepEqual((await listPosts(config.discordMessagesFile)).map(post => post.webhookId).sort(), ['111', '222']);
  assert.deepEqual((await runOnce()).map(result => result.status), ['unchanged']);
});

test('多個 Webhook：其中一個失敗不影響其他，重試時只補發給失敗的 Webhook', async t => {
  const failHooks = new Set(['222']);
  const { hooks } = await setup(t, 'update', '- 更新項目', { targets: [target('111'), target('222')], failHooks });
  await assert.rejects(runOnce(), /分類檢查失敗/);
  assert.equal((await notified('111')).length, 1);
  assert.equal((await notified('222')).length, 0);
  failHooks.clear();
  hooks.length = 0;
  await runOnce();
  assert.deepEqual(hooks, ['222'], '已成功的 Webhook 不重發');
  assert.equal((await notified('222')).length, 1);
});

test('各 Webhook 紀錄不同時仍只呼叫一次 Codex，共用同一份摘要，只依各自紀錄加上標籤與（公告已更新）', async t => {
  const { hooks, posts, codexCount } = await setup(t, 'update', '- 更新項目', { targets: [target('111'), target('222')] });
  await saveState(config.stateFile, { targets: { 111: { notified: [{ id: 'latest', hash: 'old-version', title: '測試公告' }] } } });
  await runOnce();
  assert.equal(await codexCount(), 1);
  assert.deepEqual(hooks, ['111', '222']);
  const [updated, fresh] = posts.map(post => post.embeds[0]);
  assert.match(updated.title, /^【公告更新】/, '111 收到過舊版本，標示為更新');
  assert.match(fresh.title, /^【新公告】/, '222 第一次收到，標示為新公告');
  assert.equal(updated.description, `（公告已更新）\n\n${fresh.description}`);
  assert.equal(fresh.description, '- 更新項目');
});

test('舊版單一 Webhook 紀錄套用到目前設定的每個 Webhook，轉成新格式後不重發', async t => {
  const { posts } = await setup(t, 'update', '- 更新項目');
  await runOnce();
  const versions = await notified('111');
  // 改寫成舊格式，並新增第二個 Webhook
  await writeFile(config.stateFile, JSON.stringify({ notified: versions }));
  config.targets = [target('111'), target('222')];
  posts.length = 0;
  assert.deepEqual((await runOnce()).map(result => result.status), ['unchanged']);
  assert.equal(posts.length, 0);
  const saved = JSON.parse(await readFile(config.stateFile, 'utf8'));
  assert.deepEqual(Object.keys(saved), ['targets']);
  assert.deepEqual(saved.targets, { 111: { notified: versions }, 222: { notified: versions } });
});
