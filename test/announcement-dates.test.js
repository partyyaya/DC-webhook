import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublishedTime } from '../src/announcement-dates.js';

test('以官網台灣時間解析發布日期、時分與秒數', () => {
  assert.equal(getPublishedTime({ publishedAt: '2026.11.17 08:13' }), Date.parse('2026-11-17T00:13:00Z'));
  assert.equal(getPublishedTime({ publishedAt: '2026/11/17 08:13:05' }), Date.parse('2026-11-17T00:13:05Z'));
  assert.equal(getPublishedTime({ publishedAt: '2026-11-17 08:13:06' }), Date.parse('2026-11-17T00:13:06Z'));
});

test('依發布時間比較先後，不採用相同的標題日期或內文維護日', () => {
  const update = { title: '11/17（二）更新公告', publishedAt: '2026.11.17 08:13' };
  const maintenance = { title: '11/17（二）維護公告', publishedAt: '2026.11.16 15:59',
    content: '維護時間：11/17 08:00～10:30' };
  assert.ok(getPublishedTime(update) > getPublishedTime(maintenance));
  assert.equal(getPublishedTime({ title: '11/17 維護公告', content: '維護時間：11/17 08:00～10:30' }), undefined);
});

test('同一天發布仍比較時分秒，時間相同則相等', () => {
  const time = publishedAt => getPublishedTime({ publishedAt });
  assert.ok(time('2026.11.17 08:14') > time('2026.11.17 08:13'));
  assert.ok(time('2026.11.17 09:00') > time('2026.11.17 08:59'));
  assert.ok(time('2026.11.17 08:13:01') > time('2026.11.17 08:13'));
  assert.equal(time('2026.11.17 08:13:00'), time('2026.11.17 08:13'));
});

test('只有日期時視為台灣當日午夜，缺少 publishedAt 時使用列表日期', () => {
  assert.equal(getPublishedTime({ publishedAt: '2026.11.17' }), Date.parse('2026-11-16T16:00:00Z'));
  assert.equal(getPublishedTime({ date: '2026.11.17' }), Date.parse('2026-11-16T16:00:00Z'));
  assert.equal(getPublishedTime({ publishedAt: '2026.11.18 08:00', date: '2026.11.17' }), Date.parse('2026-11-18T00:00:00Z'));
});

test('無效、缺漏或格式錯誤的發布時間不會被當成有效時間', () => {
  for (const publishedAt of ['2026.02.30', '2026.13.01', '2026.00.01', '2026.11.00', '2026.11.17 24:00',
    '2026.11.17 08:60', '2026.11.17 08:00:60', '11/17', '無日期', 123, null]) {
    assert.equal(getPublishedTime({ publishedAt }), undefined);
  }
  assert.equal(getPublishedTime(), undefined);
});
