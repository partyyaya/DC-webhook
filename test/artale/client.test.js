import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categoryUrl,
  extractFlightPayload,
  fetchAnnouncementsInRange,
  parseAnnouncementPage,
  parseCategories,
  parseNewsList,
} from '../../src/artale/client.js';
import { ContentParseError } from '../../src/artale/errors.js';

// 斷言會拋出內容轉譯錯誤（ContentParseError），且訊息符合 pattern
const assertParseError = (fn, pattern) =>
  assert.throws(fn, (err) => err instanceof ContentParseError && pattern.test(err.message));

test('解析公告分類設定：去除空白、轉小寫、移除重複', () => {
  assert.deepEqual(parseCategories('update,bm'), ['update', 'bm']);
  assert.deepEqual(parseCategories(' Update , BM ,update'), ['update', 'bm']);
  assert.deepEqual(parseCategories('all'), ['all']);
});

test('不認得的分類或空白設定會拋錯並列出可用值', () => {
  assert.throws(() => parseCategories('update,shop'), /ARTALE_NEWS_CATEGORIES 設定錯誤[\s\S]*bm（購物商場）/);
  assert.throws(() => parseCategories(' , '), /ARTALE_NEWS_CATEGORIES 設定錯誤/);
});

test('組出分類列表網址，all 不帶分類參數', () => {
  assert.equal(categoryUrl('bm'), 'https://artale.live/tw/news?category=bm');
  assert.equal(categoryUrl('update'), 'https://artale.live/tw/news?category=update');
  assert.equal(categoryUrl('all'), 'https://artale.live/tw/news');
});

const PIN = '<span class="notice-pin" aria-label="置頂"><svg></svg><span>置頂</span></span>';
const row = (id, title, date, pinned = false) =>
  `<a href="/tw/news/${id}" class="row"><div class="notice-badges">${pinned ? PIN : ''}<span class="tag tag-update">更新</span></div><span class="title">${title}</span><span class="date">${date}</span></a>`;

const LIST_HTML = `<div class="filter-tabs"><a class="active" href="/tw/news?category=update">更新</a></div><div class="notice-list">${[
  row('pinnedold', '10/26（一）Artale World 事前預約登錄開跑', '2026.10.26', true),
  row('newest', '11/17（二）Artale World 更新公告 &amp; HotFix', '2026.11.17'),
  row('older', 'Tespia 營運結束及活動獎勵相關公告', '2026.11.16'),
].join('')}</div>`;

test('解析公告列表並略過非公告連結', () => {
  const items = parseNewsList(LIST_HTML, 'https://artale.live/tw/news?category=update');

  assert.deepEqual(
    items.map(({ id, url, title, date, category, pinned }) => ({ id, url, title, date, category, pinned })),
    [
      {
        id: 'pinnedold',
        url: 'https://artale.live/tw/news/pinnedold',
        title: '10/26（一）Artale World 事前預約登錄開跑',
        date: '2026.10.26',
        category: '更新',
        pinned: true,
      },
      {
        id: 'newest',
        url: 'https://artale.live/tw/news/newest',
        title: '11/17（二）Artale World 更新公告 & HotFix',
        date: '2026.11.17',
        category: '更新',
        pinned: false,
      },
      {
        id: 'older',
        url: 'https://artale.live/tw/news/older',
        title: 'Tespia 營運結束及活動獎勵相關公告',
        date: '2026.11.16',
        category: '更新',
        pinned: false,
      },
    ],
  );
});

test('列表解析不到任何公告時視為內容轉譯錯誤', () => {
  assertParseError(() => parseNewsList('<div class="notice-list"></div>', 'https://artale.live/tw/news'), /解析不到任何公告/);
});

test('列表有公告缺少日期或標題時視為內容轉譯錯誤', () => {
  const missingDate = `<div class="notice-list">${row('a', '標題', '')}</div>`;
  const badDate = `<div class="notice-list">${row('b', '標題', '11/17')}</div>`;
  const missingTitle = `<div class="notice-list">${row('c', '', '2026.11.17')}</div>`;
  for (const html of [missingDate, badDate, missingTitle]) {
    assertParseError(() => parseNewsList(html, 'https://artale.live/tw/news'), /缺少標題或日期格式不符/);
  }
});

function detailHtml(lexicalDoc, { publishedAt = '2026.11.17 08:13' } = {}) {
  const flight = `20:I[490575,[],"LexicalRenderer"]\n21:T1a2b,${typeof lexicalDoc === 'string' ? lexicalDoc : JSON.stringify(lexicalDoc)}9:["$","div",null,{}]\n`;
  const middle = Math.floor(flight.length / 2);
  const pushes = [flight.slice(0, middle), flight.slice(middle)]
    .map((chunk) => `<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`)
    .join('');
  return [
    '<main><article class="article"><header class="article-head"><div class="article-head-inner">',
    `<h1>11/17（二）Artale World 更新公告</h1><div class="article-meta"><span>${publishedAt}</span></div>`,
    '</div></header><div><img src="https://cdn.example/thumb.webp?a=1&amp;b=2" alt=""/></div>',
    '<div class="article-body"></div></article></main>',
    '<script>(self.__next_f=self.__next_f||[]).push([0])</script>',
    pushes,
  ].join('');
}

test('合併被拆成多段的 Next.js flight 資料', () => {
  const html = detailHtml({ root: { type: 'root', children: [] } });
  assert.match(extractFlightPayload(html), /^20:I\[490575/);
});

test('從內文頁解析標題、發布時間、縮圖與內文', () => {
  const html = detailHtml({
    root: {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'text', text: '含有 {大括號}、[中括號] 與 "引號" 的內容' }] },
        { type: 'heading', tag: 'h2', children: [{ type: 'text', text: '1. 多角色系統' }] },
      ],
    },
  });

  const announcement = parseAnnouncementPage(html, {
    id: 'newest',
    url: 'https://artale.live/tw/news/newest',
    title: '列表標題',
    date: '2026.11.17',
    category: '更新',
  });

  assert.equal(announcement.title, '11/17（二）Artale World 更新公告');
  assert.equal(announcement.publishedAt, '2026.11.17 08:13');
  assert.equal(announcement.thumbnail, 'https://cdn.example/thumb.webp?a=1&b=2');
  assert.equal(announcement.content, '含有 {大括號}、[中括號] 與 "引號" 的內容\n\n## 1. 多角色系統');
});

test('內文為空時視為內容轉譯錯誤，避免送出空摘要', () => {
  const html = detailHtml({ root: { type: 'root', children: [] } });
  assertParseError(() => parseAnnouncementPage(html, { id: 'empty' }), /解析不到內文/);
});

test('找不到內文資料、資料不完整或格式不符時視為內容轉譯錯誤', () => {
  const item = { id: 'x', title: '標題', date: '2026.11.17' };
  assertParseError(() => parseAnnouncementPage('<html><body>沒有資料</body></html>', item), /找不到公告內文資料/);
  assertParseError(() => parseAnnouncementPage(detailHtml('{"root":{"children":[{"type":"paragraph"'), item), /不完整/);
  assertParseError(() => parseAnnouncementPage(detailHtml({ root: { type: 'root', children: 'oops' } }), item), /格式不符/);
});

test('發布時間格式不符時視為內容轉譯錯誤', () => {
  const doc = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: '內容' }] }] } };
  const html = detailHtml(doc, { publishedAt: 'Nov 17, 2026' });
  assertParseError(() => parseAnnouncementPage(html, { id: 'x', title: '標題', date: '' }), /發布時間格式不符/);
});

const RANGE = {
  newsUrl: 'https://artale.live/tw/news?category=update', timeoutMs: 10_000,
  startTime: Date.parse('2026-11-17T08:20:00+08:00'), endTime: Date.parse('2026-11-17T09:20:00+08:00'),
};

function mockPages(t, pages, times) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    requests.push(url);
    assert.equal(url.hostname, 'artale.live');
    if (url.pathname === '/tw/news') {
      const page = Number(url.searchParams.get('page') || 1);
      assert.ok(pages[page], `不應請求第 ${page} 頁`);
      return new Response(pages[page]);
    }
    const id = url.pathname.split('/').at(-1);
    assert.ok(times[id], `不應讀取 ${id} 內文`);
    const doc = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: `公告 ${id}` }] }] } };
    return new Response(detailHtml(doc, { publishedAt: times[id] }));
  });
  return requests;
}

test('取得範圍內多篇公告，含起訖邊界並由舊到新排列，排除區間外與未來公告', async t => {
  const rows = ['future', 'end', 'middle', 'start', 'before'].map(id => row(id, id, '2026.11.17'));
  rows.unshift(row('old-pin', '置頂舊文', '2026.10.26', true));
  const requests = mockPages(t, { 1: rows.join('') }, {
    future: '2026.11.17 09:21', end: '2026.11.17 09:20', middle: '2026.11.17 08:50',
    start: '2026.11.17 08:20', before: '2026.11.17 08:19',
  });
  const { announcements } = await fetchAnnouncementsInRange(RANGE);
  assert.deepEqual(announcements.map(item => item.id), ['start', 'middle', 'end']);
  assert.ok(requests.every(url => !url.pathname.includes('old-pin')));
});

test('第一頁同篇公告僅讀一次，即使有下一頁連結也不跟隨', async t => {
  const requests = mockPages(t, {
    1: row('old-pin', '置頂舊文', '2026.10.26', true) + row('new', '新公告', '2026.11.17')
      + row('new', '重複公告', '2026.11.17', true) + row('earlier', '較早公告', '2026.11.17')
      + '<a href="/tw/news?category=update&amp;page=2">2</a>',
  }, { new: '2026.11.17 09:10', earlier: '2026.11.17 08:30' });
  const { announcements } = await fetchAnnouncementsInRange(RANGE);
  assert.deepEqual(announcements.map(item => item.id), ['earlier', 'new']);
  assert.equal(requests.filter(url => url.pathname === '/tw/news/new').length, 1);
  assert.equal(requests.filter(url => url.pathname === '/tw/news').length, 1);
});

test('跨午夜範圍可讀第一頁中前一天的公告，不讀日期外正文或第二頁', async t => {
  const requests = mockPages(t, {
    1: row('today', '今日公告', '2026.11.17') + row('last-night', '昨晚公告', '2026.11.16')
      + row('boundary', '起點公告', '2026.11.16') + row('older', '舊公告', '2026.11.15')
      + '<a href="?category=update&amp;page=2">2</a>',
  }, { today: '2026.11.17 00:30', 'last-night': '2026.11.16 23:59', boundary: '2026.11.16 23:30' });
  const { announcements } = await fetchAnnouncementsInRange({ ...RANGE,
    startTime: Date.parse('2026-11-16T23:30:00+08:00'), endTime: Date.parse('2026-11-17T00:30:00+08:00') });
  assert.deepEqual(announcements.map(item => item.id), ['boundary', 'last-night', 'today']);
  assert.equal(requests.filter(url => url.pathname === '/tw/news').length, 1);
});

test('需要維護比對時可額外讀取區間外最新版本公告，但不列入待發送公告', async t => {
  mockPages(t, { 1: row('reference', '版本公告', '2026.11.16') + row('old', '舊公告', '2026.11.15') }, {
    reference: '2026.11.16 15:59',
  });
  const result = await fetchAnnouncementsInRange({ ...RANGE, includeLatest: true });
  assert.deepEqual(result.announcements, []);
  assert.equal(result.latestAnnouncement.id, 'reference');
});

test('區間內沒有公告時回傳空陣列，不回退成最新舊公告', async t => {
  const requests = mockPages(t, { 1: LIST_HTML }, {});
  const result = await fetchAnnouncementsInRange({ ...RANGE,
    startTime: Date.parse('2026-11-18T08:20:00+08:00'), endTime: Date.parse('2026-11-18T09:20:00+08:00') });
  assert.deepEqual(result.announcements, []);
  assert.equal(requests.length, 1);
});

test('維護參考排除尚未發布的未來版本公告', async t => {
  mockPages(t, { 1: row('future', '未來公告', '2026.11.17') + row('current', '目前公告', '2026.11.17') }, {
    future: '2026.11.17 09:21', current: '2026.11.17 09:10',
  });
  const result = await fetchAnnouncementsInRange({ ...RANGE, includeLatest: true });
  assert.equal(result.latestAnnouncement.id, 'current');
  assert.deepEqual(result.announcements.map(item => item.id), ['current']);
});

test('最新三篇依發布時間決定，不把置頂舊文當成最新，也不補抓較舊日期', async t => {
  const requests = mockPages(t, { 1:
    row('pinned-old', '置頂舊文', '2026.10.26', true)
    + row('middle', '第二新', '2026.11.17') + row('third', '第三新', '2026.11.16')
    + row('latest', '最新', '2026.11.17') + row('older', '第四新', '2026.11.15')
    + '<a href="?category=update&amp;page=2">2</a>',
  }, { latest: '2026.11.17 09:10', middle: '2026.11.17 08:50', third: '2026.11.16 08:00' });
  const result = await fetchAnnouncementsInRange({ ...RANGE, startTime: 0, limit: 3, includeLatest: true });
  assert.deepEqual(result.announcements.map(item => item.id), ['third', 'middle', 'latest']);
  assert.equal(result.latestAnnouncement.id, 'latest');
  assert.ok(requests.every(url => !/\/(pinned-old|older)$/.test(url.pathname)));
  assert.equal(requests.filter(url => url.pathname === '/tw/news').length, 1);
});

test('同一天只取最新一篇，排除未來公告，不受列表排列影響', async t => {
  mockPages(t, { 1: ['old', 'future', 'latest', 'middle'].map(id => row(id, id, '2026.11.17')).join('') }, {
    old: '2026.11.17 08:30', future: '2026.11.17 09:21', latest: '2026.11.17 09:10', middle: '2026.11.17 08:50',
  });
  const result = await fetchAnnouncementsInRange({ ...RANGE, limit: 1, includeLatest: true });
  assert.deepEqual(result.announcements.map(item => item.id), ['latest']);
  assert.equal(result.latestAnnouncement.id, 'latest');
  const outside = await fetchAnnouncementsInRange({ ...RANGE, startTime: Date.parse('2026-11-17T09:15:00+08:00'), limit: 1, includeLatest: true });
  assert.deepEqual(outside.announcements, []);
  assert.equal(outside.latestAnnouncement.id, 'latest');
});
