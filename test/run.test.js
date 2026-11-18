import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { config } from '../src/config.js';
import { listPosts } from '../src/posts.js';
import { runOnce } from '../src/run.js';
import { loadState } from '../src/state.js';

async function setup(t, category, summary, { failSecond = false, content = '公告內容' } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-run-'));
  const original = { ...config };
  t.after(async () => { Object.assign(config, original); await rm(dir, { recursive: true, force: true }); });
  const bin = path.join(dir, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\nconst fs = require('node:fs');
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on('end', () => fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(summary)}));
`, { mode: 0o755 });
  Object.assign(config, {
    newsCategories: [category], discordWebhookUrl: 'https://discord.com/api/webhooks/111/testToken',
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
    if (url.pathname === '/tw/news') return new Response(`<a class="row" href="/tw/news/latest"><span class="tag">更新</span><span class="title">測試公告</span><span class="date">2026.11.17</span></a>`);
    assert.equal(url.pathname, '/tw/news/latest');
    const doc = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: content }] }] } };
    const flight = `20:I[490575,[],"LexicalRenderer"]\n21:T1a2b,${JSON.stringify(doc)}9:["$","div",null,{}]\n`;
    return new Response(`<script>self.__next_f.push(${JSON.stringify([1, flight])})</script>`);
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
