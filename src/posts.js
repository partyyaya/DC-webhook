/** 保存每次已成功的 Webhook 操作，讓部分發送成功的訊息也能被查詢及撤回。 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { deleteDiscordMessage, editDiscordMessage, parseWebhookUrl, sendToDiscord } from './discord.js';

export async function managePost(action, webhookUrl, { payload, messageId, historyFile, metadata = {}, requestOptions = {} }) {
  const url = parseWebhookUrl(webhookUrl);
  const webhookId = url.pathname.match(/\/webhooks\/(\d+)\//)[1];
  if (!['create', 'edit', 'delete'].includes(action)) throw new Error('不支援的 Webhook 操作');
  if (!historyFile) throw new Error('未指定 Discord 發文紀錄檔');
  // 先建立紀錄目錄，權限不足時不要先發出請求。
  await mkdir(path.dirname(historyFile), { recursive: true });
  let message;
  if (action === 'create') message = await sendToDiscord(webhookUrl, payload, requestOptions);
  if (action === 'edit') message = await editDiscordMessage(webhookUrl, messageId, payload, requestOptions);
  if (action === 'delete') await deleteDiscordMessage(webhookUrl, messageId, requestOptions);
  const id = action === 'create' ? message?.id : messageId;
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error('Discord 已回應成功，但未回傳有效的訊息 ID，請到 Discord 確認');
  const event = {
    action, webhookId, messageId: id, at: new Date().toISOString(),
    ...(message?.channel_id ? { channelId: message.channel_id } : {}),
    ...(url.searchParams.has('thread_id') ? { threadId: url.searchParams.get('thread_id') } : {}),
    ...(action !== 'delete' ? { title: metadata.title ?? message?.embeds?.[0]?.title ?? payload?.embeds?.[0]?.title
      ?? message?.content?.slice(0, 100) ?? payload?.content?.slice(0, 100) ?? '' } : {}),
    ...(metadata.announcementId ? { announcementId: metadata.announcementId } : {}),
    ...(metadata.category ? { category: metadata.category } : {}),
  };
  try {
    // 每個事件附加一行，不以整份檔案覆寫，讓排程與手動操作各自保留紀錄。
    await appendFile(historyFile, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch {
    throw new Error(`Discord ${action} 已成功（訊息 ID：${id}），但發文紀錄寫入失敗；請保留 ID，勿直接重試新增以免重複發文`);
  }
  return event;
}

/** 依 Webhook 與訊息 ID 合併事件，列出每則訊息的最後狀態。 */
export async function listPosts(historyFile, webhookId) {
  let text;
  try { text = await readFile(historyFile, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error('無法讀取 Discord 發文紀錄檔');
  }
  const posts = new Map();
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Discord 發文紀錄第 ${index + 1} 行格式錯誤`); }
    if (!['create', 'edit', 'delete'].includes(event?.action) || typeof event.messageId !== 'string'
      || typeof event.webhookId !== 'string') throw new Error(`Discord 發文紀錄第 ${index + 1} 行格式錯誤`);
    if (webhookId && event.webhookId !== webhookId) continue;
    const key = `${event.webhookId}:${event.messageId}`;
    const previous = posts.get(key) ?? {};
    posts.delete(key);
    posts.set(key, {
      ...previous, ...event, status: event.action === 'delete' ? 'deleted' : 'active',
      ...(event.action === 'create' ? { createdAt: event.at } : {}),
    });
  }
  return [...posts.values()].reverse();
}
