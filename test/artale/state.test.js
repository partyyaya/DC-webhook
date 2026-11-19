import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectChange, hashAnnouncement, loadState, recordNotified, saveState, targetState, withTargetState } from '../../src/artale/state.js';

const sent = (id, hash) => ({ id, hash, title: id, notifiedAt: '2026-11-17T00:00:00.000Z' });

test('雜湊值只跟標題與內文有關', () => {
  const base = { id: 'a', title: '公告', content: '內容', publishedAt: '2026.11.17 08:13' };
  assert.equal(hashAnnouncement(base), hashAnnouncement({ ...base, publishedAt: '2026.11.18 09:00' }));
  assert.notEqual(hashAnnouncement(base), hashAnnouncement({ ...base, content: '內容（修正）' }));
});

test('沒有紀錄時視為新公告', () => {
  assert.deepEqual(detectChange({ notified: [] }, 'a', 'h1'), { changed: true, kind: 'new' });
});

test('ID 與雜湊值都相同時視為沒有變化', () => {
  const state = { notified: [sent('a', 'h1')] };
  assert.deepEqual(detectChange(state, 'a', 'h1'), { changed: false, kind: 'unchanged' });
});

test('同一篇公告內容改變時視為更新', () => {
  const state = { notified: [sent('a', 'h1')] };
  assert.deepEqual(detectChange(state, 'a', 'h2'), { changed: true, kind: 'updated' });
});

test('較早通知過的版本再次出現時不重複通知', () => {
  const state = { notified: [sent('b', 'h9'), sent('a', 'h1')] };
  assert.equal(detectChange(state, 'a', 'h1').changed, false);
});

test('紀錄最新版本在最前面，且最多保留 100 筆', () => {
  let state = { notified: [] };
  for (let i = 0; i < 105; i++) state = recordNotified(state, sent(`id${i}`, `h${i}`));
  assert.equal(state.notified.length, 100);
  assert.equal(state.notified[0].id, 'id104');
});

test('狀態檔依 Webhook 分開記錄，可寫入後讀回，檔案不存在時回傳空紀錄', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-test-'));
  try {
    const file = path.join(dir, 'nested', 'state.json');
    const empty = await loadState(file);
    assert.deepEqual(empty, { targets: {} });
    assert.deepEqual(targetState(empty, '111'), { notified: [] });

    const state = withTargetState(empty, '111', recordNotified(targetState(empty, '111'), sent('a', 'h1')));
    await saveState(file, { ...state, migrated: true });
    assert.deepEqual(await loadState(file), state, '只寫入 targets，不寫入其他欄位');
    assert.deepEqual(targetState(await loadState(file), '222'), { notified: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('舊版單一 Webhook 格式以 legacy 回傳', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-test-'));
  try {
    const file = path.join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ notified: [sent('a', 'h1')] }));
    assert.deepEqual(await loadState(file), { targets: {}, legacy: { notified: [sent('a', 'h1')] } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
