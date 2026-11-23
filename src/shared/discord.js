/** 共用 Discord Webhook API：查詢、新增、修改、刪除、網址驗證與限流重試。 */
const NO_MENTIONS = { parse: [] };

/**
 * 發送訊息到 Discord Webhook。
 * 遇到 429（發送太頻繁被限流）時，依 Discord 指定的等待時間後重試；其他錯誤直接拋出。
 *
 * @param {string} webhookUrl Discord Webhook 網址
 * @param {object} payload Discord 訊息內容
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000] 每次請求的逾時時間
 * @param {number} [options.maxAttempts=3] 最多嘗試次數（含第一次）
 * @returns {Promise<object>} Discord 回傳的訊息資料
 */
export async function sendToDiscord(webhookUrl, payload, options = {}) {
  return requestWebhook(webhookUrl, 'POST', undefined, payload, options);
}

/** 修改指定訊息；未提供的欄位由 Discord 保留。 */
export async function editDiscordMessage(webhookUrl, messageId, payload, options = {}) {
  return requestWebhook(webhookUrl, 'PATCH', messageId, payload, options);
}

/** 刪除指定訊息，只能操作此 Webhook 發送的訊息。 */
export async function deleteDiscordMessage(webhookUrl, messageId, options = {}) {
  return requestWebhook(webhookUrl, 'DELETE', messageId, undefined, options);
}

/**
 * 查詢 Webhook 目前的設定（在 Discord 頻道設定中可修改的名稱與頭像）。
 * 只回傳需要的欄位，不回傳 Discord 回應中的 token。
 *
 * @returns {Promise<{id: string, name: string, avatar: string | null}>} avatar 為頭像代碼，換頭像時會改變
 */
export async function getWebhookProfile(webhookUrl, options = {}) {
  const webhook = await requestWebhook(webhookUrl, 'GET', undefined, undefined, options);
  return { id: String(webhook?.id ?? ''), name: webhook?.name ?? '', avatar: webhook?.avatar ?? null };
}

/** 驗證 Webhook 路徑，避免將訊息刪除誤送成刪除 Webhook 本身；錯誤不包含 token。 */
export function parseWebhookUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Discord Webhook 網址格式錯誤'); }
  const hosts = ['discord.com', 'discordapp.com', 'canary.discord.com', 'ptb.discord.com'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password
    || !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname)) {
    throw new Error('請提供有效的 Discord Webhook 網址（包含 Webhook ID 與 token）');
  }
  const threadId = url.searchParams.get('thread_id');
  if (threadId !== null && !/^\d+$/.test(threadId)) throw new Error('thread_id 必須是數字 ID');
  url.hash = '';
  return url;
}

async function requestWebhook(webhookUrl, method, messageId, payload, { timeoutMs = 30_000, maxAttempts = 3 } = {}) {
  const url = parseWebhookUrl(webhookUrl);
  const action = { GET: '查詢', POST: '新增', PATCH: '修改', DELETE: '刪除' }[method];
  if (method === 'GET') {
    // 查詢 Webhook 本身，不需要 wait、thread_id 等訊息參數
    url.search = '';
  } else if (method === 'POST') {
    // 等 Discord 建立訊息後取得 message ID。
    url.searchParams.set('wait', 'true');
  } else {
    if (typeof messageId !== 'string' || !/^\d+$/.test(messageId)) throw new Error('訊息 ID 必須是數字字串');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/messages/${messageId}`;
    url.searchParams.delete('wait');
  }

  // PNG 等附件以 multipart 傳送；沒有附件時保持原本的 JSON 請求。
  // 每次重試重新建立 FormData，讓 429 重試與多個 Webhook 都可重用同一份二進位資料。
  const requestBody = () => {
    if (payload === undefined) return {};
    const { files = [], ...message } = payload;
    message.allowed_mentions = NO_MENTIONS;
    if (files.length === 0) return { headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) };
    const form = new FormData();
    message.attachments = [...(message.attachments ?? []), ...files.map((file, index) => ({ id: index, filename: file.name }))];
    form.set('payload_json', JSON.stringify(message));
    files.forEach((file, index) => form.set(`files[${index}]`, new Blob([file.data], { type: file.contentType ?? 'application/octet-stream' }), file.name));
    return { body: form };
  };

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        ...requestBody(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // 不沿用可能含有完整請求網址的底層錯誤。
      throw new Error(`Discord Webhook ${action}失敗：${err.name === 'TimeoutError' ? '請求逾時' : '無法連線'}`);
    }
    if (res.ok) return res.status === 204 ? null : res.json();

    // 被限流：從回應內容（retry_after，單位秒）或 Retry-After 標頭取得等待時間，等待後重試
    const body = await res.text();
    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfterSeconds = Number(parseJson(body)?.retry_after ?? res.headers.get('retry-after') ?? 1);
      const delay = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds : 1;
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(delay * 1000)));
      continue;
    }

    // 其他錯誤（例如 Webhook 網址錯誤、已被刪除），錯誤訊息不包含網址以免洩漏 Webhook token。
    // 附上 HTTP 狀態碼，讓呼叫端可區分「訊息已不存在（404）」與其他失敗。
    const code = parseJson(body)?.code;
    const error = new Error(`Discord Webhook ${action}失敗：HTTP ${res.status}${Number.isInteger(code) ? `（Discord 錯誤碼 ${code}）` : ''}`);
    error.status = res.status;
    throw error;
  }
}

/**
 * 嘗試把字串解析成 JSON，失敗時回傳 undefined 而不是拋錯。
 *
 * @param {string} text
 * @returns {any}
 */
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
