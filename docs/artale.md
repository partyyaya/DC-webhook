# Artale 通知

定時檢查 [Artale 官網公告](https://artale.live/tw/news)，整理繁體中文摘要後發送至 Discord。

[返回共用說明](../README.md) · [環境設置](../README.md#環境設置) · [共用 Webhook 工具](../README.md#共用-webhook-工具)

## 目錄

- [快速開始](#快速開始)
- [檢查時間範圍](#檢查時間範圍)
- [Discord 發布內容](#discord-發布內容)
- [維護公告判斷](#維護公告)
- [預覽與手動操作](#預覽與手動操作)
- [強制重新發布的範圍](#強制重新發布的範圍)
- [管理 Discord 發文](#管理-discord-發文)
- [刪除後重新發布](#刪除後重新發布)
- [自動排程](#自動排程)
- [設定參考](#設定參考)
- [舊環境遷移](#舊環境遷移)
- [問題排查](#問題排查)
- [運作機制與開發](#運作機制與開發)

## 快速開始

先完成根目錄 README 的[環境設置](../README.md#環境設置)，以下指令皆在專案根目錄執行。

若尚無 Artale 正式設定檔，先複製範例：

```bash
cp env/.env.artale.example env/.env.artale
```

在 `env/.env.artale` 填入 Artale 頻道的 Webhook，範例見 [env/.env.artale.example](../env/.env.artale.example)：

```ini
ARTALE_DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy
```

依分類篇數上限預覽第一頁的已發布公告，不發送 Discord，也不更新通知或發文紀錄：

```bash
npm run artale:preview -- --force
```

預設依「維護 → 版本更新 → 購物商場」處理，維護仍會套用下方的[發布時間判斷](#維護公告)。輸出是 Discord JSON，卡片外觀需在 Discord 確認。

啟動常駐排程：

```bash
npm run artale:schedule
```

啟動後立即依「維護最新一篇、版本更新最新三篇、商城最新一篇」檢查第一頁，**不受星期、時段或回溯分鐘數限制**；之後預設每週二 **08:20～17:20，每小時檢查一次，使用台灣時間**。關閉終端機會停止排程，更多設定見[自動排程](#自動排程)。

## 檢查時間範圍

**所有模式都只讀取各分類第一頁，不讀取第二頁或後續頁面。**三個分類的比較數量如下，啟動、後續排程、預覽及 `--force` 都適用：

| 分類 | 比較數量 | 額外規則 |
| --- | --- | --- |
| 維護 | 最新一篇 | 最新版本更新發布得較晚時，略過維護 |
| 版本更新 | 最新三篇 | 後續排程再篩選時間區間；不足三篇就處理實際篇數 |
| 購物商場 | 最新一篇 | 維持商品排除、購買資訊與商城排版規則 |

「最新」依官網發布時間（含時分）判斷，置頂舊文不會因列表位置靠前而優先。先選最新幾篇，再依本輪模式套用時間範圍及去重；已通知或被略過時，**不往下補發更舊的公告**。同篇重複出現在第一頁只計一次，未來發布的公告不列入。

| 執行方式 | 檢查範圍 |
| --- | --- |
| `npm run artale` | 第一頁依上述篇數選取已發布公告，不限制回溯分鐘數 |
| `npm run artale:preview` | 同啟動檢查，只預覽、不發送或寫紀錄 |
| `npm run artale:schedule` 啟動當下 | 立即依上述篇數比對第一頁，即使不在設定的星期或時段內 |
| 排程後續每輪 | 上述最新幾篇中，發布時間落在「執行當下往前 N 分鐘」的公告 |
| 單次或預覽加上 `--window` | 模擬後續排程的區間檢查，N 取自 `ARTALE_CHECK_INTERVAL_MINUTES` |

例如設定為 `60`，排程於當天 **09:20** 執行，就比對第一頁內 **08:20～09:20** 的公告；若最新三篇版本更新公告都在區間內，三篇都會比對；若有四篇，最多只比對較新的三篇。改成 `30` 分鐘，範圍就是 **08:50～09:20**。啟動檢查不套用回溯區間，但仍遵守各分類最新一篇／三篇的限制。

分類仍依「維護 → 版本更新 → 購物商場」處理，同分類內依發布時間由舊到新。已記錄的相同版本會略過，因此重新啟動不會重發未變更的內容；首次沒有紀錄時，也只處理上述篇數上限內的公告。維護另套用下方的發布時間比較規則。

區間檢查包含起訖時間，跨午夜時可比對第一頁的前一天公告；整輪抓取及摘要耗時不會移動本輪範圍。所有模式均排除尚未發布的未來公告。官網只有日期時，視為台灣當日 00:00。

後續排程的範圍依本輪執行時間計算，不是「距上次成功檢查的時間」，不會因睡眠或錯過排程而擴大。較早發布且不在區間的公告，若只修改內文而未改發布時間，後續區間檢查不處理；重新啟動或執行 `npm run artale` 時，只會重新比對第一頁仍在各分類最新一篇／三篇範圍內的公告。

## Discord 發布內容

預設檢查維護、版本更新與購物商場，三個分類分開發送。**同一輪有兩個以上分類需通知時，固定依「維護 → 版本更新 → 購物商場」發送，不受設定中的排列順序影響。**沒有變化的公告仍會略過。版本更新最多三篇，維護與商城各最多一篇，各篇分開發送；若三個分類各有一篇需通知，正常共三則。單篇商城超過 Discord 上限時另拆成多則。

**篇數上限不等於每次必定發送的訊息數。**預設三個分類一輪最多比對五篇公告；仍需通過時間區間、去重及維護判斷，商城也可能沒有可通知內容。例如三篇版本更新與一篇商城都需要通知、維護因較新的版本更新而略過，通常會發四則。商城拆分時，訊息數可能增加。

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

**維護只選第一頁最新一篇，與第一頁最新版本更新公告的發布時間比較：**

| 發布時間比較結果 | 維護處理方式 |
| --- | --- |
| 版本更新晚於維護 | 略過維護，即使加上 `--force` 也不發送 |
| 維護較晚，或兩者相同 | 繼續比對通知紀錄，有變化或加上 `--force` 才發送 |

比較的是官網 `publishedAt` 的日期與時分，以台灣時間計算；不使用標題日期、內文的實際維護日或程式執行當天的日期。官網只有日期時視為當日 00:00；無法解析發布時間時視為內容轉譯錯誤，停止本輪發送。**略過最新維護時不改發更舊維護，版本更新與商城照常處理；不會自動撤下先前已發的維護訊息。**

即使只設定維護分類，程式仍會讀取版本更新公告作發布時間比對；參考用的最新版本更新可以在區間外，但不會因此發送。若版本更新來源暫時無法讀取，這次先不發維護，其他可處理的公告照常；下次仍在區間內才重新比對。

## 預覽與手動操作

| 想做的事 | 指令 | 是否發送 Discord |
| --- | --- | --- |
| 依篇數上限預覽，包含已處理過的版本 | `npm run artale:preview -- --force` | 否 |
| 依篇數上限預覽有變化的公告 | `npm run artale:preview` | 否 |
| 依篇數上限檢查，有變化才發送 | `npm run artale` | 是 |
| 依篇數上限強制重新處理並發送 | `npm run artale -- --force` | 是 |
| 啟動 Artale 常駐排程 | `npm run artale:schedule` | 是，啟動立即檢查，之後依排程 |
| 預覽後續排程的區間檢查 | `npm run artale:preview -- --window --force` | 否 |
| 管理 Artale 訊息 | `npm run artale:webhook -- <操作> ...` | 依操作而定 |

Artale 使用獨立指令與 `ARTALE_` 設定。舊的 `npm start`、`npm run dry-run`、`npm run schedule` 已移除，請使用上表指令及 `npm run artale:schedule`。

### 強制重新發布的範圍

`--force` 只略過「相同公告版本已處理過」的檢查，不擴大頁面或變更維護規則。預設單次執行與預覽仍只處理第一頁的「維護最新一篇、版本更新最新三篇、商城最新一篇」；加上 `--window` 時，則只重新處理本次時間區間內的公告。區間內沒有公告時，即使 `--window --force` 也不發送。

| 分類 | 使用 `--force` 時 |
| --- | --- |
| 維護 | 只選最新一篇，套用[發布時間判斷](#維護公告)，符合條件才重新摘要及發送 |
| 版本更新 | 重新摘要及發送官網 `update` 第一頁最新三篇中符合本輪模式的公告 |
| 購物商場 | 只重新摘要最新一篇，仍排除下架商品、略過未提供的購買資訊；沒有需通知內容就不發送 |

發送順序仍是「維護 → 版本更新 → 購物商場」，未選取或需略過的分類不發送。重新產生的摘要文字可能與上次不同；加上 `--dry-run` 時只預覽符合上述條件的內容。

**強制重發不會刪除或覆寫舊訊息。**需要替換舊公告時，依[刪除後重新發布](#刪除後重新發布)操作；只想撤下舊維護公告時，用 `webhook delete` 刪除即可。

### 只處理單一分類

只預覽單一分類（以下適用於 macOS／Linux）：

```bash
# 購物商場
ARTALE_NEWS_CATEGORIES=bm npm run artale:preview -- --force

# 版本更新
ARTALE_NEWS_CATEGORIES=update npm run artale:preview -- --force

# 維護
ARTALE_NEWS_CATEGORIES=maintenance npm run artale:preview -- --force
```

預覽不需要 `ARTALE_DISCORD_WEBHOOK_URL`。確認後，將同一指令中的 `npm run artale:preview` 改為 `npm run artale`，就會實際發送到設定的頻道。

<details>
<summary>尚未安裝 Codex，或預覽時摘要失敗</summary>

預覽模式會顯示失敗原因，並使用簡易內容代替：

| 分類 | 替代內容 |
| --- | --- |
| 版本更新、活動等分類 | 公告內文開頭最多 1500 字 |
| 購物商場 | 從編號商品標題粗略擷取名稱、價格、圖片與連結；略過標題已標示下架或刪除等狀態的段落。內容物顯示預覽提示，三項購買資訊留空省略 |
| 維護 | 僅顯示「維護時間：尚未取得（預覽模式）」，不回退成公告全文 |

簡易預覽只能確認基本版面，無法驗證完整的 AI 摘要與商品排除結果。正式模式不會使用替代內容：摘要失敗的公告不發送、不記錄，其他公告仍可繼續處理。

</details>

## 管理 Discord 發文

Artale 專用入口固定使用 `ARTALE_DISCORD_WEBHOOK_URL` 與 `ARTALE_DISCORD_MESSAGES_FILE`，不載入公告、排程或 Codex 設定。也可直接執行 `node src/artale/webhook.js <操作> ...`。

```bash
# 新增訊息；加 --dry-run 可先預覽
npm run artale:webhook -- create --content "測試公告"

# 查詢目前 Webhook 的本機紀錄，取得 messageId
npm run artale:webhook -- list

# 將數字換成實際的 messageId
npm run artale:webhook -- edit --message-id 123456789012345678 --content "修正後的公告"
npm run artale:webhook -- delete --message-id 123456789012345678
```

新增、修改或刪除加上 `--dry-run` 時不連線、不寫紀錄。修改公告卡片需使用 `--file`，完整操作及 JSON 範本見[共用 Webhook 工具](../README.md#共用-webhook-工具)。手動操作不會套用 Artale 摘要與排版規則，也不修改公告去重紀錄。

### 刪除後重新發布

以下流程適用於第一頁且在各分類篇數上限內的公告。先確認預覽含有目標公告與新內容，再刪除舊文並重發。`--force` 仍遵守維護一篇、更新三篇、商城一篇的限制；若只想替換特定單篇，或公告已不在上述範圍，請準備固定內容 JSON，使用 `artale:webhook` 的 `create --file` 預覽及發送。

**刪除 DC 訊息不會清除 `data/artale/state.json` 的公告去重紀錄。**即使 DC 公告已全部刪除，直接執行 `npm run artale` 仍會略過已通知且未變更的版本；需要重新發布時使用 `npm run artale -- --force`，仍遵守最新一篇／三篇與維護判斷規則。若自訂 `ARTALE_STATE_FILE`，去重紀錄以該設定路徑為準。

以下只處理商城；要處理版本更新，將 `bm` 改為 `update`：

```bash
# 1. 先確認第一頁的目標公告與新排版
ARTALE_NEWS_CATEGORIES=bm npm run artale:preview -- --force

# 2. 查詢目前 Webhook 的訊息 ID，選擇要替換的 active 紀錄
node src/artale/webhook.js list

# 3. 將數字換成舊公告的實際 messageId
node src/artale/webhook.js delete --message-id 123456789012345678

# 4. 重新產生摘要並發布商城公告
ARTALE_NEWS_CATEGORIES=bm npm run artale -- --force
```

商城若拆成多則，需逐則刪除該篇公告的舊訊息。若摘要成功但商城預覽為空，請先確認這是預期結果；正式執行時若仍沒有需通知內容，就不會發送。若需保持摘要文字完全相同，請先準備固定內容的 JSON 檔，並用 `create --file` 預覽及發送；`npm run artale -- --force` 會重新產生摘要，並不直接沿用預覽結果。

### Webhook 與訊息紀錄

Artale 發文紀錄預設為 `data/artale/discord-messages.jsonl`，可用 `ARTALE_DISCORD_MESSAGES_FILE` 調整。每份紀錄檔保留最近 100 筆新增、修改、刪除操作；排程發送的訊息也會立即記錄 ID，供查詢或撤回。

`list` 只讀本機紀錄；有設定 Webhook 時只列出該 Webhook，未設定時列出檔案中的全部紀錄。`active`／`deleted` 狀態、保留上限與紀錄寫入失敗的處理，見[共用訊息操作紀錄](../README.md#訊息操作紀錄)。

修改與刪除必須使用原本的 Webhook。Artale 專用入口不能透過 `--source` 切換主題；若要使用另一個群組的 Webhook，可明確指定 `--webhook URL`。

## 自動排程

修改 `env/.env.artale`、`env/.env.shared` 或程式後，需重新啟動常駐程式才會載入新設定與排版；已發布的訊息不會自動修改。排程可在 `env/.env.artale` 設定：

```ini
ARTALE_SCHEDULE_DAYS=2              # 1=週一，7=週日；支援 2,4、1-5 等寫法
ARTALE_SCHEDULE_START=08:20         # 開始時間
ARTALE_SCHEDULE_END=17:20           # 結束時間
ARTALE_CHECK_INTERVAL_MINUTES=60    # 後續排程間隔與回溯分鐘數，不限制啟動檢查
ARTALE_SCHEDULE_TIMEZONE=Asia/Taipei
```

啟動時先依各分類篇數上限檢查一次第一頁，不受星期與時段限制；後續預設固定時間點為 08:20、09:20、…、17:20，共 10 次。時間點從開始時間起算，超過結束時間就停止；間隔無法整除時，最後一次會早於結束時間。目前不支援跨午夜時段，開始時間必須早於或等於結束時間。

| 需求 | 設定範例 |
| --- | --- |
| 每週二、週四 10:00～18:00，每 30 分鐘 | `ARTALE_SCHEDULE_DAYS=2,4`、`ARTALE_SCHEDULE_START=10:00`、`ARTALE_SCHEDULE_END=18:00`、`ARTALE_CHECK_INTERVAL_MINUTES=30` |
| 平日 09:00～21:00，每 2 小時 | `ARTALE_SCHEDULE_DAYS=1-5`、`ARTALE_SCHEDULE_START=09:00`、`ARTALE_SCHEDULE_END=21:00`、`ARTALE_CHECK_INTERVAL_MINUTES=120` |
| 每天全天，每小時整點 | `ARTALE_SCHEDULE_DAYS=1-7`、`ARTALE_SCHEDULE_START=00:00`、`ARTALE_SCHEDULE_END=23:00`、`ARTALE_CHECK_INTERVAL_MINUTES=60` |

常駐程式每次檢查結束後才安排下一次，同一程序不會同時跑兩次。電腦睡眠後喚醒，若仍在時段內會立即檢查一次，超過時段則略過。喚醒檢查也只往前查看設定的分鐘數，不補查整段睡眠時間。

需要保持執行時，可使用 `tmux` 或 `pm2`。若使用會自動重啟的工具，需關閉自動重啟，讓內容轉譯錯誤發生時能停止排程，例如：

```bash
pm2 start npm --name artale --no-autorestart -- run artale:schedule
```

## 設定參考

Artale 設定放在 `env/.env.artale`，共用 Codex 設定放在 `env/.env.shared`。`ARTALE_STATE_FILE` 與 `ARTALE_DISCORD_MESSAGES_FILE` 的相對路徑以專案根目錄為準；手動指令的 `--file` 則以目前執行目錄為準。

Artale 的 Webhook、排程及紀錄設定統一使用 `ARTALE_` 前綴，**不回退讀取舊的全域設定，也不讀取 `STOCKS_`、`CRYPTO_` 的設定**。Codex 執行器、模型及摘要逾時仍為共用設定，與各主題的輪詢時間分開。

### 舊環境遷移

先停止原排程，再將根目錄舊 `.env` 中的 `ARTALE_` 設定移至 `env/.env.artale`，共用 Codex 設定移至 `env/.env.shared`；保留各欄位原值。若仍使用更早的全域變數，先依下表更名。

同時將舊的 `data/state.json` 與 `data/discord-messages.jsonl` 搬至 `data/artale/`，保留原檔內容。若 `ARTALE_STATE_FILE` 或 `ARTALE_DISCORD_MESSAGES_FILE` 明確指定舊路徑，也需改成新位置；自訂路徑可繼續使用。確認目標沒有其他紀錄後再搬移，不要覆蓋不同內容的檔案。搬移紀錄可避免把既有公告當成尚未通知，並保留舊訊息 ID。

程式不再讀取根目錄 `.env` 或舊的平面紀錄路徑。遷移完成後移除舊環境檔，再用 `npm run artale:schedule` 啟動。

| 舊設定 | Artale 專屬設定 |
| --- | --- |
| `DISCORD_WEBHOOK_URL` | `ARTALE_DISCORD_WEBHOOK_URL` |
| `SCHEDULE_DAYS`、`SCHEDULE_START`、`SCHEDULE_END`、`SCHEDULE_TIMEZONE` | 各自加上 `ARTALE_` 前綴 |
| `CHECK_INTERVAL_MINUTES` | `ARTALE_CHECK_INTERVAL_MINUTES` |
| `STATE_FILE`、`DISCORD_MESSAGES_FILE` | 各自加上 `ARTALE_` 前綴 |

### Artale 設定欄位

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `ARTALE_DISCORD_WEBHOOK_URL` | 無 | 正式發送及常駐排程必填；預覽不需要 |
| `ARTALE_NEWS_CATEGORIES` | `maintenance,update,bm` | 選擇要檢查的分類，逗號分隔；發送順序固定為維護 → 更新 → 商城，其他分類接在後面 |
| `ARTALE_STATE_FILE` | `data/artale/state.json` | 公告版本紀錄檔 |
| `ARTALE_DISCORD_MESSAGES_FILE` | `data/artale/discord-messages.jsonl` | 最多保留最近 100 筆新增、修改及刪除操作紀錄，供 `webhook list` 查詢 |

排程變數見[自動排程](#自動排程)；Codex 共用設定與驗證方式見[根目錄 README](../README.md#共用設定)。

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

各分類只檢查第一頁，維護與商城各選最新一篇、版本更新選最新三篇。啟動時直接比對所選公告，後續排程再套用本輪時間區間。依官網分類選取，不另外篩選標題。因此「版本更新」指官網 `update` 分類，該分類的兌換券或其他公告也可能成為本輪發送內容，以及維護發布時間的比較依據。

`all`、活動與制裁仍採第一頁符合本輪模式的公告，不套用上述三個分類的篇數上限；`all` 使用一般文字摘要，不會依文章的官網標籤套用各分類規則。若要維持維護判斷、商城商品排版與固定分類順序，請明確選擇 `maintenance,update,bm`。

## 問題排查

Node、Codex 與 Webhook 的共用問題，見[共用問題排查](../README.md#問題排查)。

| 現象 | 處理方式 |
| --- | --- |
| 預覽顯示沒有變化，未印出內容 | 使用 `npm run artale:preview -- --force` |
| 刪除 DC 公告後，重新執行仍顯示沒有變化 | 刪文不會清除公告去重紀錄；依[刪除後重新發布](#刪除後重新發布)使用 `--force`，不需刪除通知紀錄檔 |
| 發送數量比預期少，或加上 `--force` 仍沒有公告 | 先確認所選分類與啟動／區間模式；維護、商城各最新一篇，更新最新三篇。`--window` 另受時間限制，維護仍受[發布時間判斷](#維護公告)限制，商城可能沒有可通知內容 |
| 尚未設定 `ARTALE_DISCORD_WEBHOOK_URL` | 確認 `env/.env.artale` 已填入 Webhook 網址 |
| 內容轉譯錯誤，排程停止 | 檢查官網結構及 `src/artale/client.js` 解析規則，修正後先預覽，再重新啟動排程 |

### 錯誤發生後會怎樣

| 錯誤類型 | 發送與紀錄 | 常駐排程 |
| --- | --- | --- |
| 內容轉譯錯誤 | 整次所有分類都不發送、不寫紀錄 | 以結束碼 `2` 停止，需修正後重啟 |
| 網路、Codex 或 Discord 錯誤 | 抓取失敗的分類本輪略過；摘要或發送失敗只略過該篇，其他已取得的公告繼續處理 | 繼續排程；下次仍出現在第一頁、位於最新篇數上限及時間區間內時才重試 |

若訊息已成功送出，但後續訊息或紀錄檔寫入失敗，重試時可能重複發送。程式只有在該篇公告全部訊息成功後才記錄該篇版本；每則成功訊息的 ID 則另寫入發文紀錄，可用[管理 Discord 發文](#管理-discord-發文)查詢或撤回。

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

程式只讀各分類第一頁，依官網發布時間選取各分類最新幾篇。啟動直接比對所選公告，區間檢查再以內文頁完整發布時間篩選本輪區間。每篇依公告 ID 與「標題＋內文」的 SHA-256 雜湊值比對版本；發布時間只影響是否落入範圍，不計入內容雜湊。

紀錄檔預設為 `data/artale/state.json`，所有分類合計保留最近 100 筆。已記錄的相同版本會略過，超出保留範圍的舊版本則不受去重保護。商城沒有需通知內容時也會記錄，`notifiedAt` 表示完成處理的時間。

**公告去重紀錄沒有區分 Webhook。**若換到另一個群組但沿用同一份 `ARTALE_STATE_FILE`，相同版本仍會略過；可用 `npm run artale -- --force` 重發第一頁且符合篇數上限的公告。兩個群組若需各自追蹤更新，請分別設定不同的 `ARTALE_STATE_FILE`。這與按 Webhook 區分的 `ARTALE_DISCORD_MESSAGES_FILE` 發文紀錄不同。

重發第一頁且符合篇數上限的公告使用 `npm run artale -- --force`；不在選取範圍的公告用手動 JSON 發文。刪除 `ARTALE_STATE_FILE` 會清除去重紀錄，但不會突破第一頁與篇數限制；`--window` 仍受時間範圍限制。

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
| 版本更新摘要規則 | `src/artale/summarize.js` 的 `UPDATE_PROMPT` |
| 商城摘要、商品排除、購買資訊規則 | `src/artale/summarize.js` 的 `SHOP_PROMPT` |
| 維護時間擷取與輸出格式 | `src/artale/summarize.js` 的 `MAINTENANCE_PROMPT`、`parseMaintenanceSummary()` |
| 維護發布時間判斷與分類發送順序 | `src/artale/run.js`、`src/artale/announcement-dates.js` |
| 各分類共用摘要規則 | `src/artale/summarize.js` 的 `COMMON_RULES` |
| Discord 卡片、粗體、行距與標題連結 | `src/artale/format.js` 的 `buildDiscordPayload()`、`buildShopMessages()` |

商城與維護摘要使用固定 JSON Schema。程式會核對商城商品圖片及頁面連結網址是否出現在原文中；版本更新等文字摘要的連結由摘要規則要求照抄，未另做網址核對。正式模式下，摘要解析檢查失敗就不發送或記錄該篇公告，其他公告仍繼續處理。

### 設定與紀錄位置

```text
env/
├── .env.artale.example  # Artale 設定範例
├── .env.artale          # Artale 正式設定，不納入版本控制
├── .env.shared.example  # 共用 Codex 設定範例
└── .env.shared          # 共用正式設定，不納入版本控制
data/artale/
├── state.json          # 最近 100 筆公告版本
└── discord-messages.jsonl # 最近 100 筆訊息操作
```

### Artale 模組位置

| 功能 | 位置 |
| --- | --- |
| 單次執行、常駐排程、手動發文入口 | `src/artale/index.js`、`scheduler.js`、`webhook.js` |
| Artale 設定 | `src/artale/config.js` |
| 官網解析與內文轉換 | `src/artale/client.js`、`lexical.js` |
| 公告版本比對與紀錄 | `src/artale/state.js` |
| 內容轉譯錯誤類型 | `src/artale/errors.js` |
| 專屬測試 | `test/artale/` |

共用 Discord、Codex 與排程工具的位置，見[共用專案結構](../README.md#專案結構)。
