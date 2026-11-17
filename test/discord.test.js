import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscordMessages, buildDiscordPayload, buildShopMessages, toIsoTimestamp } from '../src/discord.js';

const announcement = {
  id: 'abc',
  url: 'https://artale.live/tw/news/abc',
  title: '11/17（二）Artale World 更新公告',
  category: '更新',
  publishedAt: '2026.11.17 08:13',
  thumbnail: 'https://cdn.example/thumb.webp',
  content: '內容',
};

test('發布時間以台灣時間轉成 ISO 格式', () => {
  assert.equal(toIsoTimestamp('2026.11.17 08:13'), '2026-11-17T00:13:00.000Z');
  assert.equal(toIsoTimestamp('2026.11.17'), '2026-11-16T16:00:00.000Z');
  assert.equal(toIsoTimestamp('未知'), undefined);
});

test('組出 Discord embed，並停用 @everyone 等提及', () => {
  const payload = buildDiscordPayload(announcement, '摘要內容', 'new');

  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  const [embed] = payload.embeds;
  assert.equal(embed.title, '【新公告】11/17（二）Artale World 更新公告');
  assert.equal(embed.url, announcement.url);
  assert.equal(embed.description, '摘要內容');
  assert.equal(embed.timestamp, '2026-11-17T00:13:00.000Z');
  assert.equal(embed.image, undefined);
});

test('公告更新使用不同標籤', () => {
  const [embed] = buildDiscordPayload(announcement, '摘要', 'updated').embeds;
  assert.match(embed.title, /^【公告更新】/);
});

test('過長的摘要會被截斷在 Discord 限制內', () => {
  const [embed] = buildDiscordPayload(announcement, '字'.repeat(5000), 'new').embeds;
  assert.equal(embed.description.length, 4096);
  assert.ok(embed.description.endsWith('…'));
});

const shopAnnouncement = {
  ...announcement, id: 'shop', url: 'https://artale.live/tw/news/shop',
  title: '11/17（二）Artale World 購物商場更新公告', category: '購物商場',
};
const product = (name, image = null, links = []) => ({ name, price: '4,000 WC', contents: ['突襲額外入場券', '凍結加持器'], image, links });

test('文字摘要使用單張卡片，購物商場資料使用多張卡片', () => {
  assert.equal(buildDiscordMessages(announcement, '摘要', 'new').length, 1);
  const messages = buildDiscordMessages(shopAnnouncement, { products: [product('通行證')], otherChanges: [] }, 'new');
  assert.equal(messages[0].embeds.length, 2);
});

test('更新與購物商場各自產生一則訊息，公告網址只放在標題', () => {
  const updateMessages = buildDiscordMessages(announcement, '版本更新內容', 'new');
  const shopMessages = buildDiscordMessages(shopAnnouncement, { products: [product('通行證')], otherChanges: [] }, 'new');
  const messages = [...updateMessages, ...shopMessages];
  assert.equal(messages.length, 2);
  assert.equal(messages[0].embeds[0].url, announcement.url);
  assert.equal(messages[1].embeds[0].url, shopAnnouncement.url);
  assert.ok(messages.every(({ embeds }) => embeds.every(e => !e.description?.includes('官網公告內文：'))));
  assert.ok(!JSON.stringify(messages[0]).includes(shopAnnouncement.url));
  assert.ok(!JSON.stringify(messages[1]).includes(announcement.url));
});

test('購物商場：每個商品先圖片卡片、再文字卡片，最後是其他異動', () => {
  const shop = {
    products: [
      { ...product('每週突襲重置獎勵通行證', 'https://cdn.example/pass.webp', [
        { text: '[前往說明頁面]', url: 'https://artale.live/tw/guide/pass' },
      ]),
        purchaseConditions: '角色等級 70 以上',
        purchaseLimit: '每帳號每週限購 1 次',
        salePeriod: '11/17 維護後～11/24 維護前',
      },
      product('角色養成禮包'),
    ],
    otherChanges: ['常駐禮包價格調整'],
  };
  const [message, ...rest] = buildShopMessages(shopAnnouncement, shop, 'new');
  assert.equal(rest.length, 0);
  assert.deepEqual(message.allowed_mentions, { parse: [] });

  const [header, passImage, passText, giftText, others] = message.embeds;
  assert.equal(header.title, '【新公告】11/17（二）Artale World 購物商場更新公告');
  assert.equal(header.description, undefined);
  assert.equal(header.image, undefined);
  assert.deepEqual(passImage.image, { url: 'https://cdn.example/pass.webp' });
  assert.equal(passImage.title, undefined);
  assert.equal(passText.title, '每週突襲重置獎勵通行證｜4,000 WC');
  assert.equal(
    passText.description,
    '內容物：突襲額外入場券、凍結加持器\n[前往說明頁面](https://artale.live/tw/guide/pass)\n購買條件：角色等級 70 以上\n可購買次數：每帳號每週限購 1 次\n販售時間：11/17 維護後～11/24 維護前',
  );
  assert.equal(giftText.title, '角色養成禮包｜4,000 WC');
  assert.equal(giftText.image, undefined);
  assert.equal(giftText.description, '內容物：突襲額外入場券、凍結加持器');
  assert.equal(others.title, '其他異動');
  assert.equal(others.description, '- 常駐禮包價格調整');
});

test('購物商場公告內容被修改時，公告卡片註明（公告已更新）', () => {
  const [message] = buildShopMessages(shopAnnouncement, { products: [product('通行證')], otherChanges: [] }, 'updated');
  assert.match(message.embeds[0].title, /^【公告更新】/);
  assert.equal(message.embeds[0].description, '（公告已更新）');
});

test('購物商場：購買資訊只顯示有內容的項目並放在連結後方', () => {
  const item = {
    ...product('禮包', null, [{ text: '說明', url: 'https://artale.live/tw/guide/pass' }]),
    purchaseConditions: ' ', purchaseLimit: '公告未註明', salePeriod: ' 11/17～11/24 ',
  };
  const [{ embeds }] = buildShopMessages(shopAnnouncement, { products: [item], otherChanges: [] }, 'new');
  assert.equal(embeds[1].description,
    '內容物：突襲額外入場券、凍結加持器\n[說明](https://artale.live/tw/guide/pass)\n販售時間：11/17～11/24');
});

test('購物商場：超過 10 張卡片時拆成多則訊息，且同一商品的圖片與文字不會被拆開', () => {
  const products = Array.from({ length: 8 }, (_, i) => product(`禮包${i + 1}`, `https://cdn.example/${i + 1}.webp`));
  const messages = buildShopMessages(shopAnnouncement, { products, otherChanges: [] }, 'new');

  // 公告卡片 1 張 + 每個商品 2 張：第一則可放 4 個商品（9 張），第二則放剩下 4 個商品（8 張）
  assert.deepEqual(
    messages.map((m) => m.embeds.length),
    [9, 8],
  );
  for (const { embeds } of messages) {
    assert.ok(embeds.length <= 10);
    embeds.forEach((embed, i) => {
      if (embed.image && !embed.title) assert.match(embeds[i + 1].title, /^禮包\d｜/);
    });
  }
  const sourceCount = messages.flatMap(({ embeds }) => embeds)
    .filter(({ description }) => description?.includes('官網公告內文：')).length;
  assert.equal(sourceCount, 0);
});

test('購物商場：文字總量超過 6000 字時也會拆成多則訊息', () => {
  // 每個商品的內文約 3000 字，3 個商品合計超過 6000 字
  const longContents = Array.from({ length: 600 }, (_, i) => `道具${i}`);
  const products = [1, 2, 3].map((i) => ({ ...product(`禮包${i}`), contents: longContents }));
  const messages = buildShopMessages(shopAnnouncement, { products, otherChanges: [] }, 'new');
  assert.equal(messages.length, 3);
  for (const { embeds } of messages) {
    const chars = embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0)
      + (e.footer?.text?.length ?? 0)
      + (e.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0), 0);
    assert.ok(chars <= 6000);
  }
});

test('購物商場：內容物過長時仍在卡片最後保留購買資訊', () => {
  const item = {
    ...product('禮包'), contents: ['道具'.repeat(3000)],
    purchaseConditions: '角色等級 70 以上',
    purchaseLimit: '每帳號每週限購 1 次',
    salePeriod: '11/17 維護後～11/24 維護前',
  };
  const [{ embeds }] = buildShopMessages(shopAnnouncement, { products: [item], otherChanges: [] }, 'new');
  const description = embeds[1].description;
  assert.ok(description.length <= 4096);
  assert.ok(description.endsWith('購買條件：角色等級 70 以上\n可購買次數：每帳號每週限購 1 次\n販售時間：11/17 維護後～11/24 維護前'));
});

test('購物商場只有其他異動時，截斷內文並保留標題連結', () => {
  const [{ embeds }] = buildShopMessages(shopAnnouncement, { products: [], otherChanges: ['調整'.repeat(3000)] }, 'updated');
  assert.equal(embeds.length, 2);
  assert.equal(embeds[1].description.length, 4096);
  assert.ok(embeds[1].description.endsWith('…'));
  assert.equal(embeds[0].url, shopAnnouncement.url);
});
