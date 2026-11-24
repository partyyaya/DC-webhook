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
- [Webhook 名稱與頭像變更提醒](#webhook-名稱與頭像變更提醒)
- [多個 Webhook](#多個-webhook)
- [設定參考](#設定參考)
- [舊環境遷移](#舊環境遷移)
- [問題排查](#問題排查)
- [運作機制與開發](#運作機制與開發)

## 快速開始

先完成根目錄 README 的[環境設置](../README.md#環境設置)，以下指令皆在專案根目錄執行。

Artale 的所有設定（Webhook、分類、排程、提醒、紀錄位置）集中在一份 JS 設定檔 `env/artale.js`，可以直接寫註解。若尚無正式設定檔，先複製範例：

```bash
cp env/artale.example.js env/artale.js
```

在 `webhooks` 填入 Artale 頻道的 Webhook，其他欄位說明見範例檔 [env/artale.example.js](../env/artale.example.js) 與[設定參考](#設定參考)：

```js
export default {
  webhooks: [
    { name: '自己的伺服器', url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy' },
  ],
};
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
| 版本更新 | 最新三篇 | 每輪均比對內容，不限制發布時間的回溯分鐘數；不足三篇就處理實際篇數 |
| 購物商場 | 最新一篇 | 維持商品排除、購買資訊與商城排版規則 |

「最新」依官網發布時間（含時分）判斷，置頂舊文不會因列表位置靠前而優先。先選最新幾篇，再依本輪模式套用時間範圍及去重；已通知或被略過時，**不往下補發更舊的公告**。同篇重複出現在第一頁只計一次，未來發布的公告不列入。

| 執行方式 | 檢查範圍 |
| --- | --- |
| `npm run artale` | 第一頁依上述篇數選取已發布公告，不限制回溯分鐘數 |
| `npm run artale:preview` | 同啟動檢查，只預覽、不發送或寫紀錄 |
| `npm run artale:schedule` 啟動當下 | 立即依上述篇數比對第一頁，即使不在設定的星期或時段內 |
| 排程後續每輪 | 版本更新比對第一頁最新三篇；其他分類只比對上述最新幾篇中，發布時間落在「執行當下往前 N 分鐘」的公告 |
| 單次或預覽加上 `--window` | 模擬後續排程的區間檢查，N 取自設定檔的 `schedule.intervalMinutes` |

例如設定為 `60`，排程於當天 **09:20** 執行，維護與商城只比對第一頁最新一篇且發布於 **08:20～09:20** 的公告；版本更新則每輪都比對第一頁最新三篇，即使是數天前發布的公告，標題或內文更正後也能通知。改成 `30` 分鐘，其他分類的範圍就是 **08:50～09:20**，版本更新仍比對最新三篇。啟動檢查所有分類皆不套用回溯區間。

分類仍依「維護 → 版本更新 → 購物商場」處理，同分類內依發布時間由舊到新。已記錄的相同版本會略過，因此重新啟動不會重發未變更的內容；首次沒有紀錄時，也只處理上述篇數上限內的公告。維護另套用下方的發布時間比較規則。

區間檢查包含起訖時間，跨午夜時可比對第一頁的前一天公告；整輪抓取及摘要耗時不會移動本輪範圍。所有模式均排除尚未發布的未來公告。官網只有日期時，視為台灣當日 00:00。

其他分類後續排程的範圍依本輪執行時間計算，不是「距上次成功檢查的時間」，不會因睡眠或錯過排程而擴大。較早發布且不在區間的維護、商城等公告，若只修改內文而未改發布時間，後續區間檢查不處理。版本更新不受此限制，但仍須在第一頁最新三篇內；未變更的版本會去重，不會每輪重發，也不會因第四篇有更正就往下補查。

## Discord 發布內容

預設檢查維護、版本更新與購物商場，三個分類分開發送。**同一輪有兩個以上分類需通知時，固定依「維護 → 版本更新 → 購物商場」發送，不受設定中的排列順序影響。**沒有變化的公告仍會略過。版本更新最多三篇，維護與商城各最多一篇，各篇分開發送；若三個分類各有一篇需通知，正常共三則。單篇商城超過 Discord 上限時另拆成多則。

**篇數上限不等於每次必定發送的訊息數。**預設三個分類一輪最多比對五篇公告；仍需通過去重及維護判斷，其他分類另受時間區間限制，商城也可能沒有可通知內容。例如三篇版本更新與一篇商城都需要通知、維護因較新的版本更新而略過，通常會發四則。商城拆分時，訊息數可能增加。

| 分類 | 顯示內容 | 排版 |
| --- | --- | --- |
| 維護 | 先顯示維護日期、起訖時間與時區，再列出職業、地區、技能、欄位、副本、活動等具體遊戲異動 | 一張公告卡片 |
| 版本更新 | 更新項目、關鍵日期與數值、相關頁面連結；每項說明要求 50 字以內，項目之間空一行 | 一張公告卡片 |
| 購物商場 | 商品名稱、WC 價格、內容物名稱、圖片、相關頁面連結、購買資訊 | 公告卡片 → 各商品先圖片再文字 → 其他異動（有才顯示） |

公告標題顯示於最上方，不顯示分類欄位、發布時間或底部時間戳。卡片底部保留「摘要由 AI 自動產生，詳細內容請以官方公告為準」；商城拆成多則時，只放在最後一張文字卡片。不顯示分類橫幅，保留商品圖片。

新公告標為【新公告】，同篇內容變更標為【公告更新】，強制重發已記錄的相同版本標為【公告】。**官網修改公告時，程式會另發一則更新訊息，保留舊訊息，不會自動刪除或覆寫。**判斷依公告 ID 與內容版本，不以是否同一天區分。

**點擊公告標題即可開啟對應的官網公告**，內文不再重複附上公告網址。商品說明等內文連結仍會保留。

### 購物商場的整理規則

- 「內容物、購買條件、可購買次數、販售時間」以清單呈現，欄位標題使用粗體，各項直接換行、不插入空白行，例如 `- **內容物：**道具名稱`。
- 公告未列出內容物時，直接省略「內容物」整行，不顯示「公告未列出」；單一道具仍保留商品名稱、價格、圖片與其他已知資訊。
- 每個商品文字卡片最後，依序列出「購買條件、可購買次數、販售時間」；公告沒寫的項目直接省略整行。
- 限購資訊保留帳號／角色限制、重置週期與時間；販售時間保留起訖日期及「維護前／維護後」等說明。
- 摘要規則要求 AI 排除下架、刪除、移除、停止販售或結束販售的商品，「其他異動」也不列入。仍在販售、只註明未來截止時間的商品會保留。
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

維護（`maintenance`）內文先顯示時間，再以條列列出公告內容摘要，例如以下示意：

```text
維護時間：11/24 07:00～12:00（GMT+8）

維護內容：

- 新增「皇家騎士團」職業與「耶雷弗」地區。

- 擴充寵物欄位，可攜帶三隻寵物並新增組合效果。
```

內容摘要著重玩家實際會遇到的遊戲內容異動，例如職業、地區、技能、角色／裝備／寵物欄位、副本賽季、序號活動、掉落率與具體錯誤修正。有「維護內容／更新項目」清單時優先依該清單順序整理；具體補償道具、數量或領取條件可保留。每項要求 80 字以內，保留重要日期、數量與限制，項目間空一行。

摘要排除「為提供更穩定的服務」等前言客套話、「維護時間可能調整／另行公告」「適用 PC／手機版」「維護期間無法登入／強制斷線」「請提前登出」等一般提醒，以及沒有具體細節的「其他遊戲內容優化／系統調整／例行檢查」。時間與摘要分別由 AI 擷取，再由程式組成卡片，去除空白及重複項目。有多個適用服務的時段時分行顯示；有延長、更正或實際完成時間時，依公告最新說明整理。

公告未註明時間時顯示「維護時間：公告未註明」，不以公告發布時間代替；沒有時間以外的實質內容時顯示「維護內容：公告未註明」。公告內容變更仍由標題的【公告更新】識別，內文不另外加入更新提示。

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

Artale 使用獨立指令與設定檔 `env/artale.js`。舊的 `npm start`、`npm run dry-run`、`npm run schedule` 已移除，請使用上表指令及 `npm run artale:schedule`。

### 強制重新發布的範圍

`--force` 只略過「相同公告版本已處理過」的檢查，不擴大頁面或變更維護規則。預設單次執行與預覽仍只處理第一頁的「維護最新一篇、版本更新最新三篇、商城最新一篇」；加上 `--window` 時，版本更新仍比對最新三篇，其他分類只處理本次時間區間內的公告。`--window --force` 會重發選取到的版本更新，即使發布時間在區間外。

| 分類 | 使用 `--force` 時 |
| --- | --- |
| 維護 | 只選最新一篇，套用[發布時間判斷](#維護公告)，符合條件才重新摘要及發送 |
| 版本更新 | 重新摘要及發送官網 `update` 第一頁最新三篇中符合本輪模式的公告 |
| 購物商場 | 只重新摘要最新一篇，仍排除下架商品、略過未提供的購買資訊；沒有需通知內容就不發送 |

發送順序仍是「維護 → 版本更新 → 購物商場」，未選取或需略過的分類不發送。重新產生的摘要文字可能與上次不同；加上 `--dry-run` 時只預覽符合上述條件的內容。

**強制重發不會刪除或覆寫舊訊息。**需要替換舊公告時，依[刪除後重新發布](#刪除後重新發布)操作；只想撤下舊維護公告時，用 `webhook delete` 刪除即可。

### 只處理單一分類

加上 `--category` 時，這次只處理指定分類（逗號分隔），不修改設定檔；Windows 與 macOS 用法相同：

```bash
# 購物商場
npm run artale:preview -- --force --category bm

# 版本更新
npm run artale:preview -- --force --category update

# 維護
npm run artale:preview -- --force --category maintenance
```

預覽不需要設定 Webhook。確認後，將同一指令中的 `npm run artale:preview` 改為 `npm run artale`，就會實際發送到設定的每個 Webhook。

<details>
<summary>尚未安裝 AI CLI，或預覽時摘要失敗</summary>

預覽模式會顯示失敗原因，並使用簡易內容代替：

| 分類 | 替代內容 |
| --- | --- |
| 版本更新、活動等分類 | 公告內文開頭最多 1500 字 |
| 購物商場 | 從編號商品標題粗略擷取名稱、價格、圖片與連結；略過標題已標示下架或刪除等狀態的段落。內容物顯示預覽提示，三項購買資訊留空省略 |
| 維護 | 顯示「維護時間：尚未取得（預覽模式）」；維護內容區塊明確標示摘要失敗，改列公告開頭最多 1500 字 |

簡易預覽只能確認基本版面，無法驗證完整的 AI 摘要與商品排除結果。正式模式不會使用替代內容：摘要失敗的公告不發送、不記錄，其他公告仍可繼續處理。

</details>

## 管理 Discord 發文

Artale 專用入口固定使用 `env/artale.js` 的 `webhooks` 與 `files.discordMessages`，不檢查公告、排程或 AI 設定。也可直接執行 `node src/artale/webhook.js <操作> ...`。設定了多個 Webhook 時，新增、修改、刪除需加上 `--webhook-id <ID>` 指定（ID 可從 `list` 的 `webhookId` 查到）。

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

**刪除 DC 訊息不會清除 `data/artale/state.json` 的公告去重紀錄。**即使 DC 公告已全部刪除，直接執行 `npm run artale` 仍會略過已通知且未變更的版本；需要重新發布時使用 `npm run artale -- --force`，仍遵守最新一篇／三篇與維護判斷規則。`--force` 會重新發送到設定的每個 Webhook。若自訂 `files.state`，去重紀錄以該設定路徑為準。

以下只處理商城；要處理版本更新，將 `bm` 改為 `update`：

```bash
# 1. 先確認第一頁的目標公告與新排版
npm run artale:preview -- --force --category bm

# 2. 查詢目前 Webhook 的訊息 ID，選擇要替換的 active 紀錄
node src/artale/webhook.js list

# 3. 將數字換成舊公告的實際 messageId
node src/artale/webhook.js delete --message-id 123456789012345678

# 4. 重新產生摘要並發布商城公告
npm run artale -- --force --category bm
```

商城若拆成多則，需逐則刪除該篇公告的舊訊息。若摘要成功但商城預覽為空，請先確認這是預期結果；正式執行時若仍沒有需通知內容，就不會發送。若需保持摘要文字完全相同，請先準備固定內容的 JSON 檔，並用 `create --file` 預覽及發送；`npm run artale -- --force` 會重新產生摘要，並不直接沿用預覽結果。

### Webhook 與訊息紀錄

Artale 發文紀錄預設為 `data/artale/discord-messages.jsonl`，可用設定檔的 `files.discordMessages` 調整；所有 Webhook 共用這份紀錄，每筆都記有 Webhook ID。每份紀錄檔保留最近 100 筆新增、修改、刪除操作；排程發送的訊息也會立即記錄 ID，供查詢或撤回。

`list` 只讀本機紀錄；只設定一個 Webhook 時只列出該 Webhook，有多個時列出全部（可加 `--webhook-id` 篩選）。`active`／`deleted` 狀態、保留上限與紀錄寫入失敗的處理，見[共用訊息操作紀錄](../README.md#訊息操作紀錄)。

修改與刪除必須使用原本的 Webhook。Artale 專用入口不能透過 `--source` 切換主題；若要使用另一個群組的 Webhook，可明確指定 `--webhook URL`。

## 自動排程

修改 `env/artale.js`、`env/.env.shared` 或程式後，需重新啟動常駐程式才會載入新設定與排版；已發布的訊息不會自動修改。排程在 `env/artale.js` 的 `schedule` 設定：

```js
schedule: {
  days: '2',              // 1=週一，7=週日；支援 '2,4'、'1-5' 等寫法
  start: '08:20',         // 開始時間
  end: '17:20',           // 結束時間
  intervalMinutes: 60,    // 排程間隔與其他分類回溯分鐘數；版本更新及啟動檢查不受回溯限制
  timeZone: 'Asia/Taipei',
},
```

啟動時先依各分類篇數上限檢查一次第一頁，不受星期與時段限制；後續預設固定時間點為 08:20、09:20、…、17:20，共 10 次。時間點從開始時間起算，超過結束時間就停止；間隔無法整除時，最後一次會早於結束時間。目前不支援跨午夜時段，開始時間必須早於或等於結束時間。

| 需求 | 設定範例 |
| --- | --- |
| 每週二、週四 10:00～18:00，每 30 分鐘 | `days: '2,4'`、`start: '10:00'`、`end: '18:00'`、`intervalMinutes: 30` |
| 平日 09:00～21:00，每 2 小時 | `days: '1-5'`、`start: '09:00'`、`end: '21:00'`、`intervalMinutes: 120` |
| 每天全天，每小時整點 | `days: '1-7'`、`start: '00:00'`、`end: '23:00'`、`intervalMinutes: 60` |

常駐程式每次檢查結束後才安排下一次，同一程序不會同時跑兩次。電腦睡眠後喚醒，若仍在時段內會立即檢查一次，超過時段則略過。喚醒檢查也只往前查看設定的分鐘數，不補查整段睡眠時間。

需要保持執行時，可使用 `tmux` 或 `pm2`。若使用會自動重啟的工具，需關閉自動重啟，讓內容轉譯錯誤發生時能停止排程，例如：

```bash
pm2 start npm --name artale --no-autorestart -- run artale:schedule
```

## Webhook 名稱與頭像變更提醒

伺服器管理員可以在 Discord 頻道設定中更換這個 Webhook 的頭像與名稱，Discord 不會通知程式。Artale 每次正式檢查公告時（常駐排程的每個檢查時間點，或執行 `npm run artale`），程式會先查詢每個 Webhook 目前的名稱與頭像，與上次記錄比較；被更換時發送一則提醒。

每個機器人的定位不同，所以在 `env/artale.js` 的 `webhooks` 中，**每個 Webhook 各自設定** `webhookProfile`，三者預設都是空的：

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
- 記錄依 Webhook 存在 `data/artale/webhook-profiles/<Webhook ID>.json`，與其他主題分開；即使和其他主題使用同一個 Webhook，也各自偵測、各自發送自己的提醒。
- AI 只看新頭像，不比較新舊頭像；自訂頭像被移除時不附圖，會告訴 AI 已改回 Discord 預設頭像。
- AI 感想使用共用的 AI 設定（`AI_PROVIDER` 與對應的執行檔、模型）與 `AI_TIMEOUT_MS` 逾時設定，不開放網路搜尋；實測一次約 10 秒。
- 查詢、AI 感想或發送失敗時不更新記錄，下次執行會再試；錯誤只記錄，不影響公告的發送。
- 提示詞需要換行時，在 JS 字串中以 `\n` 表示換行，或改用反引號（`` ` ``）包住多行文字。
- 只能在程式執行時發現變更，也無法得知是誰更換的；預覽模式（`npm run artale:preview`）不檢查。

## 多個 Webhook

同樣的公告要發送到多個 Discord 頻道或伺服器時，在 `env/artale.js` 的 `webhooks` 列出多個 Webhook：

```js
webhooks: [
  { name: '自己的伺服器', url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy' },
  {
    name: '朋友的伺服器', // 只是給自己辨識的備註
    url: 'https://discord.com/api/webhooks/xxxxxxxx/yyyyyyyy',
    webhookProfile: { personaPrompt: '你是一位認真的冒險者公會櫃台小姐' }, // 這個機器人自己的角色
  },
],
```

| 欄位 | 必填 | 用途 |
| --- | --- | --- |
| `url` | 是 | Discord Webhook 網址 |
| `name` | 否 | 給自己辨識用的備註，程式不會用它判斷任何事，只顯示在終端機紀錄中 |
| `webhookProfile` | 否 | 這個 Webhook 的[名稱與頭像變更提醒](#webhook-名稱與頭像變更提醒)：`personaPrompt`、`avatarMessage`、`nameMessage`，未填寫時不發送提醒 |

- 程式以網址中的 **Webhook ID** 區分每個 Webhook；`name` 只顯示在終端機紀錄中。欄位名稱寫錯或網址重複時會直接報錯。
- 每篇公告只呼叫一次 AI 產生摘要，所有 Webhook 收到的摘要內文相同，再依序發送到每個需要通知的 Webhook。
- **公告去重紀錄依 Webhook 分開**：每個 Webhook 各自記錄已通知的版本。某個 Webhook 發送失敗不影響其他 Webhook，下次檢查只補發給失敗的 Webhook（仍需在本輪檢查範圍內）。
- 新加入的 Webhook 從空紀錄開始，下次啟動檢查會收到第一頁各分類最新的公告。
- 判斷「新公告」或「公告更新」是程式比對各 Webhook 的紀錄（公告 ID 與內容雜湊值），不經過 AI。同一篇公告對已收過舊版本的 Webhook 標示【公告更新】，版本更新等文字摘要的最前面再加一行「（公告已更新）」；對第一次收到的 Webhook 標示【新公告】。這些標示由程式加上，摘要內文都一樣。
- 修改清單後需重新啟動 `npm run artale:schedule`。

## 設定參考

Artale 的所有設定集中在 `env/artale.js`（範例見 [env/artale.example.js](../env/artale.example.js)），以 `export default` 匯出設定物件，可以直接寫註解；除了 `webhooks` 以外都是選填，未填寫時使用預設值。欄位名稱寫錯或型別不符時，程式會指出設定檔與欄位名稱並停止。

共用的 AI 設定（使用的 AI、執行檔、模型、API key、摘要逾時）放在 `env/.env.shared`，見[根目錄 README](../README.md#共用設定)。紀錄檔的相對路徑以專案根目錄為準；手動指令的 `--file` 則以目前執行目錄為準。系統環境變數不會覆寫 Artale 設定；只有 `ARTALE_CONFIG_FILE` 可用來改用其他設定檔。

### Artale 設定欄位

| 欄位 | 預設值 | 用途 |
| --- | --- | --- |
| `webhooks` | 無 | Webhook 清單，正式發送及常駐排程至少要一個；預覽不需要。每個 Webhook 的欄位見[多個 Webhook](#多個-webhook) |
| `newsCategories` | `['maintenance', 'update', 'bm']` | 要檢查的分類；發送順序固定為維護 → 更新 → 商城，其他分類接在後面。也可寫成逗號分隔文字 |
| `schedule.days` | `'2'` | 排程星期，見[自動排程](#自動排程) |
| `schedule.start`、`schedule.end` | `'08:20'`、`'17:20'` | 每天第一次與最後一次檢查的時間 |
| `schedule.intervalMinutes` | `60` | 檢查間隔與其他分類的回溯分鐘數；版本更新每輪比對最新三篇 |
| `schedule.timeZone` | `'Asia/Taipei'` | 排程時區 |
| `webhooks[].webhookProfile.personaPrompt` | `''` | 該 Webhook 的角色設定提示詞；有填寫時由 AI 寫頭像與名稱的感想，見[變更提醒](#webhook-名稱與頭像變更提醒) |
| `webhooks[].webhookProfile.avatarMessage` | `''` | 沒有提示詞時，頭像被更換要發送的文字 |
| `webhooks[].webhookProfile.nameMessage` | `''` | 沒有提示詞時，名稱被更換要發送的文字；與頭像同時變更時為第二行 |
| `files.state` | `'data/artale/state.json'` | 公告版本紀錄檔（依 Webhook 分開記錄） |
| `files.discordMessages` | `'data/artale/discord-messages.jsonl'` | 最多保留最近 100 筆新增、修改及刪除操作紀錄，供 `webhook list` 查詢 |

### 舊環境遷移

舊版的 `env/.env.artale`（`ARTALE_` 開頭的環境變數）已停用，檔案仍存在時程式會提醒搬移。先停止原排程，複製 [env/artale.example.js](../env/artale.example.js) 為 `env/artale.js`，依下表填入原值後刪除 `env/.env.artale`，再重新啟動：

| 舊設定 | 新設定檔欄位 |
| --- | --- |
| `ARTALE_DISCORD_WEBHOOK_URL` | `webhooks: [{ url: '…' }]` |
| `ARTALE_NEWS_CATEGORIES` | `newsCategories` |
| `ARTALE_SCHEDULE_DAYS`、`_START`、`_END`、`_TIMEZONE` | `schedule.days`、`start`、`end`、`timeZone` |
| `ARTALE_CHECK_INTERVAL_MINUTES` | `schedule.intervalMinutes` |
| `ARTALE_PERSONA_PROMPT`、`ARTALE_AVATAR_CHANGED_MESSAGE`、`ARTALE_NAME_CHANGED_MESSAGE` | 該 Webhook 的 `webhookProfile.personaPrompt`、`avatarMessage`、`nameMessage` |
| `ARTALE_STATE_FILE`、`ARTALE_DISCORD_MESSAGES_FILE` | `files.state`、`files.discordMessages` |

舊版單一 Webhook 的公告去重紀錄（`data/artale/state.json`）會在下次正式執行時自動轉成依 Webhook 分開的格式，舊紀錄套用到當時設定的每個 Webhook，已通知的公告不會重發。更早期放在根目錄 `.env` 或 `data/state.json` 的設定與紀錄，請先搬到上述新位置；程式不再讀取根目錄 `.env`。

### 公告分類

| 設定值 | 分類 | 官網列表 |
| --- | --- | --- |
| `update` | 更新 | [查看](https://artale.live/tw/news?category=update) |
| `bm` | 購物商場 | [查看](https://artale.live/tw/news?category=bm) |
| `event` | 活動 | [查看](https://artale.live/tw/news?category=event) |
| `maintenance` | 維護 | [查看](https://artale.live/tw/news?category=maintenance) |
| `sanction` | 制裁 | [查看](https://artale.live/tw/news?category=sanction) |
| `all` | 全部 | [查看](https://artale.live/tw/news) |

例如在預設分類之外再加入活動：`newsCategories: ['maintenance', 'update', 'bm', 'event']`。其他分類依設定中的相對順序，接在維護、更新與商城之後發送。

各分類只檢查第一頁，維護與商城各選最新一篇、版本更新選最新三篇。版本更新每輪直接比對所選公告；其他分類啟動時直接比對，後續排程再套用本輪時間區間。依官網分類選取，不另外篩選標題。因此「版本更新」指官網 `update` 分類，該分類的兌換券或其他公告也可能成為本輪發送內容，以及維護發布時間的比較依據。

`all`、活動與制裁仍採第一頁符合本輪模式的公告，不套用上述三個分類的篇數上限；`all` 使用一般文字摘要，不會依文章的官網標籤套用各分類規則。若要維持維護判斷、商城商品排版與固定分類順序，請明確選擇 `maintenance,update,bm`。

## 問題排查

Node、AI CLI 與 Webhook 的共用問題，見[共用問題排查](../README.md#問題排查)。

| 現象 | 處理方式 |
| --- | --- |
| 預覽顯示沒有變化，未印出內容 | 使用 `npm run artale:preview -- --force` |
| 刪除 DC 公告後，重新執行仍顯示沒有變化 | 刪文不會清除公告去重紀錄；依[刪除後重新發布](#刪除後重新發布)使用 `--force`，不需刪除通知紀錄檔 |
| 發送數量比預期少，或加上 `--force` 仍沒有公告 | 先確認所選分類與啟動／區間模式；維護、商城各最新一篇，更新最新三篇。`--window` 只對版本更新以外的分類套用時間限制，維護仍受[發布時間判斷](#維護公告)限制，商城可能沒有可通知內容 |
| 尚未設定 Webhook | 確認 `env/artale.js` 的 `webhooks` 已填入至少一個 Webhook |
| 「env/.env.artale 已停用」 | 依[舊環境遷移](#舊環境遷移)搬到 `env/artale.js` 後刪除舊檔 |
| 「env/artale.js 的 … 有不支援的欄位」或型別錯誤 | 依錯誤訊息指出的欄位修正設定檔，欄位名稱見[設定參考](#artale-設定欄位) |
| 內容轉譯錯誤，排程停止 | 檢查官網結構及 `src/artale/client.js` 解析規則，修正後先預覽，再重新啟動排程 |

### 錯誤發生後會怎樣

| 錯誤類型 | 發送與紀錄 | 常駐排程 |
| --- | --- | --- |
| 內容轉譯錯誤 | 整次所有分類都不發送、不寫紀錄 | 以結束碼 `2` 停止，需修正後重啟 |
| 網路、AI 或 Discord 錯誤 | 抓取失敗的分類本輪略過；摘要或發送失敗只略過該篇，其他已取得的公告繼續處理 | 繼續排程；下次仍在第一頁的最新篇數上限內才重試，版本更新以外的分類另需在本輪時間區間內 |

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

程式只讀各分類第一頁，依官網發布時間選取各分類最新幾篇。啟動直接比對所選公告；後續版本更新仍比對最新三篇，其他分類再以內文頁完整發布時間篩選本輪區間。每篇依公告 ID 與「標題＋內文」的 SHA-256 雜湊值比對版本；發布時間影響選取排序及其他分類的時間範圍，不計入內容雜湊。

紀錄檔預設為 `data/artale/state.json`，依 Webhook 分開記錄，每個 Webhook 所有分類合計保留最近 100 筆。已記錄的相同版本會略過，超出保留範圍的舊版本則不受去重保護。商城沒有需通知內容時也會記錄，`notifiedAt` 表示完成處理的時間。

**公告去重紀錄依 Webhook 分開。**每個 Webhook 各自記錄已通知的版本，新加入的 Webhook 從空紀錄開始，下次啟動檢查會收到第一頁各分類最新的公告；從清單移除的 Webhook 紀錄保留在檔案中，不影響其他 Webhook。

重發第一頁且符合篇數上限的公告使用 `npm run artale -- --force`（會發送到每個 Webhook）；不在選取範圍的公告用手動 JSON 發文。刪除 `files.state` 指定的紀錄檔會清除去重紀錄，但不會突破第一頁與篇數限制；`--window` 只對版本更新以外的分類套用時間範圍限制。

<details>
<summary>查看紀錄檔格式</summary>

```json
{
  "targets": {
    "<Webhook ID>": {
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
  }
}
```

</details>

### 調整摘要與排版

| 要調整的內容 | 位置 |
| --- | --- |
| 版本更新摘要規則 | `src/artale/summarize.js` 的 `UPDATE_PROMPT` |
| 商城摘要、商品排除、購買資訊規則 | `src/artale/summarize.js` 的 `SHOP_PROMPT` |
| 維護時間、內容摘要與輸出格式 | `src/artale/summarize.js` 的 `MAINTENANCE_PROMPT`、`parseMaintenanceSummary()` |
| 維護發布時間判斷與分類發送順序 | `src/artale/run.js`、`src/artale/announcement-dates.js` |
| 各分類共用摘要規則 | `src/artale/summarize.js` 的 `COMMON_RULES` |
| Discord 卡片、粗體、行距與標題連結 | `src/artale/format.js` 的 `buildDiscordPayload()`、`buildShopMessages()` |

商城與維護摘要使用固定 JSON Schema。程式會核對商城商品圖片及頁面連結網址是否出現在原文中；版本更新等文字摘要的連結由摘要規則要求照抄，未另做網址核對。正式模式下，摘要解析檢查失敗就不發送或記錄該篇公告，其他公告仍繼續處理。

### 設定與紀錄位置

```text
env/
├── artale.example.js  # Artale 設定檔範例
├── artale.js          # Artale 正式設定檔，不納入版本控制
├── .env.shared.example  # 共用 AI 設定範例
└── .env.shared          # 共用正式設定，不納入版本控制
data/artale/
├── state.json             # 每個 Webhook 最近 100 筆公告版本
├── discord-messages.jsonl # 最近 100 筆訊息操作
└── webhook-profiles/      # 每個 Webhook 名稱與頭像的上次記錄，用來偵測更換
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

共用 Discord、AI 與排程工具的位置，見[共用專案結構](../README.md#專案結構)。
