/**
 * 主流程模組：完成一次每日新聞發送。支援多個 Webhook，新聞只搜尋一次，再分別發送到每個 Webhook。
 *
 *   1. 檢查每個 Webhook 的名稱與頭像是否被更換                         （../shared/webhook-profile.js）
 *   2. 以 Codex CLI 網路搜尋發送前 24 小時的美國經濟與虛擬貨幣新聞      （news.js）
 *   3. 每個今天尚未完成的 Webhook：
 *      a. 刪除該 Webhook 前一次發送、仍留在 Discord 上的新聞訊息         （state.js 記錄的訊息 ID）
 *      b. 發送今天的新聞                                               （format.js、../shared/posts.js）
 *      c. 記錄該 Webhook 今天已完成，同一天不重複發送                   （state.js）
 *
 * 先取得新聞才刪除舊訊息：Codex 搜尋失敗時，前一次的新聞會保留在頻道上。
 * 刪除失敗（訊息已不存在除外）時不發送該 Webhook 今天的新聞，確保「先刪除、再發送」的順序。
 * 某個 Webhook 失敗不影響其他 Webhook；全部處理完後才拋錯，重試時只處理尚未完成的 Webhook。
 *
 * index.js（單次執行）與 scheduler.js（常駐排程）都是呼叫這裡的 runDaily()。
 */
import { config } from './config.js';
import { buildDiscordMessages } from './format.js';
import { buildNewsPrompt, NEWS_SCHEMA, parseNews } from './news.js';
import { loadDigestState, saveDigestState, targetEntry, withTargetEntry } from './state.js';
import { summarizeWithCodex } from '../shared/codex.js';
import { log, logError } from '../shared/log.js';
import { listPosts, managePost } from '../shared/posts.js';
import { dateKeyInZone, formatDateInZone, formatInZone } from '../shared/schedule.js';
import { describeTarget } from '../shared/targets.js';
import { checkWebhookProfile } from '../shared/webhook-profile.js';

// 新聞搜尋範圍：執行時間往前 24 小時
const NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 確認至少設定了一個 Webhook，錯誤訊息說明兩種設定方式。 */
export function assertTargets() {
  if (config.targets.length === 0) {
    throw new Error('尚未設定 Webhook：請在 env/crypto.js 的 webhooks 填入至少一個 Webhook（範例見 env/crypto.example.js）');
  }
}

/**
 * 讀取每日新聞紀錄。舊版單一 Webhook 格式會依發文紀錄找出原本發送的 Webhook，轉成新格式
 * （找不到時歸給清單中的第一個 Webhook）；轉換結果在下次寫入紀錄時保存。
 *
 * @returns {Promise<{targets: object, migrated: boolean}>}
 */
export async function loadState() {
  const state = await loadDigestState(config.stateFile);
  if (!state.legacy) return { targets: state.targets, migrated: false };
  const { legacy } = state;
  const posts = await listPosts(config.discordMessagesFile).catch(() => []);
  const owner = posts.find((post) => legacy.messageIds.includes(post.messageId))?.webhookId ?? config.targets[0]?.webhookId;
  const targets = { ...state.targets };
  if (owner && !targets[owner]) targets[owner] = legacy;
  return { targets, migrated: true };
}

/** 判斷所有 Webhook 今天是否都已發送完成。 */
export function isAllCompleted(state, today) {
  return config.targets.every((target) => targetEntry(state, target.webhookId).completedDate === today);
}

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
  if (!dryRun) assertTargets();
  const runAt = new Date(now);
  if (Number.isNaN(runAt.getTime())) throw new Error('執行時間無效');
  const { timeZone } = config.schedule;
  const today = dateKeyInZone(runAt, timeZone);
  const postOptions = { historyFile: config.discordMessagesFile, requestOptions: { timeoutMs: config.httpTimeoutMs } };

  // 正式執行時先檢查每個 Webhook 的名稱與頭像是否被更換；未設定提醒時不檢查，檢查失敗不影響新聞發送。
  // 提醒訊息不列入每日新聞紀錄，之後不會被刪除。
  if (!dryRun) {
    for (const target of config.targets) {
      await checkWebhookProfile(target.url, { ...target.webhookProfile, codex: config.codex, ...postOptions });
    }
  }

  let state = await loadState();
  if (state.migrated && !dryRun) await saveDigestState(config.stateFile, state);
  const pending = config.targets.filter((target) => force || targetEntry(state, target.webhookId).completedDate !== today);
  if (!dryRun && pending.length === 0) {
    log(`今天（${today}）的新聞已發送過，略過；需要重新發送請加上 --force。`);
    return { status: 'skipped', state };
  }

  // 步驟 1：以 Codex 搜尋並整理新聞（所有 Webhook 共用同一份新聞）
  const from = new Date(runAt.getTime() - NEWS_WINDOW_MS);
  log(`以 Codex 搜尋新聞：${formatInZone(from, timeZone)} ～ ${formatInZone(runAt, timeZone)}（時區 ${timeZone}），約需數分鐘…`);
  log(`篇數：美國經濟 ${config.news.economyCount} 則、虛擬貨幣最多 ${config.news.coinCount} 則；幣種優先順序：${config.news.priorityCoins.join(' → ')}`);
  const prompt = buildNewsPrompt({ from, to: runAt, timeZone, ...config.news });
  const reply = await summarizeWithCodex(prompt, { ...config.codex, schema: NEWS_SCHEMA });
  const news = parseNews(reply, config.news);
  log(`取得美國經濟新聞 ${news.economy.length} 則、虛擬貨幣新聞 ${news.crypto.length} 則：`);
  for (const item of news.economy) log(`  [美國經濟] ${item.title}`);
  for (const item of news.crypto) log(`  [${item.coins.join('・') || '整體市場'}] ${item.title}`);
  const messages = buildDiscordMessages(news, { dateLabel: formatDateInZone(runAt, timeZone) });

  // 預覽模式：只印出將刪除與發送的內容
  if (dryRun) {
    log(`--dry-run：不刪除、不發送 Discord、不更新紀錄。共 ${config.targets.length} 個 Webhook，正式執行時每個 Webhook 先刪除自己前一次的新聞訊息，再發送 ${messages.length} 則訊息：`);
    for (const target of config.targets) log(`  ${describeTarget(target)}：將刪除 ${targetEntry(state, target.webhookId).messageIds.length} 則`);
    console.log(JSON.stringify(messages, null, 2));
    return { status: 'dry-run', state, news, messages };
  }

  // 步驟 2：逐一發送到尚未完成的 Webhook；單一 Webhook 失敗不影響其他 Webhook
  const failed = [];
  for (const target of pending) {
    const say = (message) => log(`[${describeTarget(target)}] ${message}`);
    try {
      state = await sendToTarget(target, state, { messages, today, postOptions, say });
    } catch (err) {
      logError(`[${describeTarget(target)}] ${err.message}`);
      failed.push(describeTarget(target));
    }
  }
  if (failed.length > 0) throw new Error(`${failed.join('、')} 發送失敗，詳見上方錯誤訊息；重試時只處理尚未完成的 Webhook`);
  log(`今天（${today}）的新聞已發送完成，共 ${pending.length} 個 Webhook。`);
  return { status: 'sent', state, news, messages };
}

/**
 * 發送到單一 Webhook：先刪除它前一次的新聞訊息，再發送今天的新聞，每一步都立即更新紀錄。
 *
 * @returns {Promise<object>} 更新後的紀錄
 */
async function sendToTarget(target, state, { messages, today, postOptions, say }) {
  const { webhookId, url } = target;
  let entry = targetEntry(state, webhookId);
  const save = async () => {
    state = withTargetEntry(state, webhookId, entry);
    await saveDigestState(config.stateFile, state);
  };

  // 刪除前一次的新聞訊息；每刪除一則就更新紀錄
  if (entry.messageIds.length > 0) say(`刪除前一次的新聞訊息，共 ${entry.messageIds.length} 則…`);
  for (const messageId of [...entry.messageIds]) {
    try {
      await managePost('delete', url, { messageId, ...postOptions });
      say(`已刪除 Discord 訊息 ${messageId}。`);
    } catch (err) {
      if (err.status !== 404) throw new Error(`刪除前一次的新聞訊息 ${messageId} 失敗，未發送今天的新聞：${err.message}`);
      say(`Discord 訊息 ${messageId} 已不存在（可能已手動刪除），略過。`);
    }
    entry = { ...entry, messageIds: entry.messageIds.filter((id) => id !== messageId) };
    await save();
  }

  // 發送今天的新聞；每發送一則就記錄 ID，中途失敗時下次重試會先刪掉已發出的部分
  for (const payload of messages) {
    const title = payload.content.replace(/^#+\s*/, '');
    const post = await managePost('create', url, { payload, ...postOptions, metadata: { title } });
    entry = { ...entry, messageIds: [...entry.messageIds, post.messageId] };
    await save();
    say(`已發送「${title}」（Discord 訊息 ID：${post.messageId}）。`);
  }

  // 全部發送完成才記錄今天已完成
  entry = { ...entry, completedDate: today };
  await save();
  return state;
}
