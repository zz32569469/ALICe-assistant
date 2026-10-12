---
name: board
description: 開啟 Codex 任務看板（本機網頁，顯示委派給 Codex 的任務狀態、進度時間軸、最終回報與工作區比對）。使用者輸入 /board、說「開看板」「看 Codex 進度」時使用。
---

# board：開啟 Codex 任務看板

只做一件事，不要讀其他檔案、不要分析任務內容：

```bash
node ~/.claude/scripts/codex-board.mjs $ARGUMENTS
```

- `$ARGUMENTS` 可為空、`task-…`（開啟並選取該任務）、`--status`、`--stop`。
- 執行後只回一行：看板網址（或狀態），不要附加說明。
- 使用者要在 Claude 桌面 App 內建瀏覽器看時，才用 Browser pane 開 `http://127.0.0.1:47777/`。
