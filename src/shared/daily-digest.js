/**
 * 每日發送的共用流程（Crypto 新聞、股票新聞、技術指標等主題共用）：完成一次每日新聞發送。
 * 支援多個 Webhook，新聞只取得一次，再分別發送到每個 Webhook。
 *
 *   1. 檢查每個 Webhook 的名稱與頭像是否被更換                   （webhook-profile.js）
 *   2. 由主題的 collect() 搜尋並整理新聞，組成 Discord 訊息          （各主題的 run.js）
 *   3. 每個今天尚未完成的 Webhook：
 *      a. 刪除該 Webhook 前一次發送、仍留在 Discord 上的新聞訊息   （digest-state.js 記錄的訊息 ID）
 *      b. 發送今天的新聞                                         （posts.js）
 *      c. 記錄該 Webhook 今天已完成，同一天不重複發送             （digest-state.js）
 *
 * 先取得新聞才刪除舊訊息：搜尋失敗時，前一次的新聞會保留在頻道上。
 * 刪除失敗（訊息已不存在除外）時不發送該 Webhook 今天的新聞，確保「先刪除、再發送」的順序。
 * 某個 Webhook 失敗不影響其他 Webhook；全部處理完後才拋錯，重試時只處理尚未完成的 Webhook。
 */
import { loadDigestState, saveDigestState, targetEntry, withTargetEntry } from './digest-state.js';
import { log, logError } from './log.js';
import { listPosts, managePost } from './posts.js';
import { dateKeyInZone } from './schedule.js';
import { describeTarget } from './targets.js';
import { checkWebhookProfile } from './webhook-profile.js';

// 新聞搜尋範圍：執行時間往前 24 小時
const NEWS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 建立主題的每日新聞流程。
 * config 在每次呼叫時才讀取（不在建立時解構），測試可以直接修改主題的 config 物件。
 *
 * @param {object} options
 * @param {string} options.topic 主題名稱，用於錯誤訊息中的設定檔名稱，例如 crypto
 * @param {string} [options.subject='新聞'] 每日發送內容的名稱，用於紀錄輸出，例如「技術分析」
 * @param {boolean} [options.oncePerDay=true] 每個 Webhook 一天只發送一次；false 時每次執行都發送
 *   （由排程決定執行頻率，例如技術指標在時段內每隔固定分鐘更新一次），每次都先刪除前一次的訊息
 * @param {object} options.config 主題設定：targets、stateFile、discordMessagesFile、schedule、httpTimeoutMs、ai
 * @param {(range: {from: Date, to: Date, timeZone: string}) => Promise<{news: object, messages: object[]}>} options.collect
 *   搜尋並整理新聞，回傳新聞資料與要發送的 Discord 訊息；失敗時拋錯（不刪除舊訊息）
 * @returns {{assertTargets: Function, loadState: Function, isAllCompleted: Function, runDaily: Function}}
 */
export function createDailyDigest({ topic, config, collect, subject = '新聞', oncePerDay = true }) {
  /** 確認至少設定了一個 Webhook。 */
  function assertTargets() {
    if (config.targets.length === 0) {
      throw new Error(`尚未設定 Webhook：請在 env/${topic}.js 的 webhooks 填入至少一個 Webhook（範例見 env/${topic}.example.js）`);
    }
  }

  /**
   * 讀取每日新聞紀錄。舊版單一 Webhook 格式會依發文紀錄找出原本發送的 Webhook，轉成新格式
   * （找不到時歸給清單中的第一個 Webhook）；轉換結果在下次寫入紀錄時保存。
   *
   * @returns {Promise<{targets: object, migrated: boolean}>}
   */
  async function loadState() {
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
  function isAllCompleted(state, today) {
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
  async function runDaily({ dryRun = false, force = false, now = Date.now() } = {}) {
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
        await checkWebhookProfile(target.url, { ...target.webhookProfile, ai: config.ai, ...postOptions });
      }
    }

    let state = await loadState();
    if (state.migrated && !dryRun) await saveDigestState(config.stateFile, state);
    const pending = config.targets.filter((target) => force || !oncePerDay || targetEntry(state, target.webhookId).completedDate !== today);
    if (!dryRun && pending.length === 0) {
      log(`今天（${today}）的${subject}已發送過，略過；需要重新發送請加上 --force。`);
      return { status: 'skipped', state };
    }

    // 步驟 1：由主題搜尋並整理新聞（所有 Webhook 共用同一份新聞）
    const from = new Date(runAt.getTime() - NEWS_WINDOW_MS);
    const { news, messages } = await collect({ from, to: runAt, timeZone });

    // 預覽模式：只印出將刪除與發送的內容
    if (dryRun) {
      log(`--dry-run：不刪除、不發送 Discord、不更新紀錄。共 ${config.targets.length} 個 Webhook，正式執行時每個 Webhook 先刪除自己前一次的${subject}訊息，再發送 ${messages.length} 則訊息：`);
      for (const target of config.targets) log(`  ${describeTarget(target)}：將刪除 ${targetEntry(state, target.webhookId).messageIds.length} 則`);
      // 預覽列出附件名稱、格式與大小，不把整張 PNG 的二進位資料印到終端機。
      console.log(JSON.stringify(messages.map(({ files, ...message }) => ({
        ...message,
        ...(files?.length ? { files: files.map(({ data, ...file }) => ({ ...file, bytes: data.byteLength })) } : {}),
      })), null, 2));
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
    log(`${oncePerDay ? `今天（${today}）的` : '本次'}${subject}已發送完成，共 ${pending.length} 個 Webhook。`);
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
    if (entry.messageIds.length > 0) say(`刪除前一次的${subject}訊息，共 ${entry.messageIds.length} 則…`);
    for (const messageId of [...entry.messageIds]) {
      try {
        await managePost('delete', url, { messageId, ...postOptions });
        say(`已刪除 Discord 訊息 ${messageId}。`);
      } catch (err) {
        if (err.status !== 404) throw new Error(`刪除前一次的${subject}訊息 ${messageId} 失敗，未發送今天的${subject}：${err.message}`);
        say(`Discord 訊息 ${messageId} 已不存在（可能已手動刪除），略過。`);
      }
      entry = { ...entry, messageIds: entry.messageIds.filter((id) => id !== messageId) };
      await save();
    }

    // 發送今天的新聞；每發送一則就記錄 ID，中途失敗時下次重試會先刪掉已發出的部分。
    // 訊息文字（只有卡片時改用第一張卡片）的第一行，去掉標題、引用與粗體等 Markdown 符號，作為紀錄用的標題
    for (const payload of messages) {
      const text = payload.content || payload.embeds?.[0]?.title || payload.embeds?.[0]?.description || '';
      const title = text.split('\n')[0].replace(/^(?:#+|>)\s*/, '').replaceAll('**', '');
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

  return { assertTargets, loadState, isAllCompleted, runDaily };
}
