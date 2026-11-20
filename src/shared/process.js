/**
 * 執行外部 CLI 的共用工具：透過 stdin 傳入資料，收集 stdout 與 stderr，並處理逾時。
 * Codex CLI 與 Claude Code CLI 執行器共用（codex.js、claude.js）。
 */
import { spawn } from 'node:child_process';

/**
 * 執行外部程式，透過 stdin 傳入資料，並收集 stdout 與 stderr。
 * 結束碼為 0 視為成功；找不到執行檔、非 0 結束碼、逾時都會拋出說明清楚的錯誤。
 * 非 0 結束碼的錯誤物件帶有 stdout，讓呼叫端可以從 CLI 的結構化輸出補充錯誤原因。
 *
 * @param {string} bin 執行檔
 * @param {string[]} args 參數
 * @param {object} options
 * @param {string} options.cwd 工作目錄
 * @param {string} options.input 要寫入 stdin 的內容
 * @param {number} options.timeoutMs 逾時時間
 * @param {string} options.label 錯誤訊息中的程式名稱，例如「Codex CLI」
 * @param {string} options.missingHint 找不到執行檔時的處理方式說明
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function runProcess(bin, args, { cwd, input, timeoutMs, label, missingHint }) {
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

    // 無法啟動程式（最常見是找不到執行檔，也就是還沒安裝 CLI）
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`找不到 ${label}（${bin}），${missingHint}`) : err);
    });

    // 程式結束：結束碼 0 為成功，否則附上失敗原因與 stderr 最後 2000 字，方便排查
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const reason = timedOut ? `超過 ${timeoutMs}ms 逾時` : signal ? `被 ${signal} 終止` : `結束碼 ${code}`;
      const error = new Error(`${label} 執行失敗：${reason}\n${stderr.trim().slice(-2000)}`);
      error.stdout = stdout;
      reject(error);
    });

    // 把內容寫入 stdin 並關閉，讓 CLI 知道輸入已結束。
    // CLI 提早結束時寫入 stdin 會發生 EPIPE，實際錯誤交由 close 事件回報
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
