/**
 * Artale 摘要規則：組出給 Codex 的提示詞，解析購物商場與維護摘要。
 *
 * 依分類產生三種摘要：
 *   - 版本更新（購物商場、維護以外的分類）：Codex 直接寫出 Markdown 文字，放進一張 Discord 卡片。
 *   - 維護：Codex 依 MAINTENANCE_SCHEMA 擷取維護時段，只輸出維護時間。
 *   - 購物商場：Codex 依 SHOP_SCHEMA 回覆 JSON（每個商品的名稱、價格、內容物、圖片、連結與購買資訊），
 *     再由 format.js 組成「先圖片、再文字」的多張卡片。
 *
 */

// 「版本更新」公告的提示詞（購物商場、維護以外的分類使用這組）。
const UPDATE_PROMPT = {
  intro:
    '你是 Artale（楓之谷世界）官方公告的整理助手。請閱讀下方公告，以繁體中文（台灣用語）整理「這次版本更新了什麼」，給 Discord 玩家快速瀏覽。',
  rules: [
    '- 每個更新項目一行，以「- 」開頭，格式為「- **項目名稱**：說明」；公告有更新目錄時，依目錄的項目與順序整理。',
    '- 每個更新項目之間空一行，避免內容過於擁擠。',
    '- 每個項目的說明不超過 50 字，簡單說明更新內容，保留關鍵的日期、時間與數值。',
    '- 若公告中該項目附有頁面連結，在該行最後附上 Markdown 連結，格式為「[連結文字](網址)」；只附公告裡實際出現的頁面連結，不要附圖片網址，也不要自行編造連結。',
    '- 只輸出上述內容，不要加開頭的主旨句、前言或結語；不要使用標題（#）或表格。',
    '- 全文不超過 3500 字。',
  ],
};

// 維護公告只擷取時間，不將補償、活動、維護項目等其他資訊放入 Discord 內文。
const MAINTENANCE_PROMPT = {
  intro: '你是 Artale（楓之谷世界）官方公告的整理助手。請閱讀下方維護公告，以繁體中文（台灣用語）擷取「維護時間」，填入指定的 JSON 欄位。',
  rules: [
    '- periods：維護時段的文字陣列，每個時段一筆，保留日期、開始時間、結束時間及原文註明的時區；未提供的年份、時間或時區不要自行推算或補上。',
    '- 有更正、延長、提前結束或實際完成時間時，採用公告最新說明；明確尚未確定的結束時間可保留「結束時間未定／延長中」等原意。',
    '- 有多個適用平台或服務的維護時段時分別列出，可用簡短的服務名稱區別，但只填與維護時間有關的資訊。',
    '- 不要填入維護項目、原因、補償、活動、注意事項、頁面連結或其他說明；不要把公告發布時間、獎勵領取日期或活動時間當成維護時間。',
    '- 公告沒有提供任何維護時間時，periods 填空陣列，不要臆測。',
  ],
};

// 「購物商場」公告的提示詞：整理商品、價格、內容物、圖片、連結、購買條件、限購次數與販售時間。
// Codex 會依 SHOP_SCHEMA 回覆 JSON，由 format.js 組成「先圖片、再文字」的卡片。
const SHOP_PROMPT = {
  intro:
    '你是 Artale（楓之谷世界）官方公告的整理助手。請閱讀下方的購物商場公告，整理「這次購物商場更新了哪些商品、需要多少 WC、禮包與內容物名稱」，以繁體中文（台灣用語）填入指定的 JSON 欄位。',
  rules: [
    '- products：依公告中的順序列出本次新增、更新或持續販售的商品（禮包、通行證、隨機寶箱等），每個商品填入：',
    '  - name：商品名稱。',
    '  - price：價格照公告的數字與單位（例如 1,320 WC）；有優惠時寫成「優惠價（原價 X WC，優惠 N%）」，例如「800 WC（原價 1,000 WC，優惠 20%）」；免費寫「免費」；公告沒寫價格時寫「價格未註明」。',
    '  - contents：這個商品直接包含的道具名稱，只寫名稱、不寫數量與說明，重複的名稱只列一次；不需要展開商品內附的箱子裡還有什麼。',
    '  - image：這個商品段落中對應的商品圖片網址，也就是公告裡「![](網址)」括號內的網址，通常是商品標題下方的第一張圖；沒有就填 null。',
    '  - links：這個商品段落中的頁面連結（公告裡「[文字](網址)」格式，不含圖片），text 填連結文字、url 填網址；沒有就填空陣列。',
    '  - purchaseConditions：購買條件，保留等級、任務、身分或其他資格限制；公告未註明時填空字串，不要填「公告未註明」。',
    '  - purchaseLimit：可購買次數，保留限購數量、計算對象（帳號／角色）、重置週期與重置時間；只有公告明確說明不限購時才能寫「不限購」，公告未註明時填空字串，不要填「公告未註明」。',
    '  - salePeriod：販售時間，保留開始與結束日期、時間、時區及「維護後／維護前」等說明；公告未註明時填空字串，不要填「公告未註明」，不要以公告發布時間代替。',
    '- 購買條件、可購買次數、販售時間也可能寫在共用說明中，僅在公告明確適用於該商品時套用；不要將道具使用條件或有效期限當成購買條件或販售時間。',
    '- 公告列為下架、刪除、移除、停止販售或結束販售的商品一律排除，不要放入 products、otherChanges 或其他商品的內容物、圖片與連結。仍在販售且僅註明未來販售截止時間的商品保留，並將截止時間填入 salePeriod。',
    '- otherChanges：其他仍適用的商場異動（例如常駐商品價格或內容物調整），不包含下架、刪除、移除或結束販售的資訊，每項一句、不超過 50 字；沒有就填空陣列。',
    '- 若公告只有上述應排除的商品或異動，products 與 otherChanges 都填空陣列，不要為了填滿欄位加入其他內容。',
    '- 圖片與連結網址必須完整照抄公告裡出現的網址，不要修改或自行編造。',
  ],
};

// 購物商場摘要的 JSON 格式（JSON Schema），透過 --output-schema 要求 Codex 的回覆必須符合
export const SHOP_SCHEMA = {
  type: 'object',
  properties: {
    products: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: 'string' },
          contents: { type: 'array', items: { type: 'string' } },
          image: { type: ['string', 'null'] },
          links: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, url: { type: 'string' } },
              required: ['text', 'url'],
              additionalProperties: false,
            },
          },
          purchaseConditions: { type: 'string' },
          purchaseLimit: { type: 'string' },
          salePeriod: { type: 'string' },
        },
        required: ['name', 'price', 'contents', 'image', 'links', 'purchaseConditions', 'purchaseLimit', 'salePeriod'],
        additionalProperties: false,
      },
    },
    otherChanges: { type: 'array', items: { type: 'string' } },
  },
  required: ['products', 'otherChanges'],
  additionalProperties: false,
};

export const MAINTENANCE_SCHEMA = {
  type: 'object',
  properties: { periods: { type: 'array', items: { type: 'string' } } },
  required: ['periods'],
  additionalProperties: false,
};

// 所有分類共用的撰寫規則
const COMMON_RULES = [
  '- 只根據公告內容撰寫，不要臆測或加入公告沒有的資訊。',
  '- 這是純文字整理工作，不需要執行任何指令或讀寫檔案。',
];

/**
 * 組出要交給 Codex 的提示詞：依分類選擇撰寫規則 + 公告標題、分類、發布時間 + 公告全文。
 * 想調整 Discord 訊息的內容或格式，修改上方的 UPDATE_PROMPT、SHOP_PROMPT、COMMON_RULES 即可。
 *
 * 提示詞只依分類決定，與比對結果（新公告／公告更新）無關，同一篇公告的摘要可共用給所有 Webhook；
 * 「（公告已更新）」等標示由 format.js 依各 Webhook 的比對結果加上，不交給 Codex 判斷。
 *
 * @param {object} announcement 公告資料（title、category、publishedAt、content）
 * @param {string} [category] bm 使用商品 JSON，maintenance 使用維護時段 JSON，其他使用版本更新格式
 * @returns {string} 提示詞
 */
export function buildSummaryPrompt(announcement, category) {
  // 依分類選擇角色設定與專屬規則
  const isShop = category === 'bm';
  const isMaintenance = category === 'maintenance';
  const { intro, rules } = isShop ? SHOP_PROMPT : isMaintenance ? MAINTENANCE_PROMPT : UPDATE_PROMPT;
  const lines = [intro, '', '撰寫規則：', ...rules];

  // 共用規則放在最後
  lines.push(...COMMON_RULES);

  // 公告的基本資訊與全文（用三個引號包起來，讓模型清楚分辨規則與公告內容）
  lines.push(
    '',
    `公告標題：${announcement.title}`,
    `分類：${announcement.category || '未分類'}`,
    `發布時間：${announcement.publishedAt}`,
    '',
    '公告內容（Markdown）：',
    '"""',
    announcement.content,
    '"""',
  );
  return lines.join('\n');
}

/** 只使用維護時段欄位組成內文，避免其他公告內容被帶入。 */
export function parseMaintenanceSummary(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Codex 回覆的維護時間不是有效的 JSON'); }
  if (!data || !Array.isArray(data.periods) || data.periods.some(period => typeof period !== 'string')) {
    throw new Error('Codex 回覆的維護時間格式不符');
  }
  const periods = [...new Set(data.periods.map(period => period.trim()).filter(Boolean))];
  return periods.length > 0 ? periods.map(period => `維護時間：${period}`).join('\n') : '維護時間：公告未註明';
}

/**
 * 解析並檢查 Codex 回覆的購物商場 JSON。
 * 格式不符時拋錯；圖片與連結網址必須確實出現在公告原文中才採用，
 * 避免 AI 編造或改錯網址，不符合的圖片改為 null、連結直接移除。
 *
 * @param {string} text Codex 的回覆
 * @param {string} content 公告原文（Markdown），用來核對網址
 * @returns {{products: Array<{name: string, price: string, contents: string[], image: string | null, links: Array<{text: string, url: string}>, purchaseConditions: string, purchaseLimit: string, salePeriod: string}>, otherChanges: string[]}}
 */
export function parseShopSummary(text, content) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Codex 回覆的購物商場資料不是有效的 JSON');
  }
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.otherChanges)) {
    throw new Error('Codex 回覆的購物商場資料格式不符');
  }

  // 去除空白、移除空字串與重複項目
  const cleanList = (list) => [
    ...new Set((Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())),
  ];
  // 網址必須是 http(s) 且出現在公告原文中
  const inContent = (url) => typeof url === 'string' && /^https?:\/\//.test(url) && content.includes(url);
  const purchaseInfo = (value) => (typeof value === 'string' && value.trim() !== '公告未註明' ? value.trim() : '');

  const products = data.products
    .filter((product) => typeof product?.name === 'string' && product.name.trim())
    .map((product) => ({
      name: product.name.trim(),
      price: typeof product.price === 'string' && product.price.trim() ? product.price.trim() : '價格未註明',
      contents: cleanList(product.contents),
      image: inContent(product.image) ? product.image : null,
      links: (Array.isArray(product.links) ? product.links : [])
        .filter((link) => inContent(link?.url))
        .map((link) => ({ text: String(link.text || link.url).trim(), url: link.url })),
      purchaseConditions: purchaseInfo(product.purchaseConditions),
      purchaseLimit: purchaseInfo(product.purchaseLimit),
      salePeriod: purchaseInfo(product.salePeriod),
    }));
  const otherChanges = cleanList(data.otherChanges);

  // 模型明確回覆兩個空陣列時，代表沒有需通知的內容；非空資料清理後全數無效仍視為錯誤。
  if (products.length === 0 && otherChanges.length === 0 && (data.products.length > 0 || data.otherChanges.length > 0)) {
    throw new Error('Codex 回覆的購物商場資料沒有任何商品或異動');
  }
  return { products, otherChanges };
}

/**
 * 預覽用：不經過 Codex，直接從公告原文粗略擷取每個商品的名稱、價格、圖片與連結。
 * 只在 --dry-run 且 Codex 無法使用時使用，讓還沒安裝 Codex 時也能預覽「先圖片、再文字」的版面；
 * 內容物以預覽提示代替，購買資訊需要 AI 整理，這裡留空省略。
 *
 * @param {string} content 公告原文（Markdown）
 * @returns {{products: object[], otherChanges: string[]}} 與 parseShopSummary() 相同的格式
 */
export function previewShopSummary(content) {
  const products = [];
  // 以「## 」標題切段，只處理「## 1. 商品名稱」這種編號標題的段落
  for (const section of content.split(/\n(?=## )/)) {
    const name = section.match(/^## \d+\.\s*(.+)/)?.[1]?.trim();
    if (!name) continue;
    // 預覽也省略明確標示為下架或刪除的商品段落，不用販售截止日期推測商品狀態。
    if (/下架|刪除|移除|停止販售|結束販售|販售結束|停售/.test(name)) continue;
    products.push({
      name,
      price: section.match(/販售價格：\s*([^\n]+)/)?.[1]?.trim() ?? '價格未註明',
      contents: ['（預覽模式：內容物需由 Codex 整理）'],
      image: section.match(/!\[[^\]]*\]\((https?:[^)\s]+)\)/)?.[1] ?? null,
      links: [...section.matchAll(/(?<!!)\[([^[\]]+)\]\((https?:[^)\s]+)\)/g)].map(([, text, url]) => ({ text, url })),
      purchaseConditions: '',
      purchaseLimit: '',
      salePeriod: '',
    });
  }
  return { products, otherChanges: [] };
}
