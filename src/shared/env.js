import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 支援的設定來源；各來源讀取 env/.env.<來源>，設定使用大寫來源名稱作為前綴。 */
export const SOURCES = ['artale', 'crypto'];

/** 載入共用與指定來源環境檔；優先順序為系統環境變數 > 來源檔 > 共用檔。 */
export function loadProjectEnv(source, { rootDir = ROOT_DIR, env = process.env } = {}) {
  if (source !== undefined && !SOURCES.includes(source)) throw new Error('不支援的環境設定來源');
  const sourcePrefix = new RegExp(`^(${SOURCES.map(name => name.toUpperCase()).join('|')})_`);
  const loaded = {};
  for (const name of ['shared', ...(source ? [source] : [])]) {
    const file = path.join(rootDir, 'env', `.env.${name}`);
    let content;
    try { content = readFileSync(file, 'utf8'); } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new Error(`無法讀取環境設定 env/.env.${name}`);
    }
    for (const [key, value] of Object.entries(parseEnv(content))) {
      // 共用檔不提供主題設定；來源檔只接受自身前綴，避免其他主題設定混入。
      const allowed = name === 'shared' ? !sourcePrefix.test(key) : key.startsWith(`${name.toUpperCase()}_`);
      if (allowed) loaded[key] = value;
    }
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (env[key] === undefined) env[key] = value;
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
