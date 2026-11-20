/**
 * 共用 Claude Code CLI 執行器，參數與回傳值和 codex.js 的 summarizeWithCodex() 相同，可互相替換。
 *
 * 實際執行的指令相當於：
 *   claude -p --output-format json --tools "" --no-session-persistence --strict-mcp-config --setting-sources "" \
 *     [--json-schema '<JSON Schema>'] [--model <模型>]
 * 提示詞從 stdin 傳入，CLI 的最終結果是一個 JSON 物件：
 *   result 為文字回覆；有指定 Schema 時，structured_output 為驗證過的 JSON；is_error 表示執行失敗。
 *
 *   - 網路搜尋：--tools 改為 WebSearch,WebFetch，並以 --allowedTools 免確認使用，其他工具一律不提供。
 *   - 附加圖片：CLI 沒有 --image，改用 stream-json 格式，把圖片（base64）與提示詞放在同一則訊息，
 *     輸出也變成一行一個事件，最後一行 type 為 result 的事件與 json 格式的結果相同。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from './process.js';

const LABEL = 'Claude Code CLI';
const MISSING_HINT = '請先安裝並登入（npm install -g @anthropic-ai/claude-code && claude auth login），或用 CLAUDE_BIN 指定執行檔路徑';

// 網路搜尋使用的內建工具
const WEB_TOOLS = 'WebSearch,WebFetch';

// 可附加的圖片格式（依副檔名判斷）
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/**
 * 呼叫 Claude Code CLI 產生摘要。
 *
 * @param {string} prompt 通知來源提供的摘要提示詞
 * @param {object} options
 * @param {string} options.bin Claude Code CLI 執行檔名稱或路徑
 * @param {string} [options.model] 指定模型（別名如 sonnet、opus 或完整模型 ID），空字串代表使用 CLI 預設模型
 * @param {number} options.timeoutMs 執行逾時時間，超過會強制終止
 * @param {object} [options.schema] JSON Schema；有指定時要求 Claude 回覆符合此格式的 JSON
 * @param {boolean} [options.webSearch=false] 開放 Claude 使用網路搜尋（需要查找最新資訊的來源使用）
 * @param {string[]} [options.images=[]] 要附加給 Claude 看的圖片檔路徑
 * @returns {Promise<string>} 摘要文字（有指定 schema 時為 JSON 字串）
 */
export async function summarizeWithClaude(prompt, { bin, model, timeoutMs, schema, webSearch = false, images = [] }) {
  const streaming = images.length > 0;

  // Claude Code CLI 參數：
  //   -p                          非互動模式，執行完就結束
  //   --output-format json        最終結果以 JSON 輸出；附圖時輸入輸出都改用 stream-json（需搭配 --verbose）
  //   --tools                     可使用的內建工具：預設全部關閉（""），網路搜尋時只提供 WebSearch、WebFetch
  //   --allowedTools              網路搜尋工具免確認（非互動模式下需要確認的工具會被拒絕）
  //   --no-session-persistence    不保存對話紀錄，避免每小時執行累積大量檔案
  //   --strict-mcp-config         不載入任何 MCP 伺服器
  //   --setting-sources ""        不讀取使用者與專案的設定檔，避免個人的 hooks、外掛影響自動執行
  //   --json-schema               要求最終回覆符合指定的 JSON Schema
  const args = [
    '-p',
    ...(streaming ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
    '--tools', webSearch ? WEB_TOOLS : '',
    ...(webSearch ? ['--allowedTools', WEB_TOOLS] : []),
    '--no-session-persistence',
    '--strict-mcp-config',
    '--setting-sources', '',
  ];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (model) args.push('--model', model);

  const input = streaming ? await imageMessage(prompt, images) : prompt;
  // 建立一個空的暫存資料夾作為工作目錄，讓 Claude 看不到專案檔案
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-claude-'));
  try {
    let stdout;
    try {
      ({ stdout } = await runProcess(bin, args, { cwd: workDir, input, timeoutMs, label: LABEL, missingHint: MISSING_HINT }));
    } catch (err) {
      // 失敗時 CLI 仍會輸出結果 JSON，錯誤原因（例如模型不存在、額度不足）放在 result
      const detail = describeError(findResult(err.stdout ?? ''));
      if (detail) err.message += `\n${detail}`;
      throw err;
    }
    return readReply(findResult(stdout), schema);
  } finally {
    // 不論成功或失敗都刪除暫存資料夾
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * 組出 stream-json 格式的使用者訊息：先放圖片（base64），再放提示詞。
 *
 * @param {string} prompt 提示詞
 * @param {string[]} images 圖片檔路徑
 * @returns {Promise<string>} 一行 JSON（結尾換行）
 */
async function imageMessage(prompt, images) {
  const content = [];
  for (const file of images) {
    const mediaType = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!mediaType) throw new Error(`${LABEL} 不支援此圖片格式：${file}（支援 ${Object.keys(IMAGE_TYPES).join('、')}）`);
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: (await readFile(file)).toString('base64') } });
  }
  content.push({ type: 'text', text: prompt });
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
}

/**
 * 從 CLI 輸出找出最終結果：json 格式整份就是結果；stream-json 每行一個事件，取最後一個 type 為 result 的事件。
 *
 * @param {string} stdout CLI 的標準輸出
 * @returns {object | null}
 */
function findResult(stdout) {
  const lines = stdout.trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event?.type === 'result') return event;
    } catch {
      // 不是 JSON 的行（例如警告訊息）略過
    }
  }
  return null;
}

/** 結果中的錯誤說明（result 文字與 errors 清單），最多 2000 字。 */
function describeError(result) {
  if (!result) return '';
  const messages = [result.result, ...(Array.isArray(result.errors) ? result.errors : [])]
    .map((message) => (typeof message === 'string' ? message : message ? JSON.stringify(message) : ''))
    .filter((message) => message.trim());
  return messages.join('\n').trim().slice(-2000);
}

/**
 * 檢查最終結果並取出回覆：有指定 Schema 時回傳 structured_output 的 JSON 字串，否則回傳文字。
 *
 * @param {object | null} result CLI 的最終結果
 * @param {object} [schema] JSON Schema
 * @returns {string}
 */
function readReply(result, schema) {
  if (!result) throw new Error(`${LABEL} 沒有輸出執行結果`);
  if (result.is_error || result.subtype !== 'success') {
    throw new Error(`${LABEL} 執行失敗：${result.subtype ?? '未知錯誤'}\n${describeError(result)}`.trim());
  }
  if (schema) {
    if (result.structured_output === undefined || result.structured_output === null) {
      throw new Error(`${LABEL} 沒有輸出符合 JSON Schema 的回覆`);
    }
    return JSON.stringify(result.structured_output);
  }
  const summary = typeof result.result === 'string' ? result.result.trim() : '';
  if (!summary) throw new Error(`${LABEL} 沒有輸出任何摘要內容`);
  return summary;
}
