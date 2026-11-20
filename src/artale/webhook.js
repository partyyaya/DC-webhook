/** Artale 專用的手動發文入口；不載入公告、排程或 AI 設定。 */
import { runWebhookCommand } from '../webhook.js';

try {
  await runWebhookCommand(process.argv.slice(2), { source: 'artale' });
} catch (err) {
  console.error(`Artale Webhook 操作失敗：${err.message}`);
  process.exitCode = 1;
}
