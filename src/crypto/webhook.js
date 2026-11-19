/** Crypto 專用的手動發文入口；不載入新聞、排程或 Codex 設定。手動發送的訊息不會被每日新聞自動刪除。 */
import { runWebhookCommand } from '../webhook.js';

try {
  await runWebhookCommand(process.argv.slice(2), { source: 'crypto' });
} catch (err) {
  console.error(`Crypto Webhook 操作失敗：${err.message}`);
  process.exitCode = 1;
}
