import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 支援的主題；各主題的設定放在 env/<主題>.js（見 topic-config.js）。 */
export const SOURCES = ['artale', 'crypto'];

/**
 * 載入共用環境檔 env/.env.shared（使用的 AI、CLI 執行檔、模型、API key 等所有主題共用的設定）。
 * 系統環境變數優先，包含已設定的空值。各主題的設定不放在這裡，以主題前綴開頭的變數會被忽略。
 */
export function loadProjectEnv({ rootDir = ROOT_DIR, env = process.env } = {}) {
  const sourcePrefix = new RegExp(`^(${SOURCES.map(name => name.toUpperCase()).join('|')})_`);
  let content;
  try { content = readFileSync(path.join(rootDir, 'env', '.env.shared'), 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return env;
    throw new Error('無法讀取環境設定 env/.env.shared');
  }
  for (const [key, value] of Object.entries(parseEnv(content))) {
    if (!sourcePrefix.test(key) && env[key] === undefined) env[key] = value;
  }
  return env;
}

/**
 * 讀取一個「正整數」型態的環境變數。
 * 沒有設定時回傳預設值；設定了但不是正整數時直接拋錯，避免帶著錯誤設定繼續執行。
 *
 * @param {string} name 環境變數名稱
 * @param {number} fallback 未設定時使用的預設值
 * @returns {number}
 */
export function positiveIntFromEnv(name, fallback, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`環境變數 ${name} 必須是正整數，目前為「${raw}」`);
  }
  return value;
}
