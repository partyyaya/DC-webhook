// 股票設定檔範例：複製為 env/stock.js 後修改（正式檔不納入版本控制）。
//
//   cp env/stock.example.js env/stock.js
//
// 這是 JS 檔，可以直接寫註解。除了 webhooks 以外都是選填，刪掉或不寫就使用預設值（即下方填的值）。
// 修改後需重新啟動 npm run stock:schedule 才會生效。
// 共用的 AI 設定（使用 Codex 或 Claude、執行檔、模型、API key）放在 env/.env.shared。

export default {
  // ---- Discord Webhook ----
  // 可以有多個；新聞只搜尋一次，再發送到每個 Webhook，各自刪除自己前一天的新聞。
  webhooks: [
    {
      name: '自己的伺服器', // 選填，給自己辨識用的備註，只會顯示在終端機紀錄中
      url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy', // 必填，Discord Webhook 網址

      // 選填，這個 Webhook（機器人）的名稱與頭像變更提醒：
      // 頭像或名稱在 Discord 被更換時，下次執行會發送一則提醒；兩者同時被更換時發送兩行：第一行頭像、第二行名稱。
      //   有角色設定提示詞    → 由 AI 以角色口吻看新頭像、新名稱寫感想，取代兩句固定文字
      //   沒有提示詞          → 直接發送兩句固定文字
      //   三者都是空的（預設）→ 不發送
      webhookProfile: {
        personaPrompt: '', // 角色設定提示詞，例如：'你是一位冷靜的資深分析師'
        avatarMessage: '', // 頭像被更換時要說的話（沒有提示詞時使用）
        nameMessage: '', // 名稱被更換時要說的話（沒有提示詞時使用）；可使用 {name}（目前名稱）、{oldName}（變更前名稱）
      },
    },
  ],

  // ---- npm run stock:schedule 常駐模式的排程 ----
  // 每天在指定時間搜尋前 24 小時的新聞，先刪除前一次的新聞訊息再發送；
  // 當天時間已過但尚未發送時，啟動或喚醒後會立即補發。
  schedule: {
    days: '1-7', // 星期幾：1～7（1=週一 … 7=週日），只在平日發送可寫 '1-5'
    time: '08:00', // 每天發送的時間（24 小時制 HH:MM）；08:00 已涵蓋美股收盤，且在台股開盤前
    timeZone: 'Asia/Taipei',
  },

  // ---- 新聞內容 ----
  // 股票清單的填寫順序就是搜尋與排列的優先順序（排越前面越優先）：
  //   每檔股票至少 1 則（選該股票最重要的新聞）；篇數少於股票數量時，依填寫順序只取前幾檔。
  //   篇數多於股票數量時，剩餘名額只放重要新聞，不會用不重要的新聞補滿。
  //   清單留空（[]）時，改選該市場最重要的新聞（大盤、權值股、政策等）。
  news: {
    twStocks: ['2330', '2345', '0050'], // 台股代號；0 開頭的代號（例如 '0050'）一定要加引號
    usStocks: ['NVDA', 'AAPL', 'MSFT'], // 美股代號，大小寫不拘；類別股寫 'BRK.B'
    twCount: 3, // 台股新聞最多篇數（0～10），0 = 不搜尋台股
    usCount: 3, // 美股新聞最多篇數（0～10），0 = 不搜尋美股；兩者不能都是 0
  },

  // AI 網路搜尋與整理新聞的逾時時間（毫秒）
  aiTimeoutMs: 600000,

  // ---- 紀錄檔位置（相對路徑以專案根目錄為準）----
  files: {
    state: 'data/stock/state.json', // 每個 Webhook 最後完成發送的日期與目前的新聞訊息 ID
    discordMessages: 'data/stock/discord-messages.jsonl', // 最近 100 筆訊息操作；供 webhook list 查詢 ID，不含 token
  },
};
