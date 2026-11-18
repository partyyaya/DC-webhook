# Discord 通知

定時檢查 [Artale 官網公告](https://artale.live/tw/news)，用 Codex CLI 整理繁體中文摘要，再透過 Discord Webhook 發送到頻道。

## 目錄

- [快速開始](#快速開始)
- [Discord 發布內容](#discord-發布內容)
- [維護公告判斷](#維護公告)
- [預覽與手動操作](#預覽與手動操作)
- [強制重新發布的範圍](#強制重新發布的範圍)
- [管理 Discord 發文](#管理-discord-發文)
- [刪除後重新發布](#刪除後重新發布)
- [自動排程](#自動排程)
- [設定參考](#設定參考)
- [問題排查](#問題排查)
- [運作機制與開發](#運作機制與開發)

## 快速開始

自動整理公告需要 Node.js 20.12 以上（本專案使用 Node 22）、Codex CLI 與 Discord Webhook 網址。專案本身沒有 npm 套件依賴；若只使用[管理 Discord 發文](#管理-discord-發文)指令，不需要 Codex CLI。

### 1. 準備執行環境

```bash
cd /Users/gary.cai/Desktop/svn-workspace/dcwebhook
nvm use
npm install -g @openai/codex
codex login
```

`nvm use` 會依 `.nvmrc` 切換到 Node 22。Codex 使用 ChatGPT 帳號登入，也可使用 API key，見[設定參考](#設定參考)。

### 2. 設定 Discord 頻道

在 Discord 開啟 **頻道設定 → 整合 → Webhook → 新 Webhook**，複製網址。

若專案尚無 `.env`，先複製範本：

```bash
cp .env.example .env
```

編輯 `.env`，填入網址：

```ini
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy
```

Webhook 的名稱與頭像在 Discord 設定。`.env` 已列入 `.gitignore`；系統環境變數的同名設定優先於 `.env`。

### 3. 預覽發布內容

```bash
npm run dry-run -- --force
```

預設會依序印出「維護」、「更新」與「購物商場」的 Discord JSON 資料，實際處理的分類由 `ARTALE_NEWS_CATEGORIES` 決定；已過期而略過的維護公告不產生預覽訊息。**不發送訊息，也不更新任何通知或發文紀錄**。實際卡片外觀需在 Discord 確認。只想看其中一個分類，見[預覽與手動操作](#預覽與手動操作)。

### 4. 啟動自動排程

```bash
npm run schedule
```

預設每週二 **08:20～17:20，每小時檢查一次，使用台灣時間**。若啟動時正在排程時段內，會立即檢查並發送需通知的內容；時段外啟動則等待下一個排程時間。關閉終端機會停止排程；調整時間見[自動排程](#自動排程)。

## Discord 發布內容

預設檢查維護、版本更新與購物商場，三個分類分開發送。**同一輪有兩個以上分類需通知時，固定依「維護 → 版本更新 → 購物商場」發送，不受設定中的排列順序影響。**沒有變化的分類仍會略過。三者都有需通知內容時，正常共三則；只有版本更新與商城需通知時，正常共兩則。商城超過 Discord 上限時才拆成多則。

| 分類 | 顯示內容 | 排版 |
| --- | --- | --- |
| 維護 | 內文只顯示維護日期、起訖時間及公告註明的時區 | 一張公告卡片 |
| 版本更新 | 更新項目、關鍵日期與數值、相關頁面連結；每項說明要求 50 字以內，項目之間空一行 | 一張公告卡片 |
| 購物商場 | 商品名稱、WC 價格、內容物名稱、圖片、相關頁面連結、購買資訊 | 公告卡片 → 各商品先圖片再文字 → 其他異動（有才顯示） |

公告標題顯示於最上方，不顯示分類欄位、發布時間或底部時間戳。卡片底部保留「摘要由 Codex 自動產生，詳細內容請以官方公告為準」；商城拆成多則時，只放在最後一張文字卡片。不顯示分類橫幅，保留商品圖片。

新公告標為【新公告】，同篇內容變更標為【公告更新】，強制重發已記錄的相同版本標為【公告】。**官網修改公告時，程式會另發一則更新訊息，保留舊訊息，不會自動刪除或覆寫。**判斷依公告 ID 與內容版本，不以是否同一天區分。

**點擊公告標題即可開啟對應的官網公告**，內文不再重複附上公告網址。商品說明等內文連結仍會保留。

### 購物商場的整理規則

- 「內容物、購買條件、可購買次數、販售時間」以清單呈現，欄位標題使用粗體，各項直接換行、不插入空白行，例如 `- **內容物：**道具名稱`。
- 每個商品文字卡片最後，依序列出「購買條件、可購買次數、販售時間」；公告沒寫的項目直接省略整行。
- 限購資訊保留帳號／角色限制、重置週期與時間；販售時間保留起訖日期及「維護前／維護後」等說明。
- 摘要規則要求 Codex 排除下架、刪除、移除、停止販售或結束販售的商品，「其他異動」也不列入。仍在販售、只註明未來截止時間的商品會保留。
- 整理後沒有任何需通知內容時，不發送訊息，但會記錄該版本，避免每次重新處理。

下架排除規則只適用於購物商場（`bm`）；版本更新公告仍可能列出結束販售的資訊。活動、制裁等其他分類使用版本更新格式；維護使用下方的時間格式。

<details>
<summary>查看商城卡片示意與長度限制</summary>

```text
［公告卡片］【新公告】11/17（二）Artale World 購物商場更新公告
［圖片卡片］（商品圖片，沒有則省略）
［文字卡片］每週突襲重置獎勵通行證｜4,000 WC
           - **內容物：**突襲額外入場券、凍結加持器、…
           前往機率型道具資訊頁面（連結）
           - **購買條件：**等級 Lv.10 以上
           - **可購買次數：**每個角色限購 1 次
           - **販售時間：**11/17 維護後～12/15 維護前
```

有多個商品時依序重複圖片與文字卡片；有其他異動時放在商品後方。

每則訊息最多 10 張卡片，卡片文字合計最多 6000 字；單張卡片標題最多 256 字、內文最多 4096 字。商城超過單則上限時會拆分，同一商品的圖片與文字卡片不會拆開。程式會預留購買資訊的空間，過長的內容物文字可能截斷。

</details>

### 維護公告

維護（`maintenance`）內文只顯示時間，例如以下示意：

```text
維護時間：11/24 07:00～12:00（GMT+8）
```

不列出維護項目、補償、活動或其他說明。有多個適用服務的時段時分行顯示；有延長、更正或實際完成時間時，依公告最新說明整理。公告未註明時間時顯示「維護時間：公告未註明」，不以公告發布時間代替。公告內容變更仍由標題的【公告更新】識別，內文不另外加入更新提示。

**比較最新版本更新與最新維護公告的官網發布時間，決定是否處理維護：**

| 發布時間比較結果 | 維護處理方式 |
| --- | --- |
| 版本更新晚於維護 | 略過維護，即使加上 `--force` 也不發送 |
| 維護較晚，或兩者相同 | 繼續比對通知紀錄，有變化或加上 `--force` 才發送 |

比較的是官網 `publishedAt` 的日期與時分，以台灣時間計算；不使用標題日期、內文的實際維護日或程式執行當天的日期。官網只有日期時視為當日 00:00；無法解析發布時間時，不因這項比較略過維護。**此規則只影響本輪維護發送，版本更新與商城照常處理；不會自動撤下先前已發的維護訊息。**

即使只設定維護分類，程式仍會讀取最新版本更新公告作發布時間比對，但不發送未選取的版本更新。若版本更新來源暫時無法讀取，這次先不發維護，其他可處理的分類照常，下次再試。

## 預覽與手動操作

| 想做的事 | 指令 | 是否發送 Discord |
| --- | --- | --- |
| 預覽最新公告，包含已處理過的版本 | `npm run dry-run -- --force` | 否 |
| 只預覽有變化的公告 | `npm run dry-run` | 否 |
| 立即檢查一次，有變化才發送 | `npm start` | 是 |
| 強制重新處理並發送最新公告 | `npm start -- --force` | 是 |
| 執行測試 | `npm test` | 否 |

### 強制重新發布的範圍

`--force` 只略過「相同公告版本已處理過」的檢查。程式仍只取 `ARTALE_NEWS_CATEGORIES` 所選分類各自最新一篇，不會補發歷史公告。

| 分類 | 使用 `--force` 時 |
| --- | --- |
| 維護 | 先套用[發布時間判斷](#維護公告)，符合條件才重新摘要及發送 |
| 版本更新 | 重新摘要及發送官網 `update` 分類最新一篇 |
| 購物商場 | 重新摘要，仍排除下架商品、略過未提供的購買資訊；沒有需通知內容就不發送 |

發送順序仍是「維護 → 版本更新 → 購物商場」，未選取或需略過的分類不發送。重新產生的摘要文字可能與上次不同；加上 `--dry-run` 時只預覽符合上述條件的內容。

**強制重發不會刪除或覆寫舊訊息。**需要替換舊公告時，依[刪除後重新發布](#刪除後重新發布)操作；只想撤下舊維護公告時，用 `webhook delete` 刪除即可。

### 只處理單一分類

只預覽單一分類（以下適用於 macOS／Linux）：

```bash
# 購物商場
ARTALE_NEWS_CATEGORIES=bm npm run dry-run -- --force

# 版本更新
ARTALE_NEWS_CATEGORIES=update npm run dry-run -- --force

# 維護
ARTALE_NEWS_CATEGORIES=maintenance npm run dry-run -- --force
```

預覽不需要 `DISCORD_WEBHOOK_URL`。確認後，將同一指令中的 `npm run dry-run` 改為 `npm start`，就會實際發送到設定的頻道。

<details>
<summary>尚未安裝 Codex，或預覽時摘要失敗</summary>

預覽模式會顯示失敗原因，並使用簡易內容代替：

| 分類 | 替代內容 |
| --- | --- |
| 版本更新、活動等分類 | 公告內文開頭最多 1500 字 |
| 購物商場 | 從編號商品標題粗略擷取名稱、價格、圖片與連結；略過標題已標示下架或刪除等狀態的段落。內容物顯示預覽提示，三項購買資訊留空省略 |
| 維護 | 僅顯示「維護時間：尚未取得（預覽模式）」，不回退成公告全文 |

簡易預覽只能確認基本版面，無法驗證完整的 AI 摘要與商品排除結果。正式模式不會使用替代內容：摘要失敗的分類不發送、不記錄，其他分類仍可繼續處理。

</details>

## 管理 Discord 發文

可直接用 Node 新增、修改或刪除訊息，**不抓取官網、不呼叫 Codex**。預設使用 `.env` 的 `DISCORD_WEBHOOK_URL`。

```bash
# 新增純文字訊息，成功後會顯示 messageId
node src/webhook.js create --content "測試公告"

# 查詢目前 Webhook 的本機發文紀錄，取得 messageId
node src/webhook.js list

# 修改純文字；將數字換成實際的 messageId
node src/webhook.js edit --message-id 123456789012345678 --content "修正後的公告"

# 刪除指定訊息
node src/webhook.js delete --message-id 123456789012345678
```

也可使用 `npm run webhook -- <操作> ...`；完整選項可用 `npm run webhook -- --help` 查看。`create`、`edit`、`delete` 會直接異動 Discord，**加上 `--dry-run` 就只預覽，不連線、不寫紀錄**。

### 發送或修改卡片

自動公告使用卡片，修改這類內容請使用 JSON 檔。先編輯範本 [examples/webhook-message.json](examples/webhook-message.json)，再執行：

```bash
# 先確認預計發送的卡片
node src/webhook.js create --file examples/webhook-message.json --dry-run

# 發送卡片
node src/webhook.js create --file examples/webhook-message.json

# 以 JSON 修改已發送的卡片
node src/webhook.js edit --message-id 123456789012345678 --file examples/webhook-message.json
```

`--content` 與 `--file` 擇一。新增可讀取單一 JSON 物件或訊息物件陣列；修改只接受單一物件。JSON 檔路徑以目前執行目錄為準。手動發文的內容與排版依 JSON 提供，不會自動套用官網公告的摘要、商品排除、粗體或空行規則。

修改時未提供的欄位會保留，提供的 `embeds` 則整組取代。`--content` 只修改普通文字，不會改動既有卡片；若要將卡片改為純文字，JSON 使用 `{"content":"新文字","embeds":[]}`。所有新增與修改都停用提及通知。

### 刪除後重新發布

若要替換已發布的公告，先確認新內容，再用訊息 ID 刪除舊文，最後重新發送。以下只處理商城；要處理版本更新，將 `bm` 改為 `update`：

```bash
# 1. 先確認最新公告與新排版
ARTALE_NEWS_CATEGORIES=bm npm run dry-run -- --force

# 2. 查詢目前 Webhook 的訊息 ID，選擇要替換的 active 紀錄
node src/webhook.js list

# 3. 將數字換成舊公告的實際 messageId
node src/webhook.js delete --message-id 123456789012345678

# 4. 重新產生摘要並發布商城公告
ARTALE_NEWS_CATEGORIES=bm npm start -- --force
```

商城若拆成多則，需逐則刪除該篇公告的舊訊息。若摘要成功但商城預覽為空，請先確認這是預期結果；正式執行時若仍沒有需通知內容，就不會發送。若需保持摘要文字完全相同，請先準備固定內容的 JSON 檔，並用 `create --file` 預覽及發送；`npm start -- --force` 會重新產生摘要，並不直接沿用預覽結果。

### Webhook 與訊息紀錄

| 選項 | 用途 |
| --- | --- |
| `--webhook URL` | 改用其他 Webhook；未指定時使用 `.env` |
| `--thread-id ID` | 討論串內的訊息，新增、修改、刪除時指定討論串 ID；也可放在 Webhook URL 的 `thread_id` 參數 |
| `--history-file PATH` | 改用其他發文紀錄檔，路徑以專案根目錄為準 |

發文紀錄預設寫入 `data/discord-messages.jsonl`，保存 Webhook ID、訊息 ID、標題及操作時間，不保存 Webhook token。**所有 Webhook 合計最多保留最近 100 筆操作紀錄**，每次成功的新增、修改、刪除各佔一筆；寫入第 101 筆時移除最舊的，既有超額紀錄也會在下次成功寫入時縮減至 100 筆。清理本機紀錄不會刪除 Discord 訊息。

排程發送的每則公告也會立即記錄 ID，即使後續另一則發送失敗，仍可在保留範圍內用 `list` 查詢。超出保留範圍後，可能查不到訊息或其完整資料；若已知訊息 ID，仍可搭配原 Webhook 修改或刪除。

`list` 只讀本機紀錄：有設定 Webhook 時只列出該 Webhook，未設定時列出全部。`status: "active"` 表示本機尚無成功刪除紀錄，`status: "deleted"` 表示本機記錄到成功刪除；若直接在 Discord 刪除，本機狀態不會同步更新。此功能加入前的舊訊息不會自動補入，仍可自行取得訊息 ID 後操作。

修改與刪除必須使用原本發送該訊息的 Webhook，見 [Discord 官方 Webhook 文件](https://docs.discord.com/developers/resources/webhook#edit-webhook-message)。`delete --message-id` 只刪除指定訊息，不會刪除 Webhook 本身。手動操作不受公告去重限制，也不修改 `STATE_FILE` 指定的公告紀錄。

## 自動排程

修改 `.env` 或程式後，需重新啟動常駐程式才會載入新設定與排版；已發布的訊息不會自動修改。排程可在 `.env` 設定：

```ini
SCHEDULE_DAYS=2              # 1=週一，7=週日；支援 2,4、1-5 等寫法
SCHEDULE_START=08:20         # 開始時間
SCHEDULE_END=17:20           # 結束時間
CHECK_INTERVAL_MINUTES=60    # 每隔幾分鐘檢查一次
SCHEDULE_TIMEZONE=Asia/Taipei
```

預設固定時間點為 08:20、09:20、…、17:20，共 10 次。時間點從開始時間起算，超過結束時間就停止；間隔無法整除時，最後一次會早於結束時間。目前不支援跨午夜時段，開始時間必須早於或等於結束時間。

| 需求 | 設定範例 |
| --- | --- |
| 每週二、週四 10:00～18:00，每 30 分鐘 | `SCHEDULE_DAYS=2,4`、`SCHEDULE_START=10:00`、`SCHEDULE_END=18:00`、`CHECK_INTERVAL_MINUTES=30` |
| 平日 09:00～21:00，每 2 小時 | `SCHEDULE_DAYS=1-5`、`SCHEDULE_START=09:00`、`SCHEDULE_END=21:00`、`CHECK_INTERVAL_MINUTES=120` |
| 每天全天，每小時整點 | `SCHEDULE_DAYS=1-7`、`SCHEDULE_START=00:00`、`SCHEDULE_END=23:00`、`CHECK_INTERVAL_MINUTES=60` |

常駐程式每次檢查結束後才安排下一次，同一程序不會同時跑兩次。電腦睡眠後喚醒，若仍在時段內會補檢查一次，超過時段則略過。

需要保持執行時，可使用 `tmux` 或 `pm2`。若使用會自動重啟的工具，需關閉自動重啟，讓內容轉譯錯誤發生時能停止排程，例如：

```bash
pm2 start npm --name artale --no-autorestart -- run schedule
```

## 設定參考

所有設定可寫在專案根目錄的 `.env`。`STATE_FILE` 與 `DISCORD_MESSAGES_FILE` 的相對路徑以專案根目錄為準；手動指令的 `--file` 則以目前執行目錄為準。

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `DISCORD_WEBHOOK_URL` | 無 | 正式發送及常駐排程必填；預覽不需要 |
| `ARTALE_NEWS_CATEGORIES` | `maintenance,update,bm` | 選擇要檢查的分類，逗號分隔；發送順序固定為維護 → 更新 → 商城，其他分類接在後面 |
| `STATE_FILE` | `data/state.json` | 公告版本紀錄檔 |
| `DISCORD_MESSAGES_FILE` | `data/discord-messages.jsonl` | 最多保留最近 100 筆新增、修改及刪除操作紀錄，供 `webhook list` 查詢 |
| `CODEX_BIN` | `codex` | CLI 執行檔名稱或絕對路徑 |
| `CODEX_MODEL` | Codex 設定檔的模型 | 摘要使用的模型 |
| `CODEX_TIMEOUT_MS` | `300000`（5 分鐘） | 單次摘要逾時時間 |
| `CODEX_API_KEY` | 使用 CLI 已儲存的登入資訊 | 選擇以 API key 執行時提供，由子程序繼承 |

排程變數見[自動排程](#自動排程)。本專案使用 `codex exec`，沿用 CLI 已儲存的登入資訊，也可透過 `CODEX_API_KEY` 提供 API key，詳見 [OpenAI 官方文件](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation)。

### 公告分類

| 設定值 | 分類 | 官網列表 |
| --- | --- | --- |
| `update` | 更新 | [查看](https://artale.live/tw/news?category=update) |
| `bm` | 購物商場 | [查看](https://artale.live/tw/news?category=bm) |
| `event` | 活動 | [查看](https://artale.live/tw/news?category=event) |
| `maintenance` | 維護 | [查看](https://artale.live/tw/news?category=maintenance) |
| `sanction` | 制裁 | [查看](https://artale.live/tw/news?category=sanction) |
| `all` | 全部 | [查看](https://artale.live/tw/news) |

例如在預設分類之外再加入活動：`ARTALE_NEWS_CATEGORIES=maintenance,update,bm,event`。其他分類依設定中的相對順序，接在維護、更新與商城之後發送。

每個分類只取最新一篇公告；依官網分類選取，不另外篩選標題。因此「版本更新」指官網 `update` 分類，該分類的兌換券或其他公告也可能成為本輪發送內容，以及維護發布時間的比較依據。最新維護被略過時，不會改抓更舊的維護公告。

不建議用 `all` 取代多個分類：它只取整個公告列表最新一篇，不會分別取得維護、更新及商城公告；維護專用判斷與排版也只在選取 `maintenance` 時套用。

## 問題排查

| 現象 | 處理方式 |
| --- | --- |
| 預覽顯示沒有變化，未印出內容 | 使用 `npm run dry-run -- --force` |
| 加上 `--force` 仍沒有維護公告 | 查看紀錄是否顯示版本更新發布時間較晚；這項[維護判斷](#維護公告)不會被 `--force` 略過 |
| 找不到 Codex CLI | 安裝 CLI 並登入；若 PATH 找不到執行檔，在 `.env` 設定 `CODEX_BIN` 絕對路徑 |
| Codex CLI 執行失敗 | 查看錯誤附帶的輸出，確認登入、額度與逾時設定；修正後重新執行或等待下次排程 |
| 尚未設定 `DISCORD_WEBHOOK_URL` | 確認專案根目錄的 `.env` 已填入 Webhook 網址 |
| `bad CPU type in executable` | 執行 `nvm use`，確認 Node 安裝架構適合目前電腦；可用 `nvm alias default 22` 設定預設版本 |
| 內容轉譯錯誤，排程停止 | 檢查官網結構及 `src/artale.js` 解析規則，修正後先預覽，再重新啟動排程 |
| 修改／刪除回傳 HTTP 404 | 確認訊息 ID 與原 Webhook 正確；訊息或 Webhook 可能已刪除 |
| 顯示 Discord 操作已成功，但發文紀錄寫入失敗 | 保留錯誤內的訊息 ID，檢查 `DISCORD_MESSAGES_FILE` 路徑與權限，避免直接重試新增造成重複發文。若程序被強制中止並留下同名 `.lock` 檔，確認沒有其他程序正在寫入後再移除該鎖檔 |

### 錯誤發生後會怎樣

| 錯誤類型 | 發送與紀錄 | 常駐排程 |
| --- | --- | --- |
| 內容轉譯錯誤 | 整次所有分類都不發送、不寫紀錄 | 以結束碼 `2` 停止，需修正後重啟 |
| 網路、Codex 或 Discord 錯誤 | 失敗分類不記錄版本，其他分類繼續處理 | 繼續執行，下個時間點重試；單次模式需再次執行 |

若訊息已成功送出，但後續訊息或紀錄檔寫入失敗，重試時可能重複發送。程式只有在該分類全部訊息成功後才記錄公告版本；每則成功訊息的 ID 則另寫入發文紀錄，可用[管理 Discord 發文](#管理-discord-發文)查詢或撤回。

<details>
<summary>哪些情況屬於內容轉譯錯誤</summary>

程式會檢查官網資料能否完整轉成公告文字。以下情況會停止整次發送：

- 公告列表為空、公告缺少標題，或日期格式不符。
- 內文資料不存在、不完整、格式不符，或轉換過程出錯。
- 轉換後內文為空，或遺漏原文文字。
- 公告標題為空，或發布時間格式不符。

程式先抓取並轉換所有分類，再進入發送階段，因此任一分類轉譯錯誤時，其他分類也不會先發送。

</details>

## 運作機制與開發

### 公告判斷與通知紀錄

程式依列表日期挑選最新公告，同一天有多篇時再比較發布時間，避免把置頂的舊公告誤認為最新。以公告 ID 與「標題＋內文」的 SHA-256 雜湊值比對版本；只改發布時間不會觸發通知。

紀錄檔預設為 `data/state.json`，所有分類合計保留最近 100 筆。已記錄的相同版本會略過，超出保留範圍的舊版本則不受去重保護。商城沒有需通知內容時也會記錄，`notifiedAt` 表示完成處理的時間。

**公告去重紀錄沒有區分 Webhook。**若換到另一個群組但沿用同一份 `STATE_FILE`，相同版本仍會略過；可加 `--force` 重發。兩個群組若需各自追蹤更新，請分別設定不同的 `STATE_FILE`。這與按 Webhook 區分的 `DISCORD_MESSAGES_FILE` 發文紀錄不同。

需要重發時使用 `npm start -- --force`。若要清除所有紀錄，可刪除 `STATE_FILE` 指定的檔案；下次正式執行會重新處理各分類最新公告。

<details>
<summary>查看紀錄檔格式</summary>

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

</details>

### 調整摘要與排版

| 要調整的內容 | 位置 |
| --- | --- |
| 版本更新摘要規則 | `src/summarize.js` 的 `UPDATE_PROMPT` |
| 商城摘要、商品排除、購買資訊規則 | `src/summarize.js` 的 `SHOP_PROMPT` |
| 維護時間擷取與輸出格式 | `src/summarize.js` 的 `MAINTENANCE_PROMPT`、`parseMaintenanceSummary()` |
| 維護發布時間判斷與分類發送順序 | `src/run.js`、`src/announcement-dates.js` |
| 各分類共用摘要規則 | `src/summarize.js` 的 `COMMON_RULES` |
| Discord 卡片、粗體、行距與標題連結 | `src/discord.js` 的 `buildDiscordPayload()`、`buildShopMessages()` |

商城與維護摘要使用固定 JSON Schema。程式會核對商城商品圖片及頁面連結網址是否出現在原文中；版本更新等文字摘要的連結由摘要規則要求照抄，未另做網址核對。正式模式下，摘要解析檢查失敗就不發送該分類。

<details>
<summary>查看專案結構</summary>

```text
.
├── .env.example        # 設定範本
├── .nvmrc              # Node 版本
├── package.json        # 執行指令
├── data/state.json     # 正式處理成功後產生的版本紀錄
├── data/discord-messages.jsonl # 每則 Discord 訊息的操作紀錄
├── examples/webhook-message.json # 手動發送與修改卡片的範本
├── src/
│   ├── index.js        # 單次執行與預覽入口
│   ├── scheduler.js    # 常駐排程入口
│   ├── schedule.js     # 排程設定與時間計算
│   ├── run.js          # 抓取、比對、摘要、發送與紀錄
│   ├── artale.js       # 官網公告解析
│   ├── announcement-dates.js # 公告發布時間解析
│   ├── lexical.js      # 內文轉成 Markdown
│   ├── state.js        # 版本比對與紀錄讀寫
│   ├── summarize.js    # Codex 摘要
│   ├── discord.js      # Discord 排版與發送
│   ├── webhook.js      # 手動新增、修改、刪除與查詢入口
│   ├── posts.js        # 執行 Webhook 操作並保存訊息 ID
│   ├── env.js          # 共用 .env 載入與專案路徑
│   ├── config.js       # 設定載入
│   ├── errors.js       # 內容轉譯錯誤類型
│   └── log.js          # 帶時間戳的紀錄輸出
└── test/               # 單元測試
```

</details>
