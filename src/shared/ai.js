/**
 * 共用 AI 摘要入口：依共用設定 AI_PROVIDER 選擇 Codex CLI（預設）或 Claude Code CLI。
 * 各主題只呼叫 summarizeWithAi()，提示詞、輸出 Schema、網路搜尋與附圖等參數兩者相同。
 */
import { summarizeWithClaude } from './claude.js';
import { summarizeWithCodex } from './codex.js';

// 支援的 AI 與各自的環境變數：執行檔、模型分開設定，切換時不用改其他設定
const PROVIDERS = {
  codex: { label: 'Codex', binEnv: 'CODEX_BIN', defaultBin: 'codex', modelEnv: 'CODEX_MODEL', summarize: summarizeWithCodex },
  claude: { label: 'Claude', binEnv: 'CLAUDE_BIN', defaultBin: 'claude', modelEnv: 'CLAUDE_MODEL', summarize: summarizeWithClaude },
};

const DEFAULT_PROVIDER = 'codex';

/** 取得 AI 設定；名稱錯誤時拋錯並列出可用的名稱。 */
function providerOf(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`AI_PROVIDER 只能是 ${Object.keys(PROVIDERS).join(' 或 ')}，目前為「${name}」`);
  return provider;
}

/**
 * 從環境變數（含 env/.env.shared）讀取要使用的 AI、執行檔與模型。
 *
 * @param {object} [env=process.env]
 * @returns {{provider: string, bin: string, model: string}}
 */
export function aiSettingsFromEnv(env = process.env) {
  const name = (env.AI_PROVIDER || DEFAULT_PROVIDER).trim().toLowerCase();
  const provider = providerOf(name);
  return { provider: name, bin: env[provider.binEnv] || provider.defaultBin, model: env[provider.modelEnv] || '' };
}

/** 紀錄輸出用的 AI 名稱，例如「Codex」、「Claude」。 */
export function aiLabel(name = DEFAULT_PROVIDER) {
  return PROVIDERS[name]?.label ?? name;
}

/**
 * 呼叫設定的 AI 產生摘要。
 *
 * @param {string} prompt 通知來源提供的摘要提示詞
 * @param {object} options
 * @param {string} [options.provider='codex'] 使用的 AI：codex 或 claude
 * @param {string} options.bin CLI 執行檔名稱或路徑
 * @param {string} [options.model] 指定模型，空字串代表使用 CLI 預設模型
 * @param {number} options.timeoutMs 執行逾時時間
 * @param {object} [options.schema] JSON Schema；有指定時回覆為符合此格式的 JSON 字串
 * @param {boolean} [options.webSearch=false] 是否開放網路搜尋
 * @param {string[]} [options.images=[]] 要附加的圖片檔路徑
 * @returns {Promise<string>}
 */
export async function summarizeWithAi(prompt, { provider = DEFAULT_PROVIDER, ...options }) {
  return providerOf(provider).summarize(prompt, options);
}
