# Crypto 每日新聞

每天以 Codex CLI 網路搜尋前 24 小時的**美國經濟新聞**與**虛擬貨幣新聞**，各整理最重要的幾則繁體中文摘要（預設各 3 則）；發送前會先刪除前一次的新聞訊息，頻道只保留最新一天的內容。

[返回共用說明](../README.md) · [環境設置](../README.md#環境設置) · [共用 Webhook 工具](../README.md#共用-webhook-工具)

## 目錄

- [快速開始](#快速開始)
- [新聞內容](#新聞內容)
- [Discord 發布內容](#discord-發布內容)
- [預覽與手動操作](#預覽與手動操作)
- [自動排程](#自動排程)
- [設定參考](#設定參考)
- [問題排查](#問題排查)
- [運作機制與開發](#運作機制與開發)

## 快速開始

先完成根目錄 README 的[環境設置](../README.md#環境設置)，以下指令皆在專案根目錄執行。

複製範例並填入 Crypto 頻道的 Webhook，範例見 [env/.env.crypto.example](../env/.env.crypto.example)：

```bash
cp env/.env.crypto.example env/.env.crypto
```

```ini
CRYPTO_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy
```

先預覽今天的新聞，不刪除、不發送 Discord，也不寫任何紀錄（Codex 網路搜尋約需數分鐘）：

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
| 美國經濟新聞 | `CRYPTO_ECONOMY_NEWS_COUNT`（3） | 最重要的新聞：聯準會利率與官員談話、CPI／PCE、就業、GDP、零售銷售、美債殖利率、美股大盤、財政與關稅政策等 |
| 虛擬貨幣新聞 | `CRYPTO_COIN_NEWS_COUNT`（最多 3） | `CRYPTO_PRIORITY_COINS` 的**每個幣種至少 1 則**，預設 **BTC → ADA（Cardano）→ ETH**；篇數少於幣種數量時依幣種順序只取前幾個；剩餘名額只放重要新聞 |

篇數可設定 1～10 則（一則 Discord 訊息最多 10 張卡片）。

### 幣種優先順序

`CRYPTO_PRIORITY_COINS` 的**填寫順序就是優先順序**，同時決定 Codex 的搜尋順序與 Discord 的排列順序：

```ini
CRYPTO_PRIORITY_COINS=BTC,ADA,ETH   # BTC 最優先，其次 ADA，再來 ETH
```

- **每個幣種至少 1 則**：選該幣種在時間範圍內最重要的新聞。某個幣種完全沒有相關新聞時才會跳過。
- **篇數少於幣種數量**時，依填寫順序只取前幾個幣種。例如 `BTC,ADA,ETH` 搭配 2 則，只發 BTC、ADA 各 1 則；前面的幣種沒有任何新聞時，才由下一個幣種遞補。
- **篇數多於幣種數量**時，各幣種 1 則之後的剩餘名額只放真正重要的新聞（例如價格大幅波動、ETF 資金流向、監管、重大技術升級、交易所或專案重大事件），可以是清單幣種的第 2 則、其他幣種或整體市場新聞；沒有重要新聞就少發，不會用例行行情評論、價格預測或公關稿補滿。
- 發送前程式會檢查並依同樣順序排列：先替每個幣種保留 1 則，再依序放入其他新聞，最後依幣種順序排列，清單外的幣種排最後。
- 一則新聞同時涉及多個幣種時，以清單中最優先的幣種作為代表，例如同時提到 BTC 與 ETH 的新聞算作 BTC。某個幣種沒有以它為主的新聞時，才會改用有提到它的新聞。
- 可寫代號或常見全名（例如 `Cardano` 會換成 `ADA`、`NIGHT` 會換成 `MIDNIGHT`），大小寫不拘。冷門幣種可在 `src/crypto/news.js` 的 `COIN_NAMES` 補上說明，幫助 Codex 辨認。

程式也會檢查 Codex 的回覆：
- 缺少標題或網址不是 `http(s)` 的新聞會被捨棄；兩個分類重複的網址只保留一次。
- 找不到足夠的新聞時，只發送實際找到的數量；兩個分類都沒有新聞時視為失敗，不刪除前一天的新聞。

新聞由 Codex 搜尋與摘要，內容可能有誤，重要資訊請點擊卡片標題查看原文。

## Discord 發布內容

每個分類發送一則訊息，訊息文字為分類與日期，每篇新聞一張卡片：

```text
## 🇺🇸 美國經濟新聞｜2026-11-18（週三）
┃ 1. 新聞標題（點擊開啟原文）
┃ 2～3 句繁體中文摘要
┃ Reuters｜2026-11-18 03:00

## 🪙 虛擬貨幣新聞｜2026-11-18（週三）
┃ 1. 新聞標題（點擊開啟原文）
┃ 2～3 句繁體中文摘要
┃ BTC・ETH｜CoinDesk｜2026-11-18 06:00
```

### 先刪除前一次的新聞

發送順序固定為：

1. 以 Codex 搜尋並整理新聞。**搜尋失敗時不刪除舊訊息**，頻道保留前一次的新聞。
2. 刪除前一次發送的新聞訊息。訊息已被手動刪除（Discord 回傳 404）時略過；其他刪除失敗時**不發送今天的新聞**，等待重試。
3. 發送今天的新聞，並記錄訊息 ID，供下一次刪除。

只會刪除每日新聞流程自己發送、記錄在 `data/crypto/state.json` 的訊息；用 `npm run crypto:webhook` 手動發送的訊息不會被自動刪除。

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

手動新增、修改、刪除或查詢訊息，固定使用 `env/.env.crypto` 的 Webhook 與紀錄：

```bash
npm run crypto:webhook -- --help
npm run crypto:webhook -- list
npm run crypto:webhook -- delete --message-id 123456789012345678 --dry-run
```

用法與[共用 Webhook 工具](../README.md#共用-webhook-工具)相同。

## 自動排程

修改 `env/.env.crypto`、`env/.env.shared` 或程式後，需重新啟動常駐程式才會載入新設定。排程可在 `env/.env.crypto` 設定：

```ini
CRYPTO_SCHEDULE_DAYS=1-7            # 1=週一，7=週日；支援 1-5、1,3,5 等寫法
CRYPTO_SCHEDULE_TIME=08:00          # 每天發送時間
CRYPTO_SCHEDULE_TIMEZONE=Asia/Taipei
```

| 需求 | 設定範例 |
| --- | --- |
| 只在平日發送 | `CRYPTO_SCHEDULE_DAYS=1-5` |
| 每天 21:30 發送 | `CRYPTO_SCHEDULE_TIME=21:30` |

排程行為：

| 情況 | 處理方式 |
| --- | --- |
| 啟動或電腦睡眠喚醒時，今天的發送時間已過、但今天還沒發送 | 立即補發一次；只補當天，不補前幾天 |
| 今天已發送過 | 重新啟動也不會重發，等到下一個排程日 |
| 發送失敗（Codex、網路或 Discord 錯誤） | 30 分鐘後重試，同一天最多 3 次，之後等下一個排程日 |

是否已發送以紀錄檔判斷，因此停止後重新啟動、或先手動執行 `npm run crypto`，排程都不會在同一天重複發送。

需要保持執行時，可使用 `tmux` 或 `pm2`，例如：

```bash
pm2 start npm --name crypto -- run crypto:schedule
```

## 設定參考

Crypto 設定放在 `env/.env.crypto`，共用 Codex 設定（`CODEX_BIN`、`CODEX_MODEL`、`CODEX_API_KEY`）放在 `env/.env.shared`。Crypto 的設定統一使用 `CRYPTO_` 前綴，不讀取 `ARTALE_` 的設定。

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `CRYPTO_DISCORD_WEBHOOK_URL` | 無（正式發送必填） | Crypto 頻道的 Webhook |
| `CRYPTO_PRIORITY_COINS` | `BTC,ADA,ETH` | 虛擬貨幣新聞的優先幣種，填寫順序即優先順序 |
| `CRYPTO_ECONOMY_NEWS_COUNT` | `3` | 美國經濟新聞篇數（1～10） |
| `CRYPTO_COIN_NEWS_COUNT` | `3` | 虛擬貨幣新聞篇數（1～10） |
| `CRYPTO_SCHEDULE_DAYS` | `1-7` | 發送的星期 |
| `CRYPTO_SCHEDULE_TIME` | `08:00` | 每天發送時間 |
| `CRYPTO_SCHEDULE_TIMEZONE` | `Asia/Taipei` | 排程與新聞時間使用的時區 |
| `CRYPTO_CODEX_TIMEOUT_MS` | `600000`（10 分鐘） | Codex 搜尋與整理的逾時時間；網路搜尋較久，不使用共用的 `CODEX_TIMEOUT_MS` |
| `CRYPTO_STATE_FILE` | `data/crypto/state.json` | 每日新聞紀錄 |
| `CRYPTO_DISCORD_MESSAGES_FILE` | `data/crypto/discord-messages.jsonl` | 訊息操作紀錄 |

紀錄檔的相對路徑以專案根目錄為準。

## 問題排查

Node、Codex 與 Webhook 的共用問題，見[共用問題排查](../README.md#問題排查)。

| 現象 | 處理方式 |
| --- | --- |
| 尚未設定 `CRYPTO_DISCORD_WEBHOOK_URL` | 確認 `env/.env.crypto` 已填入 Webhook 網址 |
| 執行後顯示「今天的新聞已發送過」 | 需要重新發送時使用 `npm run crypto -- --force` |
| Codex 逾時 | 調高 `CRYPTO_CODEX_TIMEOUT_MS` |
| 「刪除前一次的新聞訊息失敗，未發送今天的新聞」 | 確認 Webhook 沒有被更換或刪除；修正後執行 `npm run crypto` |
| 更換 Webhook 後舊新聞沒有被刪除 | 新 Webhook 無法刪除舊 Webhook 的訊息，請在 Discord 手動刪除 |
| 讀取狀態檔失敗，排程停止 | 紀錄檔損壞；確認內容或移除 `data/crypto/state.json` 後重新啟動（移除後前一次的新聞不會被自動刪除） |

## 運作機制與開發

### 設定與紀錄位置

```text
env/
├── .env.crypto.example  # Crypto 設定範例
└── .env.crypto          # Crypto 正式設定，不納入版本控制
data/crypto/
├── state.json           # 最後發送完成的日期，以及下次要刪除的新聞訊息 ID
└── discord-messages.jsonl # 最近 100 筆訊息操作
```

### 調整新聞內容與排版

| 想調整的內容 | 位置 |
| --- | --- |
| 每個分類的篇數、優先幣種 | `env/.env.crypto`，見[設定參考](#設定參考) |
| 搜尋與撰寫規則 | `src/crypto/news.js` 的 `buildNewsPrompt()` |
| 提示詞中幣種的中文名稱、全名對照 | `src/crypto/news.js` 的 `COIN_NAMES`、`COIN_ALIASES` |
| 訊息標題、卡片顏色與版面 | `src/crypto/format.js` |
| 重試間隔與每日次數 | `src/crypto/scheduler.js` 的 `RETRY_MINUTES`、`MAX_ATTEMPTS_PER_DAY` |

### Crypto 模組位置

| 功能 | 位置 |
| --- | --- |
| 單次執行、常駐排程、手動發文入口 | `src/crypto/index.js`、`scheduler.js`、`webhook.js` |
| Crypto 設定 | `src/crypto/config.js` |
| 主流程（搜尋 → 刪除 → 發送 → 記錄） | `src/crypto/run.js` |
| 每日新聞紀錄 | `src/crypto/state.js` |
| 專屬測試 | `test/crypto/` |

共用 Discord、Codex 與排程工具的位置，見[共用專案結構](../README.md#專案結構)。
