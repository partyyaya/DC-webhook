import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildDiscordMessages } from '../src/discord.js';
import {
  buildSummaryPrompt,
  parseMaintenanceSummary,
  parseShopSummary,
  previewShopSummary,
  SHOP_SCHEMA,
  summarizeWithCodex,
} from '../src/summarize.js';

const FAKE_CODEX = {
  ok: `
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.setEncoding('utf8').on('data', (chunk) => (input += chunk)).on('end', () => {
  const outputFile = args[args.indexOf('--output-last-message') + 1];
  const schemaIndex = args.indexOf('--output-schema');
  const schema = schemaIndex >= 0 ? JSON.parse(fs.readFileSync(args[schemaIndex + 1], 'utf8')) : null;
  fs.writeFileSync(outputFile, JSON.stringify({ args, input, schema }));
});`,
  fail: `process.stderr.write('not logged in'); process.exit(2);`,
  hang: `setTimeout(() => {}, 60_000);`,
};

let dir;
const bins = {};

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-codex-'));
  for (const [name, source] of Object.entries(FAKE_CODEX)) {
    bins[name] = path.join(dir, `codex-${name}`);
    await writeFile(bins[name], `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  }
});

after(() => rm(dir, { recursive: true, force: true }));

test('以 codex exec 非互動模式呼叫，提示詞從 stdin 傳入', async () => {
  const summary = await summarizeWithCodex('請摘要這篇公告', { bin: bins.ok, model: 'gpt-test', timeoutMs: 10_000 });
  const { args, input } = JSON.parse(summary);

  assert.equal(input, '請摘要這篇公告');
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-');
  for (const flag of ['--skip-git-repo-check', '--ephemeral', '--output-last-message']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-test');
});

test('指定 JSON Schema 時以 --output-schema 傳給 Codex', async () => {
  const reply = await summarizeWithCodex('整理商品', { bin: bins.ok, timeoutMs: 10_000, schema: SHOP_SCHEMA });
  const { args, schema } = JSON.parse(reply);
  assert.ok(args.includes('--output-schema'));
  assert.deepEqual(schema, SHOP_SCHEMA);
  assert.equal(args.at(-1), '-');
});

test('找不到 Codex CLI 時立即回報安裝方式', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    summarizeWithCodex('x', { bin: path.join(dir, 'missing-codex'), timeoutMs: 60_000 }),
    /找不到 Codex CLI/,
  );
  assert.ok(Date.now() - startedAt < 5_000);
});

test('Codex CLI 失敗時帶出錯誤訊息', async () => {
  await assert.rejects(summarizeWithCodex('x', { bin: bins.fail, timeoutMs: 10_000 }), /結束碼 2[\s\S]*not logged in/);
});

test('Codex CLI 逾時會被終止', async () => {
  await assert.rejects(summarizeWithCodex('x', { bin: bins.hang, timeoutMs: 300 }), /逾時/);
});

test('版本更新公告內容被修改時，提示詞會要求註明已更新（購物商場改由公告卡片註明）', () => {
  const announcement = { title: '公告', category: '更新', publishedAt: '2026.11.17 08:13', content: '內容' };
  assert.doesNotMatch(buildSummaryPrompt(announcement, 'new', 'update'), /修改後的版本/);
  assert.match(buildSummaryPrompt(announcement, 'updated', 'update'), /修改後的版本/);
  assert.doesNotMatch(buildSummaryPrompt(announcement, 'updated', 'bm'), /修改後的版本/);
});

test('版本更新公告：整理更新項目，每項 50 字以內並附連結', () => {
  const announcement = { title: '更新公告', category: '更新', publishedAt: '2026.11.17 08:13', content: '更新內容' };
  const prompt = buildSummaryPrompt(announcement, 'new', 'update');
  assert.match(prompt, /這次版本更新了什麼/);
  assert.match(prompt, /不超過 50 字/);
  assert.match(prompt, /每個更新項目之間空一行/);
  assert.match(prompt, /\[連結文字\]\(網址\)/);
  assert.doesNotMatch(prompt, /WC/);
  assert.match(prompt, /"""\n更新內容\n"""/);
});

test('維護公告只擷取維護時段，更新時也不在內文加入其他文字', () => {
  const announcement = { title: '維護公告', category: '維護', publishedAt: '2026.11.17 08:00', content: '維護及補償資訊' };
  const prompt = buildSummaryPrompt(announcement, 'updated', 'maintenance');
  assert.match(prompt, /periods：/);
  assert.match(prompt, /日期、開始時間、結束時間/);
  assert.match(prompt, /不要把公告發布時間/);
  assert.match(prompt, /補償/);
  assert.doesNotMatch(prompt, /這次版本更新了什麼|每個更新項目|（公告已更新）/);
});

test('維護摘要只輸出時間欄位，去除空白及重複時段', () => {
  assert.equal(parseMaintenanceSummary(JSON.stringify({
    periods: [' 11/24 07:00～12:00（GMT+8） ', '11/24 07:00～12:00（GMT+8）', '', '平台維護：11/24 06:00～07:00'],
    compensation: '不應顯示的補償內容',
  })), '維護時間：11/24 07:00～12:00（GMT+8）\n維護時間：平台維護：11/24 06:00～07:00');
  assert.equal(parseMaintenanceSummary('{"periods":[]}'), '維護時間：公告未註明');
});

test('維護摘要不是時間 JSON 格式時拋錯，不回傳完整公告', () => {
  assert.throws(() => parseMaintenanceSummary('維護公告全文'), /不是有效的 JSON/);
  for (const data of [null, {}, { periods: '時間' }, { periods: [123] }]) {
    assert.throws(() => parseMaintenanceSummary(JSON.stringify(data)), /格式不符/);
  }
});

test('購物商場公告：要求以 JSON 整理商品、WC 價格、內容物、圖片與連結', () => {
  const announcement = { title: '購物商場更新公告', category: '購物商場', publishedAt: '2026.11.17 08:12', content: '商品內容' };
  const prompt = buildSummaryPrompt(announcement, 'new', 'bm');
  assert.match(prompt, /需要多少 WC/);
  for (const field of ['products', 'name', 'price', 'contents', 'image', 'links', 'purchaseConditions', 'purchaseLimit', 'salePeriod', 'otherChanges']) {
    assert.match(prompt, new RegExp(`${field}：`));
  }
  assert.match(prompt, /原價 1,000 WC/);
  assert.match(prompt, /不要修改或自行編造/);
  assert.match(prompt, /不要以公告發布時間代替/);
  assert.match(prompt, /公告未註明時填空字串/);
  assert.match(prompt, /下架、刪除、移除、停止販售或結束販售的商品一律排除/);
  assert.match(prompt, /不要放入 products、otherChanges/);
  assert.match(prompt, /products 與 otherChanges 都填空陣列/);
  assert.match(prompt, /僅註明未來販售截止時間的商品保留/);
  assert.doesNotMatch(prompt, /這次版本更新了什麼/);
});

// 購物商場公告原文（節錄），用來測試網址核對與預覽擷取
const SHOP_CONTENT = [
  '## [商品列表]',
  '',
  '1. 每週突襲重置獎勵通行證',
  '',
  '## 1. 每週突襲重置獎勵通行證',
  '',
  '![](https://cdn.example/pass.webp)',
  '',
  '> 販售價格：4,000 WC',
  '',
  '[[前往通行證說明頁面](https://artale.live/tw/guide/pass)]',
  '',
  '## 2. 角色養成禮包',
  '',
  '> 販售價格：1,000 WC 800 WC（優惠20%）',
].join('\n');

test('解析 Codex 回覆的購物商場 JSON，並移除不在公告原文中的圖片與連結', () => {
  const reply = JSON.stringify({
    products: [
      {
        name: ' 每週突襲重置獎勵通行證 ',
        price: '4,000 WC',
        contents: ['突襲額外入場券', '凍結加持器', '突襲額外入場券', ''],
        purchaseConditions: ' 角色等級 70 以上 ',
        purchaseLimit: ' 每帳號每週限購 1 次，週二 00:00 重置 ',
        salePeriod: ' 11/17 維護後～11/24 維護前（UTC+8） ',
        image: 'https://cdn.example/pass.webp',
        links: [
          { text: '前往通行證說明頁面', url: 'https://artale.live/tw/guide/pass' },
          { text: '編造的連結', url: 'https://fake.example/page' },
        ],
      },
      { name: '角色養成禮包', price: '', contents: [], image: 'https://fake.example/made-up.webp', links: [] },
    ],
    otherChanges: ['常駐禮包價格調整'],
  });

  assert.deepEqual(parseShopSummary(reply, SHOP_CONTENT), {
    products: [
      {
        name: '每週突襲重置獎勵通行證',
        price: '4,000 WC',
        contents: ['突襲額外入場券', '凍結加持器'],
        purchaseConditions: '角色等級 70 以上',
        purchaseLimit: '每帳號每週限購 1 次，週二 00:00 重置',
        salePeriod: '11/17 維護後～11/24 維護前（UTC+8）',
        image: 'https://cdn.example/pass.webp',
        links: [{ text: '前往通行證說明頁面', url: 'https://artale.live/tw/guide/pass' }],
      },
      {
        name: '角色養成禮包', price: '價格未註明', contents: [], image: null, links: [],
        purchaseConditions: '', purchaseLimit: '', salePeriod: '',
      },
    ],
    otherChanges: ['常駐禮包價格調整'],
  });
});

test('Codex 回覆的購物商場資料格式不符時拋錯', () => {
  assert.throws(() => parseShopSummary('這不是 JSON', SHOP_CONTENT), /不是有效的 JSON/);
  assert.throws(() => parseShopSummary('{"items":[]}', SHOP_CONTENT), /格式不符/);
  assert.throws(() => parseShopSummary('{"products":[{"name":" "}],"otherChanges":[]}', SHOP_CONTENT), /沒有任何商品或異動/);
});

test('排除下架商品後沒有通知內容時，不產生任何 Discord 訊息', () => {
  const summary = parseShopSummary('{"products":[],"otherChanges":[]}', '## 商品刪除\n舊禮包已下架');
  assert.deepEqual(summary, { products: [], otherChanges: [] });
  assert.deepEqual(buildDiscordMessages({ title: '購物商場更新公告' }, summary, 'new'), []);
  assert.deepEqual(buildDiscordMessages({ title: '購物商場更新公告' }, summary, 'updated'), []);
});

test('購買資訊為空白、非文字或舊版未註明文字時留空', () => {
  const { products } = parseShopSummary(JSON.stringify({
    products: [
      { name: '禮包', purchaseConditions: '  ', purchaseLimit: 3, salePeriod: null },
      { name: '舊版禮包', purchaseConditions: ' 公告未註明 ', purchaseLimit: '公告未註明', salePeriod: '公告未註明' },
    ],
    otherChanges: [],
  }), SHOP_CONTENT);
  for (const product of products) {
    assert.equal(product.purchaseConditions, '');
    assert.equal(product.purchaseLimit, '');
    assert.equal(product.salePeriod, '');
  }
});

test('預覽模式從公告原文擷取商品名稱、價格、圖片與連結', () => {
  const { products } = previewShopSummary(SHOP_CONTENT);
  for (const product of products) {
    assert.equal(product.purchaseConditions, '');
    assert.equal(product.purchaseLimit, '');
    assert.equal(product.salePeriod, '');
  }
  assert.deepEqual(
    products.map(({ name, price, image, links }) => ({ name, price, image, links })),
    [
      {
        name: '每週突襲重置獎勵通行證',
        price: '4,000 WC',
        image: 'https://cdn.example/pass.webp',
        links: [{ text: '前往通行證說明頁面', url: 'https://artale.live/tw/guide/pass' }],
      },
      { name: '角色養成禮包', price: '1,000 WC 800 WC（優惠20%）', image: null, links: [] },
    ],
  );
});

test('預覽模式省略標示下架或刪除的商品，保留僅註明未來截止時間的商品', () => {
  const content = [
    '## 1. 期間限定禮包',
    '> 販售價格：800 WC',
    '> 11/24 維護前結束販售',
    '## 2. 商品下架',
    '舊禮包 A',
    '## 3. 商品刪除',
    '舊禮包 B',
    '## 4. 結束販售商品',
    '舊禮包 C',
  ].join('\n');
  const { products } = previewShopSummary(content);
  assert.deepEqual(products.map(({ name }) => name), ['期間限定禮包']);
  assert.deepEqual(previewShopSummary('## 1. 商品刪除\n舊禮包'), { products: [], otherChanges: [] });
});
