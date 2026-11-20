# Discord 通知工具

提供共用的 Discord Webhook 發文管理、AI 摘要執行器（Codex 或 Claude）、排程時間計算與訊息操作紀錄。各主題的公告來源、設定、指令與規則放在各自的文件中。

**主題文件：[Artale 通知](docs/artale.md) · [Crypto 每日新聞](docs/crypto.md) · [股票每日新聞](docs/stock.md) · [技術指標做單建議](docs/signal.md)**

## 目錄

- [環境設置](#環境設置)
- [共用設定](#共用設定)
- [共用 Webhook 工具](#共用-webhook-工具)
- [訊息操作紀錄](#訊息操作紀錄)
- [Webhook 名稱與頭像變更提醒](#webhook-名稱與頭像變更提醒)
- [問題排查](#問題排查)
- [測試與開發](#測試與開發)
- [專案結構](#專案結構)

## 環境設置

需要 Node.js 20.12 以上，專案使用 Node 22，沒有 npm 套件依賴。自動產生摘要時需要 Codex CLI 或 Claude Code CLI 其中一個（由 `AI_PROVIDER` 選擇，預設 Codex）；只使用手動 Webhook 工具時都不需要。

### Node.js 與 AI CLI

先切換至專案根目錄，再安裝要使用的 AI CLI：

```bash
nvm use

# 使用 Codex（預設）
npm install -g @openai/codex
codex login

# 或使用 Claude
npm install -g @anthropic-ai/claude-code
claude auth login
```

`nvm use` 依 [.nvmrc](.nvmrc) 切換至 Node 22。Codex 可使用 ChatGPT 帳號登入，也可透過 API key 驗證；Claude 可使用 Claude 訂閱帳號（Pro、Max、Team、Enterprise）登入，也可透過訂閱 token 或 API key 驗證。使用 Claude 時，在 `env/.env.shared` 設定 `AI_PROVIDER=claude`，見[共用設定](#共用設定)。

### 設定檔與 Discord Webhook

設定檔集中放在 `env/`，正式設定與範例檔分開：

| 檔案 | 內容 |
| --- | --- |
| `env/.env.shared` | 所有主題共用的 AI 設定（使用的 AI、執行檔、模型、API key、摘要逾時），環境變數格式 |
| `env/artale.js`、`env/crypto.js`、`env/stock.js`、`env/signal.js` | 各主題的**所有設定**：Webhook、排程、內容、名稱與頭像變更提醒、紀錄位置。JS 檔，可以直接寫註解 |

共用 AI 設定可先複製範例 [env/.env.shared.example](env/.env.shared.example)；若使用 Codex 並沿用預設值及 CLI 登入資訊，可省略正式共用檔：

```bash
cp env/.env.shared.example env/.env.shared
```

各主題複製自己的範例檔，再依主題文件填寫：

```bash
cp env/artale.example.js env/artale.js
cp env/crypto.example.js env/crypto.js
cp env/stock.example.js env/stock.js
cp env/signal.example.js env/signal.js
```

主題設定檔以 `export default` 匯出設定物件；除了 `webhooks` 以外都是選填，欄位名稱寫錯或型別不符時，程式會指出檔案與欄位並停止。共用檔只讀取 AI 等共用設定，系統環境變數優先，包含已設定的空值；系統環境變數不會覆寫主題設定。程式不讀取根目錄舊 `.env`；舊版的 `env/.env.artale`、`env/.env.crypto` 已停用，仍存在時會提醒搬到新的設定檔。

正式設定檔已列入 `.gitignore`，只有範例檔納入版本控制。

在 Discord 開啟 **頻道設定 → 整合 → Webhook → 新 Webhook**，複製網址，再填入對應主題設定檔的 `webhooks`。每個主題都可以列出多個 Webhook，同樣的內容會發送到每一個，各自記錄。Webhook 名稱與頭像也在 Discord 設定。

各主題使用自己的 Webhook、排程與去重紀錄設定。具體欄位、預設值及啟動指令請查看該主題文件；共用設定不決定任何主題的輪詢時間。修改設定後，需重新啟動對應的常駐程式。

不同主題的常駐排程是各自獨立的程式，可以在不同終端機同時執行，例如 `npm run artale:schedule`、`npm run crypto:schedule`、`npm run stock:schedule` 與 `npm run signal:schedule`。同一個主題的排程不要同時開兩份，否則會重複發送。

## 共用設定

以下設定放在 `env/.env.shared`，由共用 AI 摘要執行器使用：

| 變數 | 預設值 | 用途 |
| --- | --- | --- |
| `AI_PROVIDER` | `codex` | 使用的 AI：`codex`（Codex CLI）或 `claude`（Claude Code CLI） |
| `AI_TIMEOUT_MS` | `300000`（5 分鐘） | 單次摘要逾時時間，與公告輪詢間隔分開；舊名稱 `CODEX_TIMEOUT_MS` 仍可使用。Crypto 網路搜尋另用 `env/crypto.js` 的 `aiTimeoutMs` |
| `CODEX_BIN` | `codex` | Codex CLI 執行檔名稱或絕對路徑 |
| `CODEX_MODEL` | Codex 設定檔的模型 | 使用 Codex 時的模型 |
| `CODEX_API_KEY` | 使用 CLI 已儲存的登入資訊 | 以 API key 執行 Codex 時提供，由子程序繼承 |
| `CLAUDE_BIN` | `claude` | Claude Code CLI 執行檔名稱或絕對路徑 |
| `CLAUDE_MODEL` | Claude Code 預設模型 | 使用 Claude 時的模型，可寫別名（`sonnet`、`opus`、`haiku`）或完整模型 ID |
| `CLAUDE_CODE_OAUTH_TOKEN` | 使用 CLI 已儲存的登入資訊 | `claude setup-token` 產生的訂閱 token，供無法互動登入的主機使用 |
| `ANTHROPIC_API_KEY` | 不使用 | 以 Anthropic API key 執行 Claude，按 API 用量計費；有設定時優先於訂閱登入 |

各主題提供自己的提示詞與輸出 Schema，兩種 AI 共用；切換 `AI_PROVIDER` 後重新啟動常駐排程即可，不需修改主題設定。

### Codex

本專案使用 `codex exec`，沿用 CLI 已儲存的登入資訊，也可透過 `CODEX_API_KEY` 提供 API key，詳見 [OpenAI 官方文件](https://learn.chatgpt.com/docs/non-interactive-mode#authenticate-in-automation)。需要最新資訊的主題（Crypto）會以 `-c web_search="live"` 開放即時網路搜尋。

### Claude

本專案使用 `claude -p` 非互動模式，沿用 `claude auth login` 的登入資訊，也可透過 `CLAUDE_CODE_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY` 驗證，詳見 [Claude Code 官方文件](https://code.claude.com/docs/en/headless)。每次執行：

- 在空的暫存資料夾執行，不讀取使用者與專案的設定檔（hooks、外掛、權限規則），不載入 MCP 伺服器，也不保存對話紀錄。
- 預設不提供任何工具；需要最新資訊的主題（Crypto）只開放 `WebSearch`、`WebFetch` 網路搜尋。
- 輸出 Schema 以 `--json-schema` 傳入；AI 感想的新頭像圖片以 stream-json 格式附在訊息中。

系統環境變數或 `env/.env.shared` 有 `ANTHROPIC_API_KEY` 時，即使已用訂閱帳號登入，Claude 也會改用 API key 並按用量計費；要使用訂閱額度請移除此變數。

路徑規則：通知紀錄、發文紀錄及 `--history-file` 的相對路徑以專案根目錄為準；手動發文的 `--file` 以目前執行目錄為準。

## 共用 Webhook 工具

可直接新增、修改、刪除或查詢訊息，**不抓取公告、不呼叫 AI、不修改公告去重紀錄**。

```bash
npm run webhook -- --help
```

也可執行 `node src/webhook.js <操作> ...`。支援的來源名稱為 `artale`、`crypto`、`stock`、`signal`。

### 選擇設定來源

`--source` 依來源名稱讀取該主題設定檔中的 Webhook 與發文紀錄設定。例如選擇 `crypto`，就從 `env/crypto.js` 讀取 `webhooks` 與 `files.discordMessages`，不檢查排程等其他設定，也不讀取其他來源的設定。設定了多個 Webhook 時，新增、修改、刪除需加上 `--webhook-id` 指定。

| 選項 | 用途 |
| --- | --- |
| `--source NAME` | 使用指定來源的專屬設定 |
| `--webhook URL` | 明確指定 Webhook，優先於來源設定 |
| `--webhook-id ID` | 來源設定了多個 Webhook 時（例如 [Crypto 的 Webhook 清單](docs/crypto.md#多個-webhook)），指定要使用的 Webhook ID |
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

## Webhook 名稱與頭像變更提醒

Webhook 的名稱與頭像可以被伺服器管理員在 Discord 頻道設定中更換，Discord 不會通知 Webhook。共用模組 `src/shared/webhook-profile.js` 會在各主題每次正式執行時查詢目前的名稱與頭像，和該主題上次的記錄比較；被更換時依主題設定發送提醒：

- 每個 Webhook（機器人）的定位不同，提醒設定寫在主題設定檔 `webhooks` 中各 Webhook 的 `webhookProfile`。
- 有角色設定提示詞（`personaPrompt`）時，由 AI（Codex 或 Claude）看新頭像圖片與新名稱，以角色口吻寫感想。
- 沒有提示詞時，直接發送固定文字（`avatarMessage`、`nameMessage`）。
- 三者都是空的（預設）時不發送。兩者同時被更換時發送兩行：第一行頭像、第二行名稱。

各主題、各 Webhook 的記錄分開，詳細規則見 [Artale](docs/artale.md#webhook-名稱與頭像變更提醒)、[Crypto](docs/crypto.md#webhook-名稱與頭像變更提醒) 文件；股票與技術指標的規則與 Crypto 相同。

## 問題排查

| 現象 | 處理方式 |
| --- | --- |
| 找不到 Codex CLI 或 Claude Code CLI | 安裝並登入；PATH 找不到時，設定 `CODEX_BIN` 或 `CLAUDE_BIN` 絕對路徑 |
| Codex CLI 或 Claude Code CLI 執行失敗 | 查看錯誤輸出，確認登入、額度、模型名稱與逾時設定 |
| `AI_PROVIDER 只能是 codex 或 claude` | 修正 `env/.env.shared` 或系統環境變數的 `AI_PROVIDER` |
| Claude 按 API 用量計費，而不是使用訂閱額度 | 移除系統環境變數或 `env/.env.shared` 中的 `ANTHROPIC_API_KEY` |
| `bad CPU type in executable` | 執行 `nvm use`，確認 Node 架構適合目前電腦；可用 `nvm alias default 22` 設定預設版本 |
| 找不到 Webhook 設定 | 確認選擇的來源、主題設定檔 `env/<主題>.js` 的 `webhooks`，或 `--webhook` 參數 |
| 修改／刪除回傳 HTTP 404 | 確認訊息 ID 與原 Webhook；訊息或 Webhook 可能已刪除 |
| Discord 操作成功但紀錄寫入失敗 | 保留錯誤內的訊息 ID，檢查紀錄檔路徑與權限，勿直接重試新增 |
| 紀錄檔留下 `.lock` | 確認沒有其他程序正在寫入，再移除強制中止程序留下的鎖檔 |

公告解析錯誤、維護判斷、排程與通知重試方式請查看主題文件。

## 測試與開發

```bash
npm test
```

`src/shared/` 不依賴特定主題；各主題自行處理資料取得、篩選、摘要規則與排版，再呼叫共用工具。定期發送並取代前一次訊息的主題（Crypto、股票、技術指標）共用同一套發送流程與紀錄（`daily-digest.js`、`digest-state.js`），只需提供自己的內容產生方式與排版；Crypto 與股票每天發送一次，共用 `digest-scheduler.js` 的排程，技術指標則與 Artale 一樣在時段內每隔固定分鐘執行。

| 共用功能 | 位置 |
| --- | --- |
| Discord API、網址驗證與限流重試 | `src/shared/discord.js` |
| 發文操作及訊息 ID 紀錄 | `src/shared/posts.js` |
| 選擇 AI（`AI_PROVIDER`）與摘要入口 | `src/shared/ai.js` |
| Codex CLI 執行器 | `src/shared/codex.js` |
| Claude Code CLI 執行器 | `src/shared/claude.js` |
| 外部 CLI 執行、逾時與錯誤處理 | `src/shared/process.js` |
| 發送流程：產生內容 → 刪除前一次的訊息 → 發送 → 記錄 | `src/shared/daily-digest.js` |
| 每天一次的常駐排程、補發與重試 | `src/shared/digest-scheduler.js` |
| 每日紀錄（依 Webhook 分開） | `src/shared/digest-state.js` |
| 新聞欄位 Schema、整理、依優先清單挑選與卡片排版 | `src/shared/news.js` |
| 虛擬貨幣、台股、美股的代號格式規則 | `src/shared/symbols.js` |
| 排程設定與時間計算 | `src/shared/schedule.js` |
| 分來源環境檔載入與專案路徑 | `src/shared/env.js` |
| 紀錄輸出 | `src/shared/log.js` |
| Webhook 名稱與頭像變更提醒 | `src/shared/webhook-profile.js` |
| 主題設定檔載入與欄位檢查 | `src/shared/topic-config.js` |
| Webhook 清單檢查 | `src/shared/targets.js` |

新增主題時，建立專屬模組、指令、設定檔範例（`env/<主題>.example.js`）與說明文件，並將來源名稱加入 `src/shared/env.js` 的 `SOURCES`；各主題分開執行。主題設定檔的載入與欄位檢查工具在 `src/shared/topic-config.js`。

## 專案結構

```text
.
├── README.md           # 共用環境與工具說明
├── docs/               # 各主題的使用文件
├── env/
│   ├── .env.shared.example # 共用 AI 設定範本
│   ├── .env.shared     # 正式共用設定，不納入版本控制
│   ├── <主題>.example.js # 各主題設定檔範例
│   └── <主題>.js       # 各主題正式設定檔（Webhook、排程、內容、提醒），不納入版本控制
├── .nvmrc              # Node 版本
├── package.json        # 執行指令
├── examples/           # 手動發文 JSON 範本
├── data/               # 依來源分資料夾存放紀錄，不納入版本控制
├── src/
│   ├── shared/         # 共用 Discord、AI、排程與環境工具
│   ├── webhook.js      # 共用手動發文管理入口
│   ├── artale/         # Artale 公告通知，詳見專屬文件
│   ├── crypto/         # 每日美國經濟與虛擬貨幣新聞，詳見專屬文件
│   ├── stock/          # 每日台股與美股新聞，詳見專屬文件
│   └── signal/         # 每日技術指標做單建議，詳見專屬文件
└── test/               # 共用與各主題測試
```
