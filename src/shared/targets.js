/**
 * Webhook 清單：檢查各主題設定檔中的 webhooks 陣列。
 *
 * 程式一律以網址中的 Webhook ID 區分各個 Webhook（紀錄、刪除、名稱與頭像偵測都依 ID）；
 * name 只是給使用者辨識用的備註，只會顯示在紀錄輸出中。
 */
import { parseWebhookUrl } from './discord.js';
import { section, text } from './topic-config.js';

// 每個 Webhook 可以使用的欄位；寫錯欄位名稱時直接報錯，避免設定被默默忽略
const FIELDS = ['name', 'url', 'webhookProfile'];
// 每個 Webhook 的名稱與頭像變更提醒設定（每個機器人的角色各自設定）
const PROFILE_FIELDS = ['personaPrompt', 'avatarMessage', 'nameMessage'];

/**
 * 檢查並整理 Webhook 清單。
 *
 * @param {any} list 設定檔中的 webhooks（未填寫時視為空清單）
 * @param {string} where 錯誤訊息使用的位置，例如「env/crypto.js 的 webhooks」
 * @returns {Array<{name: string, url: string, webhookId: string, webhookProfile: {personaPrompt: string, avatarMessage: string, nameMessage: string}}>}
 */
export function parseWebhookTargets(list, where) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${where} 必須是陣列`);
  const targets = list.map((item, index) => {
    const at = `${where} 第 ${index + 1} 個${typeof item?.name === 'string' && item.name ? `（${item.name}）` : ''}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${at} 必須是物件`);
    const unknown = Object.keys(item).filter((key) => !FIELDS.includes(key));
    if (unknown.length > 0) throw new Error(`${at} 有不支援的欄位：${unknown.join('、')}；可用欄位為 ${FIELDS.join('、')}`);
    for (const key of ['name', 'url']) {
      if (item[key] !== undefined && typeof item[key] !== 'string') throw new Error(`${at} 的 ${key} 必須是文字`);
    }
    const profile = section(item.webhookProfile, PROFILE_FIELDS, `${at} 的 webhookProfile`);
    // 驗證網址並取出 Webhook ID；錯誤訊息不包含網址，以免洩漏 token
    let url;
    try {
      url = parseWebhookUrl(item.url ?? '');
    } catch (err) {
      throw new Error(`${at} 的網址無效：${err.message}`);
    }
    return {
      name: item.name?.trim() ?? '',
      url: item.url,
      webhookId: url.pathname.match(/\/webhooks\/(\d+)\//)[1],
      webhookProfile: Object.fromEntries(PROFILE_FIELDS.map((key) => [key, text(profile[key], '', `${at} 的 webhookProfile.${key}`)])),
    };
  });

  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.webhookId)) throw new Error(`${where} 中有重複的 Webhook（ID ${target.webhookId}）`);
    seen.add(target.webhookId);
  }
  return targets;
}

/** 紀錄輸出用的 Webhook 名稱：有 name 時顯示「name（ID）」，否則只顯示 ID。 */
export function describeTarget({ name, webhookId }) {
  return name ? `${name}（${webhookId}）` : `Webhook ${webhookId}`;
}
