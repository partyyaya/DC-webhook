import assert from 'node:assert/strict';
import test from 'node:test';
import {
  categoryUrl,
  extractFlightPayload,
  newestCandidates,
  parseAnnouncementPage,
  parseCategories,
  parseNewsList,
} from '../src/artale.js';
import { ContentParseError } from '../src/errors.js';

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

test('置頂的舊公告不會被當成最新公告', () => {
  const items = parseNewsList(LIST_HTML, 'https://artale.live/tw/news');
  assert.deepEqual(
    newestCandidates(items).map((item) => item.id),
    ['newest'],
  );
});

test('同一天有多篇公告時全部列為候選', () => {
  const items = [
    { id: 'a', date: '2026.11.10' },
    { id: 'b', date: '2026.11.10' },
    { id: 'c', date: '2026.11.03' },
  ];
  assert.deepEqual(
    newestCandidates(items).map((item) => item.id),
    ['a', 'b'],
  );
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
