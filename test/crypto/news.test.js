import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscordMessages } from '../../src/crypto/format.js';
import { buildNewsPrompt, MAX_NEWS_COUNT, NEWS_SCHEMA, parseCoins, parseNews } from '../../src/crypto/news.js';

const DEFAULTS = { economyCount: 3, coinCount: 3, priorityCoins: ['BTC', 'ADA', 'ETH'] };
const item = (n, extra = {}) => ({
  title: `新聞${n}`, summary: `摘要${n}`, source: 'Reuters', url: `https://example.com/${n}`, publishedAt: '2026-11-18 07:30', ...extra,
});
const coin = (n, coins) => item(n, { coins });
const titles = (list) => list.map((n) => n.title);

test('解析優先幣種：順序保留、轉大寫、全名換成代號、重複只留第一次', () => {
  assert.deepEqual(parseCoins('BTC,ADA,ETH'), ['BTC', 'ADA', 'ETH']);
  assert.deepEqual(parseCoins(' eth , Cardano, btc, ETH '), ['ETH', 'ADA', 'BTC']);
  for (const invalid of ['', ' , ', 'BTC;ETH', 'B', 'BTC,比特幣']) {
    assert.throws(() => parseCoins(invalid), /news.priorityCoins 格式錯誤/);
  }
});

test('提示詞依設定寫入時間範圍、篇數與幣種優先順序；Schema 要求兩個分類', () => {
  const prompt = buildNewsPrompt({
    from: new Date('2026-11-17T08:00:00+08:00'), to: new Date('2026-11-18T08:00:00+08:00'), timeZone: 'Asia/Taipei',
    economyCount: 2, coinCount: 5, priorityCoins: ['ETH', 'BTC', 'PEPE'],
  });
  assert.match(prompt, /2026-11-17（週二）08:00 ～ 2026-11-18（週三）08:00（時區 Asia\/Taipei）/);
  assert.match(prompt, /美國經濟新聞，最重要的 2 則/);
  assert.match(prompt, /虛擬貨幣新聞，最多 5 則/);
  assert.match(prompt, /ETH、BTC、PEPE 每個幣種至少 1 則/);
  assert.match(prompt, /剩下的 2 個名額只放真正重要的新聞/);
  assert.doesNotMatch(prompt, /依優先順序只選前/);
  assert.match(prompt, / {2}1\. ETH（以太坊）\n {2}2\. BTC（比特幣）\n {2}3\. PEPE\n/);
  assert.deepEqual(NEWS_SCHEMA.required, ['economy', 'crypto']);
  assert.deepEqual(NEWS_SCHEMA.properties.crypto.items.required, ['title', 'summary', 'source', 'url', 'publishedAt', 'coins']);
});

test('篇數少於幣種數量時，提示詞要求依幣種順序只選前幾個；篇數等於幣種數量時沒有剩餘名額', () => {
  const base = { from: new Date(), to: new Date(), timeZone: 'Asia/Taipei', economyCount: 3, priorityCoins: ['BTC', 'ADA', 'ETH'] };
  const fewer = buildNewsPrompt({ ...base, coinCount: 2 });
  assert.match(fewer, /BTC、ADA 每個幣種至少 1 則/);
  assert.match(fewer, /依優先順序只選前 2 個幣種/);
  assert.doesNotMatch(fewer, /剩下的/);
  const equal = buildNewsPrompt({ ...base, coinCount: 3 });
  assert.match(equal, /BTC、ADA、ETH 每個幣種至少 1 則/);
  assert.doesNotMatch(equal, /剩下的|依優先順序只選前/);
});

test('虛擬貨幣新聞依優先幣種順序排列（BTC → ADA → ETH），其他幣種最後，再取設定篇數', () => {
  const news = parseNews(JSON.stringify({
    economy: [item(1), item(2), item(3), item(4)],
    crypto: [coin(11, ['SOL']), coin(12, ['ETH']), coin(13, []), coin(14, ['Cardano']), coin(15, ['btc'])],
  }), DEFAULTS);
  assert.deepEqual(titles(news.economy), ['新聞1', '新聞2', '新聞3']);
  assert.deepEqual(titles(news.crypto), ['新聞15', '新聞14', '新聞12']);
  assert.deepEqual(news.crypto.map((n) => n.coins), [['BTC'], ['ADA'], ['ETH']]);
});

test('同時涉及多個幣種時以最優先的幣種排序；清單外的幣種維持 Codex 的重要性順序', () => {
  const news = parseNews(JSON.stringify({
    economy: [],
    crypto: [coin(1, ['ETH']), coin(2, ['SOL', 'ETH', 'ADA']), coin(4, ['XRP']), coin(5, ['DOGE'])],
  }), { ...DEFAULTS, coinCount: 5 });
  assert.deepEqual(titles(news.crypto), ['新聞2', '新聞1', '新聞4', '新聞5']);
  assert.deepEqual(news.crypto[0].coins, ['SOL', 'ETH', 'ADA']);
});

test('每個優先幣種至少 1 則：即使 BTC 新聞較多，也保留 ADA、ETH 各 1 則', () => {
  const news = parseNews(JSON.stringify({
    economy: [],
    crypto: [coin(1, ['BTC']), coin(2, ['BTC']), coin(3, ['BTC']), coin(4, ['SOL']), coin(5, ['ETH']), coin(6, ['ADA'])],
  }), DEFAULTS);
  assert.deepEqual(titles(news.crypto), ['新聞1', '新聞6', '新聞5']);
});

test('篇數少於幣種數量時依幣種順序只取前幾個；前面的幣種沒有新聞才由下一個遞補', () => {
  const reply = (crypto) => JSON.stringify({ economy: [], crypto });
  const options = { ...DEFAULTS, coinCount: 2 };
  assert.deepEqual(titles(parseNews(reply([coin(1, ['ETH']), coin(2, ['ADA']), coin(3, ['BTC'])]), options).crypto), ['新聞3', '新聞2']);
  assert.deepEqual(titles(parseNews(reply([coin(1, ['ETH']), coin(3, ['BTC']), coin(4, ['SOL'])]), options).crypto), ['新聞3', '新聞1']);
});

test('篇數多於幣種數量時，各幣種 1 則之後依順序放入其他新聞，沒有就不補滿', () => {
  const reply = JSON.stringify({
    economy: [],
    crypto: [coin(1, ['BTC']), coin(2, ['SOL']), coin(3, ['BTC']), coin(4, ['ETH']), coin(5, []), coin(6, ['ADA']), coin(7, ['XRP'])],
  });
  // 5 則：BTC、ADA、ETH 各 1 則，剩下 2 個名額依排列順序放 BTC 的第 2 則與 SOL
  assert.deepEqual(titles(parseNews(reply, { ...DEFAULTS, coinCount: 5 }).crypto), ['新聞1', '新聞3', '新聞6', '新聞4', '新聞2']);
  // Codex 只回覆 3 則時不會補滿到 5 則
  const few = JSON.stringify({ economy: [], crypto: [coin(1, ['BTC']), coin(2, ['ADA']), coin(3, ['ETH'])] });
  assert.equal(parseNews(few, { ...DEFAULTS, coinCount: 5 }).crypto.length, 3);
});

test('優先幣種沒有以它為主的新聞時，改選有提到該幣種的新聞', () => {
  const news = parseNews(JSON.stringify({
    economy: [],
    crypto: [coin(1, ['BTC']), coin(2, ['BTC', 'ADA']), coin(3, ['SOL']), coin(4, ['ETH'])],
  }), DEFAULTS);
  assert.deepEqual(titles(news.crypto), ['新聞1', '新聞2', '新聞4']);
});

test('篇數與優先幣種依設定調整', () => {
  const reply = JSON.stringify({
    economy: [item(1), item(2), item(3)],
    crypto: [coin(11, ['BTC']), coin(12, ['SOL']), coin(13, ['ETH'])],
  });
  const news = parseNews(reply, { economyCount: 1, coinCount: 2, priorityCoins: ['SOL', 'ETH'] });
  assert.deepEqual(titles(news.economy), ['新聞1']);
  assert.deepEqual(titles(news.crypto), ['新聞12', '新聞13']);
});

test('捨棄沒有標題或網址無效的新聞，重複網址只保留第一次', () => {
  const news = parseNews(JSON.stringify({
    economy: [item(1, { title: '  ' }), item(2, { url: 'javascript:alert(1)' }), item(3, { url: '不是網址' }), item(4)],
    crypto: [coin(4, ['BTC']), coin(5, ['ETH'])],
  }), DEFAULTS);
  assert.deepEqual(titles(news.economy), ['新聞4']);
  assert.deepEqual(titles(news.crypto), ['新聞5']);
});

test('回覆不是 JSON、格式不符或完全沒有新聞時拋錯', () => {
  assert.throws(() => parseNews('不是 JSON', DEFAULTS), /不是有效的 JSON/);
  assert.throws(() => parseNews('{"economy":[]}', DEFAULTS), /格式不符/);
  assert.throws(() => parseNews('{"economy":[],"crypto":[]}', DEFAULTS), /沒有找到任何/);
  assert.throws(() => parseNews(JSON.stringify({ economy: [item(1, { url: '' })], crypto: [] }), DEFAULTS), /沒有找到任何/);
});

test('每個分類一則訊息，每篇新聞一張可點擊的卡片；沒有新聞的分類不發送', () => {
  const news = parseNews(JSON.stringify({ economy: [item(1, { source: '', publishedAt: '' })], crypto: [coin(2, ['BTC', 'ETH'])] }), DEFAULTS);
  const messages = buildDiscordMessages(news, { dateLabel: '2026-11-18（週三）' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, '## 🇺🇸 美國經濟新聞｜2026-11-18（週三）');
  assert.deepEqual(messages[0].embeds, [{ title: '1. 新聞1', url: 'https://example.com/1', color: 0x1f6feb, description: '摘要1' }]);
  assert.equal(messages[1].content, '## 🪙 虛擬貨幣新聞｜2026-11-18（週三）');
  assert.deepEqual(messages[1].embeds[0].footer, { text: 'BTC・ETH｜Reuters｜2026-11-18 07:30' });

  const cryptoOnly = buildDiscordMessages({ economy: [], crypto: news.crypto }, { dateLabel: '2026-11-18（週三）' });
  assert.equal(cryptoOnly.length, 1);
  assert.match(cryptoOnly[0].content, /虛擬貨幣/);
});

test('篇數上限 10 則且內容超長時，仍符合 Discord 每則訊息 10 張卡片、6000 字的限制', () => {
  const long = (n) => ({
    title: '標'.repeat(500), summary: '摘'.repeat(2000), source: '源'.repeat(200), url: `https://example.com/${n}`,
    publishedAt: '時'.repeat(100), coins: [`C${n}`, 'LONGCOINNAME'.repeat(10)],
  });
  const reply = JSON.stringify({
    economy: Array.from({ length: 12 }, (_, n) => long(n)),
    crypto: Array.from({ length: 12 }, (_, n) => long(n + 100)),
  });
  const news = parseNews(reply, { economyCount: MAX_NEWS_COUNT, coinCount: MAX_NEWS_COUNT, priorityCoins: ['BTC'] });
  for (const message of buildDiscordMessages(news, { dateLabel: '2026-11-18（週三）' })) {
    assert.equal(message.embeds.length, MAX_NEWS_COUNT);
    const chars = message.embeds.reduce((sum, embed) => sum + embed.title.length + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0), 0);
    assert.ok(chars <= 6000, `卡片文字總量 ${chars} 超過 6000`);
  }
});
