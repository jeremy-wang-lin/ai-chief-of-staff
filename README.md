# AI Chief of Staff (`lcos`)

AI 驅動、local-first 的個人工作管理系統。資料存放在單一 SQLite 檔案，所有操作由同一份 operation registry 定義，再投影成 CLI、REST API + Web UI，以及 MCP tools，讓人與 AI agent 共用一致的操作邊界。

> 本 repository 是公開可存取的 distribution snapshot，不是開源專案，也沒有授予 open-source license。詳見 [`NOTICE.md`](NOTICE.md)。

## 功能概覽

- Tasks、Notes、Radar、Projects、Briefings 與全文搜尋
- React SPA + 本機 REST server
- 全 JSON CLI 與 38 個 registry-backed MCP tools
- 覆寫前保留 revision、刪除採 soft delete
- `/daily`、`/weekly`、`/process-notes`、`/summarize-projects` AI 工作流
- Jira Server/Data Center 與 Cloud 的唯讀查詢；Jira 不可用時可降級運作
- SQLite 單檔備份與 NDJSON 匯入

需求：Node.js 22.13 以上、pnpm 11。

## Quickstart

```bash
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
set -a && source .env && set +a
pnpm lcos read snapshot
pnpm web:build
pnpm serve
```

瀏覽 <http://127.0.0.1:4700>。第一次執行會建立 SQLite DB 並自動套用 migrations；空資料庫也會回傳合法 snapshot。

程式只讀取 process environment，不會自動載入 `.env`。每個新 shell 都需要重新 `source .env`，或在執行指令時直接提供環境變數。

## 資料與安全邊界

- 本系統設計給單一使用者在受信任電腦上執行，不是多租戶或 Internet-facing service。
- SQLite 內容未加密；DB、backup、`.env` 與任何匯出資料都不應提交版本控制。
- 預設只監聽 `127.0.0.1`，不接受其他裝置連線。
- 對區網開放時必須設定 access token；流量仍是明文 HTTP，只能用在受信任網路。
- Jira token 應使用所需查詢權限內的最小權限憑證。
- 實際工作資料不會被同步至 Jira 或其他雲端服務；Jira connector 僅即時唯讀查詢。

## 環境變數

| 變數 | 用途 |
|---|---|
| `LCOS_DB_PATH` | SQLite 路徑；預設 `~/.lcos/data.db` |
| `LCOS_BACKUP_DIR` | `pnpm lcos backup` 未傳 `--dest` 時的目的地 |
| `LCOS_PORT` | Web server port；預設 `4700` |
| `LCOS_HOST` | 綁定位址；預設 `127.0.0.1` |
| `LCOS_TOKEN` | `/api/*` 的 Bearer token；非 loopback 模式必填 |
| `LCOS_ALLOWED_HOSTS` | 非 loopback 模式額外允許的 hostname，逗號分隔、不含 port |
| `JIRA_BASE_URL` | Jira base URL，不含結尾斜線 |
| `JIRA_TOKEN` | Jira PAT，或 Cloud 的 `email:api-token` |
| `JIRA_PROJECTS` | 允許查詢的 project keys，逗號分隔 |

## CLI

CLI 目前由 TypeScript source 直接執行，因此請從 repository 根目錄使用 `pnpm lcos …`：

```bash
pnpm lcos --help
pnpm lcos read tasks --status To-do --overdue
pnpm lcos read task --id 12
pnpm lcos search --q 支付閘道
pnpm lcos write note --body-file note.md --type Meeting
pnpm lcos update task --id 12 --status Done
pnpm lcos import --table tasks --file rows.ndjson --dry-run true
pnpm lcos backup --dest /path/to/backups
```

成功時 stdout 為 JSON、exit code `0`；操作錯誤時 stderr 為 `{"error":{"code":"…","message":"…"}}`、exit code `1`。`import` 的資料驗證失敗會輸出 `ok:false` 並維持 exit code `0`，呼叫端需檢查 `.ok`。

## Web UI

正式使用：

```bash
pnpm web:build
pnpm serve
```

若 `packages/web/dist` 不存在，server 仍會提供 API，但瀏覽器根路徑會回 `not found`。

前端開發需要兩個 terminal：

```bash
# terminal 1
pnpm serve

# terminal 2
pnpm web:dev
```

開發 UI 位於 <http://127.0.0.1:5173>，Vite 會將 `/api` proxy 到 port 4700。

## 從其他裝置連入

只有在受信任區網中才應開啟：

```bash
openssl rand -hex 32
```

將產生的固定值寫入 `.env`，不要在 `.env` 內寫 command substitution：

```bash
LCOS_HOST=0.0.0.0
LCOS_TOKEN=<貼上固定的隨機值>
```

以 hostname（例如 mDNS 名稱）連線時，需加入 allowlist：

```bash
LCOS_ALLOWED_HOSTS=myhost.local
```

啟動後會列出可連線的 IPv4 URLs。沒有正確 token 的 API request 會回 `401`；未允許的 Host 會回 `403`。Token 不能提供 TLS 保護，同網段攻擊者仍可能觀察明文流量。

## MCP 與 opencode 工作流

MCP stdio server 入口：

```bash
pnpm tsx packages/app/src/mcp/main.ts
```

opencode 設定格式依版本可能不同；一個常見的 local MCP 設定如下：

```json
{
  "mcp": {
    "lcos": {
      "type": "local",
      "command": ["pnpm", "tsx", "packages/app/src/mcp/main.ts"],
      "enabled": true
    }
  }
}
```

Repository 內的 `.opencode/command/` 提供四個工作流：

| 指令 | 用途 |
|---|---|
| `/daily` | 處理筆記、增量更新專案知識、產生 Daily Briefing |
| `/weekly` | 產生每週趨勢、風險與建議 |
| `/process-notes [id]` | 即時處理指定或全部未處理筆記 |
| `/summarize-projects [project]` | 強制更新指定或全部 Active project 知識 |

工作流遵循「AI 提案 → 人批准 → 落地」；實際寫入前應確認提案內容。

## Jira

Jira connector 不會將 issue 寫入 SQLite，只執行即時唯讀查詢。未設定 Jira 時相關操作回 `JIRA_UNAVAILABLE`，其他功能不受影響。

- Server / Data Center：`JIRA_TOKEN` 使用 Personal Access Token，以 Bearer authentication 送出。
- Cloud（`*.atlassian.net`）：`JIRA_TOKEN` 使用 `email:api-token`，connector 會轉成 Basic authentication。

驗證：

```bash
pnpm lcos read jira sprint
```

## 備份

本系統不內建排程 daemon。請定期手動執行：

```bash
pnpm lcos backup --dest /path/to/backups
```

備份使用 SQLite `VACUUM INTO`，並採 temporary-file-then-rename，避免失敗時破壞既有備份。

## 驗證與開發

```bash
pnpm typecheck
pnpm test
pnpm web:build
```

資料庫 schema 變更只能新增 migration；已發布於 `packages/core/drizzle/` 的 migration 不得修改。

主要目錄：

```text
packages/core/   SQLite、repositories、revisions、search、registry、Jira
packages/app/    CLI、REST server、MCP server
packages/web/    React SPA
.opencode/       AI workflow commands 與共用 steps
```

## Distribution notice

這份 source snapshot 公開可見，但不提供 open-source license，也不保證接受 issues、pull requests 或外部功能需求。使用、修改或再散布前，請先取得權利人的書面許可；GitHub Terms of Service 所提供的必要平台權利不受此聲明影響。
