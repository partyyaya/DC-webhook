/**
 * Lexical 轉 Markdown 模組：把官網公告正文的 Lexical 編輯器 JSON 轉成 Markdown 文字。
 *
 * 轉出來的文字有兩個用途：
 *   1. 計算內容雜湊值，判斷公告是否有變化（state.js）
 *   2. 當作提示詞的一部分交給 AI 產生摘要（summarize.js）
 *
 * Lexical 的文件是一棵樹，每個節點都有 type，例如：
 *   - 區塊節點：paragraph（段落）、heading（標題）、quote（引用）、list / listitem（清單）、
 *               table / tablerow / tablecell（表格）、horizontalrule（分隔線）
 *   - 行內節點：text（文字）、link（連結）、image（圖片）、linebreak（換行）
 * 只保留文字內容，不保留粗體、顏色等格式，避免單純改格式就被當成內容變化。
 */

// 屬於「行內」的節點類型：會跟前後的行內節點接在同一段文字裡，而不是獨立成一個區塊
const INLINE_TYPES = new Set(['text', 'linebreak', 'tab', 'link', 'autolink', 'image', 'hashtag', 'mention', 'emoji']);

/**
 * 把 Lexical 文件轉成 Markdown 文字。這是本模組對外的主要入口。
 *
 * @param {{root: object}} doc Lexical 文件物件
 * @returns {string} Markdown 文字；文件為空時回傳空字串
 */
export function lexicalToMarkdown(doc) {
  const root = doc?.root;
  if (!root) return '';
  // 轉換後再整理空白：去除行尾空白、把 3 行以上的空行壓成 1 行空行
  return renderNodes(root.children ?? [], 0)
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 檢查轉換結果是否完整：Lexical 文件中每一段文字，都必須出現在轉換後的 Markdown 裡。
 * 用來發現「轉換時默默漏掉內容」的情況（例如官網開始使用程式不認得的內容格式）。
 *
 * 比對時忽略空白，以及轉換時會加上的 Markdown 符號（引用的 >、表格跳脫的 \ 與 |），
 * 避免因為格式差異而誤判。
 *
 * @param {{root: object}} doc Lexical 文件物件
 * @param {string} markdown lexicalToMarkdown() 的轉換結果
 * @returns {string[]} 轉換結果中找不到的文字片段；空陣列代表內容完整
 */
export function findMissingText(doc, markdown) {
  const normalize = (text) => text.replace(/[\s>\\|]/g, '');
  const output = normalize(markdown);
  const missing = [];

  // 走訪整棵樹，檢查每個帶有文字的節點
  const walk = (node) => {
    if (typeof node.text === 'string') {
      const text = normalize(node.text);
      if (text && !output.includes(text)) missing.push(node.text.trim());
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(doc.root);

  return missing;
}

/**
 * 判斷節點是否為行內節點。
 * 除了已知的行內類型之外，沒有子節點但有 text 的未知節點也當成行內文字處理。
 *
 * @param {object} node Lexical 節點
 * @returns {boolean}
 */
function isInline(node) {
  return INLINE_TYPES.has(node.type) || (!node.children && typeof node.text === 'string');
}

/**
 * 轉換一串同層的節點（可能混合區塊節點與行內節點）。
 * 連續的行內節點會合併成一段文字；每個區塊之間以一個空行分隔。
 *
 * @param {object[]} nodes 同層的節點陣列
 * @param {number} depth 目前的清單巢狀層數，用來決定清單縮排
 * @returns {string}
 */
function renderNodes(nodes, depth) {
  const blocks = [];
  let inline = [];

  // 把目前累積的行內節點合併成一段文字，加入區塊清單
  const flushInline = () => {
    const text = renderInline(inline).trim();
    if (text) blocks.push(text);
    inline = [];
  };

  for (const node of nodes) {
    // 行內節點先累積起來，等遇到區塊節點或結尾時再一起輸出
    if (isInline(node)) {
      inline.push(node);
      continue;
    }
    // 遇到區塊節點：先輸出前面累積的行內文字，再轉換這個區塊
    flushInline();
    const block = renderBlock(node, depth);
    if (block) blocks.push(block);
  }
  flushInline();

  return blocks.join('\n\n');
}

/**
 * 轉換行內節點，接成一行文字。
 *
 * @param {object[]} nodes 行內節點陣列
 * @returns {string}
 */
function renderInline(nodes) {
  return nodes
    .map((node) => {
      switch (node.type) {
        // 換行與 Tab
        case 'linebreak':
          return '\n';
        case 'tab':
          return '\t';
        // 連結：轉成 [文字](網址)；文字與網址相同時只輸出網址
        case 'link':
        case 'autolink': {
          const label = renderInline(node.children ?? []).trim();
          if (!node.url) return label;
          return label && label !== node.url ? `[${label}](${node.url})` : node.url;
        }
        // 圖片：轉成 ![說明](圖片網址)
        case 'image':
          return node.src ? `![${node.alt ?? node.altText ?? ''}](${node.src})` : '';
        // 一般文字，或其他含有子節點的行內節點
        default:
          return node.children ? renderInline(node.children) : (node.text ?? '');
      }
    })
    .join('');
}

/**
 * 轉換單一區塊節點。
 *
 * @param {object} node 區塊節點
 * @param {number} depth 目前的清單巢狀層數
 * @returns {string} Markdown 文字；沒有內容時回傳空字串（呼叫端會略過）
 */
function renderBlock(node, depth) {
  const children = node.children ?? [];
  switch (node.type) {
    // 標題：h2 → "## 標題"，標題內的換行合併成空格
    case 'heading': {
      const level = Math.min(Number(String(node.tag ?? '').replace(/\D/g, '')) || 2, 6);
      const text = renderNodes(children, depth).replace(/\s*\n+\s*/g, ' ');
      return text ? `${'#'.repeat(level)} ${text}` : '';
    }
    // 引用：每一行前面加上 "> "（官網的引用區塊內可能還包著段落與清單）
    case 'quote': {
      const text = renderNodes(children, depth);
      return text
        ? text
            .split('\n')
            .map((line) => (line ? `> ${line}` : '>'))
            .join('\n')
        : '';
    }
    // 清單與表格交給專門的函式處理
    case 'list':
      return renderList(node, depth);
    case 'table':
      return renderTable(node);
    // 分隔線
    case 'horizontalrule':
      return '---';
    // 程式碼區塊
    case 'code':
      return `\`\`\`\n${renderInline(children)}\n\`\`\``;
    // 段落及其他未知的區塊：直接轉換其子節點
    default:
      return renderNodes(children, depth);
  }
}

/**
 * 轉換清單（含巢狀清單）。
 * Lexical 的巢狀清單是放在某個 listitem 的子節點裡，所以要把它挑出來，縮排一層後另外轉換。
 *
 * @param {object} list list 節點
 * @param {number} depth 巢狀層數，每一層縮排 2 個空格
 * @returns {string}
 */
function renderList(list, depth) {
  const indent = '  '.repeat(depth);
  const lines = [];
  let counter = list.start ?? 1;

  for (const item of list.children ?? []) {
    const itemChildren = item.children ?? [];

    // 這個項目本身的文字（排除巢狀清單）；有文字才輸出一行，並加上項目符號
    const text = renderNodes(
      itemChildren.filter((child) => child.type !== 'list'),
      depth + 1,
    );
    if (text) {
      const marker = listMarker(list.listType, item, counter++);
      // 項目文字有多行時，後續行要縮排對齊
      lines.push(`${indent}${marker} ${text.replace(/\n+/g, `\n${indent}   `)}`);
    }

    // 這個項目底下的巢狀清單，往內縮一層
    for (const nested of itemChildren.filter((child) => child.type === 'list')) {
      lines.push(renderList(nested, depth + 1));
    }
  }

  return lines.join('\n');
}

/**
 * 依清單類型決定項目符號。
 *   - number（編號清單）：「1.」「2.」…，優先使用 Lexical 記錄的編號
 *   - check（核取清單）：「- [x]」或「- [ ]」
 *   - 其他（項目清單）：「-」
 *
 * @param {string} listType 清單類型
 * @param {object} item listitem 節點
 * @param {number} counter 沒有記錄編號時使用的流水號
 * @returns {string}
 */
function listMarker(listType, item, counter) {
  if (listType === 'number') return `${item.value ?? counter}.`;
  if (listType === 'check') return item.checked ? '- [x]' : '- [ ]';
  return '-';
}

/**
 * 轉換表格成 Markdown 表格，第一列當作表頭。
 *
 * @param {object} table table 節點
 * @returns {string}
 */
function renderTable(table) {
  // 把每一列轉成字串陣列；跨欄（colSpan > 1）的儲存格後面補空白格，讓欄位對齊
  const rows = (table.children ?? [])
    .filter((row) => row.type === 'tablerow')
    .map((row) =>
      (row.children ?? [])
        .filter((cell) => cell.type === 'tablecell')
        .flatMap((cell) => [renderCell(cell), ...Array(Math.max((cell.colSpan ?? 1) - 1, 0)).fill('')]),
    );

  // 以最多欄位的那一列作為表格寬度；空表格不輸出
  const width = Math.max(0, ...rows.map((cells) => cells.length));
  if (width === 0) return '';

  // 組出「| a | b |」格式的每一列，欄位不足的補空字串；第一列後面加上分隔線
  const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line)].join('\n');
}

/**
 * 轉換單一儲存格的內容。
 * Markdown 表格的儲存格只能是一行，所以把換行換成空格，並跳脫會破壞表格的「|」符號。
 *
 * @param {object} cell tablecell 節點
 * @returns {string}
 */
function renderCell(cell) {
  return renderNodes(cell.children ?? [], 0)
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\|/g, '\\|');
}
