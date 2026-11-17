/**
 * 摘要模組：組出給 Codex 的提示詞，並以非互動模式呼叫 Codex CLI 產生繁體中文摘要。
 *
 * 依分類產生兩種摘要：
 *   - 版本更新（購物商場以外的分類）：Codex 直接寫出 Markdown 文字，放進一張 Discord 卡片。
 *   - 購物商場：Codex 依 SHOP_SCHEMA 回覆 JSON（每個商品的名稱、價格、內容物、圖片、連結與購買資訊），
 *     再由 discord.js 組成「先圖片、再文字」的多張卡片。
 *
 * 實際執行的指令相當於：
 *   codex exec --skip-git-repo-check --ephemeral --sandbox read-only --color never \
 *     --output-last-message <暫存檔> [--output-schema <JSON Schema 檔>] [--model <模型>] -
 * 提示詞從 stdin 傳入（最後的「-」），Codex 的最終回覆會寫到暫存檔再讀回來。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 「版本更新」公告的提示詞（購物商場以外的分類都使用這組）：整理這次版本更新了什麼
const UPDATE_PROMPT = {
  intro:
    '你是 Artale（楓之谷世界）官方公告的整理助手。請閱讀下方公告，以繁體中文（台灣用語）整理「這次版本更新了什麼」，給 Discord 玩家快速瀏覽。',
  rules: [
    '- 每個更新項目一行，以「- 」開頭，格式為「- **項目名稱**：說明」；公告有更新目錄時，依目錄的項目與順序整理。',
    '- 每個項目的說明不超過 50 字，簡單說明更新內容，保留關鍵的日期、時間與數值。',
    '- 若公告中該項目附有頁面連結，在該行最後附上 Markdown 連結，格式為「[連結文字](網址)」；只附公告裡實際出現的頁面連結，不要附圖片網址，也不要自行編造連結。',
    '- 只輸出上述內容，不要加開頭的主旨句、前言或結語；不要使用標題（#）或表格。',
    '- 全文不超過 3500 字。',
  ],
};

// 「購物商場」公告的提示詞：整理商品、價格、內容物、圖片、連結、購買條件、限購次數與販售時間。
// Codex 會依 SHOP_SCHEMA 回覆 JSON，由 discord.js 組成「先圖片、再文字」的卡片。
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

// 所有分類共用的撰寫規則
const COMMON_RULES = [
  '- 只根據公告內容撰寫，不要臆測或加入公告沒有的資訊。',
  '- 這是純文字整理工作，不需要執行任何指令或讀寫檔案。',
];

/**
 * 組出要交給 Codex 的提示詞：依分類選擇撰寫規則 + 公告標題、分類、發布時間 + 公告全文。
 * 想調整 Discord 訊息的內容或格式，修改上方的 UPDATE_PROMPT、SHOP_PROMPT、COMMON_RULES 即可。
 *
 * @param {object} announcement 公告資料（title、category、publishedAt、content）
 * @param {'new' | 'updated' | 'unchanged'} kind 比對結果；版本更新格式在 updated 時會要求在最前面註明已更新
 *   （購物商場格式由 discord.js 在公告卡片上註明，不需要 Codex 處理）
 * @param {string} [category] 分類代碼；bm（購物商場）使用商品 JSON 格式，其他分類使用版本更新格式
 * @returns {string} 提示詞
 */
export function buildSummaryPrompt(announcement, kind, category) {
  // 依分類選擇角色設定與專屬規則
  const isShop = category === 'bm';
  const { intro, rules } = isShop ? SHOP_PROMPT : UPDATE_PROMPT;
  const lines = [intro, '', '撰寫規則：', ...rules];

  // 同一篇公告內容被修改時，多加一條規則，讓讀者知道這是更新版
  if (kind === 'updated' && !isShop) {
    lines.push('- 這是先前已通知過的公告修改後的版本，請在最前面單獨加一行「（公告已更新）」。');
  }

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

/**
 * 解析並檢查 Codex 回覆的購物商場 JSON。
 * 格式不符時拋錯（下次排程會重試）；圖片與連結網址必須確實出現在公告原文中才採用，
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

/**
 * 呼叫 Codex CLI 產生摘要。
 *
 * @param {string} prompt 提示詞（buildSummaryPrompt() 的結果）
 * @param {object} options
 * @param {string} options.bin Codex CLI 執行檔名稱或路徑
 * @param {string} [options.model] 指定模型，空字串代表使用 Codex 設定檔的預設模型
 * @param {number} options.timeoutMs 執行逾時時間，超過會強制終止
 * @param {object} [options.schema] JSON Schema；有指定時要求 Codex 回覆符合此格式的 JSON（購物商場使用）
 * @returns {Promise<string>} 摘要文字（有指定 schema 時為 JSON 字串）
 */
export async function summarizeWithCodex(prompt, { bin, model, timeoutMs, schema }) {
  // 建立一個空的暫存資料夾作為 Codex 的工作目錄，讓它看不到專案檔案，也用來存放輸出檔
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'artale-codex-'));
  const outputFile = path.join(workDir, 'summary.md');

  // Codex CLI 參數：
  //   exec                    非互動模式，執行完就結束
  //   --skip-git-repo-check   允許在非 Git 資料夾（暫存資料夾）執行
  //   --ephemeral             不保存對話紀錄檔，避免每小時執行累積大量檔案
  //   --sandbox read-only     唯讀沙箱，Codex 無法修改任何檔案
  //   --color never           輸出不含顏色控制碼
  //   --output-last-message   把最終回覆（摘要）寫到指定檔案
  //   --output-schema         （購物商場）要求最終回覆符合指定的 JSON Schema
  //   -                       從 stdin 讀取提示詞
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '--output-last-message',
    outputFile,
  ];
  const schemaFile = schema ? path.join(workDir, 'schema.json') : null;
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (model) args.push('--model', model);
  args.push('-');

  try {
    // 有指定 JSON 格式時，先把 Schema 寫到暫存資料夾供 --output-schema 讀取
    if (schemaFile) await writeFile(schemaFile, JSON.stringify(schema));

    // 執行 Codex，優先讀取輸出檔中的摘要；讀不到時改用 stdout（Codex 也會把最終回覆印到 stdout）
    const { stdout } = await runProcess(bin, args, { cwd: workDir, input: prompt, timeoutMs });
    const fromFile = await readFile(outputFile, 'utf8').catch(() => '');
    const summary = (fromFile || stdout).trim();
    if (!summary) throw new Error('Codex CLI 沒有輸出任何摘要內容');
    return summary;
  } finally {
    // 不論成功或失敗都刪除暫存資料夾
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * 執行外部程式，透過 stdin 傳入資料，並收集 stdout 與 stderr。
 * 結束碼為 0 視為成功；找不到執行檔、非 0 結束碼、逾時都會拋出說明清楚的錯誤。
 *
 * @param {string} bin 執行檔
 * @param {string[]} args 參數
 * @param {object} options
 * @param {string} options.cwd 工作目錄
 * @param {string} options.input 要寫入 stdin 的內容
 * @param {number} options.timeoutMs 逾時時間
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runProcess(bin, args, { cwd, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // 逾時處理：時間到就強制終止程式。
    // 不用 spawn 的 timeout 選項：執行檔不存在時它的計時器不會被清除，程序會多等到逾時才結束
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // 收集程式的標準輸出與錯誤輸出
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });

    // 無法啟動程式（最常見是找不到執行檔，也就是還沒安裝 Codex CLI）
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error(
              `找不到 Codex CLI（${bin}），請先安裝並登入（npm install -g @openai/codex && codex login），或用 CODEX_BIN 指定執行檔路徑`,
            )
          : err,
      );
    });

    // 程式結束：結束碼 0 為成功，否則附上失敗原因與 stderr 最後 2000 字，方便排查
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const reason = timedOut ? `超過 ${timeoutMs}ms 逾時` : signal ? `被 ${signal} 終止` : `結束碼 ${code}`;
      reject(new Error(`Codex CLI 執行失敗：${reason}\n${stderr.trim().slice(-2000)}`));
    });

    // 把提示詞寫入 stdin 並關閉，讓 Codex 知道輸入已結束。
    // Codex 提早結束時寫入 stdin 會發生 EPIPE，實際錯誤交由 close 事件回報
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
