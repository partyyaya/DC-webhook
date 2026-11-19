/**
 * 主題設定檔：每個主題的所有設定（Webhook、排程、內容、提醒、紀錄位置）集中在一份 JS 檔，
 * 預設為 env/<主題>.js，以 export default 匯出設定物件，可以直接寫註解。
 * 共用的 Codex 設定仍放在 env/.env.shared（見 env.js）。
 *
 * 這裡只負責載入檔案與提供欄位檢查工具；各主題的 config.js 依自己的欄位檢查與套用預設值。
 * 欄位名稱寫錯或型別不符時直接報錯，避免設定被默默忽略。
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR } from './env.js';

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * 載入主題設定檔。檔案不存在時回傳空設定（全部使用預設值，且沒有 Webhook）。
 * 可用環境變數 <主題>_CONFIG_FILE 改用其他檔案（相對路徑以專案根目錄為準）。
 *
 * @param {string} source 主題名稱，例如 artale
 * @param {object} [options]
 * @param {object} [options.env=process.env] 環境變數
 * @param {string} [options.rootDir=ROOT_DIR] 專案根目錄
 * @returns {Promise<{file: string | null, label: string, values: object}>} label 為錯誤訊息使用的檔名
 */
export async function loadTopicConfig(source, { env = process.env, rootDir = ROOT_DIR } = {}) {
  const custom = env[`${source.toUpperCase()}_CONFIG_FILE`];
  const file = path.resolve(rootDir, custom || `env/${source}.js`);
  const label = path.relative(rootDir, file) || file;

  // 舊版的 env/.env.<主題> 已停用；仍存在時提醒搬移，避免以為設定有生效
  if (!custom && existsSync(path.join(rootDir, 'env', `.env.${source}`))) {
    throw new Error(`env/.env.${source} 已停用：請把設定搬到 env/${source}.js（範例見 env/${source}.example.js），再刪除 env/.env.${source}`);
  }
  if (!existsSync(file)) return { file: null, label, values: {} };

  let values;
  try {
    // 加上修改時間作為版本，同一個程序中檔案被修改時會重新載入，而不是沿用 import 快取
    const version = statSync(file, { bigint: true }).mtimeNs;
    ({ default: values } = await import(`${pathToFileURL(file).href}?v=${version}`));
  } catch (err) {
    throw new Error(`無法載入 ${label}：${err.message}`);
  }
  if (!isPlainObject(values)) throw new Error(`${label} 必須以 export default 匯出設定物件`);
  return { file, label, values };
}

/**
 * 檢查設定區塊：未填寫時回傳空物件；不是物件或有不支援的欄位時拋錯。
 *
 * @param {any} value 設定值
 * @param {string[]} keys 可用欄位
 * @param {string} where 錯誤訊息使用的位置，例如「env/crypto.js 的 schedule」
 * @returns {object}
 */
export function section(value, keys, where) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new Error(`${where} 必須是物件`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${where} 有不支援的欄位：${unknown.join('、')}；可用欄位為 ${keys.join('、')}`);
  return value;
}

/** 文字欄位：未填寫時使用預設值。 */
export function text(value, fallback, where) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`${where} 必須是文字`);
  return value;
}

/** 整數欄位：未填寫時使用預設值，超出範圍時拋錯。 */
export function integer(value, fallback, where, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `${min} 以上` : `${min}～${max} `;
    throw new Error(`${where} 必須是 ${range}的整數，目前為「${value}」`);
  }
  return value;
}

/**
 * 清單欄位：可寫成陣列（['BTC', 'ETH']）或逗號分隔文字（'BTC,ETH'），統一轉成逗號分隔文字交給各主題解析。
 * 星期也可以寫成數字（2）。
 */
export function listText(value, fallback, where) {
  if (value === undefined) return fallback;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' || Number.isInteger(item))) return value.join(',');
  if (typeof value === 'string' || Number.isInteger(value)) return String(value);
  throw new Error(`${where} 必須是陣列或逗號分隔的文字`);
}

/** 紀錄檔路徑：相對路徑以專案根目錄為準。 */
export function filePath(value, fallback, where, rootDir = ROOT_DIR) {
  return path.resolve(rootDir, text(value, fallback, where));
}
