/**
 * 每日新聞紀錄模組：讀寫紀錄檔（預設 data/crypto/state.json）。
 *
 * 紀錄檔格式：
 *   { "completedDate": "2026-11-18", "messageIds": ["123", ...] }
 *   - completedDate：最後一次「全部訊息發送完成」的日期（排程時區），同一天不會重複發送。
 *   - messageIds：目前留在 Discord 上的新聞訊息 ID，下次發送前會先刪除。
 *     每刪除或發送一則就立即更新，中途失敗時重試也能刪掉已發出的部分。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 讀取紀錄檔。
 * 檔案不存在（第一次執行）時回傳空紀錄；檔案損壞時直接拋錯，
 * 避免把損壞當成「沒有紀錄」而留下舊新聞或重複發送。
 *
 * @param {string} file 紀錄檔路徑
 * @returns {Promise<{completedDate: string | null, messageIds: string[]}>}
 */
export async function loadDigestState(file) {
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { completedDate: null, messageIds: [] };
    throw new Error(`讀取狀態檔 ${file} 失敗：${err.message}`);
  }
  return {
    completedDate: typeof state?.completedDate === 'string' ? state.completedDate : null,
    messageIds: Array.isArray(state?.messageIds) ? state.messageIds.filter((id) => typeof id === 'string' && /^\d+$/.test(id)) : [],
  };
}

/**
 * 寫入紀錄檔。先寫到暫存檔再改名覆蓋，確保寫到一半中斷時不會留下損壞的紀錄檔。
 *
 * @param {string} file 紀錄檔路徑（資料夾不存在會自動建立）
 * @param {{completedDate: string | null, messageIds: string[]}} state 要寫入的紀錄
 */
export async function saveDigestState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpFile, file);
}
