/** 股票專用的手動發文入口；不載入新聞、排程或 AI 設定。手動發送的訊息不會被每日新聞自動刪除。 */
import { runWebhookCommand } from '../webhook.js';

try {
  await runWebhookCommand(process.argv.slice(2), { source: 'stock' });
} catch (err) {
  console.error(`股票 Webhook 操作失敗：${err.message}`);
  process.exitCode = 1;
}
