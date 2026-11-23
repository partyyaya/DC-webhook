# Crypto 每日新聞

每天以 AI（Codex 或 Claude，見[共用設定](../README.md#共用設定)）網路搜尋前 24 小時的**美國經濟新聞**與**虛擬貨幣新聞**，各整理最重要的幾則繁體中文摘要（預設各 3 則）；發送前會先刪除前一次的新聞訊息，頻道只保留最新一天的內容。

[返回共用說明](../README.md) · [環境設置](../README.md#環境設置) · [共用 Webhook 工具](../README.md#共用-webhook-工具)

## 目錄

- [快速開始](#快速開始)
- [新聞內容](#新聞內容)
- [Discord 發布內容](#discord-發布內容)
- [預覽與手動操作](#預覽與手動操作)
- [自動排程](#自動排程)
- [多個 Webhook](#多個-webhook)
- [Webhook 名稱與頭像變更提醒](#webhook-名稱與頭像變更提醒)
- [設定參考](#設定參考)
- [問題排查](#問題排查)
- [運作機制與開發](#運作機制與開發)

## 快速開始

先完成根目錄 README 的[環境設置](../README.md#環境設置)，以下指令皆在專案根目錄執行。

Crypto 的所有設定（Webhook、排程、新聞內容、提醒、紀錄位置）集中在一份 JS 設定檔 `env/crypto.js`，可以直接寫註解。先複製範例：

```bash
cp env/crypto.example.js env/crypto.js
```

在 `webhooks` 填入 Crypto 頻道的 Webhook，其他欄位說明見範例檔 [env/crypto.example.js](../env/crypto.example.js) 與[設定參考](#設定參考)：

```js
export default {
  webhooks: [
    { name: '自己的伺服器', url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy' },
  ],
};
```

要發送到多個 Webhook 時，在 `webhooks` 繼續加，見[多個 Webhook](#多個-webhook)。

先預覽今天的新聞，不刪除、不發送 Discord，也不寫任何紀錄（AI 網路搜尋約需數分鐘）：

```bash
npm run crypto:preview
```

啟動常駐排程：

```bash
npm run crypto:schedule
```

預設**每天 08:00（台灣時間）發送一次**。啟動時如果今天 08:00 已過、且今天還沒發送，會立即補發一次。關閉終端機會停止排程，更多設定見[自動排程](#自動排程)。

Crypto 與 Artale 的排程彼此獨立，可以在兩個終端機分別執行 `npm run artale:schedule` 與 `npm run crypto:schedule`。同一個排程不要同時開兩份。

## 新聞內容

搜尋範圍為執行時間往前 24 小時。預設 08:00 執行時，涵蓋前一天 08:00 到當天 08:00，也就是完整的美股交易日與美國經濟數據公布時段。

| 分類 | 篇數（預設） | 選擇方式 |
| --- | --- | --- |
| 美國經濟新聞 | `news.economyCount`（3） | 最重要的新聞：聯準會利率與官員談話、CPI／PCE、就業、GDP、零售銷售、美債殖利率、美股大盤、財政與關稅政策等 |
| 虛擬貨幣新聞 | `news.coinCount`（最多 3） | `news.priorityCoins` 的**每個幣種至少 1 則**，預設 **BTC → ADA（Cardano）→ ETH**；篇數少於幣種數量時依幣種順序只取前幾個；剩餘名額只放重要新聞 |

篇數可設定 1～10 則（一則 Discord 訊息最多 10 張卡片）。

### 幣種優先順序

`news.priorityCoins` 的**填寫順序就是優先順序**，同時決定 AI 的搜尋順序與 Discord 的排列順序：

```js
news: {
  priorityCoins: ['BTC', 'ADA', 'ETH'], // BTC 最優先，其次 ADA，再來 ETH
},
```

- **每個幣種至少 1 則**：選該幣種在時間範圍內最重要的新聞。某個幣種完全沒有相關新聞時才會跳過。
- **篇數少於幣種數量**時，依填寫順序只取前幾個幣種。例如 `['BTC', 'ADA', 'ETH']` 搭配 2 則，只發 BTC、ADA 各 1 則；前面的幣種沒有任何新聞時，才由下一個幣種遞補。
- **篇數多於幣種數量**時，各幣種 1 則之後的剩餘名額只放真正重要的新聞（例如價格大幅波動、ETF 資金流向、監管、重大技術升級、交易所或專案重大事件），可以是清單幣種的第 2 則、其他幣種或整體市場新聞；沒有重要新聞就少發，不會用例行行情評論、價格預測或公關稿補滿。
- 發送前程式會檢查並依同樣順序排列：先替每個幣種保留 1 則，再依序放入其他新聞，最後依幣種順序排列，清單外的幣種排最後。
- 一則新聞同時涉及多個幣種時，以清單中最優先的幣種作為代表，例如同時提到 BTC 與 ETH 的新聞算作 BTC。某個幣種沒有以它為主的新聞時，才會改用有提到它的新聞。
- 可寫代號或常見全名（例如 `Cardano` 會換成 `ADA`、`NIGHT` 會換成 `MIDNIGHT`），大小寫不拘。冷門幣種可在 `src/crypto/news.js` 的 `COIN_NAMES` 補上說明，幫助 AI 辨認。

程式也會檢查 AI 的回覆：
- 缺少標題或網址不是 `http(s)` 的新聞會被捨棄；兩個分類重複的網址只保留一次。
- 找不到足夠的新聞時，只發送實際找到的數量；兩個分類都沒有新聞時視為失敗，不刪除前一天的新聞。

新聞由 AI 搜尋與摘要，內容可能有誤，重要資訊請點擊卡片標題查看原文。

## Discord 發布內容

整批新聞最上方顯示一次「經濟與虛擬貨幣新聞｜日期（週幾）」，各分類標題不重複日期。每個分類發送一則訊息，每篇新聞一張卡片；只有一個分類有新聞時，共用標題也會放在該分類最上方：

```text
# 經濟與虛擬貨幣新聞｜2026-11-18（週三）

## 🇺🇸 美國經濟新聞
┃ 1. 新聞標題（點擊開啟原文）
┃ 2～3 句繁體中文摘要
┃ Reuters｜2026-11-18 03:00

## 🪙 虛擬貨幣新聞
┃ 1. 新聞標題（點擊開啟原文）
┃ 2～3 句繁體中文摘要
┃ BTC・ETH｜CoinDesk｜2026-11-18 06:00
```

### 先刪除前一次的新聞

發送順序固定為：

1. 以 AI 搜尋並整理新聞。**搜尋失敗時不刪除舊訊息**，頻道保留前一次的新聞。
2. 刪除前一次發送的新聞訊息。訊息已被手動刪除（Discord 回傳 404）時略過；其他刪除失敗時**不發送今天的新聞**，等待重試。
3. 發送今天的新聞，並記錄訊息 ID，供下一次刪除。

只會刪除每日新聞流程自己發送、記錄在 `data/crypto/state.json` 的訊息；用 `npm run crypto:webhook` 手動發送的訊息不會被自動刪除。有多個 Webhook 時，每個 Webhook 各自刪除自己前一次發送的新聞。

## 預覽與手動操作

```bash
# 預覽：搜尋並印出 Discord JSON，不刪除、不發送、不寫紀錄
npm run crypto:preview

# 立即執行一次（不受排程星期與時間限制）；今天已發送過則略過
npm run crypto

# 今天已發送過仍重新發送：先刪除目前的新聞訊息，再重新搜尋並發送
npm run crypto -- --force
```

### 管理 Discord 發文

手動新增、修改、刪除或查詢訊息，固定使用 `env/crypto.js` 的 `webhooks` 與 `files.discordMessages`：

```bash
npm run crypto:webhook -- --help
npm run crypto:webhook -- list
npm run crypto:webhook -- delete --message-id 123456789012345678 --dry-run

# 有多個 Webhook 時，新增、修改、刪除需用 --webhook-id 指定（ID 可從 list 的 webhookId 查到）
npm run crypto:webhook -- create --webhook-id 1234567890 --content "測試" --dry-run
```

用法與[共用 Webhook 工具](../README.md#共用-webhook-工具)相同。

## 自動排程

修改 `env/crypto.js`、`env/.env.shared` 或程式後，需重新啟動常駐程式才會載入新設定。排程在 `env/crypto.js` 的 `schedule` 設定：

```js
schedule: {
  days: '1-7',            // 1=週一，7=週日；支援 '1-5'、'1,3,5' 等寫法
  time: '08:00',          // 每天發送時間
  timeZone: 'Asia/Taipei',
},
```

| 需求 | 設定範例 |
| --- | --- |
| 只在平日發送 | `days: '1-5'` |
| 每天 21:30 發送 | `time: '21:30'` |

排程行為：

| 情況 | 處理方式 |
| --- | --- |
| 啟動或電腦睡眠喚醒時，今天的發送時間已過、但今天還沒發送 | 立即補發一次；只補當天，不補前幾天 |
| 今天已發送過 | 重新啟動也不會重發，等到下一個排程日 |
| 發送失敗（AI、網路或 Discord 錯誤） | 30 分鐘後重試，同一天最多 3 次，之後等下一個排程日 |

是否已發送以紀錄檔判斷，因此停止後重新啟動、或先手動執行 `npm run crypto`，排程都不會在同一天重複發送。

需要保持執行時，可使用 `tmux` 或 `pm2`，例如：

```bash
pm2 start npm --name crypto -- run crypto:schedule
```

## 多個 Webhook

同一份新聞要發送到多個 Discord 頻道或伺服器時，在 `env/crypto.js` 的 `webhooks` 列出多個 Webhook：

```js
webhooks: [
  { name: '自己的伺服器', url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy' },
  {
    name: '朋友的伺服器', // 只是給自己辨識的備註
    url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy',
    webhookProfile: { personaPrompt: '你是一位冷靜的華爾街分析師' }, // 這個機器人自己的角色
  },
],
```

| 欄位 | 必填 | 用途 |
| --- | --- | --- |
| `url` | 是 | Discord Webhook 網址 |
| `name` | 否 | 給自己辨識用的備註，程式不會用它判斷任何事，只顯示在終端機紀錄中 |
| `webhookProfile` | 否 | 這個 Webhook 的[名稱與頭像變更提醒](#webhook-名稱與頭像變更提醒)：`personaPrompt`、`avatarMessage`、`nameMessage`，未填寫時不發送提醒 |

運作方式：

- 程式以網址中的 **Webhook ID** 區分每個 Webhook，不使用 `name`；欄位名稱寫錯（例如 `persona`）或網址重複時會直接報錯。
- 新聞只用 AI 搜尋一次，再依清單順序發送到每個 Webhook，費用與時間不會因 Webhook 變多而增加。
- 每個 Webhook 只能刪除自己發送的訊息，所以每日紀錄依 Webhook 分開：每個 Webhook 各自刪除自己前一天的新聞、各自記錄今天是否完成。
- 某個 Webhook 失敗（例如被對方刪除）不影響其他 Webhook；全部完成才算今天已發送，重試時只處理尚未完成的 Webhook。
- 修改清單後需重新啟動 `npm run crypto:schedule`。從清單移除的 Webhook，它最後一次發送的新聞不會被自動刪除。

## Webhook 名稱與頭像變更提醒

伺服器管理員可以在 Discord 頻道設定中更換這個 Webhook 的頭像與名稱，Discord 不會通知程式。Crypto 每次正式執行時（每天的發送時間，或執行 `npm run crypto`），程式會先查詢每個 Webhook 目前的名稱與頭像，與上次記錄比較；被更換時發送一則提醒。

每個機器人的定位不同，所以在 `env/crypto.js` 的 `webhooks` 中，**每個 Webhook 各自設定** `webhookProfile`，三者預設都是空的：

```js
webhooks: [
  {
    name: '自己的伺服器',
    url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy',
    webhookProfile: {
      // 角色設定提示詞：有填寫時由 AI 以角色口吻寫感想
      personaPrompt: '你是一隻傲嬌的貓，句尾會加「喵」',
      // 沒有提示詞時直接發送的固定文字
      avatarMessage: '我換新頭像了！',
      nameMessage: '我從「{oldName}」改名為「{name}」了！',
    },
  },
],
```

| 設定 | 發送內容 |
| --- | --- |
| 有角色設定提示詞 | 由 AI 以角色口吻寫感想，**取代**兩句固定文字。頭像被更換時把新頭像圖片附給 AI 看；名稱被更換時提供新舊名稱 |
| 沒有提示詞，有固定文字 | 直接發送固定文字；被更換的項目沒有設定文字時略過該行。`{name}` 會換成目前名稱、`{oldName}` 會換成變更前的名稱 |
| 三者都是空的（預設） | 不查詢、不發送 |

只換頭像或只換名稱時發送一行；兩者同時被更換時發送兩行，**第一行頭像、第二行名稱**。例如：

```text
紫底配白色的圖案還算順眼啦，才沒有偷偷期待換成貓咪頭像喵
從「Spidey Bot」改叫「新名字」也太隨便了吧，不過你叫的話，我還是會勉強回應喵
```

其他規則：

- 第一次檢查，或改用另一個 Webhook 時，只記錄目前的名稱與頭像，不發送。
- 記錄依 Webhook 存在 `data/crypto/webhook-profiles/<Webhook ID>.json`，與其他主題分開；即使和其他主題使用同一個 Webhook，也各自偵測、各自發送自己的提醒。
- 有[多個 Webhook](#多個-webhook) 時，每個 Webhook 各自偵測，用自己的角色設定與提醒文字。
- AI 只看新頭像，不比較新舊頭像；自訂頭像被移除時不附圖，會告訴 AI 已改回 Discord 預設頭像。
- AI 感想使用共用的 AI 設定（`AI_PROVIDER` 與對應的執行檔、模型）與設定檔的 `aiTimeoutMs` 逾時設定，不開放網路搜尋；實測一次約 10 秒。
- 查詢、AI 感想或發送失敗時不更新記錄，下次執行會再試；錯誤只記錄，不影響新聞的發送。
- 提示詞需要換行時，在 JS 字串中以 `\n` 表示換行，或改用反引號（`` ` ``）包住多行文字。
- 只能在程式執行時發現變更，也無法得知是誰更換的；預覽模式（`npm run crypto:preview`）不檢查。
- 提醒在當天新聞之前發送；它不列入每日新聞紀錄，隔天不會被刪除。

## 設定參考

Crypto 的所有設定集中在 `env/crypto.js`（範例見 [env/crypto.example.js](../env/crypto.example.js)），以 `export default` 匯出設定物件，可以直接寫註解；除了 `webhooks` 以外都是選填，未填寫時使用預設值。欄位名稱寫錯或型別不符時，程式會指出設定檔與欄位名稱並停止。

共用的 AI 設定（`AI_PROVIDER`、執行檔、模型、API key）放在 `env/.env.shared`，見[根目錄 README](../README.md#共用設定)。系統環境變數不會覆寫 Crypto 設定；只有 `CRYPTO_CONFIG_FILE` 可用來改用其他設定檔。

| 欄位 | 預設值 | 用途 |
| --- | --- | --- |
| `webhooks` | 無 | Webhook 清單，正式發送至少要一個；預覽不需要。每個 Webhook 的欄位見[多個 Webhook](#多個-webhook) |
| `webhooks[].webhookProfile.personaPrompt` | `''` | 該 Webhook 的角色設定提示詞；有填寫時由 AI 寫頭像與名稱的感想，見[變更提醒](#webhook-名稱與頭像變更提醒) |
| `webhooks[].webhookProfile.avatarMessage` | `''` | 沒有提示詞時，頭像被更換要發送的文字 |
| `webhooks[].webhookProfile.nameMessage` | `''` | 沒有提示詞時，名稱被更換要發送的文字；與頭像同時變更時為第二行 |
| `schedule.days` | `'1-7'` | 發送的星期 |
| `schedule.time` | `'08:00'` | 每天發送時間 |
| `schedule.timeZone` | `'Asia/Taipei'` | 排程與新聞時間使用的時區 |
| `news.priorityCoins` | `['BTC', 'ADA', 'ETH']` | 虛擬貨幣新聞的優先幣種，填寫順序即優先順序；也可寫成逗號分隔文字 |
| `news.economyCount` | `3` | 美國經濟新聞篇數（1～10） |
| `news.coinCount` | `3` | 虛擬貨幣新聞最多篇數（1～10） |
| `aiTimeoutMs` | `600000`（10 分鐘） | AI 搜尋與整理的逾時時間；網路搜尋較久，不使用共用的 `AI_TIMEOUT_MS`。舊欄位名稱 `codexTimeoutMs` 仍可使用 |
| `files.state` | `'data/crypto/state.json'` | 每日新聞紀錄（依 Webhook 分開） |
| `files.discordMessages` | `'data/crypto/discord-messages.jsonl'` | 訊息操作紀錄 |

紀錄檔的相對路徑以專案根目錄為準。

### 舊環境遷移

舊版的 `env/.env.crypto`（`CRYPTO_` 開頭的環境變數）已停用，檔案仍存在時程式會提醒搬移。先停止原排程，複製 [env/crypto.example.js](../env/crypto.example.js) 為 `env/crypto.js`，依下表填入原值後刪除 `env/.env.crypto`，再重新啟動：

| 舊設定 | 新設定檔欄位 |
| --- | --- |
| `CRYPTO_DISCORD_WEBHOOK_URL` | `webhooks: [{ url: '…' }]` |
| `CRYPTO_PERSONA_PROMPT`、`CRYPTO_AVATAR_CHANGED_MESSAGE`、`CRYPTO_NAME_CHANGED_MESSAGE` | 該 Webhook 的 `webhookProfile.personaPrompt`、`avatarMessage`、`nameMessage` |
| `CRYPTO_SCHEDULE_DAYS`、`_TIME`、`_TIMEZONE` | `schedule.days`、`time`、`timeZone` |
| `CRYPTO_PRIORITY_COINS`、`CRYPTO_ECONOMY_NEWS_COUNT`、`CRYPTO_COIN_NEWS_COUNT` | `news.priorityCoins`、`economyCount`、`coinCount` |
| `CRYPTO_CODEX_TIMEOUT_MS` | `aiTimeoutMs` |
| `CRYPTO_STATE_FILE`、`CRYPTO_DISCORD_MESSAGES_FILE` | `files.state`、`files.discordMessages` |

舊版單一 Webhook 的每日紀錄（`data/crypto/state.json`）會在下次正式執行時自動轉成依 Webhook 分開的格式，仍能刪除前一天的新聞。

## 問題排查

Node、AI CLI 與 Webhook 的共用問題，見[共用問題排查](../README.md#問題排查)。

| 現象 | 處理方式 |
| --- | --- |
| 尚未設定 Webhook | 確認 `env/crypto.js` 的 `webhooks` 已填入至少一個 Webhook |
| 「env/.env.crypto 已停用」 | 依[舊環境遷移](#舊環境遷移)搬到 `env/crypto.js` 後刪除舊檔 |
| 「env/crypto.js 的 … 有不支援的欄位」、型別錯誤或「網址無效」 | 依錯誤訊息指出的欄位或第 N 個 Webhook 修正設定檔，欄位名稱見[設定參考](#設定參考) |
| 手動發文顯示「設定了 N 個 Webhook，請用 --webhook-id 指定」 | 加上 `--webhook-id <ID>`，ID 可從 `list` 的 `webhookId` 查到 |
| 執行後顯示「今天的新聞已發送過」 | 需要重新發送時使用 `npm run crypto -- --force` |
| AI 逾時 | 調高設定檔的 `aiTimeoutMs` |
| 「刪除前一次的新聞訊息失敗，未發送今天的新聞」 | 確認 Webhook 沒有被更換或刪除；修正後執行 `npm run crypto` |
| 更換 Webhook 後舊新聞沒有被刪除 | 新 Webhook 無法刪除舊 Webhook 的訊息，請在 Discord 手動刪除 |
| 讀取狀態檔失敗，排程停止 | 紀錄檔損壞；確認內容或移除 `data/crypto/state.json` 後重新啟動（移除後前一次的新聞不會被自動刪除） |

## 運作機制與開發

### 設定與紀錄位置

```text
env/
├── crypto.example.js           # Crypto 設定檔範例
└── crypto.js                   # Crypto 正式設定檔，不納入版本控制
data/crypto/
├── state.json                  # 每個 Webhook 最後發送完成的日期，以及下次要刪除的新聞訊息 ID
├── discord-messages.jsonl      # 最近 100 筆訊息操作
└── webhook-profiles/           # 每個 Webhook 名稱與頭像的上次記錄，用來偵測更換
```

### 調整新聞內容與排版

| 想調整的內容 | 位置 |
| --- | --- |
| 每個分類的篇數、優先幣種 | `env/crypto.js` 的 `news`，見[設定參考](#設定參考) |
| 搜尋與撰寫規則 | `src/crypto/news.js` 的 `buildNewsPrompt()` |
| 提示詞中幣種的中文名稱、全名對照 | `src/crypto/news.js` 的 `COIN_NAMES`、`COIN_ALIASES` |
| 訊息標題、卡片顏色與版面 | `src/crypto/format.js` |
| 重試間隔與每日次數（與股票共用） | `src/shared/digest-scheduler.js` 的 `RETRY_MINUTES`、`MAX_ATTEMPTS_PER_DAY` |

### Crypto 模組位置

| 功能 | 位置 |
| --- | --- |
| 單次執行、常駐排程、手動發文入口 | `src/crypto/index.js`、`scheduler.js`、`webhook.js` |
| Crypto 設定 | `src/crypto/config.js` |
| 新聞搜尋與整理 | `src/crypto/run.js`、`news.js` |
| 每日流程（刪除 → 發送 → 記錄）、排程與紀錄（與股票共用；流程與紀錄也與技術指標共用） | `src/shared/daily-digest.js`、`digest-scheduler.js`、`digest-state.js` |
| Webhook 清單讀取（共用） | `src/shared/targets.js` |
| 專屬測試 | `test/crypto/` |

共用 Discord、AI 與排程工具的位置，見[共用專案結構](../README.md#專案結構)。
