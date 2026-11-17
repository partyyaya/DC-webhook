/**
 * 自訂錯誤類型模組。
 */

/**
 * 內容轉譯錯誤：把官網網頁轉成公告資料（列表、標題、發布時間、內文）的過程出錯。
 * 通常代表官網的網頁結構改變了，轉出來的內容不可信。
 *
 * 發生這種錯誤時（見 run.js、index.js、scheduler.js）：
 *   - 這次執行不會發送任何訊息到 Discord，直接結束（結束碼 2）
 *   - npm run schedule 的常駐排程也會停止，不再繼續輪詢
 *
 * 網路逾時、Codex 或 Discord 暫時失敗等「可能自己恢復」的錯誤不屬於這一類，
 * 那些錯誤只會跳過這次，下一個排程時間點再試。
 */
export class ContentParseError extends Error {
  /**
   * @param {string} message 錯誤原因
   * @param {{cause?: unknown}} [options] 原始錯誤
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'ContentParseError';
  }
}
