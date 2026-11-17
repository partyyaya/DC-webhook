import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSchedule,
  describeSchedule,
  formatInZone,
  isWithinSchedule,
  nextRunTime,
  parseDays,
  parseTime,
} from '../src/schedule.js';

const tuesday = (overrides = {}) =>
  createSchedule({ days: '2', start: '08:20', end: '17:20', intervalMinutes: 60, timeZone: 'Asia/Taipei', ...overrides });

// 台灣時間 → Date，例如 taipei('2026-11-17 08:20')
const taipei = (text) => new Date(`${text.replace(' ', 'T')}:00+08:00`);

test('解析星期設定：單一、範圍、逗號，7 與 0 都代表週日', () => {
  assert.deepEqual([...parseDays('2')], [2]);
  assert.deepEqual([...parseDays('1-5')], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseDays('2, 4')], [2, 4]);
  assert.deepEqual([...parseDays('7')], [0]);
  assert.deepEqual([...parseDays('0')], [0]);
  for (const invalid of ['', '8', '5-1', 'tue', '2;4']) {
    assert.throws(() => parseDays(invalid), /SCHEDULE_DAYS 格式錯誤/);
  }
});

test('解析 HH:MM 時間', () => {
  assert.equal(parseTime('08:20', 'X'), 500);
  assert.equal(parseTime('8:05', 'X'), 485);
  assert.equal(parseTime('23:59', 'X'), 1439);
  for (const invalid of ['24:00', '08:60', '0820', 'abc']) {
    assert.throws(() => parseTime(invalid, 'SCHEDULE_START'), /SCHEDULE_START 格式錯誤/);
  }
});

test('開始時間晚於結束時間、或時區無效時拋錯', () => {
  assert.throws(() => tuesday({ start: '18:00', end: '08:00' }), /不能晚於/);
  assert.throws(() => tuesday({ timeZone: 'Mars/Base' }), /不是有效的時區/);
});

test('預設排程：每週二 08:20～17:20 每小時一次', () => {
  const schedule = tuesday();
  assert.equal(describeSchedule(schedule), '每週二 08:20～17:20，每 60 分鐘檢查一次（時區 Asia/Taipei）');

  // 2026-11-17 是週二
  assert.equal(nextRunTime(taipei('2026-11-17 07:00'), schedule).getTime(), taipei('2026-11-17 08:20').getTime());
  assert.equal(nextRunTime(taipei('2026-11-17 08:20'), schedule).getTime(), taipei('2026-11-17 09:20').getTime());
  assert.equal(nextRunTime(taipei('2026-11-17 15:21'), schedule).getTime(), taipei('2026-11-17 16:20').getTime());
});

test('當天時段結束或不是排程星期時，排到下一個排程日', () => {
  const schedule = tuesday();
  assert.equal(nextRunTime(taipei('2026-11-17 17:20'), schedule).getTime(), taipei('2026-11-24 08:20').getTime());
  assert.equal(nextRunTime(taipei('2026-11-18 12:00'), schedule).getTime(), taipei('2026-11-24 08:20').getTime());
});

test('可以改成其他星期與間隔', () => {
  const weekdays = tuesday({ days: '1-5' });
  assert.equal(nextRunTime(taipei('2026-11-20 18:00'), weekdays).getTime(), taipei('2026-11-23 08:20').getTime());

  const sunday = tuesday({ days: '7' });
  assert.equal(nextRunTime(taipei('2026-11-17 12:00'), sunday).getTime(), taipei('2026-11-22 08:20').getTime());

  const every90 = tuesday({ intervalMinutes: 90 });
  assert.equal(nextRunTime(taipei('2026-11-17 16:00'), every90).getTime(), taipei('2026-11-17 17:20').getTime());
});

test('以設定的時區計算，包含日光節約時間的時區', () => {
  const utc = tuesday({ timeZone: 'UTC' });
  assert.equal(nextRunTime(new Date('2026-11-17T07:00:00Z'), utc).toISOString(), '2026-11-17T08:20:00.000Z');

  // 紐約 2026-03-08 開始日光節約：之前 08:20 = 13:20Z（UTC-5），之後 08:20 = 12:20Z（UTC-4）
  const newYork = tuesday({ days: '1-7', timeZone: 'America/New_York' });
  assert.equal(nextRunTime(new Date('2026-03-06T12:00:00Z'), newYork).toISOString(), '2026-03-06T13:20:00.000Z');
  assert.equal(nextRunTime(new Date('2026-03-09T11:00:00Z'), newYork).toISOString(), '2026-03-09T12:20:00.000Z');
});

test('判斷是否在排程時段內', () => {
  const schedule = tuesday();
  assert.equal(isWithinSchedule(taipei('2026-11-17 08:20'), schedule), true);
  assert.equal(isWithinSchedule(taipei('2026-11-17 12:00'), schedule), true);
  assert.equal(isWithinSchedule(taipei('2026-11-17 17:20'), schedule), true);
  assert.equal(isWithinSchedule(taipei('2026-11-17 08:19'), schedule), false);
  assert.equal(isWithinSchedule(taipei('2026-11-17 17:21'), schedule), false);
  assert.equal(isWithinSchedule(taipei('2026-11-18 12:00'), schedule), false);
});

test('以排程時區格式化時間', () => {
  assert.equal(formatInZone(taipei('2026-11-24 08:20'), 'Asia/Taipei'), '2026-11-24（週二）08:20');
});
