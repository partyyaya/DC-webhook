import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiscordMessages } from '../../src/stock/format.js';
import { buildNewsPrompt, buildNewsSchema, MAX_NEWS_COUNT, parseNews, parseStockCodes } from '../../src/stock/news.js';

const DEFAULTS = { twStocks: ['2330', '2317', '2454'], usStocks: ['NVDA', 'AAPL', 'MSFT'], twCount: 3, usCount: 3 };
const RANGE = { from: new Date('2026-11-19T08:00:00+08:00'), to: new Date('2026-11-20T08:00:00+08:00'), timeZone: 'Asia/Taipei' };
const item = (n, stocks = [], extra = {}) => ({
  title: `新聞${n}`, summary: `摘要${n}`, source: '經濟日報', url: `https://example.com/${n}`, publishedAt: '2026-11-20 07:30', stocks, ...extra,
});
const titles = (list) => list.map((n) => n.title);
const reply = (data) => JSON.stringify(data);

test('解析台股代號：順序保留、去掉 .TW／.TWO、重複只留第一次，可以是空的', () => {
  assert.deepEqual(parseStockCodes('tw', ' 2330 , 0050,2330.TW, 00878, 6488.two,00679b,2881A '), ['2330', '0050', '00878', '6488', '00679B', '2881A']);
  assert.deepEqual(parseStockCodes('tw', ''), []);
  for (const invalid of ['TSMC', '233', '2330;2317', '台積電', '50']) {
    assert.throws(() => parseStockCodes('tw', invalid), /news\.twStocks 格式錯誤[\s\S]*0050/);
  }
});

test('解析美股代號：轉大寫、去掉 $、類別股統一用點號', () => {
  assert.deepEqual(parseStockCodes('us', 'aapl, $nvda, BRK-B, brk.b, msft'), ['AAPL', 'NVDA', 'BRK.B', 'MSFT']);
  assert.deepEqual(parseStockCodes('us', ''), []);
  for (const invalid of ['蘋果', 'TOOLONG', 'A1', 'AAPL;NVDA']) {
    assert.throws(() => parseStockCodes('us', invalid), /news\.usStocks 格式錯誤/);
  }
});

test('提示詞依設定寫入時間範圍、兩個市場的篇數與股票優先順序；Schema 要求兩個市場', () => {
  const prompt = buildNewsPrompt({ ...RANGE, ...DEFAULTS, usCount: 5, usStocks: ['NVDA', 'TSLA'] });
  assert.match(prompt, /2026-11-19（週四）08:00 ～ 2026-11-20（週五）08:00（時區 Asia\/Taipei）/);
  assert.match(prompt, /一、tw：台股新聞，最多 3 則/);
  assert.match(prompt, /二、us：美股新聞，最多 5 則/);
  assert.match(prompt, / {2}1\. 2330\n {2}2\. 2317\n {2}3\. 2454\n/);
  assert.match(prompt, /2330、2317、2454 每檔股票至少 1 則/);
  assert.match(prompt, /NVDA、TSLA 每檔股票至少 1 則/);
  assert.match(prompt, /剩下的 3 個名額只放真正重要的新聞，可以是上列股票的第 2 則，或其他個股、美股大盤的新聞/);
  assert.match(prompt, /tw 與 us 之間也不要重複/);
  const schema = buildNewsSchema(DEFAULTS);
  assert.deepEqual(schema.required, ['tw', 'us']);
  assert.deepEqual(schema.properties.tw.items.required, ['title', 'summary', 'source', 'url', 'publishedAt', 'stocks']);
});

test('篇數少於股票數量時只選前幾檔；股票清單為空時改選市場最重要的新聞', () => {
  const fewer = buildNewsPrompt({ ...RANGE, ...DEFAULTS, twCount: 2 });
  assert.match(fewer, /2330、2317 每檔股票至少 1 則/);
  assert.match(fewer, /依優先順序只選前 2 檔股票/);
  const empty = buildNewsPrompt({ ...RANGE, ...DEFAULTS, usStocks: [] });
  assert.match(empty, /二、us：美股新聞，最多 3 則\n- 選出最重要的美股新聞，例如道瓊/);
  assert.doesNotMatch(empty.slice(empty.indexOf('二、us'), empty.indexOf('每則新聞的欄位')), /優先順序|每檔股票至少/);
});

test('篇數設為 0 的市場不搜尋：提示詞與 Schema 都不包含該市場', () => {
  const usOnly = { ...DEFAULTS, twCount: 0 };
  const prompt = buildNewsPrompt({ ...RANGE, ...usOnly });
  assert.doesNotMatch(prompt, /台股|tw：|2330/);
  assert.match(prompt, /一、us：美股新聞，最多 3 則/);
  assert.doesNotMatch(prompt, /之間也不要重複/);
  assert.deepEqual(buildNewsSchema(usOnly), { ...buildNewsSchema(DEFAULTS), properties: { us: buildNewsSchema(DEFAULTS).properties.us }, required: ['us'] });
  assert.deepEqual(buildNewsSchema({ ...DEFAULTS, usCount: 0 }).required, ['tw']);
});

test('每個市場依股票清單順序挑選：每檔先選 1 則，代號統一格式，清單外的排最後', () => {
  const news = parseNews(reply({
    tw: [item(1, ['2454']), item(2, ['2330.TW']), item(3, []), item(4, ['2317']), item(5, ['2330'])],
    us: [item(11, ['tsla']), item(12, ['AAPL', 'NVDA']), item(13, ['MSFT']), item(14, ['NVDA'])],
  }), DEFAULTS);
  assert.deepEqual(titles(news.tw), ['新聞2', '新聞4', '新聞1']);
  assert.deepEqual(news.tw[0].stocks, ['2330']);
  // 同時涉及 AAPL 與 NVDA 的新聞算作 NVDA（較優先）；NVDA 有了之後，AAPL 改選有提到它的新聞
  assert.deepEqual(titles(news.us), ['新聞12', '新聞14', '新聞13']);
});

test('股票清單為空時依 AI 的重要性順序取前幾則；篇數多於股票時剩餘名額依序補上', () => {
  const news = parseNews(reply({
    tw: [item(1), item(2, ['2603']), item(3), item(4)],
    us: [item(11, ['NVDA']), item(12, ['NVDA']), item(13, ['TSLA'])],
  }), { twStocks: [], usStocks: ['NVDA'], twCount: 2, usCount: 5 });
  assert.deepEqual(titles(news.tw), ['新聞1', '新聞2']);
  assert.deepEqual(titles(news.us), ['新聞11', '新聞12', '新聞13']);
});

test('篇數為 0 的市場即使 AI 有回覆也不採用，也不要求回覆該市場', () => {
  const usOnly = { ...DEFAULTS, twCount: 0 };
  assert.deepEqual(parseNews(reply({ us: [item(1, ['NVDA'])] }), usOnly).tw, []);
  const news = parseNews(reply({ tw: [item(1, ['2330'])], us: [item(2, ['NVDA'])] }), usOnly);
  assert.deepEqual(news.tw, []);
  assert.deepEqual(titles(news.us), ['新聞2']);
});

test('捨棄沒有標題或網址無效的新聞，兩個市場重複的網址只保留第一次', () => {
  const news = parseNews(reply({
    tw: [item(1, ['2330'], { title: ' ' }), item(2, ['2330'], { url: 'javascript:alert(1)' }), item(3, ['2330'])],
    us: [item(3, ['NVDA']), item(4, ['NVDA'])],
  }), DEFAULTS);
  assert.deepEqual(titles(news.tw), ['新聞3']);
  assert.deepEqual(titles(news.us), ['新聞4']);
});

test('回覆不是 JSON、缺少需要的市場或完全沒有新聞時拋錯', () => {
  assert.throws(() => parseNews('不是 JSON', DEFAULTS), /不是有效的 JSON/);
  assert.throws(() => parseNews(reply({ tw: [] }), DEFAULTS), /格式不符/);
  assert.throws(() => parseNews(reply({ tw: [], us: [] }), DEFAULTS), /沒有找到任何/);
  assert.throws(() => parseNews(reply({ us: [] }), { ...DEFAULTS, twCount: 0 }), /沒有找到任何/);
});

test('每個市場一則訊息，卡片底部顯示股票代號；沒有新聞的市場不發送', () => {
  const news = parseNews(reply({ tw: [item(1, ['2330', '2317'])], us: [item(2, [], { source: '', publishedAt: '' })] }), DEFAULTS);
  const messages = buildDiscordMessages(news, { dateLabel: '2026-11-20（週五）' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, '# 股票新聞｜2026-11-20（週五）\n\n## 🇹🇼 台股新聞');
  assert.deepEqual(messages[0].embeds[0], {
    title: '1. 新聞1', url: 'https://example.com/1', color: 0xe63946, description: '摘要1', footer: { text: '2330・2317｜經濟日報｜2026-11-20 07:30' },
  });
  assert.equal(messages[1].content, '## 🇺🇸 美股新聞');
  assert.deepEqual(messages[1].embeds[0], { title: '1. 新聞2', url: 'https://example.com/2', color: 0x1f6feb, description: '摘要2' });

  const usOnly = buildDiscordMessages({ tw: [], us: news.us }, { dateLabel: '2026-11-20（週五）' });
  assert.equal(usOnly.length, 1);
  assert.equal(usOnly[0].content, '# 股票新聞｜2026-11-20（週五）\n\n## 🇺🇸 美股新聞');
  assert.deepEqual(buildDiscordMessages({ tw: [], us: [] }, { dateLabel: '2026-11-20（週五）' }), []);
});

test('篇數上限 10 則且內容超長時，仍符合 Discord 每則訊息 10 張卡片、6000 字的限制', () => {
  const long = (n) => ({
    title: '標'.repeat(500), summary: '摘'.repeat(2000), source: '源'.repeat(200), url: `https://example.com/${n}`,
    publishedAt: '時'.repeat(100), stocks: [`${1000 + n}`, 'LONGCODE'.repeat(10)],
  });
  const news = parseNews(reply({
    tw: Array.from({ length: 12 }, (_, n) => long(n)),
    us: Array.from({ length: 12 }, (_, n) => long(n + 100)),
  }), { twStocks: [], usStocks: [], twCount: MAX_NEWS_COUNT, usCount: MAX_NEWS_COUNT });
  for (const message of buildDiscordMessages(news, { dateLabel: '2026-11-20（週五）' })) {
    assert.equal(message.embeds.length, MAX_NEWS_COUNT);
    const chars = message.embeds.reduce((sum, embed) => sum + embed.title.length + (embed.description?.length ?? 0) + (embed.footer?.text.length ?? 0), 0);
    assert.ok(chars <= 6000, `卡片文字總量 ${chars} 超過 6000`);
  }
});
