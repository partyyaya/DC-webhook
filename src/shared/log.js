/**
 * 紀錄輸出模組：在每一行訊息前面加上本地時間，方便從 cron 紀錄檔追查每次執行的狀況。
 */

// 產生本地時間字串，格式為「2026-11-17 12:05:00」（借用瑞典語系剛好是這個格式）
const timestamp = () => new Date().toLocaleString('sv-SE', { hour12: false });

// 一般訊息，輸出到 stdout
export const log = (message) => console.log(`[${timestamp()}] ${message}`);

// 錯誤訊息，輸出到 stderr
export const logError = (message) => console.error(`[${timestamp()}] ${message}`);
