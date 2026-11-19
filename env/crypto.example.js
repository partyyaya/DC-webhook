// Crypto 設定檔範例：複製為 env/crypto.js 後修改（正式檔不納入版本控制）。
//
//   cp env/crypto.example.js env/crypto.js
//
// 這是 JS 檔，可以直接寫註解。除了 webhooks 以外都是選填，刪掉或不寫就使用預設值（即下方填的值）。
// 修改後需重新啟動 npm run crypto:schedule 才會生效。
// 共用的 Codex 設定（執行檔、模型、API key）放在 env/.env.shared。

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
        personaPrompt: '', // 角色設定提示詞，例如：'你是一隻傲嬌的貓，說話句尾會加「喵」'
        avatarMessage: '', // 頭像被更換時要說的話（沒有提示詞時使用）
        nameMessage: '', // 名稱被更換時要說的話（沒有提示詞時使用）；可使用 {name}（目前名稱）、{oldName}（變更前名稱）
      },
    },
    // {
    //   name: '朋友的伺服器',
    //   url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy',
    //   webhookProfile: { personaPrompt: '你是一位冷靜的華爾街分析師' }, // 每個機器人可以有不同的角色
    // },
  ],

  // ---- npm run crypto:schedule 常駐模式的排程 ----
  // 每天在指定時間搜尋前 24 小時的新聞，先刪除前一次的新聞訊息再發送；
  // 當天時間已過但尚未發送時，啟動或喚醒後會立即補發。
  schedule: {
    days: '1-7', // 星期幾：1～7（1=週一 … 7=週日），可寫 '1-5'、'1,3,5'
    time: '08:00', // 每天發送的時間（24 小時制 HH:MM）
    timeZone: 'Asia/Taipei',
  },

  // ---- 新聞內容 ----
  news: {
    // 虛擬貨幣新聞的優先幣種；填寫順序就是搜尋與排列的優先順序（排越前面越優先）。
    // 每個幣種至少 1 則（選該幣種最重要的新聞）；篇數少於幣種數量時，依填寫順序只取前幾個幣種。
    // 篇數多於幣種數量時，剩餘名額只放重要新聞，不會用不重要的新聞補滿。
    priorityCoins: ['BTC', 'ADA', 'ETH'],
    economyCount: 3, // 美國經濟新聞篇數（1～10）
    coinCount: 3, // 虛擬貨幣新聞最多篇數（1～10）
  },

  // Codex 網路搜尋與整理新聞的逾時時間（毫秒）
  codexTimeoutMs: 600000,

  // ---- 紀錄檔位置（相對路徑以專案根目錄為準）----
  files: {
    state: 'data/crypto/state.json', // 每個 Webhook 最後完成發送的日期與目前的新聞訊息 ID
    discordMessages: 'data/crypto/discord-messages.jsonl', // 最近 100 筆訊息操作；供 webhook list 查詢 ID，不含 token
  },
};
