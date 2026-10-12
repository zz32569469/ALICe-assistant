---
type: tool
title: Claude Code
aliases: [Claude, Claude Code CLI]
domain: AI 協作
tags: [工具/Claude Code]
projects: []
sources: []
up: "[[Claude Code 與 Codex 分工]]"
related: ["[[Codex]]", "[[token 節省原則]]", "[[委派 Codex 流程]]"]
created: {{DATE}}
updated: {{DATE}}
status: draft
---

# Claude Code

> Anthropic 的 AI coding agent（CLI、桌面 App、IDE 外掛）。在本工作流程中擔任主導：查知識庫、規劃、與使用者確認、委派 [[Codex]]、驗收，並維護知識庫。

## 基本資訊

| 項目 | 內容 |
| --- | --- |
| 類別 | AI coding agent |
| 使用環境 | Claude 桌面 App（Code 分頁），Windows |
| 官方文件 | https://docs.claude.com/en/docs/claude-code |

## 核心用法

### 設定檔

| 檔案 | 用途 | 本庫內容 |
| --- | --- | --- |
| `{{USERPROFILE}}/.claude/CLAUDE.md` | 全域指引，每個 session 載入 | 知識庫查詢規則、Claude Code 與 Codex 分工（細節在 skill） |
| `{{USERPROFILE}}/.claude/skills/<name>/SKILL.md` | skill：依 `description` 觸發、需要時才載入 | `kb`（知識庫查詢與維護）、`delegate`（委派 Codex） |
| `{{USERPROFILE}}/.claude/scripts/` | skill 使用的腳本 | `codex-delegate.mjs`、`agent-snapshot.mjs`、`codex-watch.mjs` |
| `{{USERPROFILE}}/.claude/settings.json` | 模型、外掛、權限 | 啟用 codex-plugin-cc；權限允許清單 |
| `{{USERPROFILE}}/.claude/projects/<path>/memory/` | 跨 session 記憶 | 使用者偏好 |

### 權限允許清單

`settings.json` 的 `permissions.allow` 列出免詢問的指令。只放不修改檔案或已驗證的腳本：

```json
"permissions": { "allow": [
  "Bash(node ~/.claude/scripts/codex-delegate.mjs:*)",
  "Bash(git status:*)", "Bash(git diff:*)"
] }
```

- 會覆寫檔案的操作（從快照還原、`git commit`、啟動 dev server）不放入，保留每次詢問。
- 可用內建 `/fewer-permission-prompts` 依過去紀錄產生建議清單。
- 修改後從下一個 session 生效。

### 等待長時間工作的兩種方式

| 方式 | 通知次數 | 適用 |
| --- | --- | --- |
| 背景 Bash（`run_in_background`，指令在條件成立時結束） | 1 次 | 只需要知道何時完成（委派、模擬、建置） |
| Monitor（每行輸出一則通知） | 每則事件 1 次 | 每個事件都需要 Claude 處理；**不要**用於給人看的進度 |

### 跨 session 溝通

- `ListAgents` 列出本機其他 session，以名稱用 `SendMessage` 傳訊；回覆時 `to` 用收到訊息的 `from`。
- session 重開後位址會變，傳送失敗時重新 `ListAgents` 以名稱傳送。

## 注意事項

> [!danger] 注意
> - 全域 `CLAUDE.md` 會在每個 session 載入，Codex 也會透過轉址讀取；只放原則與入口，流程細節放 skill（[[token 節省原則]]）。
> - skill 的 `description` 決定何時觸發；Codex 版 skill 轉址到 Claude 版時，`description` 兩邊要同步。
> - Bash 工具在 Windows 上是 Git Bash；`node -e` 內混用反引號時會被 shell 展開，改用 Edit 或腳本檔。
> - Git Bash 會把 `/PID` 這類斜線開頭的參數轉成路徑，`taskkill /PID <n> /F` 會失敗；改用 PowerShell 的 `Stop-Process -Id <n>`（或寫成 `taskkill //PID`）。
> - 內含引號、反引號的長腳本用 heredoc 寫檔時可能出現 `unexpected EOF`；改用 Write 工具寫腳本檔再執行。
> - PowerShell 5.1 呼叫原生程式（node 等）時，空字串參數 `''` 會被丟掉，後面的位置參數往前錯位；要保留空字串改傳 `'""'`。
> - 開在 App worktree 的 session 不能用 Edit 修改主 repo 目錄的檔案（推測是桌面 App worktree 的內建保護）；做專案工作的 session 開在專案主目錄（`CLAUDE.md` §9.7）。

## 相關

- [[Codex]]
- [[Claude Code 與 Codex 分工]]
- [[token 節省原則]]
- [[委派 Codex 流程]]
