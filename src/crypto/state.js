/**
 * 每日新聞紀錄模組：讀寫紀錄檔（預設 data/crypto/state.json）。
 *
 * 紀錄檔格式（依 Webhook ID 分開記錄，每個 Webhook 只能刪除自己發送的訊息）：
 *   { "targets": { "<Webhook ID>": { "completedDate": "2026-11-18", "messageIds": ["123", ...] } } }
 *   - completedDate：該 Webhook 最後一次「全部訊息發送完成」的日期（排程時區），同一天不會重複發送。
 *   - messageIds：該 Webhook 目前留在 Discord 上的新聞訊息 ID，下次發送前會先刪除。
 *     每刪除或發送一則就立即更新，中途失敗時重試也能刪掉已發出的部分。
 *
 * 舊版只支援單一 Webhook 的格式 { completedDate, messageIds } 會以 legacy 欄位回傳，由 run.js 依發文紀錄
 * 找出原本的 Webhook 後轉成新格式。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const EMPTY = { completedDate: null, messageIds: [] };

/** 整理單一 Webhook 的紀錄，忽略格式不符的值。 */
function cleanEntry(entry) {
  return {
    completedDate: typeof entry?.completedDate === 'string' ? entry.completedDate : null,
    messageIds: Array.isArray(entry?.messageIds) ? entry.messageIds.filter((id) => typeof id === 'string' && /^\d+$/.test(id)) : [],
  };
}

/**
 * 讀取紀錄檔。
 * 檔案不存在（第一次執行）時回傳空紀錄；檔案損壞時直接拋錯，
 * 避免把損壞當成「沒有紀錄」而留下舊新聞或重複發送。
 *
 * @param {string} file 紀錄檔路徑
 * @returns {Promise<{targets: Record<string, {completedDate: string | null, messageIds: string[]}>, legacy?: {completedDate: string | null, messageIds: string[]}}>}
 */
export async function loadDigestState(file) {
  let state;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { targets: {} };
    throw new Error(`讀取狀態檔 ${file} 失敗：${err.message}`);
  }
  const targets = {};
  for (const [webhookId, entry] of Object.entries(state?.targets ?? {})) {
    if (/^\d+$/.test(webhookId)) targets[webhookId] = cleanEntry(entry);
  }
  const isLegacy = state && !state.targets && ('completedDate' in state || 'messageIds' in state);
  return isLegacy ? { targets, legacy: cleanEntry(state) } : { targets };
}

/** 取得指定 Webhook 的紀錄；沒有紀錄時回傳空紀錄。 */
export function targetEntry(state, webhookId) {
  return state.targets[webhookId] ?? EMPTY;
}

/** 回傳更新指定 Webhook 紀錄後的新物件，不修改傳入的 state。 */
export function withTargetEntry(state, webhookId, entry) {
  return { ...state, targets: { ...state.targets, [webhookId]: entry } };
}

/**
 * 寫入紀錄檔。先寫到暫存檔再改名覆蓋，確保寫到一半中斷時不會留下損壞的紀錄檔。
 * 只寫入新格式（不保留 legacy 欄位）。
 *
 * @param {string} file 紀錄檔路徑（資料夾不存在會自動建立）
 * @param {{targets: object}} state 要寫入的紀錄
 */
export async function saveDigestState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify({ targets: state.targets }, null, 2)}\n`);
  await rename(tmpFile, file);
}
