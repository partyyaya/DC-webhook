/**
 * Webhook 名稱與頭像變更偵測：查詢 Webhook 目前的名稱與頭像，與上次記錄比較，
 * 被更換時發送提醒，並更新記錄。
 *
 *   - 提醒內容依各主題的設定決定：
 *       有角色設定提示詞 → 由 AI 以角色口吻看新頭像與新名稱寫感想（取代固定文字）
 *       沒有提示詞       → 直接發送設定的固定文字（可使用 {name}、{oldName}）
 *       提示詞與兩句文字都沒有設定（預設） → 不查詢、不發送
 *   - 第一行為頭像、第二行為名稱；只變更其中一項時只發送該行。
 *   - 第一次檢查（或主題更換成另一個 Webhook）時只記錄目前狀態，不發送。
 *   - 記錄由各主題分開存放（例如 data/artale/webhook-profile.json），不同主題即使使用同一個 Webhook，
 *     也各自比較、各自發送自己的提醒，互不影響。
 *   - 查詢、AI 感想或發送失敗時不更新記錄，下次檢查會再試；錯誤只記錄，不影響各主題的發文流程。
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { summarizeWithAi } from './ai.js';
import { getWebhookProfile } from './discord.js';
import { log, logError } from './log.js';
import { managePost } from './posts.js';

// AI 感想的 JSON 格式：頭像與名稱各一句，沒有變更的項目填空字串
export const REACTION_SCHEMA = {
  type: 'object',
  properties: { avatar: { type: 'string' }, name: { type: 'string' } },
  required: ['avatar', 'name'],
  additionalProperties: false,
};

/**
 * 檢查 Webhook 名稱與頭像是否被更換，有變更時發送提醒。
 *
 * @param {string} webhookUrl Discord Webhook 網址
 * @param {object} options
 * @param {string} [options.personaPrompt] 角色設定提示詞；有設定時由 AI 寫感想，取代固定文字
 * @param {string} [options.avatarMessage] 沒有提示詞時，頭像變更要發送的文字；空字串代表不發送
 * @param {string} [options.nameMessage] 沒有提示詞時，名稱變更要發送的文字；空字串代表不發送
 * @param {object} [options.ai] AI 設定（provider、bin、model、timeoutMs），AI 感想使用
 * @param {string} options.profileFile 此主題的名稱與頭像記錄檔
 * @param {string} options.historyFile 發文紀錄檔
 * @param {object} [options.requestOptions] Discord 請求選項（逾時時間等）
 * @returns {Promise<{status: 'disabled' | 'recorded' | 'unchanged' | 'changed' | 'failed', avatarChanged?: boolean, nameChanged?: boolean, content?: string}>}
 */
export async function checkWebhookProfile(webhookUrl, {
  personaPrompt = '', avatarMessage = '', nameMessage = '', ai, profileFile, historyFile, requestOptions = {},
}) {
  if (!personaPrompt && !avatarMessage && !nameMessage) return { status: 'disabled' };
  try {
    const current = await getWebhookProfile(webhookUrl, requestOptions);
    if (!/^\d+$/.test(current.id)) throw new Error('Discord 未回傳有效的 Webhook ID');
    if (!profileFile) throw new Error('未指定 Webhook 名稱與頭像記錄檔');
    const previous = await loadProfile(profileFile);
    const profile = { webhookId: current.id, name: current.name, avatar: current.avatar, checkedAt: new Date().toISOString() };

    // 第一次檢查，或此主題已改用另一個 Webhook：只記錄目前狀態
    if (!previous || previous.webhookId !== current.id) {
      await saveProfile(profileFile, profile);
      log(`已記錄 Webhook 目前的名稱「${current.name}」與頭像，之後被更換時會發送提醒。`);
      return { status: 'recorded' };
    }

    const avatarChanged = previous.avatar !== current.avatar;
    const nameChanged = previous.name !== current.name;
    if (!avatarChanged && !nameChanged) return { status: 'unchanged' };
    const changes = [avatarChanged && '頭像', nameChanged && `名稱（「${previous.name}」→「${current.name}」）`].filter(Boolean).join('、');

    // 有角色設定時由 AI 寫感想，否則使用固定文字；第一行頭像、第二行名稱
    const lines = personaPrompt
      ? await reactWithAi({ personaPrompt, ai, current, previous, avatarChanged, nameChanged, requestOptions })
      : fixedLines({ avatarMessage, nameMessage, current, previous, avatarChanged, nameChanged });
    const content = lines.join('\n');

    if (content) {
      const post = await managePost('create', webhookUrl, {
        payload: { content }, historyFile, requestOptions, metadata: { title: 'Webhook 名稱／頭像變更提醒' },
      });
      log(`偵測到 Webhook ${changes}被更換，已發送${personaPrompt ? ' AI 感想' : '提醒'}（Discord 訊息 ID：${post.messageId}）。`);
    } else {
      log(`偵測到 Webhook ${changes}被更換，未設定對應的提醒文字，不發送。`);
    }
    await saveProfile(profileFile, profile);
    return { status: 'changed', avatarChanged, nameChanged, content };
  } catch (err) {
    logError(`Webhook 名稱與頭像檢查失敗，下次檢查再試：${err.message}`);
    return { status: 'failed' };
  }
}

/** 沒有角色設定時的固定文字；被更換的項目沒有設定文字時略過該行。 */
function fixedLines({ avatarMessage, nameMessage, current, previous, avatarChanged, nameChanged }) {
  const fill = (text) => text.replaceAll('{name}', current.name).replaceAll('{oldName}', previous.name);
  const lines = [];
  if (avatarChanged && avatarMessage) lines.push(fill(avatarMessage));
  if (nameChanged && nameMessage) lines.push(fill(nameMessage));
  return lines;
}

/**
 * 由 AI 以角色口吻寫感想：頭像被更換時附上新頭像圖片，名稱被更換時提供新舊名稱。
 * 被更換的項目沒有寫出感想時視為失敗，不發送也不更新記錄，下次再試。
 *
 * @returns {Promise<string[]>} 依序為頭像、名稱的感想（只包含被更換的項目）
 */
async function reactWithAi({ personaPrompt, ai, current, previous, avatarChanged, nameChanged, requestOptions }) {
  if (!ai?.bin) throw new Error('未提供 AI CLI 設定，無法產生 AI 感想');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-avatar-'));
  try {
    // 新頭像有自訂圖片時下載下來附給 AI；被移除（改回 Discord 預設頭像）時不附圖
    const images = [];
    if (avatarChanged && current.avatar) {
      const file = path.join(dir, 'avatar.png');
      await writeFile(file, await downloadAvatar(current.id, current.avatar, requestOptions));
      images.push(file);
    }
    const prompt = buildReactionPrompt({ personaPrompt, current, previous, avatarChanged, nameChanged });
    const reply = await summarizeWithAi(prompt, { ...ai, webSearch: false, schema: REACTION_SCHEMA, images });
    let data;
    try { data = JSON.parse(reply); } catch { throw new Error('AI 回覆的感想不是有效的 JSON'); }
    const clean = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : '');
    const lines = [];
    if (avatarChanged) lines.push(clean(data?.avatar));
    if (nameChanged) lines.push(clean(data?.name));
    if (lines.some((line) => !line)) throw new Error('AI 沒有寫出被更換項目的感想');
    log(`AI 感想：${lines.join(' / ')}`);
    return lines;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 組出 AI 感想的提示詞：角色設定 + 這次被更換的內容。
 *
 * @returns {string}
 */
export function buildReactionPrompt({ personaPrompt, current, previous, avatarChanged, nameChanged }) {
  const avatarStatus = !avatarChanged
    ? '沒有被更換'
    : current.avatar ? '被更換了，新頭像就是附上的圖片' : '自訂頭像被移除，改回 Discord 的預設頭像（沒有附圖）';
  return [
    '角色設定：',
    '"""',
    personaPrompt,
    '"""',
    '',
    '你就是上面角色設定中的角色，也是 Discord 頻道中發訊息的這個 Webhook。伺服器管理員剛剛更換了你的頭像或名稱。',
    '請以角色的口吻與個性，用繁體中文（台灣用語）對被更換的項目各寫一句感想，填入指定的 JSON 欄位。',
    '',
    `頭像：${avatarStatus}`,
    `名稱：${nameChanged ? `從「${previous.name}」改為「${current.name}」` : `沒有被更換（目前為「${current.name}」）`}`,
    '',
    '規則：',
    '- avatar：對新頭像的感想；頭像沒有被更換時填空字串。看得到圖片時，可以具體描述圖片內容。',
    '- name：對新名稱的感想；名稱沒有被更換時填空字串。',
    '- 每句不超過 100 字、不要換行，只寫感想本身，不要加引號、前綴或說明。',
    '- 這是純文字寫作工作，不需要執行任何指令或讀寫檔案。',
  ].join('\n');
}

/** 從 Discord CDN 下載 Webhook 的頭像圖片。 */
async function downloadAvatar(webhookId, avatar, { timeoutMs = 30_000 } = {}) {
  if (!/^\d+$/.test(webhookId) || !/^(a_)?[0-9a-f]+$/.test(avatar)) throw new Error('頭像資料格式不符');
  let res;
  try {
    res = await fetch(`https://cdn.discordapp.com/avatars/${webhookId}/${avatar}.png?size=256`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new Error(`下載新頭像失敗：${err.name === 'TimeoutError' ? '請求逾時' : '無法連線'}`);
  }
  if (!res.ok) throw new Error(`下載新頭像失敗：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 讀取記錄；檔案不存在時回傳 null，檔案損壞時拋錯，避免誤判成第一次檢查。 */
async function loadProfile(file) {
  try {
    const profile = JSON.parse(await readFile(file, 'utf8'));
    return { webhookId: String(profile?.webhookId ?? ''), name: String(profile?.name ?? ''), avatar: profile?.avatar ?? null };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`讀取 Webhook 記錄 ${file} 失敗：${err.message}`);
  }
}

/** 先寫暫存檔再改名覆蓋，避免寫到一半中斷時留下損壞的記錄。 */
async function saveProfile(file, profile) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(profile, null, 2)}\n`);
  await rename(tmpFile, file);
}
