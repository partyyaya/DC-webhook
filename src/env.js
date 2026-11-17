import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 公告排程與手動 Webhook 指令共用設定來源；手動指令不需要解析排程或啟動 Codex。
export function loadProjectEnv() {
  const file = path.join(ROOT_DIR, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
