# 股票每日新聞

每天以 AI（Codex 或 Claude，見[共用設定](../README.md#共用設定)）網路搜尋前 24 小時的**台股新聞**與**美股新聞**，依設定的股票代號整理繁體中文摘要（預設各 3 則）；發送前會先刪除前一次的新聞訊息，頻道只保留最新一天的內容。任一市場的篇數設為 0 時，就不搜尋也不發送該市場。

[返回共用說明](../README.md) · [環境設置](../README.md#環境設置) · [共用 Webhook 工具](../README.md#共用-webhook-工具)

## 目錄

- [快速開始](#快速開始)
- [新聞內容](#新聞內容)
- [Discord 發布內容](#discord-發布內容)
- [預覽與手動操作](#預覽與手動操作)
- [自動排程](#自動排程)
- [多個 Webhook 與變更提醒](#多個-webhook-與變更提醒)
- [設定參考](#設定參考)
- [問題排查](#問題排查)
- [運作機制與開發](#運作機制與開發)

## 快速開始

先完成根目錄 README 的[環境設置](../README.md#環境設置)，以下指令皆在專案根目錄執行。

股票的所有設定（Webhook、排程、股票代號與篇數、提醒、紀錄位置）集中在 `env/stock.js`，可以直接寫註解。先複製範例：

```bash
cp env/stock.example.js env/stock.js
```

填入 Webhook 與要追蹤的股票代號，其他欄位說明見範例檔 [env/stock.example.js](../env/stock.example.js) 與[設定參考](#設定參考)：

```js
export default {
  webhooks: [
    { name: '自己的伺服器', url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy' },
  ],
  news: {
    twStocks: ['2330', '2317', '0050'], // 台股代號
    usStocks: ['NVDA', 'AAPL', 'TSLA'], // 美股代號
    twCount: 3, // 台股新聞最多 3 則；0 = 不搜尋台股
    usCount: 3, // 美股新聞最多 3 則；0 = 不搜尋美股
  },
};
```

先預覽今天的新聞，不刪除、不發送 Discord，也不寫任何紀錄（AI 網路搜尋約需數分鐘）：

```bash
npm run stock:preview
```

啟動常駐排程：

```bash
npm run stock:schedule
```

預設**每天 08:00（台灣時間）發送一次**。啟動時如果今天 08:00 已過、且今天還沒發送，會立即補發一次。股票、Crypto 與 Artale 的排程彼此獨立，可以在不同終端機同時執行；同一個排程不要同時開兩份。

## 新聞內容

搜尋範圍為執行時間往前 24 小時。預設 08:00 執行時，涵蓋前一天的台股交易時段與當天凌晨收盤的美股交易時段，並在台股 09:00 開盤前送達。

| 市場 | 篇數（預設） | 選擇方式 |
| --- | --- | --- |
| 台股 | `news.twCount`（最多 3） | `news.twStocks` 的**每檔股票至少 1 則**，預設 **2330 → 2317 → 2454**；清單為空時選台股最重要的新聞（加權指數、外資買賣超、權值股、央行與金管會政策等） |
| 美股 | `news.usCount`（最多 3） | `news.usStocks` 的**每檔股票至少 1 則**，預設 **NVDA → AAPL → MSFT**；清單為空時選美股最重要的新聞（三大指數、聯準會、大型科技股、重要財報等） |

篇數可設定 0～10 則（一則 Discord 訊息最多 10 張卡片）：

- **篇數設為 0**：不搜尋該市場，提示詞與 AI 回覆格式都不包含它，也不發送該市場的訊息。
- 兩個市場不能都是 0，否則程式會指出設定錯誤並停止。

### 優先來源與其他新聞

由 AI 網路搜尋先檢查以下公開來源，再從其他可信來源補足；來源規則集中在 `src/stock/news.js` 的 `MARKETS`，套用於 Codex 與 Claude，不需要新增設定：

| 市場 | 優先來源 | 其他來源 |
| --- | --- | --- |
| 台股 | [郭哲榮（哲哲）的官方公開 Telegram](https://t.me/s/a178178)，以及能取得公開字幕或完整相關文字的官方影片 | 經濟日報、工商時報、中央社、鉅亨網、MoneyDJ、公開資訊觀測站與公司公告 |
| 美股 | [Better Leaf 好葉官網](https://www.betterleaf.co/)與[官方 YouTube](https://www.youtube.com/@betterleaf)、[ARK Invest 官方研究](https://www.ark-invest.com/articles)與[基金公開資料](https://www.ark-funds.com/) | Reuters、Bloomberg、CNBC、WSJ、AP、MarketWatch、公司公告與 SEC 文件 |

仍先滿足設定的股票清單與篇數，同樣符合條件時優先採用指定來源；剩餘名額再挑選其他來源的重要內容。這三個來源不各自保留名額，也不額外增加篇數；沒有在前 24 小時內發布、與指定股票無關或無法讀取的內容會略過，改找其他來源。搜尋收錄或頁面擷取時間不算發布時間，不會拿舊文章當成今日資訊。

個人或機構分析的標題加上「【觀點】」與發布者名稱，摘要以「郭哲榮認為」「ARK Invest 指出」等方式表達，保留條件與不確定性；卡片底部顯示原始發布者，點擊標題開啟該篇文章、貼文或影片，而非來源首頁。新聞報導維持原本格式，同一事件不重複收錄。只讀得到影片標題、縮圖或宣傳文案時，不推測完整影片內容。

優先保留具體個股、產業與市場分析及其理由，排除招生、課程或開戶廣告、聯絡電話、入群邀請、獲利炫耀與重複宣傳。ARK 的研究預測不視為已發生的事實；提及買賣須能核對官方公開紀錄的日期、基金、股票與方向，不從單日持倉或權重變化推算交易。

### 股票代號與優先順序

股票清單的**填寫順序就是優先順序**，同時決定 AI 的搜尋順序與 Discord 的排列順序：

- **每檔股票至少 1 則**：選該股票在時間範圍內最重要的新聞。某檔股票完全沒有相關新聞時才會跳過。
- **篇數少於股票數量**時，依填寫順序只取前幾檔。例如 `['2330', '2317', '2454']` 搭配 2 則，只發 2330、2317 各 1 則；前面的股票沒有任何新聞時，才由下一檔遞補。
- **篇數多於股票數量**時，各股票 1 則之後的剩餘名額只放重要新聞，或優先來源有新資訊與明確理由的個股／產業分析，可以是清單股票的第 2 則、其他個股或大盤內容。沒有重要內容就少發，不用沒有新資訊的盤勢評論、單純目標價喊話或公關稿補滿。
- 一則新聞同時涉及多檔股票時，以清單中最優先的股票作為代表。
- **清單留空**（`[]`）時，改選該市場最重要的新聞。

代號寫法：

| 市場 | 寫法 | 範例 |
| --- | --- | --- |
| 台股 | 4～6 位數字，可帶一個英文字母；`.TW`、`.TWO` 後綴會自動去掉 | `'2330'`、`'0050'`、`'00878'`、`'00679B'`、`'6488.TWO'` |
| 美股 | 1～5 個英文字母，大小寫不拘；類別股用點號或連字號 | `'NVDA'`、`'aapl'`、`'BRK.B'`、`'BRK-B'` |

**0 開頭的台股代號一定要加引號**（例如 `'0050'`）：JS 中 `0050` 不是合法的數字寫法，設定檔會無法載入。其他代號寫成數字（`2330`）或逗號分隔文字（`'2330,2317'`）也可以。

程式也會檢查 AI 的回覆：

- 缺少標題或網址不是 `http(s)` 的新聞會被捨棄；兩個市場重複的網址只保留一次。
- 找不到足夠的新聞時，只發送實際找到的數量；所有市場都沒有新聞時視為失敗，不刪除前一天的新聞。

新聞由 AI 搜尋與摘要，內容可能有誤，也不構成投資建議；重要資訊請點擊卡片標題查看原文。

## Discord 發布內容

整批新聞最上方顯示一次「股票新聞｜日期（週幾）」，各市場標題不重複日期。每個市場發送一則訊息，每篇新聞一張卡片，卡片底部顯示新聞涉及的股票代號；只有一個市場有新聞時，共用標題也會放在該市場最上方：

```text
# 股票新聞｜2026-11-20（週五）

## 🇹🇼 台股新聞
┃ 1. 新聞標題（點擊開啟原文）
┃ 2～3 句繁體中文摘要
┃ 2330｜經濟日報｜2026-11-19 14:00

## 🇺🇸 美股新聞
┃ 1. 新聞標題（點擊開啟原文）
┃ 2～3 句繁體中文摘要
┃ NVDA｜Reuters｜2026-11-20 05:30
```

發送順序與 Crypto 相同：

1. 以 AI 搜尋並整理新聞。**搜尋失敗時不刪除舊訊息**，頻道保留前一次的新聞。
2. 刪除前一次發送的新聞訊息。訊息已被手動刪除（Discord 回傳 404）時略過；其他刪除失敗時**不發送今天的新聞**，等待重試。
3. 發送今天的新聞，並記錄訊息 ID，供下一次刪除。

只會刪除每日新聞流程自己發送、記錄在 `data/stock/state.json` 的訊息；用 `npm run stock:webhook` 手動發送的訊息不會被自動刪除。

## 預覽與手動操作

```bash
# 預覽：搜尋並印出 Discord JSON，不刪除、不發送、不寫紀錄
npm run stock:preview

# 立即執行一次（不受排程星期與時間限制）；今天已發送過則略過
npm run stock

# 今天已發送過仍重新發送：先刪除目前的新聞訊息，再重新搜尋並發送
npm run stock -- --force
```

手動新增、修改、刪除或查詢訊息，固定使用 `env/stock.js` 的 `webhooks` 與 `files.discordMessages`，用法與[共用 Webhook 工具](../README.md#共用-webhook-工具)相同：

```bash
npm run stock:webhook -- --help
npm run stock:webhook -- list
```

## 自動排程

修改 `env/stock.js`、`env/.env.shared` 或程式後，需重新啟動常駐程式才會載入新設定。排程在 `env/stock.js` 的 `schedule` 設定：

```js
schedule: {
  days: '1-7',            // 1=週一，7=週日；只在平日發送可寫 '1-5'
  time: '08:00',          // 每天發送時間
  timeZone: 'Asia/Taipei',
},
```

| 情況 | 處理方式 |
| --- | --- |
| 啟動或電腦睡眠喚醒時，今天的發送時間已過、但今天還沒發送 | 立即補發一次；只補當天，不補前幾天 |
| 今天已發送過 | 重新啟動也不會重發，等到下一個排程日 |
| 發送失敗（AI、網路或 Discord 錯誤） | 30 分鐘後重試，同一天最多 3 次，之後等下一個排程日 |

需要保持執行時，可使用 `tmux` 或 `pm2`，例如：

```bash
pm2 start npm --name stock -- run stock:schedule
```

## 多個 Webhook 與變更提醒

`webhooks` 可以列出多個 Webhook，寫法與規則和 Crypto 相同，見 Crypto 文件的[多個 Webhook](crypto.md#多個-webhook)：新聞只搜尋一次，再依清單順序發送到每個 Webhook；每個 Webhook 各自刪除自己前一天的新聞、各自記錄今天是否完成。

每個 Webhook 也可以設定 `webhookProfile`（`personaPrompt`、`avatarMessage`、`nameMessage`），在名稱或頭像被更換時發送提醒，規則見 Crypto 文件的 [Webhook 名稱與頭像變更提醒](crypto.md#webhook-名稱與頭像變更提醒)。股票的記錄存在 `data/stock/webhook-profiles/<Webhook ID>.json`，與其他主題分開；AI 感想使用設定檔的 `aiTimeoutMs` 逾時設定。

## 設定參考

股票的所有設定集中在 `env/stock.js`（範例見 [env/stock.example.js](../env/stock.example.js)），以 `export default` 匯出設定物件；除了 `webhooks` 以外都是選填，未填寫時使用預設值。欄位名稱寫錯、型別不符或代號格式錯誤時，程式會指出設定檔與欄位名稱並停止。

共用的 AI 設定（`AI_PROVIDER`、執行檔、模型、API key）放在 `env/.env.shared`，見[根目錄 README](../README.md#共用設定)。系統環境變數不會覆寫股票設定；只有 `STOCK_CONFIG_FILE` 可用來改用其他設定檔。

| 欄位 | 預設值 | 用途 |
| --- | --- | --- |
| `webhooks` | 無 | Webhook 清單，正式發送至少要一個；預覽不需要 |
| `webhooks[].webhookProfile` | 全部空白 | 該 Webhook 的名稱與頭像變更提醒，見[多個 Webhook 與變更提醒](#多個-webhook-與變更提醒) |
| `schedule.days` | `'1-7'` | 發送的星期 |
| `schedule.time` | `'08:00'` | 每天發送時間 |
| `schedule.timeZone` | `'Asia/Taipei'` | 排程與新聞時間使用的時區 |
| `news.twStocks` | `['2330', '2317', '2454']` | 台股代號，填寫順序即優先順序；可留空（`[]`）改選台股重要新聞 |
| `news.usStocks` | `['NVDA', 'AAPL', 'MSFT']` | 美股代號，填寫順序即優先順序；可留空（`[]`）改選美股重要新聞 |
| `news.twCount` | `3` | 台股新聞最多篇數（0～10）；0 = 不搜尋台股 |
| `news.usCount` | `3` | 美股新聞最多篇數（0～10）；0 = 不搜尋美股。兩者不能都是 0 |
| `aiTimeoutMs` | `600000`（10 分鐘） | AI 搜尋與整理的逾時時間；網路搜尋較久，不使用共用的 `AI_TIMEOUT_MS` |
| `files.state` | `'data/stock/state.json'` | 每日新聞紀錄（依 Webhook 分開） |
| `files.discordMessages` | `'data/stock/discord-messages.jsonl'` | 訊息操作紀錄 |

紀錄檔的相對路徑以專案根目錄為準。

## 問題排查

Node、AI CLI 與 Webhook 的共用問題，見[共用問題排查](../README.md#問題排查)。

| 現象 | 處理方式 |
| --- | --- |
| 尚未設定 Webhook | 確認 `env/stock.js` 的 `webhooks` 已填入至少一個 Webhook |
| 「news.twStocks 格式錯誤」或「news.usStocks 格式錯誤」 | 依[代號寫法](#股票代號與優先順序)修正；0 開頭的台股代號要加引號 |
| 「無法載入 env/stock.js：Octal literals are not allowed in strict mode」 | 台股代號寫成了 `0050` 這種數字，改成 `'0050'` |
| 「twCount 與 usCount 不能都是 0」 | 至少讓一個市場的篇數大於 0 |
| 某檔股票沒有出現在新聞中 | 該股票在前 24 小時內沒有找到相關新聞，或篇數少於股票數量而只取了前幾檔 |
| 執行後顯示「今天的新聞已發送過」 | 需要重新發送時使用 `npm run stock -- --force` |
| AI 逾時 | 調高設定檔的 `aiTimeoutMs` |
| 「刪除前一次的新聞訊息失敗，未發送今天的新聞」 | 確認 Webhook 沒有被更換或刪除；修正後執行 `npm run stock` |
| 讀取狀態檔失敗，排程停止 | 紀錄檔損壞；確認內容或移除 `data/stock/state.json` 後重新啟動（移除後前一次的新聞不會被自動刪除） |

## 運作機制與開發

### 設定與紀錄位置

```text
env/
├── stock.example.js            # 股票設定檔範例
└── stock.js                    # 股票正式設定檔，不納入版本控制
data/stock/
├── state.json                  # 每個 Webhook 最後發送完成的日期，以及下次要刪除的新聞訊息 ID
├── discord-messages.jsonl      # 最近 100 筆訊息操作
└── webhook-profiles/           # 每個 Webhook 名稱與頭像的上次記錄，用來偵測更換
```

### 調整新聞內容與排版

| 想調整的內容 | 位置 |
| --- | --- |
| 股票代號與篇數 | `env/stock.js` 的 `news`，見[設定參考](#設定參考) |
| 搜尋與撰寫規則、各市場的參考來源與重要新聞定義 | `src/stock/news.js` 的 `MARKETS`、`buildNewsPrompt()` |
| 代號格式檢查（與技術指標共用） | `src/shared/symbols.js` 的 `SYMBOL_RULES` |
| 訊息標題、卡片顏色 | `src/stock/format.js` |

### 股票模組位置

| 功能 | 位置 |
| --- | --- |
| 單次執行、常駐排程、手動發文入口 | `src/stock/index.js`、`scheduler.js`、`webhook.js` |
| 股票設定 | `src/stock/config.js` |
| 新聞搜尋與整理 | `src/stock/run.js`、`news.js` |
| 每日流程（刪除 → 發送 → 記錄）、排程與紀錄（與 Crypto 共用；流程與紀錄也與技術指標共用） | `src/shared/daily-digest.js`、`digest-scheduler.js`、`digest-state.js` |
| 專屬測試 | `test/stock/` |

共用 Discord、AI 與排程工具的位置，見[共用專案結構](../README.md#專案結構)。
