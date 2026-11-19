/**
 * 共用 Codex CLI 執行器，提示詞與輸出 Schema 由各通知來源提供。
 *
 * 實際執行的指令相當於：
 *   codex exec [--image <圖片檔>] --skip-git-repo-check --ephemeral --sandbox read-only --color never \
 *     --output-last-message <暫存檔> [--output-schema <JSON Schema 檔>] [--model <模型>] \
 *     [-c web_search="live"] -
 * 提示詞從 stdin 傳入（最後的「-」），Codex 的最終回覆會寫到暫存檔再讀回來。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 呼叫 Codex CLI 產生摘要。
 *
 * @param {string} prompt 通知來源提供的摘要提示詞
 * @param {object} options
 * @param {string} options.bin Codex CLI 執行檔名稱或路徑
 * @param {string} [options.model] 指定模型，空字串代表使用 Codex 設定檔的預設模型
 * @param {number} options.timeoutMs 執行逾時時間，超過會強制終止
 * @param {object} [options.schema] JSON Schema；有指定時要求 Codex 回覆符合此格式的 JSON
 * @param {boolean} [options.webSearch=false] 開放 Codex 使用即時網路搜尋（需要查找最新資訊的來源使用）
 * @param {string[]} [options.images=[]] 要附加給 Codex 看的圖片檔路徑
 * @returns {Promise<string>} 摘要文字（有指定 schema 時為 JSON 字串）
 */
export async function summarizeWithCodex(prompt, { bin, model, timeoutMs, schema, webSearch = false, images = [] }) {
  // 建立一個空的暫存資料夾作為 Codex 的工作目錄，讓它看不到專案檔案，也用來存放輸出檔
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'dcwebhook-codex-'));
  const outputFile = path.join(workDir, 'summary.md');

  // Codex CLI 參數：
  //   exec                    非互動模式，執行完就結束
  //   --image                 附加圖片；可接多個檔案，所以放在其他選項前面，避免把最後的「-」當成圖片
  //   --skip-git-repo-check   允許在非 Git 資料夾（暫存資料夾）執行
  //   --ephemeral             不保存對話紀錄檔，避免每小時執行累積大量檔案
  //   --sandbox read-only     唯讀沙箱，Codex 無法修改任何檔案
  //   --color never           輸出不含顏色控制碼
  //   --output-last-message   把最終回覆（摘要）寫到指定檔案
  //   --output-schema         要求最終回覆符合指定的 JSON Schema
  //   -c web_search="live"    開放即時網路搜尋（只有 webSearch 為 true 時加上）
  //   -                       從 stdin 讀取提示詞
  const args = [
    'exec',
    ...images.flatMap((image) => ['--image', image]),
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
  if (webSearch) args.push('-c', 'web_search="live"');
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
