# Discord 通知工具

提供共用的 Discord Webhook 發文管理、Codex 摘要執行器、排程時間計算與訊息操作紀錄。各主題的公告來源、設定、指令與規則放在各自的文件中。

**主題文件：[Artale 通知](docs/artale.md)**

## 目錄

- [環境設置](#環境設置)
- [共用設定](#共用設定)
- [共用 Webhook 工具](#共用-webhook-工具)
- [訊息操作紀錄](#訊息操作紀錄)
- [問題排查](#問題排查)
- [測試與開發](#測試與開發)
- [專案結構](#專案結構)

## 環境設置

需要 Node.js 20.12 以上，專案使用 Node 22，沒有 npm 套件依賴。自動產生摘要時需要 Codex CLI；只使用手動 Webhook 工具時不需要 Codex。

### Node.js 與 Codex CLI

先切換至專案根目錄，再執行：

```bash
nvm use
npm install -g @openai/codex
codex login
```

`nvm use` 依 [.nvmrc](.nvmrc) 切換至 Node 22。Codex 可使用 ChatGPT 帳號登入，也可透過 API key 驗證，見[共用設定](#共用設定)。

### 環境變數與 Discord Webhook

環境檔集中放在 `env/`，正式設定與範例檔分開。共用 Codex 設定可先複製：

```bash
cp env/.env.shared.example env/.env.shared
```

共用範例見 [env/.env.shared.example](env/.env.shared.example)。若沿用 Codex 預設值及 CLI 登入資訊，可省略正式共用檔。各主題另外複製 `env/.env.<來源>.example` 為 `env/.env.<來源>`，操作方式見主題文件。

程式只載入 `env/.env.shared` 與本次指定來源的環境檔，不讀取根目錄舊 `.env`、其他來源或 `.example`。系統環境變數優先，包含已設定的空值。共用檔不提供主題前綴設定，來源檔只接受自身前綴；Codex 設定請放在共用檔。

正式環境檔已列入 `.gitignore`，只有 `.example` 範例納入版本控制。

在 Discord 開啟 **頻道設定 → 整合 → Webhook → 新 Webhook**，複製網址，再填入對應主題的設定。Webhook 名稱與頭像也在 Discord 設定。

各主題使用自己的 Webhook、排程與去重紀錄設定。具體變數、預設值及啟動指令請查看該主題文件；共用設定不決定任何主題的輪詢時間。修改設定後，需重新啟動對應的常駐程式。

## 共用設定

以下設定放在 `env/.env.shared`，由共用 Codex CLI 執行器使用：

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | CLI 執行檔名稱或絕對路徑 |
| `CODEX_MODEL` | Codex 設定檔的模型 | 摘要使用的模型 |
| `CODEX_TIMEOUT_MS` | `300000`（5 分鐘） | 單次摘要逾時時間，與公告輪詢間隔分開 |
| `CODEX_API_KEY` | 使用 CLI 已儲存的登入資訊 | 以 API key 執行時提供，由子程序繼承 |

本專案使用 `codex exec`，沿用 CLI 已儲存的登入資訊，也可透過 `CODEX_API_KEY` 提供 API key，詳見 [OpenAI 官方文件](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation)。各主題提供自己的提示詞與輸出 Schema。

路徑規則：通知紀錄、發文紀錄及 `--history-file` 的相對路徑以專案根目錄為準；手動發文的 `--file` 以目前執行目錄為準。

## 共用 Webhook 工具

可直接新增、修改、刪除或查詢訊息，**不抓取公告、不呼叫 Codex、不修改公告去重紀錄**。

```bash
npm run webhook -- --help
```

也可執行 `node src/webhook.js <操作> ...`。支援的來源名稱為 `artale`、`stocks`、`crypto`；來源名稱用來選擇設定，不代表已實作該來源的自動公告服務。

### 選擇設定來源

`--source` 依來源名稱讀取 `env/.env.<來源>` 中的專屬 Webhook 與發文紀錄設定。例如選擇 `crypto`，就從 `env/.env.crypto` 讀取 `CRYPTO_DISCORD_WEBHOOK_URL` 與 `CRYPTO_DISCORD_MESSAGES_FILE`，不回退至其他來源或舊的全域設定。股票與虛擬幣的手動管理範例檔為 [env/.env.stocks.example](env/.env.stocks.example)、[env/.env.crypto.example](env/.env.crypto.example)。

| 選項 | 用途 |
| --- | --- |
| `--source NAME` | 使用指定來源的專屬設定 |
| `--webhook URL` | 明確指定 Webhook，優先於來源設定 |
| `--history-file PATH` | 明確指定發文紀錄檔，優先於來源設定 |
| `--thread-id ID` | 指定訊息所在的討論串；也可放在 Webhook URL 的 `thread_id` 參數 |
| `--dry-run` | 新增、修改、刪除只預覽，不連線、不寫紀錄 |

未指定 `--source` 時，新增、修改、刪除必須提供 `--webhook`。各來源預設紀錄分別放在 `data/<來源>/discord-messages.jsonl`；未指定來源或紀錄路徑時，使用 `data/shared/discord-messages.jsonl`。各主題也可提供固定來源的專用入口，見主題文件。

### 新增、修改與刪除

以下以已設定 Webhook 的 `crypto` 來源為例，可換成其他來源。新增、修改、刪除先加上 `--dry-run` 預覽；移除該參數才會異動 Discord。

```bash
# 新增純文字訊息
npm run webhook -- create --source crypto --content "測試公告" --dry-run

# 查詢本機發文紀錄，取得 messageId；list 不接受 --dry-run
npm run webhook -- list --source crypto

# 修改或刪除；將數字換成實際的 messageId
npm run webhook -- edit --source crypto --message-id 123456789012345678 --content "修正後的內容" --dry-run
npm run webhook -- delete --source crypto --message-id 123456789012345678 --dry-run
```

修改、刪除必須使用原本發送該訊息的 Webhook，見 [Discord 官方 Webhook 文件](https://docs.discord.com/developers/resources/webhook#edit-webhook-message)。`delete --message-id` 只刪除指定訊息，不會刪除 Webhook 本身。所有新增與修改都停用提及通知。

### 發送或修改卡片

先編輯範本 [examples/webhook-message.json](examples/webhook-message.json)，再預覽：

```bash
npm run webhook -- create --source crypto --file examples/webhook-message.json --dry-run
npm run webhook -- edit --source crypto --message-id 123456789012345678 --file examples/webhook-message.json --dry-run
```

`--content` 與 `--file` 擇一。新增接受單一 JSON 物件或訊息物件陣列；修改只接受單一物件。手動發文依 JSON 提供內容與排版，不自動套用主題的摘要規則。

修改時未提供的欄位會保留，提供的 `embeds` 則整組取代。`--content` 只修改普通文字；若要將既有卡片改為純文字，JSON 使用 `{"content":"新文字","embeds":[]}`。

## 訊息操作紀錄

每次成功的新增、修改、刪除都立即寫入紀錄，保存 Webhook ID、訊息 ID、標題及操作時間，不保存 Webhook token。**每份紀錄檔內，所有 Webhook 合計最多保留最近 100 筆操作**，超過時刪除最舊紀錄；既有超額紀錄也會在下次成功寫入時縮減。清理本機紀錄不會刪除 Discord 訊息。

`list` 只讀本機紀錄，不向 Discord 查詢：

| 狀態／情況 | 意義 |
| --- | --- |
| `status: "active"` | 本機尚無成功刪除紀錄 |
| `status: "deleted"` | 本機已記錄成功刪除 |
| 有設定或指定 Webhook | 只列出該 Webhook 的紀錄 |
| 未設定或指定 Webhook | 列出該紀錄檔中的全部 Webhook |

直接在 Discord 刪除訊息不會同步更新本機狀態。超出保留範圍後，可能查不到訊息或完整資料；若已知訊息 ID，仍可搭配原 Webhook 修改、刪除。功能加入前的舊訊息不會自動補入。

如果批次發送中途失敗，已成功訊息的 ID 仍會保存。Discord 已成功但紀錄寫入失敗時，程式會明確回報操作及訊息 ID；請保留 ID 並修正紀錄路徑或權限，避免直接重試新增造成重複訊息。各主題的公告去重機制另見專屬文件。

## 問題排查

| 現象 | 處理方式 |
| --- | --- |
| 找不到 Codex CLI | 安裝並登入；PATH 找不到時，設定 `CODEX_BIN` 絕對路徑 |
| Codex CLI 執行失敗 | 查看錯誤輸出，確認登入、額度與逾時設定 |
| `bad CPU type in executable` | 執行 `nvm use`，確認 Node 架構適合目前電腦；可用 `nvm alias default 22` 設定預設版本 |
| 找不到 Webhook 設定 | 確認選擇的來源、專屬環境變數或 `--webhook` 參數 |
| 修改／刪除回傳 HTTP 404 | 確認訊息 ID 與原 Webhook；訊息或 Webhook 可能已刪除 |
| Discord 操作成功但紀錄寫入失敗 | 保留錯誤內的訊息 ID，檢查紀錄檔路徑與權限，勿直接重試新增 |
| 紀錄檔留下 `.lock` | 確認沒有其他程序正在寫入，再移除強制中止程序留下的鎖檔 |

公告解析錯誤、維護判斷、排程與通知重試方式請查看主題文件。

## 測試與開發

```bash
npm test
```

`src/shared/` 不依賴特定主題；各主題自行處理資料取得、篩選、摘要規則、排版、去重與執行流程，再呼叫共用工具。

| 共用功能 | 位置 |
| --- | --- |
| Discord API、網址驗證與限流重試 | `src/shared/discord.js` |
| 發文操作及訊息 ID 紀錄 | `src/shared/posts.js` |
| Codex CLI、輸出 Schema 與逾時處理 | `src/shared/codex.js` |
| 排程設定與時間計算 | `src/shared/schedule.js` |
| 分來源環境檔載入與專案路徑 | `src/shared/env.js` |
| 紀錄輸出 | `src/shared/log.js` |

新增主題時，建立專屬模組、指令、設定前綴與說明文件；各主題分開執行。股票與虛擬幣目前只有共用手動 Webhook 工具支援，尚未加入自動公告抓取或排程服務。

## 專案結構

```text
.
├── README.md           # 共用環境與工具說明
├── docs/               # 各主題的使用文件
├── env/
│   ├── .env.shared.example # 共用 Codex 設定範本
│   ├── .env.shared     # 正式共用設定，不納入版本控制
│   └── .env.<來源>*    # 各主題正式設定與 .example 範本
├── .nvmrc              # Node 版本
├── package.json        # 執行指令
├── examples/           # 手動發文 JSON 範本
├── data/               # 依來源分資料夾存放紀錄，不納入版本控制
├── src/
│   ├── shared/         # 共用 Discord、Codex、排程與環境工具
│   ├── webhook.js      # 共用手動發文管理入口
│   └── artale/         # 主題模組，詳見專屬文件
└── test/               # 共用與各主題測試
```
