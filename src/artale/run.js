/**
 * 主流程模組：把各模組串起來，完成一次完整的公告檢查。
 *
 * 依 ARTALE_NEWS_CATEGORIES 設定的分類（預設「維護」、「更新」與「購物商場」）分兩個階段處理：
 *
 *   第一階段：抓取並轉譯各分類第一頁中符合本輪範圍的公告  （client.js）
 *     任何一個分類發生「內容轉譯錯誤」（ContentParseError，通常是官網結構改變），
 *     就整次停止、什麼都不發送，並把錯誤往外拋，讓 index.js / scheduler.js 結束程式。
 *
 *   第二階段：依分類順序與發布時間逐篇執行
 *     1. 計算雜湊值並與紀錄比對        （state.js）
 *     2. 沒有變化就跳過該篇公告
 *     3. 有變化才呼叫 Codex 產生摘要    （summarize.js）
 *     4. 發送到 Discord Webhook         （../shared/posts.js）
 *     5. 記錄已發送的公告版本          （state.js）
 *
 * index.js（單次執行）與 scheduler.js（常駐排程）都是呼叫這裡的 runOnce()。
 */
import { categoryUrl, fetchAnnouncementsInRange, NEWS_CATEGORIES } from './client.js';
import { getPublishedTime } from './announcement-dates.js';
import { config } from './config.js';
import { buildDiscordMessages } from './format.js';
import { managePost } from '../shared/posts.js';
import { ContentParseError } from './errors.js';
import { log, logError } from '../shared/log.js';
import { detectChange, hashAnnouncement, loadState, recordNotified, saveState } from './state.js';
import {
  buildSummaryPrompt,
  MAINTENANCE_SCHEMA,
  parseMaintenanceSummary,
  parseShopSummary,
  previewShopSummary,
  SHOP_SCHEMA,
} from './summarize.js';
import { summarizeWithCodex } from '../shared/codex.js';

// 依比對結果（新公告／公告更新／強制重發）顯示對應的紀錄訊息
const CHANGE_MESSAGES = {
  new: '偵測到新公告，開始產生摘要…',
  updated: '偵測到公告內容更新，開始產生摘要…',
  unchanged: '已指定 --force，略過比對並重新發送…',
};

const NOTIFICATION_PRIORITY = { maintenance: 0, update: 1, bm: 2 };
const ANNOUNCEMENT_LIMITS = { maintenance: 1, update: 3, bm: 1 };

/**
 * 執行一次完整的公告檢查。
 *
 * 錯誤處理：
 *   - 內容轉譯錯誤（ContentParseError）：立即停止，不發送任何訊息，直接拋出。
 *   - 抓取暫時失敗：跳過該分類；摘要或發送失敗：只跳過該篇，其他公告繼續處理。
 *     全部處理完後再拋錯；後續執行只有仍在時間範圍內的公告才會再試。
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] 預覽模式：印出將發送的內容，但不發送 Discord、不寫入紀錄
 * @param {boolean} [options.force=false] 忽略版本比對，仍遵守本輪範圍與維護判斷
 * @param {boolean} [options.startup=false] 啟動檢查：依分類篇數上限，不限制回溯分鐘數
 * @param {Date | number} [options.now=Date.now()] 本輪開始時間，供模擬及測試固定範圍
 * @returns {Promise<Array<{category: string, status: 'unchanged' | 'outdated' | 'unavailable' | 'dry-run' | 'sent', announcement: object, messages?: object[]}>>}
 */
export async function runOnce({ dryRun = false, force = false, startup = false, now = Date.now() } = {}) {
  // 正式發送前先確認 Webhook 已設定（預覽模式不需要）
  if (!dryRun && !config.discordWebhookUrl) {
    throw new Error('尚未設定環境變數 ARTALE_DISCORD_WEBHOOK_URL');
  }

  // 整輪共用同一個時間快照，抓取及摘要耗時不會移動本輪範圍。
  const endTime = new Date(now).getTime();
  const startTime = startup ? 0 : endTime - config.schedule.intervalMinutes * 60_000;
  if (!Number.isFinite(endTime)) throw new Error('執行時間無效');
  const showTime = time => new Date(time + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').replace('Z', '（GMT+8）');
  if (startup) log('啟動檢查：第一頁維護最新 1 篇、版本更新最新 3 篇、商城最新 1 篇，不限制回溯分鐘數。');
  else log(`公告檢查範圍：${showTime(startTime)} ～ ${showTime(endTime)}（含起訖時間，只讀第一頁）`);
  const failedLabels = [];
  const selected = new Set(config.newsCategories);
  const fetchCategories = [...selected];
  // 只選維護時，也需要讀取版本更新公告作發布時間比對，但不因此發送版本更新。
  if (selected.has('maintenance') && !selected.has('update')) fetchCategories.push('update');

  // 第一階段：抓取並轉譯所有分類第一頁中符合本輪範圍的公告。全部成功後才進入發送階段，
  // 確保只要有任何一個分類轉譯錯誤，這次就一則訊息都不會發出去。
  const fetched = [];
  let latestUpdate;
  for (const category of fetchCategories) {
    const label = NEWS_CATEGORIES[category];
    try {
      const limit = selected.has(category) ? ANNOUNCEMENT_LIMITS[category] : 1;
      const { announcements, latestAnnouncement } = await fetchAnnouncementsInRange({
        newsUrl: categoryUrl(category),
        timeoutMs: config.httpTimeoutMs,
        startTime, endTime,
        includeLatest: selected.has('maintenance') && category === 'update',
        limit,
      });
      if (category === 'update') latestUpdate = latestAnnouncement;
      for (const announcement of announcements) fetched.push({ category, label, announcement });
      if (selected.has(category)) log(`[${label}] 第一頁${limit ? `最新 ${limit} 篇中` : '中'}符合${startup ? '啟動檢查' : '時間範圍'}的公告共 ${announcements.length} 篇。`);
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
  // 每篇公告處理成功後會更新紀錄，再交給下一篇比對。
  let state = await loadState(config.stateFile);
  const results = [];
  const notifications = fetched.filter(item => selected.has(item.category))
    .sort((a, b) => (NOTIFICATION_PRIORITY[a.category] ?? 3) - (NOTIFICATION_PRIORITY[b.category] ?? 3)
      || config.newsCategories.indexOf(a.category) - config.newsCategories.indexOf(b.category)
      || getPublishedTime(a.announcement) - getPublishedTime(b.announcement));
  for (const item of notifications) {
    try {
      if (item.category === 'maintenance') {
        if (!latestUpdate) {
          logError('[維護] 無法取得版本更新公告作發布時間比對，這次略過維護公告，下次檢查再試。');
          results.push({ category: item.category, status: 'unavailable', state, announcement: item.announcement });
          continue;
        }
        const updateTime = getPublishedTime(latestUpdate);
        const maintenanceTime = getPublishedTime(item.announcement);
        if (updateTime !== undefined && maintenanceTime !== undefined && updateTime > maintenanceTime) {
          log(`[維護] 版本更新發布時間 ${latestUpdate.publishedAt || latestUpdate.date} 晚於維護公告發布時間 ${item.announcement.publishedAt || item.announcement.date}，略過維護公告。`);
          results.push({ category: item.category, status: 'outdated', state, announcement: item.announcement });
          continue;
        }
      }
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
 * 處理已抓到的單篇公告：比對 → 有變化才摘要、發送並記錄。
 *
 * @param {{category: string, label: string, announcement: object}} item 第一階段抓到的資料
 * @param {{notified: object[]}} state 目前的已發送紀錄
 * @param {{dryRun: boolean, force: boolean}} options
 * @returns {Promise<{category: string, status: string, state: object, announcement: object, messages?: object[]}>}
 *   回傳的 state 為處理後的紀錄（有發送時會包含剛發送的版本）
 */
async function notifyIfChanged({ category, label, announcement }, state, { dryRun, force }) {
  // 每行紀錄前面加上分類名稱，例如「[購物商場] 公告：…」
  const say = (message) => log(`[${label}] ${message}`);

  // 步驟 1：計算內容雜湊值，用公告 ID + 雜湊值比對已發送紀錄
  const hash = hashAnnouncement(announcement);
  say(`公告：${announcement.title}（ID ${announcement.id}，${announcement.publishedAt}，hash ${hash.slice(0, 12)}）`);

  // 步驟 2：完全沒有變化就跳過這篇公告
  const change = detectChange(state, announcement.id, hash);
  if (!change.changed && !force) {
    say('與已通知過的版本相同，沒有變化。');
    return { category, status: 'unchanged', state, announcement };
  }
  say(CHANGE_MESSAGES[change.kind]);

  // 步驟 3：有變化才呼叫共用 Codex 執行器產生摘要，再用 Artale 格式組出訊息（商城可能有多則）
  const summary = await summarize(announcement, change.kind, category, dryRun, say);
  const messages = buildDiscordMessages(announcement, summary, change.kind);

  // 預覽模式：只印出將發送的內容，不發送也不寫紀錄
  if (dryRun) {
    say(`--dry-run：不發送 Discord、不更新紀錄，預計發送 ${messages.length} 則訊息，內容如下：`);
    console.log(JSON.stringify(messages, null, 2));
    return { category, status: 'dry-run', state, announcement, messages };
  }

  // 步驟 4：依序發送到 Discord；失敗不記錄公告版本，仍在後續檢查範圍時才重試。
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
 *   - 維護（maintenance）：要求 Codex 回覆 MAINTENANCE_SCHEMA，僅組成維護時間內文。
 *   - 其他分類：回傳 Codex 寫好的文字摘要。
 * 正式模式下 Codex 失敗（或回覆格式不符）就直接拋錯（不發送、不記錄）；
 * 預覽模式下則改用預覽內容代替，讓還沒安裝 Codex 時也能看到訊息長相。
 *
 * @param {object} announcement 公告資料（含標題、內文等）
 * @param {'new' | 'updated' | 'unchanged'} kind 比對結果
 * @param {string} category 分類代碼，決定使用購物商場、維護時間或版本更新格式
 * @param {boolean} dryRun 是否為預覽模式
 * @param {(message: string) => void} say 帶分類名稱的紀錄輸出函式
 * @returns {Promise<string | {products: object[], otherChanges: string[]}>} 文字摘要或購物商場的商品資料
 */
async function summarize(announcement, kind, category, dryRun, say) {
  const isShop = category === 'bm';
  const isMaintenance = category === 'maintenance';
  const prompt = buildSummaryPrompt(announcement, kind, category);
  try {
    if (isMaintenance) {
      const reply = await summarizeWithCodex(prompt, { ...config.codex, schema: MAINTENANCE_SCHEMA });
      return parseMaintenanceSummary(reply);
    }
    if (isShop) {
      const reply = await summarizeWithCodex(prompt, { ...config.codex, schema: SHOP_SCHEMA });
      return parseShopSummary(reply, announcement.content);
    }
    return await summarizeWithCodex(prompt, config.codex);
  } catch (err) {
    if (!dryRun) throw err;
    say(`Codex 摘要失敗，--dry-run 改用預覽內容代替：${err.message}`);
    // 維護預覽失敗時也不能回退成公告全文，以免混入時間以外的內容。
    if (isMaintenance) return '維護時間：尚未取得（預覽模式）';
    return isShop
      ? previewShopSummary(announcement.content)
      : `（Codex 摘要失敗，以下為公告開頭內容）\n\n${announcement.content.slice(0, 1500)}`;
  }
}
