# Artale 公告 Discord 通知

依設定的排程（預設每週二 08:20～17:20 每小時一次）檢查 [Artale 官網公告](https://artale.live/tw/news)的「更新」與「購物商場」分類，發現新公告或公告內容被修改時，用 Codex CLI 產生繁體中文重點摘要，再透過 Discord Webhook 發送到頻道。沒有變化時不做任何事，也不會重複通知同一個版本。

## 運作流程

每次檢查時，依序處理每個設定的分類（預設「更新」與「購物商場」），每個分類各自執行：

1. 讀取該分類的公告列表第一頁，找出最新的一篇公告並抓取全文。
2. 以「標題 + 內文」計算 SHA-256 雜湊值，和已發送的紀錄比對公告 ID 與雜湊值。
3. 完全沒有變化就跳過這個分類。
4. 有變化才呼叫 Codex CLI 產生繁體中文摘要。
5. 將摘要以 Discord embed 格式發送到 Webhook。
6. 發送成功後，把這個公告版本寫入 `data/state.json`，之後不會再重複通知。

程式會先把所有分類都抓完、轉換完，才開始比對和發送。若任何分類發生內容轉譯錯誤（官網結構可能改變），整次停止、不發送任何訊息，常駐排程也會停止，詳見「內容轉譯錯誤的防護」。網路、Codex、Discord 暫時失敗則只會跳過該分類，其他分類照常處理。

「最新公告」的判斷方式：官網會把置頂的舊公告排在列表最前面，所以程式是依列表上的日期挑出最新的公告；同一天有多篇時，再比較內文頁上的發布時間（含時分）。

同一篇公告的內容被官方修改時，雜湊值會改變，Discord 訊息標題會標成【公告更新】；全新的公告則標成【新公告】。

## Discord 訊息內容

每則公告都會先有一張公告卡片：標題為【新公告】或【公告更新】加上公告標題（點擊可開啟官網公告），下方附分類、發布時間與公告縮圖。其餘內容由 Codex 依分類整理成不同格式（實際文字由 Codex 產生，以下為示意）。

**版本更新公告**：這次版本更新了什麼，每個項目 50 字以內，有連結就附上。

```
- **事前預約200萬人提前達標**：所有階段獎勵已開放，11/24 維護後依序發放。[前往事前預約頁面](https://pre.cygnus.artale.live/...)
- **創作者同樂會特別序號活動**：觀看創作者直播取得兌換券，可兌換創作者代幣與獎勵。[前往創作者同樂會公告頁面](https://artale.live/tw/news/...)
- **怪物技能書掉落率 UP 第 2 週**：11/17～11/24 黃色炸彈球、電子機器人技能書掉落率提升。
```

版本更新公告的摘要放在公告卡片的內文。

**購物商場公告**：更新了哪些商品、需要多少 WC、禮包名稱與內容物名稱，並附上每個商品對應的圖片與連結，**先圖片、再文字**。每個商品文字卡片最後依序列出「購買條件、可購買次數、販售時間」，公告沒寫的項目直接省略整行。

公告列為下架、刪除、移除或結束販售的商品及相關異動不列入 Discord 摘要。若整篇公告只有這類資訊，就不發送任何訊息，並記錄該版本以避免重複處理。仍在販售且僅註明未來截止時間的商品會保留。

```
［公告卡片］【新公告】11/17（二）Artale World 購物商場更新公告
［圖片卡片］（每週突襲重置獎勵通行證的商品圖）
［文字卡片］每週突襲重置獎勵通行證｜4,000 WC
           內容物：突襲額外入場券、歐洛拉戒指(7日)、甜蜜藥水箱、凍結加持器、…
           前往機率型道具資訊頁面（連結）
           購買條件：依公告列出
           可購買次數：依公告列出（包含帳號／角色限制與重置週期）
           販售時間：依公告列出開始與結束時間
［圖片卡片］（角色養成禮包的商品圖，公告中沒有圖片則省略）
［文字卡片］角色養成禮包｜800 WC（原價 1,000 WC，優惠 20%）
           內容物：…
［文字卡片］其他異動（例如常駐商品價格或內容物調整，沒有則省略）
```

- Discord 卡片的大圖固定顯示在文字下方，所以每個商品的圖片放在獨立的卡片，排在文字卡片前面。
- 一則 Discord 訊息最多 10 張卡片、文字合計 6000 字，商品多的時候會自動拆成多則訊息依序發送，同一個商品的圖片與文字不會被拆開。
- 圖片與連結網址由 Codex 從公告中挑出，程式會核對網址確實出現在公告原文中才採用，避免 AI 編造網址。
- 購物商場的摘要請 Codex 以固定的 JSON 格式回覆（`--output-schema`），格式不符時視為 Codex 失敗：這次不發送，下一個排程時間點再試。

想調整格式，修改 `src/summarize.js` 上方的 `UPDATE_PROMPT`（版本更新）、`SHOP_PROMPT`（購物商場）與 `COMMON_RULES`（共用規則）；購物商場的卡片排版在 `src/discord.js` 的 `buildShopMessages()`。除了購物商場以外，其他分類（例如活動、維護）都使用版本更新的格式。

## 環境需求

- Node.js 20.12 以上（專案的 `.nvmrc` 指定 22），不需要安裝任何 npm 套件
- [Codex CLI](https://developers.openai.com/codex/noninteractive)（產生摘要用，可以晚點再裝）
- 一個 Discord Webhook 網址

## 安裝與設定

### 1. 切換 Node 版本

```bash
cd /Users/gary.cai/Desktop/svn-workspace/dcwebhook
nvm use          # 依 .nvmrc 切換到 Node 22
node -v          # 確認是 v22.x
```

### 2. 建立 Discord Webhook

在 Discord 打開要接收通知的頻道：**編輯頻道 → 整合 → Webhook → 新 Webhook → 複製 Webhook 網址**。

Webhook 的名稱與頭像在這裡設定即可，程式不會覆寫。

### 3. 設定環境變數

```bash
cp .env.example .env
```

打開 `.env`，填入剛剛複製的網址：

```ini
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy
```

`.env` 已列在 `.gitignore`，不會被提交。如果系統環境變數裡已經有同名設定，會優先使用系統環境變數。

### 4. 安裝 Codex CLI

```bash
npm install -g @openai/codex
codex login      # 用 ChatGPT 帳號登入；或改用環境變數 CODEX_API_KEY
```

還沒安裝 Codex CLI 之前，仍可以用 `npm run dry-run` 預覽流程，詳見下方說明。

## 使用方式

| 指令 | 說明 |
| --- | --- |
| `npm run dry-run` | 預覽模式：抓公告、比對、產生摘要，並印出將發送的 Discord 內容，但**不發送、不寫入紀錄** |
| `npm start` | 執行一次完整檢查，有變化才發送並記錄 |
| `npm start -- --force` | 忽略比對結果，強制重新發送目前最新的公告（測試 Webhook 用） |
| `npm run schedule` | 常駐模式：依排程時段（預設每週二 08:20～17:20）每小時檢查一次 |
| `npm test` | 執行單元測試 |

建議第一次使用時依序執行：

1. `npm run dry-run`：確認抓得到公告、摘要內容合理。
2. `npm start`：實際發送一次。因為還沒有任何紀錄，**第一次執行一定會把每個分類目前最新的公告各發一則到 Discord**（預設為「更新」與「購物商場」共 2 則）。
3. 再執行一次 `npm start`：每個分類都應該顯示「與已通知過的版本相同，沒有變化。」

### 還沒安裝 Codex CLI 時

- `npm run dry-run` 會顯示「找不到 Codex CLI」的提示，並改用公告開頭的內容代替摘要，讓你先看看訊息長相。
- `npm start` 會在摘要階段失敗並回傳錯誤碼 1，且**不會寫入紀錄**，所以下一次檢查會自動重試，不會漏掉公告。

## 設定自動執行

以下兩種方式擇一即可。

### 方式一：常駐模式（建議）

```bash
npm run schedule
```

程式會一直執行，只在指定的星期幾、指定的時間區段內，每隔固定分鐘數檢查一次。預設為**每週二 08:20～17:20、每 60 分鐘一次**，也就是 08:20、09:20、…、17:20，共 10 次，以台灣時間計算。

啟動後的紀錄輸出大致如下：

```
[2026-11-17 15:25:05] 排程模式啟動：每週二 08:20～17:20，每 60 分鐘檢查一次（時區 Asia/Taipei）
[2026-11-17 15:25:05] 目前在排程時段內，先立即檢查一次。
...
[2026-11-17 15:25:05] 下次檢查時間：2026-11-17（週二）16:20
```

- 啟動當下如果正好在排程時段內，會先立即檢查一次，之後再依時間點執行。
- 每次檢查完才排下一次，不會有兩次檢查同時進行。
- 電腦睡眠期間錯過的時間點，喚醒後若仍在時段內會補檢查一次；已經超過時段就略過。
- 終端機關掉程式就會停止，適合開著終端機或搭配 `pm2`、`tmux` 等工具使用（使用 `pm2` 請見「內容轉譯錯誤的防護」的注意事項）。
- 發生內容轉譯錯誤（官網結構可能改變）時，排程會自動停止，詳見「內容轉譯錯誤的防護」。

#### 調整排程

在 `.env` 修改以下設定，重新啟動 `npm run schedule` 後生效：

```ini
SCHEDULE_DAYS=2              # 星期幾：1～7（1=週一 … 7=週日）
SCHEDULE_START=08:20         # 每天第一次檢查的時間
SCHEDULE_END=17:20           # 每天最後一次檢查的時間
CHECK_INTERVAL_MINUTES=60    # 間隔幾分鐘檢查一次
SCHEDULE_TIMEZONE=Asia/Taipei
```

`SCHEDULE_DAYS` 可以用逗號與範圍組合：

| 設定值 | 意思 |
| --- | --- |
| `2` | 每週二 |
| `2,4` | 每週二、週四 |
| `1-5` | 週一到週五 |
| `1-3,6` | 週一到週三，以及週六 |
| `1-7` | 每天 |

更多範例：

| 需求 | 設定 |
| --- | --- |
| 每週二、週四 10:00～18:00，每 30 分鐘 | `SCHEDULE_DAYS=2,4`、`SCHEDULE_START=10:00`、`SCHEDULE_END=18:00`、`CHECK_INTERVAL_MINUTES=30` |
| 平日 09:00～21:00，每 2 小時 | `SCHEDULE_DAYS=1-5`、`SCHEDULE_START=09:00`、`SCHEDULE_END=21:00`、`CHECK_INTERVAL_MINUTES=120` |
| 每天全天，每小時整點 | `SCHEDULE_DAYS=1-7`、`SCHEDULE_START=00:00`、`SCHEDULE_END=23:00`、`CHECK_INTERVAL_MINUTES=60` |

注意事項：

- 檢查時間點是從 `SCHEDULE_START` 開始，每隔 `CHECK_INTERVAL_MINUTES` 分鐘一次，超過 `SCHEDULE_END` 就停止。間隔若無法剛好整除，最後一次會早於 `SCHEDULE_END`。
- 目前不支援跨越午夜的時段（例如 22:00～02:00），`SCHEDULE_START` 必須早於或等於 `SCHEDULE_END`。
- 設定格式錯誤時，程式啟動就會顯示錯誤原因並結束，例如「SCHEDULE_DAYS 格式錯誤：「週二」，請使用 1～7…」。

### 方式二：crontab

讓系統依 crontab 的時間呼叫單次模式。使用 crontab 時，**排程由 crontab 決定，上面的 `SCHEDULE_*` 設定不會生效**。執行 `crontab -e` 加入（以下等同每週二 08:20～17:20 每小時一次）：

```cron
20 8-17 * * 2 cd /Users/gary.cai/Desktop/svn-workspace/dcwebhook && /Users/gary.cai/.nvm/versions/node/v22.23.4/bin/node src/index.js >> /tmp/artale-dcwebhook.log 2>&1
```

crontab 時間欄位依序為「分 時 日 月 星期」，`20 8-17 * * 2` 代表每週二 8～17 點的第 20 分。

使用 crontab 時要注意：

- crontab 使用電腦本身的時區，不會參考 `SCHEDULE_TIMEZONE`。

- cron 不會載入 nvm，所以 `node` 必須寫絕對路徑（可用 `nvm which 22` 查詢）。
- cron 的 PATH 很精簡，可能找不到 `codex`。請在 `.env` 設定 `CODEX_BIN` 為絕對路徑（可用 `which codex` 查詢）。
- macOS 預設會阻擋 cron 存取「桌面」資料夾。請到 **系統設定 → 隱私權與安全性 → 完整磁碟取用權限** 加入 `/usr/sbin/cron`，或把專案搬到桌面以外的位置。
- 執行紀錄會寫到 `/tmp/artale-dcwebhook.log`，可用 `tail -f /tmp/artale-dcwebhook.log` 查看。

## 環境變數

| 變數 | 必填 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | 是 | — | Discord Webhook 網址 |
| `ARTALE_NEWS_CATEGORIES` | 否 | `update,bm` | 要檢查的公告分類，逗號分隔，見下方「公告來源」 |
| `STATE_FILE` | 否 | `data/state.json` | 已發送版本的紀錄檔，相對路徑以專案根目錄為準 |
| `CODEX_BIN` | 否 | `codex` | Codex CLI 執行檔名稱或絕對路徑 |
| `CODEX_MODEL` | 否 | 使用 Codex 設定檔的模型 | 指定摘要使用的模型 |
| `CODEX_TIMEOUT_MS` | 否 | `300000`（5 分鐘） | Codex CLI 執行逾時時間 |
| `SCHEDULE_DAYS` | 否 | `2`（週二） | `npm run schedule` 要檢查的星期幾，1～7（1=週一、7=週日），可用逗號與範圍 |
| `SCHEDULE_START` | 否 | `08:20` | `npm run schedule` 每天第一次檢查的時間（HH:MM） |
| `SCHEDULE_END` | 否 | `17:20` | `npm run schedule` 每天最後一次檢查的時間（HH:MM） |
| `CHECK_INTERVAL_MINUTES` | 否 | `60` | `npm run schedule` 的檢查間隔（分鐘） |
| `SCHEDULE_TIMEZONE` | 否 | `Asia/Taipei` | 計算排程時間用的時區 |

### 公告來源

預設檢查官網的「更新」與「購物商場」兩個分類。每個分類各自找出最新的一篇公告、各自比對，有變化就各自發送一則訊息。

要增減分類，修改 `ARTALE_NEWS_CATEGORIES`，用逗號分隔：

| 設定值 | 分類 | 列表網址 |
| --- | --- | --- |
| `update` | 更新 | `https://artale.live/tw/news?category=update` |
| `bm` | 購物商場 | `https://artale.live/tw/news?category=bm` |
| `event` | 活動 | `https://artale.live/tw/news?category=event` |
| `maintenance` | 維護 | `https://artale.live/tw/news?category=maintenance` |
| `sanction` | 制裁 | `https://artale.live/tw/news?category=sanction` |
| `all` | 全部 | `https://artale.live/tw/news` |

例如同時檢查更新、購物商場與活動：`ARTALE_NEWS_CATEGORIES=update,bm,event`。

不建議使用 `all`：「全部」分類只會取所有公告中最新的一篇，若最新的是維護或制裁公告，同一時間發布的更新公告就會被蓋過。

## 已發送紀錄

紀錄檔 `data/state.json` 的格式如下，最新的版本排在最前面，最多保留 100 筆：

```json
{
  "notified": [
    {
      "id": "tsijzkrlsgtxs4f4aopbz7pe",
      "hash": "ed9e1062a109ade31fb3909a5c0feb5f6782cb9d519d6e5211feacadb4ea73f8",
      "title": "11/17（二）Artale World 更新公告",
      "publishedAt": "2026.11.17 08:13",
      "url": "https://artale.live/tw/news/tsijzkrlsgtxs4f4aopbz7pe",
      "notifiedAt": "2026-11-17T04:45:14.485Z"
    }
  ]
}
```

- 想讓程式「忘記」所有已發送的公告，刪除 `data/state.json` 即可，下次執行會重新發送最新公告。
- 只想重發一次而不清除紀錄，使用 `npm start -- --force`。

## 內容轉譯錯誤的防護

程式把官網網頁轉成公告內容時，會一併檢查轉換結果是否正確。發現以下任一情況，就視為「內容轉譯錯誤」，通常代表官網的網頁結構改變了：

- 公告列表讀不到任何公告，或有公告缺少標題、日期格式不是 `YYYY.MM.DD`
- 內文頁找不到內文資料、資料不完整或格式不符，或轉換過程出錯
- 轉換後的內文是空的，或原始內文中有文字沒出現在轉換結果裡（轉換不完整）
- 標題是空的，或發布時間格式不符

發生內容轉譯錯誤時：

- **不發送任何訊息到 Discord**：程式會先把所有分類都抓完、轉換完，全部成功才開始發送。所以只要有一個分類轉譯錯誤，這次所有分類都不會發送，也不會寫入紀錄。
- **直接結束**：`npm start` 以結束碼 `2` 結束。
- **常駐排程也停止**：`npm run schedule` 會立即結束，不再繼續輪詢。

紀錄輸出大致如下：

```
內容轉譯錯誤，未發送任何訊息到 Discord：[購物商場] 公告列表 https://artale.live/tw/news?category=bm 解析不到任何公告，網站結構可能已變更
官網的網頁結構可能已改變，排程已停止。修正 src/artale.js 的解析規則後，請重新執行 npm run schedule。
```

恢復方式：確認官網結構、修正 `src/artale.js` 的解析規則後，先用 `npm run dry-run` 確認能正確解析，再重新執行 `npm run schedule`。

以下錯誤**不屬於**內容轉譯錯誤，只會跳過這次（不發送、不記錄），排程不會停止，下一個時間點會自動再試：網路逾時或官網暫時無法連線、Codex CLI 執行失敗、Discord 發送失敗。

注意事項：

- 若用 `pm2` 等會自動重啟的工具執行常駐排程，程式結束後會被自動重新啟動。請關閉自動重啟（例如 `pm2 start npm --name artale --no-autorestart -- run schedule`），排程才會真的停止。
- 若用 crontab，cron 每次仍會依時間呼叫程式。每次都會因為轉譯錯誤而直接結束、不會發送，但不會自動停止呼叫，需要手動移除 crontab 設定。

## 常見問題

**執行 `node` 出現 `bad CPU type in executable`**

目前使用的 Node 是 x86 版本，無法在 Apple Silicon Mac 上執行。在專案目錄執行 `nvm use` 切換到 Node 22；若想永久改掉預設版本，執行 `nvm alias default 22`。

**出現「找不到 Codex CLI」**

尚未安裝 Codex CLI，或是在 cron 等環境中找不到執行檔。請安裝並登入 Codex CLI，或在 `.env` 用 `CODEX_BIN` 指定絕對路徑。

**出現「Codex CLI 執行失敗」**

錯誤訊息後面會附上 Codex CLI 的輸出。常見原因是尚未登入（執行 `codex login`）或額度不足。發生錯誤時不會寫入紀錄，修正後下次執行會自動重試。

**出現「內容轉譯錯誤」**

官網的網頁結構可能改版了，程式已停止且沒有發送任何訊息，常駐排程也已結束，詳見上方「內容轉譯錯誤的防護」。修正 `src/artale.js` 的解析規則後，重新啟動即可。

**出現「尚未設定環境變數 DISCORD_WEBHOOK_URL」**

確認專案根目錄有 `.env` 檔，且 `DISCORD_WEBHOOK_URL` 已填入網址。

## 專案結構

```
.
├── .env.example        # 環境變數範本
├── .nvmrc              # 指定 Node 版本
├── package.json
├── data/state.json     # 已發送的公告版本紀錄（執行後自動產生）
├── src/
│   ├── index.js        # 單次執行入口（npm start / npm run dry-run）
│   ├── scheduler.js    # 常駐排程入口（npm run schedule）
│   ├── schedule.js     # 排程設定解析、下次檢查時間計算
│   ├── run.js          # 主流程：抓取 → 比對 → 摘要 → 發送 → 記錄
│   ├── artale.js       # 抓取並解析 Artale 公告列表與內文
│   ├── lexical.js      # 將公告內文（Lexical 編輯器格式）轉成 Markdown 文字
│   ├── state.js        # 雜湊值計算、變化比對與紀錄檔讀寫
│   ├── summarize.js    # 呼叫 Codex CLI 產生摘要
│   ├── discord.js      # 組出 Discord embed 並發送
│   ├── config.js       # 讀取 .env 與環境變數
│   ├── errors.js       # 自訂錯誤類型（內容轉譯錯誤）
│   └── log.js          # 帶時間戳的紀錄輸出
└── test/               # 單元測試（node:test）
```
