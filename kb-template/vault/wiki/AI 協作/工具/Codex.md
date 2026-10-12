---
type: tool
title: Codex
aliases: [Codex CLI, OpenAI Codex, codex-plugin-cc]
domain: AI 協作
tags: [工具/Codex]
projects: []
sources: []
up: "[[Claude Code 與 Codex 分工]]"
related: ["[[Claude Code]]", "[[委派 Codex 流程]]"]
created: {{DATE}}
updated: {{DATE}}
status: draft
---

# Codex

> OpenAI 的程式撰寫 agent（CLI 與桌面 App）。在本工作流程中由 [[Claude Code]] 透過 codex-plugin-cc 外掛委派，負責撰寫與修改程式。

## 基本資訊

| 項目 | 內容 |
| --- | --- |
| 類別 | AI coding agent（CLI） |
| 使用版本 | （填寫 `codex --version` 與外掛版本） |
| 登入 | ChatGPT 帳號（用量算在 Codex 額度，不算 Claude token） |
| 官方文件 | https://github.com/openai/codex、https://github.com/openai/codex-plugin-cc |

## 核心用法

### 指引與 skill 的轉址

| Codex 讀取 | 對應 Claude Code | 本庫做法 |
| --- | --- | --- |
| `{{USERPROFILE}}/.codex/AGENTS.md`（全域指引） | `{{USERPROFILE}}/.claude/CLAUDE.md` | 只寫「先讀 `~/.claude/CLAUDE.md`」 |
| repo 根目錄 `AGENTS.md` | repo 根目錄 `CLAUDE.md` | 知識庫根目錄 `AGENTS.md` 指向 `CLAUDE.md` |
| `{{USERPROFILE}}/.codex/skills/<name>/SKILL.md`（以 `$name` 呼叫） | `{{USERPROFILE}}/.claude/skills/<name>/SKILL.md`（`/name`） | `kb` skill 轉址到 Claude 版；`description` 兩邊要同步 |

轉址讓規範只維護一份（知識庫的 schema 也在 `CLAUDE.md`）。

### 設定

- `{{USERPROFILE}}/.codex/config.toml`：`[mcp_servers.*]`、`[projects.'<path>']` 信任設定、`[windows] sandbox`、`model_reasoning_effort`。
- 寫入 repo 外的目錄需要 `[sandbox_workspace_write] writable_roots`；知識庫不加入，Codex 被委派時不寫知識庫。

### codex-plugin-cc（在 Claude Code 中使用）

| 指令 | 用途 |
| --- | --- |
| `/codex:setup` | 檢查安裝與登入；可開關 review gate |
| `/codex:rescue` | 經子代理委派任務（較耗 token，改用 [[委派 Codex 流程\|/delegate]]） |
| `/codex:review`、`/codex:adversarial-review` | 請 Codex 審查改動或挑戰設計 |
| `/codex:status`、`/codex:result`、`/codex:cancel` | 查詢、取結果、取消背景任務 |

- 背景任務紀錄：`{{USERPROFILE}}/.claude/plugins/data/codex-openai-codex/state/<workspace>-<hash>/jobs/<jobId>.json` 與 `.log`；`.json` 的 `result.rawOutput` 是最終回報，`result.touchedFiles` 是修改檔案。

## 注意事項

> [!danger] 注意
> - **Windows sandbox 內 GUI 與 Office COM 會卡住逾時**，且可能已改動檔案位元組；需要 GUI 或桌面環境的工作不要委派。
> - 任務說明提到「知識庫」時，Codex 會依 skill 描述自動套用 `$kb` 並讀完整規範；已提供頁面路徑時要明確禁止（[[委派 Codex 流程]] 的固定開頭）。
> - 外掛任務紀錄依工作目錄分開存放，`/codex:status` 在其他目錄執行會顯示「No job found」。
> - review gate 開啟後，每次 Claude 結束回合都會觸發 Codex 審查，可能形成來回循環並耗盡額度；預設保持關閉。
> - Codex 自述不可盡信，驗收以快照比對為準（[[委派驗收與工作區快照]]）。
> - **sandbox 內不能建立子行程**（`child_process.spawn` → `spawn EPERM`），唯讀與寫入模式都一樣；`worker_threads` 可用。因此 `tsx`（esbuild 要另開子行程）跑不了 `.ts` 腳本，`tsc --noEmit` 可以。替代做法：用 `node -r <ts-register.cjs> <腳本.ts>`，以 `require.extensions['.ts']` 呼叫 `typescript` 的 `transpileModule` 單檔轉譯；不做型別檢查（另跑 `tsc --noEmit`），不支援 `const enum`、`import x = require`。

## 相關

- [[Claude Code]]
- [[Claude Code 與 Codex 分工]]
- [[委派 Codex 流程]]
