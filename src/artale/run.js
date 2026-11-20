/**
 * 主流程模組：把各模組串起來，完成一次完整的公告檢查。
 *
 * 依設定檔 newsCategories 的分類（預設「維護」、「更新」與「購物商場」）分兩個階段處理：
 *
 *   第一階段：抓取並轉譯各分類第一頁中符合本輪範圍的公告  （client.js）
 *     任何一個分類發生「內容轉譯錯誤」（ContentParseError，通常是官網結構改變），
 *     就整次停止、什麼都不發送，並把錯誤往外拋，讓 index.js / scheduler.js 結束程式。
 *
 *   第二階段：依分類順序與發布時間逐篇執行
 *     1. 計算雜湊值並與紀錄比對        （state.js）
 *     2. 沒有變化就跳過該篇公告
 *     3. 有變化才呼叫 AI 產生摘要       （summarize.js）
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
import { detectChange, hashAnnouncement, loadState, recordNotified, saveState, targetState, withTargetState } from './state.js';
import {
  buildSummaryPrompt,
  MAINTENANCE_SCHEMA,
  parseMaintenanceSummary,
  parseShopSummary,
  previewShopSummary,
  SHOP_SCHEMA,
} from './summarize.js';
import { aiLabel, summarizeWithAi } from '../shared/ai.js';
import { checkWebhookProfile } from '../shared/webhook-profile.js';
import { describeTarget } from '../shared/targets.js';

// 依比對結果（新公告／公告更新／強制重發）顯示對應的紀錄訊息
const CHANGE_MESSAGES = {
  new: '偵測到新公告',
  updated: '偵測到公告內容更新',
  unchanged: '已指定 --force，略過比對並重新發送',
};

const NOTIFICATION_PRIORITY = { maintenance: 0, update: 1, bm: 2 };

/** 確認至少設定了一個 Webhook。 */
export function assertTargets() {
  if (config.targets.length === 0) {
    throw new Error('尚未設定 Webhook：請在 env/artale.js 的 webhooks 填入至少一個 Webhook（範例見 env/artale.example.js）');
  }
}

/**
 * 讀取公告去重紀錄。舊版單一 Webhook 格式的紀錄套用到目前設定的每個 Webhook（舊紀錄就是這些公告已通知過），
 * 轉換結果在下次寫入紀錄時保存；之後新增的 Webhook 從空紀錄開始。
 */
async function loadStates() {
  const state = await loadState(config.stateFile);
  if (!state.legacy) return state;
  const targets = { ...state.targets };
  for (const { webhookId } of config.targets) targets[webhookId] ??= state.legacy;
  return { targets, migrated: true };
}
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
  if (!dryRun) assertTargets();

  // 正式執行時先檢查每個 Webhook 的名稱與頭像是否被更換；未設定提醒時不檢查，檢查失敗不影響公告檢查
  if (!dryRun) {
    for (const target of config.targets) {
      await checkWebhookProfile(target.url, {
        ...target.webhookProfile, ai: config.ai, historyFile: config.discordMessagesFile,
        requestOptions: { timeoutMs: config.httpTimeoutMs },
      });
    }
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
  let state = await loadStates();
  if (state.migrated && !dryRun) await saveState(config.stateFile, state);
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
      if (result.failedTargets?.length > 0) failedLabels.push(item.label);
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
 * 處理已抓到的單篇公告：每個 Webhook 各自比對 → 有變化的 Webhook 才摘要、發送並記錄。
 * 每篇公告只呼叫一次 AI 產生摘要，所有 Webhook 共用；標題標籤與「（公告已更新）」由程式依各 Webhook 的比對結果加上。
 * 某個 Webhook 發送失敗不影響其他 Webhook，失敗的 Webhook 不記錄此版本，之後仍在檢查範圍內時再補發。
 *
 * @param {{category: string, label: string, announcement: object}} item 第一階段抓到的資料
 * @param {{targets: object}} state 目前的已發送紀錄
 * @param {{dryRun: boolean, force: boolean}} options
 * @returns {Promise<{category: string, status: string, state: object, announcement: object, messages?: object[], failedTargets?: string[]}>}
 *   回傳的 state 為處理後的紀錄（有發送成功的 Webhook 會包含剛發送的版本）
 */
async function notifyIfChanged({ category, label, announcement }, state, { dryRun, force }) {
  // 每行紀錄前面加上分類名稱，例如「[購物商場] 公告：…」
  const say = (message) => log(`[${label}] ${message}`);

  // 步驟 1：計算內容雜湊值，每個 Webhook 各自用公告 ID + 雜湊值比對已發送紀錄。
  // 預覽模式沒有設定 Webhook 時，以空紀錄比對（視為新公告）
  const hash = hashAnnouncement(announcement);
  say(`公告：${announcement.title}（ID ${announcement.id}，${announcement.publishedAt}，hash ${hash.slice(0, 12)}）`);
  const targets = config.targets.length > 0 ? config.targets : [{ name: '預覽', webhookId: '' }];
  const pending = targets
    .map((target) => ({ target, change: detectChange(targetState(state, target.webhookId), announcement.id, hash) }))
    .filter(({ change }) => change.changed || force);

  // 步驟 2：所有 Webhook 都沒有變化就跳過這篇公告
  if (pending.length === 0) {
    say('與已通知過的版本相同，沒有變化。');
    return { category, status: 'unchanged', state, announcement };
  }

  // 步驟 3：呼叫一次 AI 產生摘要，所有 Webhook 共用；再依各 Webhook 的比對結果分組排版
  // （標題標籤與「（公告已更新）」由程式加上），商城可能有多則訊息
  const groups = new Map();
  for (const { target, change } of pending) {
    if (!groups.has(change.kind)) groups.set(change.kind, { targets: [] });
    groups.get(change.kind).targets.push(target);
  }
  for (const [kind, group] of groups) {
    say(`${CHANGE_MESSAGES[kind]}${config.targets.length > 1 ? `：${group.targets.map(describeTarget).join('、')}` : ''}`);
  }
  say('開始產生摘要…');
  const summary = await summarize(announcement, category, dryRun, say);
  for (const [kind, group] of groups) group.messages = buildDiscordMessages(announcement, summary, kind, category);
  const messages = groups.values().next().value.messages;

  // 預覽模式：只印出將發送的內容，不發送也不寫紀錄
  if (dryRun) {
    for (const [kind, group] of groups) {
      say(`--dry-run：不發送 Discord、不更新紀錄，${groups.size > 1 ? `${kind} 版本` : ''}預計發送 ${group.messages.length} 則訊息，內容如下：`);
      console.log(JSON.stringify(group.messages, null, 2));
    }
    return { category, status: 'dry-run', state, announcement, messages };
  }

  // 步驟 4：依序發送到每個需要通知的 Webhook；失敗的 Webhook 不記錄公告版本，仍在後續檢查範圍時才重試。
  // 步驟 5：該 Webhook 發送成功或沒有需通知的內容時記錄此版本，避免重複通知或每次重新摘要
  const version = { id: announcement.id, hash, title: announcement.title, publishedAt: announcement.publishedAt, url: announcement.url };
  const failedTargets = [];
  for (const [, group] of groups) {
    for (const target of group.targets) {
      const where = describeTarget(target);
      try {
        for (const payload of group.messages) {
          const post = await managePost('create', target.url, {
            payload, historyFile: config.discordMessagesFile,
            metadata: { announcementId: announcement.id, category, title: announcement.title },
            requestOptions: { timeoutMs: config.httpTimeoutMs },
          });
          say(`[${where}] Discord 訊息 ID：${post.messageId}`);
        }
        state = withTargetState(state, target.webhookId,
          recordNotified(targetState(state, target.webhookId), { ...version, notifiedAt: new Date().toISOString() }));
        await saveState(config.stateFile, state);
        say(group.messages.length > 0
          ? `[${where}] 已發送 ${group.messages.length} 則訊息到 Discord 並記錄此公告版本。`
          : `[${where}] 沒有需通知的內容，不發送 Discord，已記錄此公告版本。`);
      } catch (err) {
        logError(`[${label}][${where}] 發送失敗：${err.message}`);
        failedTargets.push(where);
      }
    }
  }
  return { category, status: failedTargets.length === pending.length ? 'failed' : 'sent', state, announcement, messages, failedTargets };
}

/**
 * 呼叫設定的 AI（Codex 或 Claude）產生摘要。
 *   - 購物商場（bm）：要求 AI 回覆 SHOP_SCHEMA 格式的 JSON，解析後回傳商品資料。
 *   - 維護（maintenance）：要求 AI 回覆 MAINTENANCE_SCHEMA，僅組成維護時間內文。
 *   - 其他分類：回傳 AI 寫好的文字摘要。
 * 正式模式下 AI 失敗（或回覆格式不符）就直接拋錯（不發送、不記錄）；
 * 預覽模式下則改用預覽內容代替，讓還沒安裝 AI CLI 時也能看到訊息長相。
 *
 * @param {object} announcement 公告資料（含標題、內文等）
 * @param {string} category 分類代碼，決定使用購物商場、維護時間或版本更新格式
 * @param {boolean} dryRun 是否為預覽模式
 * @param {(message: string) => void} say 帶分類名稱的紀錄輸出函式
 * @returns {Promise<string | {products: object[], otherChanges: string[]}>} 文字摘要或購物商場的商品資料
 */
async function summarize(announcement, category, dryRun, say) {
  const isShop = category === 'bm';
  const isMaintenance = category === 'maintenance';
  const prompt = buildSummaryPrompt(announcement, category);
  try {
    if (isMaintenance) {
      const reply = await summarizeWithAi(prompt, { ...config.ai, schema: MAINTENANCE_SCHEMA });
      return parseMaintenanceSummary(reply);
    }
    if (isShop) {
      const reply = await summarizeWithAi(prompt, { ...config.ai, schema: SHOP_SCHEMA });
      return parseShopSummary(reply, announcement.content);
    }
    return await summarizeWithAi(prompt, config.ai);
  } catch (err) {
    if (!dryRun) throw err;
    say(`${aiLabel(config.ai.provider)} 摘要失敗，--dry-run 改用預覽內容代替：${err.message}`);
    // 維護預覽失敗時也不能回退成公告全文，以免混入時間以外的內容。
    if (isMaintenance) return '維護時間：尚未取得（預覽模式）';
    return isShop
      ? previewShopSummary(announcement.content)
      : `（AI 摘要失敗，以下為公告開頭內容）\n\n${announcement.content.slice(0, 1500)}`;
  }
}
