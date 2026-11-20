// Artale 設定檔範例：複製為 env/artale.js 後修改（正式檔不納入版本控制）。
//
//   cp env/artale.example.js env/artale.js
//
// 這是 JS 檔，可以直接寫註解。除了 webhooks 以外都是選填，刪掉或不寫就使用預設值（即下方填的值）。
// 修改後需重新啟動 npm run artale:schedule 才會生效。
// 共用的 AI 設定（使用 Codex 或 Claude、執行檔、模型、API key、摘要逾時）放在 env/.env.shared。

export default {
  // ---- Discord Webhook ----
  // 可以有多個；每個 Webhook 都會收到同樣的公告，各自記錄是否已通知。
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
    //   webhookProfile: { personaPrompt: '你是一位認真的冒險者公會櫃台小姐' }, // 每個機器人可以有不同的角色
    // },
  ],

  // ---- 要檢查的公告分類 ----
  // 有變化才發送，固定順序：維護 → 更新 → 購物商場；只讀第一頁：維護最新 1 篇、版本更新最新 3 篇、商城最新 1 篇
  // 可用值：update（更新）、bm（購物商場）、event（活動）、maintenance（維護）、sanction（制裁）、all（全部）
  newsCategories: ['maintenance', 'update', 'bm'],

  // ---- npm run artale:schedule 常駐模式的排程 ----
  // 啟動時先比對第一頁；之後在指定星期與時段內，每隔固定分鐘檢查一次（以下為每週二 08:20、09:20、…、17:20）
  schedule: {
    days: '2', // 星期幾：1～7（1=週一 … 7=週日），可寫 '2'、'1-5'、'2,4'
    start: '08:20', // 每天第一次檢查的時間（24 小時制 HH:MM）
    end: '17:20', // 每天最後一次檢查的時間，不支援跨越午夜
    intervalMinutes: 60, // 檢查間隔與回溯分鐘數；啟動檢查不受限制
    timeZone: 'Asia/Taipei',
  },

  // ---- 紀錄檔位置（相對路徑以專案根目錄為準）----
  files: {
    state: 'data/artale/state.json', // 已通知的公告版本（依 Webhook 分開記錄）
    discordMessages: 'data/artale/discord-messages.jsonl', // 最近 100 筆訊息操作；供 webhook list 查詢 ID，不含 token
  },
};
