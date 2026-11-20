/** 技術指標專用的手動發文入口；不載入行情、排程或 AI 設定。手動發送的訊息不會被每日技術分析自動刪除。 */
import { runWebhookCommand } from '../webhook.js';

try {
  await runWebhookCommand(process.argv.slice(2), { source: 'signal' });
} catch (err) {
  console.error(`技術指標 Webhook 操作失敗：${err.message}`);
  process.exitCode = 1;
}
