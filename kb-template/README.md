# 知識庫可攜範本

這份範本用於在新電腦建立不含既有內容的 Obsidian vault，並安裝相同的 Claude Code 與 Codex 協作方式。請由專案根目錄執行 `node scripts/setup-kb.cjs --kb <路徑>`，不要直接複製後編輯範本。

Codex 是選用工具；`--codex auto|yes|no` 控制是否安裝 Codex 專用工具（預設 `auto`，會檢查 Codex 已安裝並以 ChatGPT 登入），沒有 Codex 時仍可只用 Claude Code 完成所有工作。

## 內容

- `vault/`：空知識庫的 Schema、頁面範本、維護流程與 AI 協作頁。
- `global-CLAUDE.md`：新電腦的 Claude Code 全域指引範本。
- `claude/skills/`：知識庫、委派、看板與用量相關 skill。
- `claude/scripts/`：委派、快照、通知與看板腳本。`codex-board/roles.example.json` 是專案資料夾對應角色的設定範例；要啟用時複製為 `roles.json` 並修改內容。
- `codex/AGENTS.md`：轉址到 Claude Code 全域指引的 Codex 範本。

## 佔位符

| 佔位符 | 設定時替換為 |
| --- | --- |
| `{{KB_PATH}}` | 新 vault 的完整路徑 |
| `{{WORKSPACE}}` | 專案 repo 與工作紀錄的上層資料夾 |
| `{{USERPROFILE}}` | 使用者家目錄 |
| `{{DATE}}` | 執行當天的 `YYYY-MM-DD` 日期 |

頁面範本原有的 `{{title}}` 會轉成 `<title>`，`{{date:YYYY-MM-DD}}` 會轉成執行當天。所有路徑在文字檔中都會寫成正斜線格式。設定腳本逐檔檢查，不會覆寫已存在的檔案。
