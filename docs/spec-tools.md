# 規格 ④：工具（階段 B：Codex 工具）

> v1.1（2026-09-30 主人確認）。v1.1：拒絕／逾時也讓艾莉絲簡短回報（§4、§9）；逾時錯誤附上限；艾莉絲派的任務不讀全域指引（§6）。對應規劃紀錄 Q7（長任務）、Q8（權限）。
> 階段 B 只做「單一任務委派」；標 **〔C〕** 的欄位與規則是為階段 C（專案管理者：拆解計畫、依序委派、彙整回報）預留，B 不實作行為。

## 0. 已確認的前提

- 花費只限 Claude Max 與 Codex Pro 訂閱，不可使用任何 API 金鑰（見規劃紀錄 §13）。
- D1：艾莉絲以回覆結尾的「任務請求區塊」提出任務，Core 解析。
- D2：Core 直接執行 `codex exec`，自己做快照驗收。
- D3：白名單一開始只有測試 repo `workspace/alice-sandbox`。
- D4：命令列顯示任務摘要，主人按 y／n；5 分鐘無回應視為拒絕。
- Codex CLI 0.154.0 已查證的參數：`exec`、`--json`（JSONL 事件：`thread.started`、`turn.started`、`turn.completed`（含 usage）、`turn.failed`、`item.started`／`item.completed`）、`-C <dir>`、`-s workspace-write`、`--output-schema <file>`、`-o <file>`、`--ephemeral`；任務說明從 stdin 傳入。`codex login status` 目前為「Logged in using ChatGPT」。官方文件：`CODEX_API_KEY`／`OPENAI_API_KEY` 會改走 API 金鑰。

## 1. 流程

```
主人：「幫我在 sandbox 加一個 slugify 函式和測試」
  → 艾莉絲回覆（說明打算怎麼做）＋結尾的任務請求區塊
  → Core 解析、檢查白名單 → 建立任務（pending_approval）→ 推送 permission.request
  → 主人在命令列按 y
  → Core 快照 repo → 執行 codex exec（背景）→ 推送 task.progress
  → Codex 結束 → Core 讀結構化回報、做快照比對
  → Core 以「任務完成通知」再呼叫一次推理引擎 → 艾莉絲用自己的口吻回報
```

任務執行期間主人可以繼續聊天（對話佇列與任務互不阻塞）。

## 2. 任務請求區塊（艾莉絲的輸出格式）

艾莉絲需要動用 Codex 時，在回覆**最後**輸出一個區塊，其前是給主人看的說明：

```
<<<ALICE_TASK
{"tool":"codex","repo":"alice-sandbox","goal":"新增 slugify 函式與測試","instructions":"在 src/slugify.js 實作……","acceptance":["npm test 全部通過","slugify('Hello World') === 'hello-world'"],"estimateMin":10}
ALICE_TASK>>>
```

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `tool` | 是 | 階段 B 只有 `codex` |
| `repo` | 是 | 白名單中的**名稱**（不是路徑） |
| `goal` | 是 | 一句話目標，顯示在確認畫面 |
| `instructions` | 是 | 給 Codex 的具體說明 |
| `acceptance` | 是 | 驗收標準（1～10 條） |
| `estimateMin` | 否 | 預估分鐘數，顯示用 |
| `planId` | 否 | 〔C〕所屬計畫 |

- Core 串流時**不轉送**區塊內容：看到 `<<<ALICE_TASK` 開頭後的文字全部攔下（需處理標記被切在兩個 delta 之間的情況）；存入對話紀錄的艾莉絲訊息也不含區塊。
- 一則回覆最多一個區塊；第二個起忽略並記 log。
- 解析失敗、欄位不合、`repo` 不在白名單、已有任務在 `pending_approval`／`running`：不建立任務，Core 推送 `task.rejected`（`reason`），並寫一則 `role: "system"` 訊息到對話紀錄（例：「任務未建立：repo 不在白名單」），艾莉絲下一輪看得到。

## 3. 讓艾莉絲知道工具（系統提示新增段落）

Core 在系統提示的「# 目前狀態」**之前**加入 `# 工具` 段落（由設定產生，內容固定，不含時間）：

- 可用工具與白名單 repo 名稱（附一句用途說明）。
- 使用規則：有副作用的工作（改檔、執行指令）一律用任務請求區塊，等主人確認；**不得聲稱已完成**，要等任務完成通知；主人只是問問題時不要開任務。
- 目前任務狀態（有進行中的任務時列出 id、目標、狀態）——這部分會變，放在 `# 目前狀態` 段落內。

## 4. 確認（權限）

- 建立任務後推送 `permission.request`：`{ taskId, tool, repo, repoPath, goal, acceptance, estimateMin, expiresAt }`。
- 主人以 HTTP 回覆：`POST /api/tasks/:id/approve`、`POST /api/tasks/:id/reject`（body 可附 `reason`）。
- 5 分鐘（`approvalTimeoutMin`，可設定）無回應 → `expired`，視同拒絕。
- 每次決定寫入任務紀錄（時間、`clientId`、結果），供稽核。
- 拒絕或逾時也寫一則 `role: "system"` 訊息（例：「主人拒絕了任務：……」），並觸發一次艾莉絲的簡短回報（v1.1，見 §9）。

## 5. 任務紀錄與狀態

SQLite 新表 `tasks`（Core 重啟後仍在）：

| 欄位 | 說明 |
| --- | --- |
| `id` | UUID |
| `planId` | 〔C〕可為 null |
| `sourceMessageId` | 提出任務的艾莉絲訊息 |
| `tool`、`repo`、`repoPath`、`goal`、`instructions`、`acceptance`（JSON）、`estimateMin` | 來自任務請求 |
| `status` | 見下 |
| `createdAt`、`decidedAt`、`decidedBy`、`startedAt`、`endedAt` | 時間與決定者 |
| `codexThreadId` | 來自 `thread.started` |
| `report`（JSON） | Codex 結構化回報（§7） |
| `diff`（JSON） | 快照比對（§8） |
| `error` | 失敗原因 |

狀態：`pending_approval` →（`approved` →）`running` → `succeeded`／`failed`／`cancelled`；或 `pending_approval` → `rejected`／`expired`。

- 階段 B 同時最多一個 `pending_approval` 或 `running` 的任務。
- Core 重啟時：`pending_approval` 改為 `expired`；`running` 改為 `failed`（`error: "Core 重啟，任務中斷"`），並嘗試結束殘留的 Codex 行程（以任務紀錄中的 PID）。
- 狀態機：任務進入 `running` 呼叫 `onTaskStart()`（E3），離開 `running` 呼叫 `onTaskEnd()`（E4）。

## 6. 執行 Codex

- 前置檢查（Core 啟動時與每次執行前）：`codex login status` 的輸出須含 `ChatGPT`，否則工具停用（聊天照常），啟動時印出原因。
- 子程序環境移除：`OPENAI_API_KEY`、`CODEX_API_KEY`、`OPENAI_BASE_URL`（以及 Claude 那邊的清單）。
- 指令：`codex exec --json -C <repoPath> -s workspace-write --output-schema <schema.json> -o <report.json>`，任務說明從 stdin 傳入；不加 `--ephemeral`（保留 Codex session 供主人事後查看）。
- 任務說明由 Core 依範本產生：目標、驗收標準、`instructions`、固定規則（不 commit、不切分支、不 reset／stash、不改寫既有未提交改動、只改 repo 內檔案、做不到就停下回報、回報附測試指令與結果）；v1.1 起另加「這是 Alice Core 派的任務，不需要讀取全域指引（`~/.claude/CLAUDE.md`）或知識庫」。
- 逾時 `taskTimeoutMin`（預設 30）→ 結束行程，`failed`，`error` 附上限（例：「逾時（上限 30 分鐘）」）。
- **取消**：`POST /api/tasks/:id/cancel` → 結束 Codex **整個行程樹**（Windows 用 `taskkill /T /F /PID`），確認沒有殘留子行程後標 `cancelled`（知識庫實測：只結束主行程時，Codex 開的子行程會繼續跑）。
- `turn.failed` 或非零結束碼：`failed`，`error` 取 Codex 的錯誤原文（例：額度用完的訊息）。
- 進度：`item.completed` 中的指令執行、檔案變更、訊息，轉成一行摘要推送 `task.progress`（每則 ≤ 200 字；同一秒內合併）。

## 7. 結構化回報（`--output-schema`）

```json
{
  "summary": "一兩句說明做了什麼",
  "filesChanged": [{ "path": "src/slugify.js", "change": "added" }],
  "tests": [{ "command": "npm test", "result": "pass", "detail": "12 passed" }],
  "acceptance": [{ "criterion": "npm test 全部通過", "met": true, "evidence": "…" }],
  "unfinished": ["…"],
  "notes": "…"
}
```

`change`：`added`／`modified`／`deleted`；`result`：`pass`／`fail`／`not_run`。回報檔不存在或不合格式時，任務仍依結束碼判定，`report` 記 null 並在完成通知中註明。

## 8. 快照驗收（不採信 Codex 自述）

- repo 必須是 git repo。執行前記錄 `HEAD` 與所有檔案（排除 `.git/`、`node_modules/` 與 `.gitignore` 忽略的檔）的 SHA-256；結束後再算一次。
- `diff`：`added`、`modified`、`deleted` 三個清單，另記 `HEAD` 是否改變。
- 與 Codex 回報的 `filesChanged` 比對，不一致的列為 `mismatch`（例：回報說改了但實際沒變、實際改了但沒回報）。
- `HEAD` 改變或有 `deleted` 時，在完成通知中特別標註，由艾莉絲提醒主人。

## 9. 完成通知與艾莉絲回報

- 任務結束（任何終態）後，Core 寫一則 `role: "system"` 訊息（例：「任務 xxx 完成：……」）到對話紀錄，並以「任務完成通知」觸發一次推理（放進對話佇列，照順序處理）。
- 該次推理的系統提示 `# 目前狀態` 段落附上任務結果：狀態、`report`、`diff`、`mismatch`、`error`。艾莉絲依工作模式回報：結論 → 修改檔案 → 測試與驗收 → 不一致或未完成事項 → 需要主人做的事。
- 這次回覆**不得**再開新任務（Core 忽略區塊）；階段 C 再放寬。
- 拒絕或確認逾時（v1.1）：同樣放進對話佇列觸發一次推理，transcript 結尾為「（系統通知）任務未執行：主人拒絕／確認逾時，請用一兩句告知主人。」，這次同樣不得開新任務。

## 10. 協定變更（`spec-protocol.md` 需同步升版）

- `Message.role` 新增 `"system"`（Core 產生的通知，不是主人或艾莉絲說的話）；組提示時以「（系統通知）……」的形式放進對話紀錄。
- HTTP：`GET /api/tasks`（新到舊，含 `limit`）、`GET /api/tasks/:id`、`POST /api/tasks/:id/approve`、`/reject`、`/cancel`。
- WebSocket 事件（原預留名稱轉為正式）：`task.created`、`permission.request`、`permission.resolved`（`approved`／`rejected`／`expired`）、`task.rejected`（未建立，含 `reason`）、`task.started`、`task.progress`、`task.done`（含終態、`report`、`diff`、`error`）。
- 錯誤碼新增：`not_found`（任務不存在）、`conflict`（狀態不允許此操作，例如已開始的任務不能 approve）。

## 11. 命令列 Client

- 收到 `permission.request`：印出任務摘要（repo、路徑、目標、驗收標準、預估時間、逾時時間），提示 `核准這個任務嗎？(y/n)`；輸入後送 approve／reject。
- `task.progress`：一行一則，前綴 `[任務]`。
- 指令：`/tasks` 列最近任務、`/cancel` 取消進行中的任務。

## 12. 設定（`config`）

```json
{
  "tools": {
    "codex": {
      "enabled": true,
      "codexPath": "codex",
      "repos": { "alice-sandbox": { "path": "<workspace>/alice-sandbox", "description": "測試用 repo" } },
      "approvalTimeoutMin": 5,
      "taskTimeoutMin": 30
    }
  }
}
```

## 13. 人格檔

`persona/alice.md` 不寫工具細節（由 Core 的 `# 工具` 段落提供，隨設定變動）；只在工作模式規則補一句：「需要動手做的工作交給工具，自己不假裝已經做了」。

## 14. 已確認（2026-09-29）

1. 任務請求區塊標記 `<<<ALICE_TASK … ALICE_TASK>>>` 與 §2 欄位。
2. 同時只允許一個任務；Core 重啟時進行中的任務標失敗。
3. 不加 `--ephemeral`。
4. 完成後艾莉絲主動回報。
5. 對話紀錄新增 `system` 角色。
6. 測試 repo `workspace/alice-sandbox` 由 Claude 建立。
