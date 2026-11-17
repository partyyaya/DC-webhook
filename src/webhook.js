/** 手動管理 Webhook 發文；不抓取公告、不呼叫 Codex、不變更公告去重紀錄。 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseWebhookUrl } from './discord.js';
import { loadProjectEnv, ROOT_DIR } from './env.js';
import { listPosts, managePost } from './posts.js';

export const WEBHOOK_HELP = `用法：node src/webhook.js <create|edit|delete|list> [選項]
也可使用：npm run webhook -- <操作> [選項]

  create --content "文字"                    新增一則訊息
  create --file payload.json                 新增卡片；可提供單一物件或物件陣列
  edit --message-id ID --content "新文字"     修改訊息文字（其他欄位保留）
  edit --message-id ID --file payload.json    修改卡片／文字；只接受單一物件
  delete --message-id ID                     刪除指定訊息
  list                                      查看本機發文紀錄與訊息 ID

共用選項：
  --webhook URL       改用指定 Webhook，預設讀取 .env 的 DISCORD_WEBHOOK_URL
  --thread-id ID      訊息所在的討論串 ID（討論串訊息需提供）
  --history-file PATH 發文紀錄檔，預設讀取 DISCORD_MESSAGES_FILE
  --dry-run           僅顯示操作內容，不連線、不修改或刪除訊息、不寫紀錄
  --help              顯示說明

修改與刪除只能操作原 Webhook 發送的訊息。JSON 內的 embeds 會整組取代。
修改舊卡片為純文字時，JSON 請提供 {"content":"新文字","embeds":[]}。
所有發送與修改都停用提及通知。`;

function validatePayload(payload, action) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('發文 JSON 必須是單一訊息物件');
  if (payload.content !== undefined && payload.content !== null && typeof payload.content !== 'string') {
    throw new Error('content 必須是文字或 null');
  }
  if (payload.embeds !== undefined && payload.embeds !== null && !Array.isArray(payload.embeds)) {
    throw new Error('embeds 必須是陣列或 null');
  }
  if (payload.content?.length > 2000) throw new Error('content 超過 2000 字，請改用 embeds 或拆成多則訊息');
  const embeds = payload.embeds ?? [];
  if (embeds.length > 10) throw new Error('每則訊息最多 10 張卡片');
  let chars = 0;
  for (const embed of embeds) {
    if (!embed || typeof embed !== 'object' || Array.isArray(embed)) throw new Error('每張卡片必須是物件');
    if ((embed.title?.length ?? 0) > 256 || (embed.description?.length ?? 0) > 4096) {
      throw new Error('卡片標題最多 256 字，內文最多 4096 字');
    }
    if (embed.fields !== undefined && (!Array.isArray(embed.fields) || embed.fields.length > 25)) {
      throw new Error('卡片 fields 必須是陣列，最多 25 個欄位');
    }
    for (const field of embed.fields ?? []) {
      if (typeof field?.name !== 'string' || typeof field?.value !== 'string'
        || field.name.length > 256 || field.value.length > 1024) throw new Error('卡片欄位名稱最多 256 字，內容最多 1024 字，且必須是文字');
      chars += field.name.length + field.value.length;
    }
    chars += (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
      + (embed.footer?.text?.length ?? 0) + (embed.author?.name?.length ?? 0);
  }
  if (chars > 6000) throw new Error('卡片文字總量超過 6000 字，請拆成多則訊息');
  if (action === 'create' && !payload.content?.trim() && embeds.length === 0) throw new Error('新增訊息至少需要 content 或一張 embed 卡片');
  if (action === 'edit' && !Object.hasOwn(payload, 'content') && !Object.hasOwn(payload, 'embeds')) {
    throw new Error('修改訊息至少需要提供 content 或 embeds 欄位');
  }
  return { ...payload, allowed_mentions: { parse: [] } };
}

export async function runWebhookCommand(args, { env = process.env, output = console.log, requestOptions = {} } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    content: { type: 'string' }, file: { type: 'string' },
    'message-id': { type: 'string' }, webhook: { type: 'string' }, 'thread-id': { type: 'string' },
    'history-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) { output(WEBHOOK_HELP); return; }
  const [action] = positionals;
  if (positionals.length !== 1 || !['create', 'edit', 'delete', 'list'].includes(action)) {
    throw new Error('請使用 create、edit、delete 或 list；加上 --help 查看用法');
  }
  const messageId = values['message-id'];
  const hasContent = values.content !== undefined;
  const hasFile = values.file !== undefined;
  if (['edit', 'delete'].includes(action) && (typeof messageId !== 'string' || !/^\d+$/.test(messageId))) {
    throw new Error('修改／刪除必須用 --message-id 指定數字訊息 ID');
  }
  if (['create', 'list'].includes(action) && messageId !== undefined) throw new Error('此操作不接受 --message-id');
  if (['create', 'edit'].includes(action) && hasContent === hasFile) throw new Error('請選擇 --content 或 --file 其中一個提供發文內容');
  if (['delete', 'list'].includes(action) && (hasContent || hasFile)) throw new Error('刪除或查詢不接受 --content、--file');
  if (action === 'list' && (values['thread-id'] !== undefined || values['dry-run'])) throw new Error('list 不接受 --thread-id 或 --dry-run');

  const historyFile = path.resolve(ROOT_DIR, values['history-file'] || env.DISCORD_MESSAGES_FILE || 'data/discord-messages.jsonl');
  const webhook = values.webhook ?? env.DISCORD_WEBHOOK_URL;
  if (action === 'list') {
    const webhookId = webhook ? parseWebhookUrl(webhook).pathname.match(/\/webhooks\/(\d+)\//)[1] : undefined;
    const posts = await listPosts(historyFile, webhookId);
    output(JSON.stringify(posts, null, 2));
    return posts;
  }
  if (!webhook) throw new Error('請在 .env 設定 DISCORD_WEBHOOK_URL，或用 --webhook 指定');
  const url = parseWebhookUrl(webhook);
  if (values['thread-id'] !== undefined) {
    if (!/^\d+$/.test(values['thread-id'])) throw new Error('--thread-id 必須是數字 ID');
    url.searchParams.set('thread_id', values['thread-id']);
  }
  const webhookId = url.pathname.match(/\/webhooks\/(\d+)\//)[1];
  let payloads = [];
  if (hasContent) payloads = [{ content: values.content }];
  if (hasFile) {
    let parsed;
    try { parsed = JSON.parse(await readFile(values.file, 'utf8')); } catch {
      throw new Error('無法讀取 --file 指定的 JSON 檔案，請確認檔案存在且 JSON 格式正確');
    }
    if (action === 'edit' && Array.isArray(parsed)) throw new Error('修改訊息只接受單一 JSON 物件，不能使用陣列');
    payloads = Array.isArray(parsed) ? parsed : [parsed];
    if (payloads.length === 0) throw new Error('JSON 陣列沒有任何訊息可發送');
  }
  // 先驗證所有訊息，再開始發送，避免直到中途才發現下一筆 JSON 不符。
  payloads = payloads.map((payload) => validatePayload(payload, action));
  if (values['dry-run']) {
    const preview = { action, webhookId, messageId, threadId: url.searchParams.get('thread_id'), payloads };
    output(JSON.stringify(preview, null, 2));
    return preview;
  }
  const results = [];
  for (const payload of action === 'delete' ? [undefined] : payloads) {
    const result = await managePost(action, url.toString(), { payload, messageId, historyFile, requestOptions });
    results.push(result);
    output(JSON.stringify(result, null, 2));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    loadProjectEnv();
    await runWebhookCommand(process.argv.slice(2));
  } catch (err) {
    console.error(`Webhook 操作失敗：${err.message}`);
    process.exitCode = 1;
  }
}
