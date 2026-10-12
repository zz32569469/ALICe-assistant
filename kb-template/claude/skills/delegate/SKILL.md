---
name: delegate
description: 把程式撰寫、檔案修改交給 Codex 執行，並自動快照工作區、開任務看板、結束後驗收。使用者輸入 /delegate、說「交給 Codex」「委派 Codex」，或 Claude 規劃完要把實作交給 Codex 時使用。取代 /codex:rescue（後者經子代理轉呼叫，較耗 token）。
---

# delegate：委派 Codex

腳本：`~/.claude/scripts/codex-delegate.mjs`（內部使用 `agent-snapshot.mjs`、`codex-watch.mjs`）。

## token 原則
- 不花在對工作進度沒有幫助的地方：進度只在獨立 cmd 視窗顯示，**不要**用 Monitor 或輪詢把進度帶進對話。
- 花 token 能減少錯誤或提升效率時照常花：規格查證、讀完整指南、看關鍵 diff、完整驗收與回報。

## 步驟

### 1. 規劃（啟動前）
- 需求不明確時先用 AskUserQuestion 確認規格（一次問完）。
- 查知識庫先用 Grep 定位；任務要照指南的檢查清單做時（例：新增一項有既定檢查清單的功能），完整讀該指南，避免漏項。
- 目標 dev server / App 正在執行、或工作區有大量未提交改動時，提醒使用者（可選擇先 commit）。
- 任務涉及 Excel 二進位檔（`.xls`）寫入：不要交給 Codex（sandbox 內 Excel COM 會卡住），由 Claude 處理，第一次修改前先問使用者。
- 內容已確定、幾行以內的說明文件修改（例：README 的過時說明）由 Claude 直接改，不委派：一次委派最少約 1M 輸入 token。程式檔即使一行也照常委派。

### 2. 寫任務說明
先選範本（`~/.claude/skills/delegate/templates/`），複製到 scratchpad 填空：

| 範本 | 用途 | 啟動參數 |
| --- | --- | --- |
| `run-only.md` | 只執行既有腳本或指令（量測、確認候選、耗時） | `--effort low` |
| `verify.md` | Claude 改好來源後，重跑產生器並驗證（例：改設定表後跑 parser） | `--effort low` |
| `implement.md` | 寫程式、改腳本 | 預設或 `--effort high` |

填寫時：
- **相關知識庫頁面的完整路徑**；不需要就寫「不需要知識庫頁面」（腳本會自動加上固定規則：直接讀列出的頁面、不執行 `$kb`、不寫知識庫、不 commit、輸出限長、不反覆查看進度、不重跑沒變的測試，不必重寫）。
- 已確認的事實直接寫進背景（數值、檔案行號、上一步的結果），不要讓 Codex 讀頁面自己找；同一系列的任務不重複列必讀頁。
- 測試只列這次改動需要的；全模式回歸在一系列改動的最後做一次。
- 限制（哪些檔案不能動、不能用的做法）、基準狀態（已知失敗的測試）、回報格式。

### 3. 啟動
```bash
node ~/.claude/scripts/codex-delegate.mjs start --cwd <repo> --prompt-file <任務說明.md> --label "<簡短任務名>" [--track <二進位檔...>] [--resume] [--effort low|medium|high] [--read-only]
```
- `--track`：未修改但要監控的檔案（例：專案內的 `.xls` 設定檔），會以 sha256 比對。
- `--resume`：延續同一 repo 的上一個 Codex 對話（追問、接續修正時用）。**會沿用上一個對話的 sandbox 設定**：上一次是唯讀，接續後仍唯讀；要改權限就開新對話。
- `--read-only`：只調查、回答時用。會擋住 repo 外的寫入（例：新增量測腳本、寫輸出檔），要寫檔的任務不要加。
- `--effort`：一般不指定；步驟完全明確、出錯影響小的任務才用 `low`；複雜或容易出錯的任務用 `high`。
- `--label`：通知與任務總表顯示的名稱（例「<專案>：<功能>」），一律填寫。
- 腳本會快照工作區、背景啟動 Codex、開 **Codex 任務看板**（本機網頁 http://127.0.0.1:47777/；已開著就切到這個任務），輸出 `jobId`。加 `--cmd` 另開 cmd 進度視窗；`--no-window` 都不開。
- 任務結束時，看板與進度視窗更新狀態，並發 Windows 通知與提示音（成功一聲、失敗三聲）；額度用完等中途失敗也會判定為失敗。這些都不經過 Claude。

### 4. 等待
立刻以**背景 Bash**（`run_in_background: true`）執行，然後結束本回合，告訴使用者看板已開啟（`/board` 可重開）：
```bash
node ~/.claude/scripts/codex-delegate.mjs wait <jobId>
```
完成通知到達後再讀輸出檔。

### 5. 驗收
`wait` 的輸出包含 Codex 最終回報與快照比對。驗收時：
- **以快照比對為準**，不採信 Codex 自述（它可能說未修改但檔案已變）。
- 「原本已有未提交改動、又被修改」「刪除」「HEAD/分支改變」要逐項確認是否合理。
- 自己重跑任務指定的測試。檢查改動是否正確時，閱讀新增檔與關鍵修改的 diff；只有排版差異、自動產生的檔案（例：註冊表、`config.json` 重新排版）不必逐行看。
- 有副作用時回報並提議以快照副本還原（`~/.claude/codex-snapshots/<jobId>/files/`）。

### 6. 回報使用者
- 修改檔案清單、測試結果、需要使用者手動做的事（例：填 Excel、按 Reload）。
- dev server / App 正在執行時，提醒**重啟 `npm run dev`** 再驗證（watch 可能建出過期 bundle）。
- Codex 列出的「知識庫回寫候選」：詢問使用者要不要寫入、寫到哪一頁。

## 失敗處理
- Codex 做不到（sandbox、權限、工具限制）→ Claude 接手；第一次修改檔案前先向使用者說明做法並取得同意。
- `start` 失敗且出現 `pending-*` 快照資料夾，可刪除。
- 使用者看進度：`/board`（看板，推薦）。其他查詢（不花 token，給使用者自己執行）：`node ~/.claude/scripts/codex-jobs.mjs`（總表）、`codex-jobs.mjs --watch`（常駐更新，期間結束的任務會通知）、`codex-jobs.mjs <jobId>`（詳情）、`codex-watch.mjs <jobId> --all`（即時進度）。`/codex:status` 要在目標 repo 目錄執行。
- 補發通知：`node ~/.claude/scripts/codex-notify.mjs <jobId> --force`。
