/**
 * 版本紀錄模組：負責計算公告內容的雜湊值、比對是否有變化，
 * 以及讀寫已發送紀錄檔（預設 data/artale/state.json），用來避免重複通知。
 *
 * 紀錄檔格式：
 *   { "notified": [ { id, hash, title, publishedAt, url, notifiedAt }, ... ] }
 * 最新發送的版本排在最前面。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 紀錄檔最多保留的版本筆數，超過時刪除最舊的，避免檔案無限變大
const MAX_HISTORY = 100;

/**
 * 計算公告的 SHA-256 雜湊值，作為「內容版本」的識別。
 * 只使用標題與內文，所以官網單純改動發布時間不會被當成內容變化。
 *
 * @param {{title: string, content: string}} announcement
 * @returns {string} 64 字元的十六進位雜湊值
 */
export function hashAnnouncement({ title, content }) {
  return createHash('sha256').update(`${title}\n\n${content}`).digest('hex');
}

/**
 * 讀取已發送紀錄檔。
 * 檔案不存在（第一次執行）時回傳空紀錄；檔案損壞時直接拋錯，
 * 避免把損壞當成「沒有紀錄」而重複發送。
 *
 * @param {string} file 紀錄檔路徑
 * @returns {Promise<{notified: object[]}>}
 */
export async function loadState(file) {
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    return { notified: Array.isArray(state.notified) ? state.notified : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return { notified: [] };
    throw new Error(`讀取狀態檔 ${file} 失敗：${err.message}`);
  }
}

/**
 * 寫入已發送紀錄檔。
 * 先寫到暫存檔再改名覆蓋，確保寫到一半中斷時不會留下損壞的紀錄檔。
 *
 * @param {string} file 紀錄檔路徑（資料夾不存在會自動建立）
 * @param {{notified: object[]}} state 要寫入的紀錄
 */
export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpFile, file);
}

/**
 * 用公告 ID 與雜湊值比對已發送紀錄，判斷這次抓到的公告是否需要通知。
 *   - ID 與雜湊值都出現過      → unchanged（沒有變化，不通知）
 *   - ID 出現過但雜湊值不同    → updated（同一篇公告內容被修改）
 *   - ID 從未出現過            → new（全新的公告）
 *
 * @param {{notified: object[]}} state 已發送紀錄
 * @param {string} id 公告 ID
 * @param {string} hash 公告內容雜湊值
 * @returns {{changed: boolean, kind: 'new' | 'updated' | 'unchanged'}}
 */
export function detectChange(state, id, hash) {
  const versions = state.notified.filter((version) => version.id === id);
  if (versions.some((version) => version.hash === hash)) return { changed: false, kind: 'unchanged' };
  return { changed: true, kind: versions.length > 0 ? 'updated' : 'new' };
}

/**
 * 把剛發送的公告版本加到紀錄最前面，並只保留最新的 MAX_HISTORY 筆。
 * 不會修改傳入的 state，而是回傳新的物件。
 *
 * @param {{notified: object[]}} state 原本的紀錄
 * @param {object} version 剛發送的版本資料（id、hash、title、publishedAt、url、notifiedAt）
 * @returns {{notified: object[]}}
 */
export function recordNotified(state, version) {
  return { notified: [version, ...state.notified].slice(0, MAX_HISTORY) };
}
