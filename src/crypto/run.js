/**
 * 主流程模組：完成一次每日新聞發送。
 *
 *   1. 以 Codex CLI 網路搜尋發送前 24 小時的美國經濟與虛擬貨幣新聞  （news.js）
 *   2. 刪除前一次發送、仍留在 Discord 上的新聞訊息                   （state.js 記錄的訊息 ID）
 *   3. 發送今天的新聞                                                 （format.js、../shared/posts.js）
 *   4. 記錄今天已完成，同一天不重複發送                               （state.js）
 *
 * 先取得新聞才刪除舊訊息：Codex 搜尋失敗時，前一次的新聞會保留在頻道上。
 * 刪除失敗（訊息已不存在除外）時不發送今天的新聞，確保「先刪除、再發送」的順序。
 *
 * index.js（單次執行）與 scheduler.js（常駐排程）都是呼叫這裡的 runDaily()。
 */
import { config } from './config.js';
import { buildDiscordMessages } from './format.js';
import { buildNewsPrompt, NEWS_SCHEMA, parseNews } from './news.js';
import { loadDigestState, saveDigestState } from './state.js';
import { summarizeWithCodex } from '../shared/codex.js';
import { log } from '../shared/log.js';
import { managePost } from '../shared/posts.js';
import { dateKeyInZone, formatDateInZone, formatInZone } from '../shared/schedule.js';

// 新聞搜尋範圍：執行時間往前 24 小時
const NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 執行一次每日新聞發送。
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] 預覽模式：搜尋並印出將發送的內容，不刪除、不發送、不寫紀錄
 * @param {boolean} [options.force=false] 今天已發送過仍重新發送（會先刪除目前的新聞訊息）
 * @param {Date | number} [options.now=Date.now()] 本次執行時間，決定「今天」與搜尋範圍
 * @returns {Promise<{status: 'skipped' | 'dry-run' | 'sent', state: object, news?: object, messages?: object[]}>}
 */
export async function runDaily({ dryRun = false, force = false, now = Date.now() } = {}) {
  if (!dryRun && !config.discordWebhookUrl) {
    throw new Error('尚未設定環境變數 CRYPTO_DISCORD_WEBHOOK_URL');
  }
  const runAt = new Date(now);
  if (Number.isNaN(runAt.getTime())) throw new Error('執行時間無效');
  const { timeZone } = config.schedule;
  const today = dateKeyInZone(runAt, timeZone);

  let state = await loadDigestState(config.stateFile);
  if (!dryRun && !force && state.completedDate === today) {
    log(`今天（${today}）的新聞已發送過，略過；需要重新發送請加上 --force。`);
    return { status: 'skipped', state };
  }

  // 步驟 1：以 Codex 搜尋並整理新聞
  const from = new Date(runAt.getTime() - NEWS_WINDOW_MS);
  log(`以 Codex 搜尋新聞：${formatInZone(from, timeZone)} ～ ${formatInZone(runAt, timeZone)}（時區 ${timeZone}），約需數分鐘…`);
  log(`篇數：美國經濟 ${config.news.economyCount} 則、虛擬貨幣 ${config.news.coinCount} 則；幣種優先順序：${config.news.priorityCoins.join(' → ')}`);
  const prompt = buildNewsPrompt({ from, to: runAt, timeZone, ...config.news });
  const reply = await summarizeWithCodex(prompt, { ...config.codex, schema: NEWS_SCHEMA });
  const news = parseNews(reply, config.news);
  log(`取得美國經濟新聞 ${news.economy.length} 則、虛擬貨幣新聞 ${news.crypto.length} 則：`);
  for (const item of news.economy) log(`  [美國經濟] ${item.title}`);
  for (const item of news.crypto) log(`  [${item.coins.join('・') || '整體市場'}] ${item.title}`);
  const messages = buildDiscordMessages(news, { dateLabel: formatDateInZone(runAt, timeZone) });

  // 預覽模式：只印出將刪除與發送的內容
  if (dryRun) {
    log(`--dry-run：不刪除、不發送 Discord、不更新紀錄。正式執行會先刪除 ${state.messageIds.length} 則前一次的新聞訊息，再發送 ${messages.length} 則訊息，內容如下：`);
    console.log(JSON.stringify(messages, null, 2));
    return { status: 'dry-run', state, news, messages };
  }

  const postOptions = { historyFile: config.discordMessagesFile, requestOptions: { timeoutMs: config.httpTimeoutMs } };

  // 步驟 2：刪除前一次的新聞訊息；每刪除一則就更新紀錄
  if (state.messageIds.length > 0) log(`刪除前一次的新聞訊息，共 ${state.messageIds.length} 則…`);
  for (const messageId of [...state.messageIds]) {
    try {
      await managePost('delete', config.discordWebhookUrl, { messageId, ...postOptions });
      log(`已刪除 Discord 訊息 ${messageId}。`);
    } catch (err) {
      if (err.status !== 404) throw new Error(`刪除前一次的新聞訊息 ${messageId} 失敗，未發送今天的新聞：${err.message}`);
      log(`Discord 訊息 ${messageId} 已不存在（可能已手動刪除），略過。`);
    }
    state = { ...state, messageIds: state.messageIds.filter((id) => id !== messageId) };
    await saveDigestState(config.stateFile, state);
  }

  // 步驟 3：發送今天的新聞；每發送一則就記錄 ID，中途失敗時下次重試會先刪掉已發出的部分
  for (const payload of messages) {
    const title = payload.content.replace(/^#+\s*/, '');
    const post = await managePost('create', config.discordWebhookUrl, { payload, ...postOptions, metadata: { title } });
    state = { ...state, messageIds: [...state.messageIds, post.messageId] };
    await saveDigestState(config.stateFile, state);
    log(`已發送「${title}」（Discord 訊息 ID：${post.messageId}）。`);
  }

  // 步驟 4：全部發送完成才記錄今天已完成
  state = { ...state, completedDate: today };
  await saveDigestState(config.stateFile, state);
  log(`今天（${today}）的新聞已發送完成，共 ${messages.length} 則訊息。`);
  return { status: 'sent', state, news, messages };
}
