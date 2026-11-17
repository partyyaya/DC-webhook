/**
 * 主流程模組：把各模組串起來，完成一次完整的公告檢查。
 *
 * 依 ARTALE_NEWS_CATEGORIES 設定的分類（預設「更新」與「購物商場」）分兩個階段處理：
 *
 *   第一階段：抓取並轉譯每個分類最新的一篇公告  （artale.js）
 *     任何一個分類發生「內容轉譯錯誤」（ContentParseError，通常是官網結構改變），
 *     就整次停止、什麼都不發送，並把錯誤往外拋，讓 index.js / scheduler.js 結束程式。
 *
 *   第二階段：每個分類各自執行
 *     1. 計算雜湊值並與紀錄比對        （state.js）
 *     2. 沒有變化就跳過這個分類
 *     3. 有變化才呼叫 Codex 產生摘要    （summarize.js）
 *     4. 發送到 Discord Webhook         （discord.js）
 *     5. 記錄已發送的公告版本          （state.js）
 *
 * index.js（單次執行）與 scheduler.js（常駐排程）都是呼叫這裡的 runOnce()。
 */
import { categoryUrl, fetchLatestAnnouncement, NEWS_CATEGORIES } from './artale.js';
import { config } from './config.js';
import { buildDiscordMessages } from './discord.js';
import { managePost } from './posts.js';
import { ContentParseError } from './errors.js';
import { log, logError } from './log.js';
import { detectChange, hashAnnouncement, loadState, recordNotified, saveState } from './state.js';
import {
  buildSummaryPrompt,
  parseShopSummary,
  previewShopSummary,
  SHOP_SCHEMA,
  summarizeWithCodex,
} from './summarize.js';

// 依比對結果（新公告／公告更新／強制重發）顯示對應的紀錄訊息
const CHANGE_MESSAGES = {
  new: '偵測到新公告，開始產生摘要…',
  updated: '偵測到公告內容更新，開始產生摘要…',
  unchanged: '已指定 --force，略過比對並重新發送…',
};

/**
 * 執行一次完整的公告檢查。
 *
 * 錯誤處理：
 *   - 內容轉譯錯誤（ContentParseError）：立即停止，不發送任何訊息，直接拋出。
 *   - 其他錯誤（網路逾時、Codex、Discord 暫時失敗）：只跳過該分類，其他分類照常處理，
 *     全部處理完後再拋出錯誤，讓呼叫端以失敗結束；下一個排程時間點會再試。
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] 預覽模式：印出將發送的內容，但不發送 Discord、不寫入紀錄
 * @param {boolean} [options.force=false] 忽略比對結果，即使沒有變化也重新發送
 * @returns {Promise<Array<{category: string, status: 'unchanged' | 'dry-run' | 'sent', announcement: object, messages?: object[]}>>}
 */
export async function runOnce({ dryRun = false, force = false } = {}) {
  // 正式發送前先確認 Webhook 已設定（預覽模式不需要）
  if (!dryRun && !config.discordWebhookUrl) {
    throw new Error('尚未設定環境變數 DISCORD_WEBHOOK_URL');
  }

  const failedLabels = [];

  // 第一階段：抓取並轉譯所有分類的最新公告。全部成功後才進入發送階段，
  // 確保只要有任何一個分類轉譯錯誤，這次就一則訊息都不會發出去。
  const fetched = [];
  for (const category of config.newsCategories) {
    const label = NEWS_CATEGORIES[category];
    try {
      const announcement = await fetchLatestAnnouncement({
        newsUrl: categoryUrl(category),
        timeoutMs: config.httpTimeoutMs,
      });
      fetched.push({ category, label, announcement });
    } catch (err) {
      // 內容轉譯錯誤：加上分類名稱後往外拋，整次停止
      if (err instanceof ContentParseError) {
        throw new ContentParseError(`[${label}] ${err.message}`, { cause: err });
      }
      // 其他錯誤（例如網路逾時）：記錄後跳過這個分類
      logError(`[${label}] 抓取失敗：${err.message}`);
      failedLabels.push(label);
    }
  }

  // 第二階段：逐一比對，有變化才摘要、發送、記錄。
  // 每個分類發送成功後會更新紀錄，再交給下一個分類比對。
  let state = await loadState(config.stateFile);
  const results = [];
  for (const item of fetched) {
    try {
      const result = await notifyIfChanged(item, state, { dryRun, force });
      state = result.state;
      results.push(result);
    } catch (err) {
      logError(`[${item.label}] 處理失敗：${err.message}`);
      failedLabels.push(item.label);
    }
  }

  if (failedLabels.length > 0) {
    throw new Error(`${failedLabels.join('、')} 分類檢查失敗，詳見上方錯誤訊息`);
  }
  return results;
}

/**
 * 處理單一分類已抓到的公告：比對 → 有變化才摘要、發送並記錄。
 *
 * @param {{category: string, label: string, announcement: object}} item 第一階段抓到的資料
 * @param {{notified: object[]}} state 目前的已發送紀錄
 * @param {{dryRun: boolean, force: boolean}} options
 * @returns {Promise<{category: string, status: string, state: object, announcement: object, messages?: object[]}>}
 *   回傳的 state 為處理後的紀錄（有發送時會包含剛發送的版本）
 */
async function notifyIfChanged({ category, label, announcement }, state, { dryRun, force }) {
  // 每行紀錄前面加上分類名稱，例如「[購物商場] 最新公告：…」
  const say = (message) => log(`[${label}] ${message}`);

  // 步驟 1：計算內容雜湊值，用公告 ID + 雜湊值比對已發送紀錄
  const hash = hashAnnouncement(announcement);
  say(`最新公告：${announcement.title}（ID ${announcement.id}，${announcement.publishedAt}，hash ${hash.slice(0, 12)}）`);

  // 步驟 2：完全沒有變化就跳過這個分類
  const change = detectChange(state, announcement.id, hash);
  if (!change.changed && !force) {
    say('與已通知過的版本相同，沒有變化。');
    return { category, status: 'unchanged', state, announcement };
  }
  say(CHANGE_MESSAGES[change.kind]);

  // 步驟 3：有變化才呼叫 Codex 產生摘要，並組出要發送的 Discord 訊息（購物商場可能有多則）
  const summary = await summarize(announcement, change.kind, category, dryRun, say);
  const messages = buildDiscordMessages(announcement, summary, change.kind);

  // 預覽模式：只印出將發送的內容，不發送也不寫紀錄
  if (dryRun) {
    say(`--dry-run：不發送 Discord、不更新紀錄，預計發送 ${messages.length} 則訊息，內容如下：`);
    console.log(JSON.stringify(messages, null, 2));
    return { category, status: 'dry-run', state, announcement, messages };
  }

  // 步驟 4：依序發送到 Discord；發送失敗會拋錯，不會執行下面的紀錄步驟，下次檢查會重試
  for (const payload of messages) {
    const post = await managePost('create', config.discordWebhookUrl, {
      payload, historyFile: config.discordMessagesFile,
      metadata: { announcementId: announcement.id, category, title: announcement.title },
      requestOptions: { timeoutMs: config.httpTimeoutMs },
    });
    say(`Discord 訊息 ID：${post.messageId}`);
  }

  // 步驟 5：發送成功或沒有需通知的內容時記錄此版本，避免重複通知或每次重新摘要
  const nextState = recordNotified(state, {
    id: announcement.id,
    hash,
    title: announcement.title,
    publishedAt: announcement.publishedAt,
    url: announcement.url,
    notifiedAt: new Date().toISOString(),
  });
  await saveState(config.stateFile, nextState);
  say(messages.length > 0
    ? `已發送 ${messages.length} 則訊息到 Discord 並記錄此公告版本。`
    : '沒有需通知的內容，不發送 Discord，已記錄此公告版本。');
  return { category, status: 'sent', state: nextState, announcement, messages };
}

/**
 * 呼叫 Codex 產生摘要。
 *   - 購物商場（bm）：要求 Codex 回覆 SHOP_SCHEMA 格式的 JSON，解析後回傳商品資料。
 *   - 其他分類：回傳 Codex 寫好的文字摘要。
 * 正式模式下 Codex 失敗（或回覆格式不符）就直接拋錯（不發送、不記錄，等下次重試）；
 * 預覽模式下則改用預覽內容代替，讓還沒安裝 Codex 時也能看到訊息長相。
 *
 * @param {object} announcement 公告資料（含標題、內文等）
 * @param {'new' | 'updated' | 'unchanged'} kind 比對結果
 * @param {string} category 分類代碼，決定使用哪一種摘要格式（購物商場或版本更新）
 * @param {boolean} dryRun 是否為預覽模式
 * @param {(message: string) => void} say 帶分類名稱的紀錄輸出函式
 * @returns {Promise<string | {products: object[], otherChanges: string[]}>} 文字摘要或購物商場的商品資料
 */
async function summarize(announcement, kind, category, dryRun, say) {
  const isShop = category === 'bm';
  const prompt = buildSummaryPrompt(announcement, kind, category);
  try {
    if (isShop) {
      const reply = await summarizeWithCodex(prompt, { ...config.codex, schema: SHOP_SCHEMA });
      return parseShopSummary(reply, announcement.content);
    }
    return await summarizeWithCodex(prompt, config.codex);
  } catch (err) {
    if (!dryRun) throw err;
    say(`Codex 摘要失敗，--dry-run 改用預覽內容代替：${err.message}`);
    return isShop
      ? previewShopSummary(announcement.content)
      : `（Codex 摘要失敗，以下為公告開頭內容）\n\n${announcement.content.slice(0, 1500)}`;
  }
}
