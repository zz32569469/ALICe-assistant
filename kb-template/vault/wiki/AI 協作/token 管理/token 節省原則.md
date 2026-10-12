---
type: pattern
title: token 節省原則
aliases: [進度視窗, token 管理]
domain: AI 協作
tags: [流程/token, 工具/Claude Code, 工具/Codex]
projects: []
sources: []
up: "[[Claude Code 與 Codex 分工]]"
related: ["[[委派 Codex 流程]]", "[[Claude Code]]", "[[Codex]]"]
created: {{DATE}}
updated: {{DATE}}
status: draft
---

# token 節省原則

> token 不消耗在對工作進度沒有幫助的地方；**花 token 能減少錯誤或提升效率時照常花**。判斷新做法時問「對工作有沒有幫助」，不是「是不是比較耗 token」。

## 解決什麼問題

- 把 Codex 進度逐則串進對話，每則都觸發一次 Claude 回應，對工作沒有幫助。
- 固定載入的指引檔（全域 `CLAUDE.md`）越寫越長，每個專案、每個 session 都要付這份成本，Codex 也會讀。
- 反過來，為了省 token 略過查證或驗收，會讓錯誤漏到後面（例：只看 Codex 自述，會漏掉二進位檔被改的位元組）。

## 做法

| 項目 | 對工作的幫助 | 做法 |
| --- | --- | --- |
| 與使用者對話、規格確認 | 減少錯誤 | 照常花 |
| 委派 Codex、Codex 工作 | 完成工作 | 任務說明寫清楚，減少 Codex 重複讀檔（[[委派 Codex 流程]]） |
| 委派進度 | 無（使用者看得到就好） | **不花**：進度在獨立視窗或看板顯示；對話端用背景 Bash 等待，只收一次完成通知 |
| 驗收、查證、看關鍵 diff | 減少錯誤 | 照常花（[[委派驗收與工作區快照]]） |
| 其他長時間工作的過程（模擬、建置、長測試） | 無 | **不花**：放背景，結束後再讀結果 |

減少無幫助的消耗：
1. 全域指引只留原則與入口，細節放 skill（依描述觸發、需要時才載入）。
2. 讀知識庫先用 Grep 定位；任務要照指南的檢查清單做時，完整讀該指南，避免漏項。
3. 只有排版差異或自動產生的輸出不印進對話；判斷改動正確性的 diff 要看。
4. 常用的唯讀指令加入權限允許清單，避免被擋後重試的輪數（[[Claude Code#權限允許清單]]）。
5. Codex `--effort low` 只用在步驟完全明確、出錯影響小的任務；容易出錯的任務用 `high`。

## 取捨

| 優點 | 缺點 |
| --- | --- |
| 進度不消耗 token | 使用者要自己看視窗；Claude 無法在中途發現 Codex 走錯方向 |
| 固定載入內容變少 | 規則分散在 skill，需要時才載入 |

## 注意事項

> [!danger] 注意
> - Monitor 適合「每則事件都需要 Claude 處理」的情境；只是給人看的進度不要用 Monitor。
> - 背景等待的腳本要涵蓋所有結束狀態（`completed`、`failed`、`cancelled`、`error`），否則任務失敗時不會收到通知。

## 相關

- [[Claude Code 與 Codex 分工]]
- [[委派 Codex 流程]]
- [[Claude Code]]
- [[Codex]]
