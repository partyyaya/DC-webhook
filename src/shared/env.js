import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 載入共用與指定來源環境檔；優先順序為系統環境變數 > 來源檔 > 共用檔。 */
export function loadProjectEnv(source, { rootDir = ROOT_DIR, env = process.env } = {}) {
  if (source !== undefined && !['artale', 'stocks', 'crypto'].includes(source)) throw new Error('不支援的環境設定來源');
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
      const allowed = name === 'shared' ? !/^(ARTALE|STOCKS|CRYPTO)_/.test(key) : key.startsWith(`${name.toUpperCase()}_`);
      if (allowed) loaded[key] = value;
    }
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}
