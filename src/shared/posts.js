/** 保存每次已成功的 Webhook 操作，讓部分發送成功的訊息也能被查詢及撤回。 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { deleteDiscordMessage, editDiscordMessage, parseWebhookUrl, sendToDiscord } from './discord.js';

const MAX_HISTORY = 100;

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
    await savePostEvent(historyFile, event);
  } catch {
    throw new Error(`Discord ${action} 已成功（訊息 ID：${id}），但發文紀錄寫入失敗；請保留 ID，勿直接重試新增以免重複發文`);
  }
  return event;
}

/** 保留檔案寫入順序最後 100 筆；互斥寫入避免排程與不同 Node 指令互相覆蓋。 */
async function savePostEvent(historyFile, event) {
  const lockFile = `${historyFile}.lock`;
  const lock = await acquireHistoryLock(lockFile);
  const tempFile = `${historyFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const events = [...await readPostEvents(historyFile), event].slice(-MAX_HISTORY);
    await writeFile(tempFile, `${events.map(item => JSON.stringify(item)).join('\n')}\n`, { mode: 0o600 });
    await rename(tempFile, historyFile);
  } finally {
    await rm(tempFile, { force: true }).catch(() => {});
    await lock.close();
    await rm(lockFile, { force: true });
  }
}

async function acquireHistoryLock(file) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return await open(file, 'wx', 0o600); } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= deadline) throw new Error('Discord 發文紀錄正由其他程序寫入，無法取得寫入鎖');
      await sleep(25);
    }
  }
}

async function readPostEvents(historyFile) {
  let text;
  try { text = await readFile(historyFile, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error('無法讀取 Discord 發文紀錄檔');
  }
  const events = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Discord 發文紀錄第 ${index + 1} 行格式錯誤`); }
    if (!['create', 'edit', 'delete'].includes(event?.action) || typeof event.messageId !== 'string'
      || typeof event.webhookId !== 'string') throw new Error(`Discord 發文紀錄第 ${index + 1} 行格式錯誤`);
    events.push(event);
  }
  return events;
}

/** 依 Webhook 與訊息 ID 合併現存事件，列出每則訊息的最後狀態；查詢不修改檔案。 */
export async function listPosts(historyFile, webhookId) {
  const posts = new Map();
  for (const event of await readPostEvents(historyFile)) {
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
