# 規格 ⑥：計畫與修改類派工（階段 C2、C3、R2、§27）

> v1.3（2026-10-01）：加入 §13 派工給同事 session、直接傳訊、跨計畫依賴。v1.2（2026-09-30）：加入 R2（§12：Core 驗收測試、禁改與監看路徑、Claude 代寫策略、更改紀錄草稿）。v1.1（2026-09-30）。v1.0 依規劃紀錄 §16（Q5、Q9、Q14、Q17、Q18、Q20、Q21、Q25）、K7 與 C2 開工決定（C2-1～C2-5）撰寫；v1.1 加入 C3（C3-1～C3-5）：多計畫並行與排隊、重啟接續、報告檔、回寫候選、自我改進建議、審查附 diff、單一任務的 repo 衝突提示（§11）。

## 0. 已查證的事實（2026-09-30）

- 可寫檔的 Claude worker：`--tools "Read,Grep,Glob,Edit,Write,Bash" --permission-mode dontAsk --permission-prompts none --allowedTools "Edit" "Write" "Bash(npm test)"`，在 repo 內**可改檔、可跑 `npm test`**；`git commit`、`rm`、`node -e`、讀工作目錄外的檔案**全部被拒**（列在 `permission_denials`）。
- `--json-schema <schema>` 讓 `result` 行帶 `structured_output`（官方文件；本規格用它取得與 Codex 相同格式的結構化回報）。

## 1. 可修改的目標（白名單）

- 來源：`config.tools.codex.repos`（名稱 → `{ path, description, testCommands?, highRiskPatterns? }`）與 `alice.local.json` 中 `writable: true` 的專案（可再加 `testCommands`、`highRiskPatterns`）。
- `testCommands`：Claude 寫檔 worker 可執行的指令（每條轉成 `--allowedTools "Bash(<指令>)"`）；預設 `["npm test"]`。
- `highRiskPatterns`：路徑樣式（`*` 不跨 `/`、`**` 可跨；比對 repo 相對路徑，不分大小寫）；預設 `["**/*.xls", "**/*.xlsx", "docs/**", "**/*spec*", "**/config/**", "**/*.config.*"]`。
- 唯讀項目的目標仍是 `alice.local.json` 的專案（有角色）。

## 2. `ALICE_PLAN` 區塊

```
<<<ALICE_PLAN
{"goal":"……","items":[
  {"key":"a","title":"分析現況","kind":"read","project":"工具專案","role":"工程師","instructions":"……","acceptance":["……"]},
  {"key":"b","title":"實作","kind":"modify","project":"alice-sandbox","instructions":"……","acceptance":["npm test 全部通過"],"dependsOn":["a"],"risk":"normal","estimateMin":10}
],"risks":["……"],"decisions":["……"],"preauthorizeClaudeFallback":false}
ALICE_PLAN>>>
```

- `kind`：`read`（唯讀部下）或 `modify`（Codex／Claude 寫檔）；`review` 只由 Core 自動插入。
- `read` 必填 `role`、`project`（本機設定的專案）；`modify` 的 `project` 必須在 §1 白名單。
- `key` 唯一（`[a-z0-9-]`，≤ 20 字）；`dependsOn` 只能引用前面出現過的 key（不可循環）；項目 1～10 個；`acceptance` 1～10 條；`risk` 為 `normal`／`high`（預設 normal）。
- 驗證失敗 → 不建立計畫，寫 `system` 訊息說明，艾莉絲下一輪看得到。
- 同時只能有一份計畫在等待確認（`pending_approval`）；執行中、暫停、排隊的計畫不影響提新計畫（C3-3，見 §11）。
- 一則回覆裡 `ALICE_PLAN` 與 `ALICE_TASK` 同時出現時，只處理計畫。

## 3. 確認

- 建立後狀態 `pending_approval`，推送 `plan.created` 與 `plan.permission.request`（含完整項目、依賴、風險、需要決定的事、`expiresAt`）。
- 命令列顯示計畫全文並問 `核准這份計畫嗎？(y/n)`；HTTP `POST /api/plans/:id/approve`、`/reject`。
- `planApprovalTimeoutMin`（預設 10）無回應 → `expired`。拒絕／逾時寫 `system` 訊息並觸發艾莉絲簡短回報。

## 4. 執行

- 核准後 `running`（已有 2 份執行中則 `queued`，§11）。可執行的項目 = 狀態 `pending` 且依賴都 `done`。**所有計畫合計**同時最多 2 個項目執行中；同一個 repo 同時只能一個 `modify`（跨計畫）。
- **read／review**：以 C1 的唯讀 worker 執行一輪（建立工作頻道，標題 `計畫 <短 id>・<key> <title>`，你看得到過程）；worker 回覆後項目 `done`（review 見 §6）。問題文字 = instructions ＋ 驗收標準 ＋「需要決定的事、規格衝突、知識庫回寫候選列在最後的『需要決定：』／『規格衝突：』／『回寫候選：』段落」。
- **modify**：
  1. repo 衝突檢查（Q21）：`git status --porcelain` 的檔案中，若有**不是本計畫先前項目改過**的未提交改動 → 計畫 `paused`（理由 `repo_dirty`）並問主人。
  2. 選擇執行者（§5）。
  3. 以 `Task`（`planId` = 計畫 id，寫入 tasks 表）交給執行者；快照驗收與結構化回報沿用階段 B。
  4. 判定（Core 決定，不採信自述）：成功 = 執行者 `succeeded` 且報告存在且 `acceptance` 全部 `met`、`tests` 沒有 `fail`、快照與回報沒有不一致、沒有 `deleted`、`HEAD` 未改變。
  5. 有 `deleted` 或 `HEAD` 改變 → 立即 `paused`（Q17 ④）。
  6. 其他失敗 → 自動重試一次（把錯誤、未達成的驗收、快照差異附在 instructions 後）；第二次仍失敗 → `paused`（Q17 ②）。
  7. 改到 `highRiskPatterns` 的檔案，或項目本身 `risk: high` → 在後面自動插入 `review` 項目（§6）。
- R2 起，禁改路徑、監看路徑與 Core 驗收測試的判定見 §12。
- 報告的 `notes` 或 worker 回覆含非空的「規格衝突：」→ `paused`（Q17 ①）。內容取「規格衝突：」同一行；同一行空白時取緊接的條列行；「無」視為沒有。
- 全部 `done` → `completed`，觸發艾莉絲彙整回報（effort high，附全部項目結果）。
- 任何 `paused`：推送 `plan.paused`（理由、項目、細節），寫 `system` 訊息並觸發艾莉絲向主人說明與提問。主人以 `/plan resume <id>`（繼續；失敗的項目重設為 pending、嘗試次數歸零）或 `/plan cancel <id>` 決定；也可以直接跟艾莉絲說，她會提醒用這兩個指令。

## 5. 執行者選擇（K7、C2-3）

- `tools.codex.use`：`"auto"`（預設）／`true`／`false`。`auto` 時依啟動時的 `codex login status` 判定可用（`tools.codex.enabled` 仍表示「任務工具是否啟用」，維持相容）。
- Codex 可用且額度未達門檻（短期已用 < 85% 且每週已用 < 90%，讀不到額度時視為可用）→ Codex。
- Codex 被關閉或不可用 → Claude 寫檔 worker（不需詢問，K7）。
- Codex 可用但額度達門檻、或執行中因額度失敗（錯誤訊息含 `usage limit`）→ 計畫有 `preauthorizeClaudeFallback: true` 時改派 Claude；否則 `paused`（理由 `codex_quota`，Q17 ⑤），主人 `/plan resume <id> claude` 可授權改派後繼續。
- 單一任務（`ALICE_TASK`）在 Codex 不可用時也改用 Claude 寫檔 worker。

## 6. 審查（Q14、C2-4）

- 自動插入的 `review` 項目：key `<原 key>-review`、依賴原項目、角色取「該專案在本機設定的角色」，沒有角色時用第一個設定的角色；唯讀 worker 以 `--add-dir` 讀 repo。
- 問題文字包含原項目的目標、驗收標準、變更檔案清單與**實際 diff**（`git diff --no-color -- <變更檔>`，截斷至 8 KB；新增的未追蹤檔只列檔名），要求最後一行輸出 `審查結論：通過` 或 `審查結論：不通過（理由）`。
- 不通過 → 原項目重設為 pending 重做一次（附審查意見）；再不通過 → `paused`。

## 7. Claude 寫檔 worker

- 指令：`claude -p --safe-mode --tools "Read,Grep,Glob,Edit,Write,Bash" --disallowedTools "mcp__*" --permission-mode dontAsk --permission-prompts none --allowedTools "Edit" "Write" <每條 Bash(testCommand)> --model <config.model> --effort high --json-schema <與 Codex 相同的回報 schema> --output-format stream-json --verbose --include-partial-messages --no-session-persistence`，工作目錄為 repo；環境 `subscriptionOnlyEnv`。
- stdin：與 Codex 相同的任務說明範本（固定規則：不 commit、不刪檔、只改 repo 內檔案、做不到就停下…），外加「你只能執行這些測試指令：…」。
- 結構化回報取 `result.structured_output`；缺少或不合格 → 視同 Codex 的 `reportError`。逾時 `taskTimeoutMin`。
- 用量寫 `usage`（`kind: worker`、`refType: task`）。

## 8. 艾莉絲的系統提示

- 新增 `# 計畫` 段落（內容穩定）：何時提計畫（需要多步驟或多個角色、會改檔且不只一件事、主人說 `/計畫`）、區塊格式與範例、可修改目標清單、規則（修改類一定要有可驗證的驗收標準；高風險標 `risk: high`；不要把 commit／push／刪檔寫進計畫）。
- `# 目前狀態` 附上進行中計畫的摘要（id、狀態、各項目狀態）。
- 計畫完成／暫停／拒絕的通知推理附上計畫結果 JSON（截斷至 12 KB）；這次回覆的區塊一律忽略。

## 9. 協定與命令列

- WebSocket：`plan.created`、`plan.permission.request`、`plan.permission.resolved`、`plan.updated`（狀態或項目變更）、`plan.queued`（C3：核准或 resume 後排隊）、`plan.paused`、`plan.done`。
- HTTP：`GET /api/plans`、`GET /api/plans/:id`、`POST /api/plans/:id/approve|reject|resume|cancel`（`resume` body 可帶 `{"executor":"claude"}`）。
- 命令列：計畫確認 y/n、`[計畫]` 進度行、`/plans`、`/plan <id>`、`/plan resume <id> [claude]`、`/plan cancel <id>`、`/計畫 <需求>`（effort high，並提示艾莉絲做成計畫）。

## 10. 資料

- `plans`：`id`、`goal`、`status`（`pending_approval`／`running`／`paused`／`completed`／`cancelled`／`rejected`／`expired`／`failed`）、`risks`、`decisions`、`preauthorize_claude_fallback`、`source_message_id`、`pause_reason`、`pause_detail`、`created_at`、`decided_at`、`decided_by`、`ended_at`。
- `plan_items`：`id`、`plan_id`、`seq`、`key`、`title`、`kind`、`project`、`role`、`instructions`、`acceptance`、`depends_on`、`risk`、`estimate_min`、`status`（`pending`／`running`／`done`／`failed`／`cancelled`）、`attempts`、`executor`（`worker`／`codex`／`claude`）、`ref_type`、`ref_id`（頻道或任務 id）、`result`（JSON）、`error`、`review_of`、`started_at`、`ended_at`。
- `plans.status` 另有 `queued`（C3）。
- Core 重啟：見 §11.2。

## 11. C3 追加

### 11.1 多計畫並行（C3-3）

- 同時最多 **2 份計畫** `running`。再核准或 resume 的計畫進入 `queued`，並寫一則 `system` 訊息「排隊等候」。
- 任何計畫結束（完成、暫停、取消）後，依建立順序把 `queued` 遞補為 `running`。
- 項目層級沿用 §4：
  - 所有計畫合計最多 2 個項目執行中。
  - 同一 repo 同時只能有一個 `modify`；另一份計畫在同一 repo 的修改項目要等前一個結束。
- 等待確認中的計畫只能有一份。

### 11.2 重啟接續（C3-4、Q26）

- `pending_approval` → `expired`。
- `running`／`queued`／`paused` 的計畫：
  - 進行中的項目改回 `pending`，錯誤欄記「Core 重啟時中斷，重新執行」。
  - 修改項目的任務若還沒有快照差異，就把當下 repo 的未提交檔案記為該任務的差異（`interrupted: true`）。這些改動視為本計畫造成，resume 時不會誤判 `repo_dirty`。
- 中斷的修改項目另外列出「可能留下的半成品」：當下的未提交檔，扣掉本計畫其他任務在同一 repo 已記錄的改動；扣完沒有剩就寫「沒有看到這一項留下的未提交檔」（C3 補強）。
- 不是 `paused` 的計畫改為 `paused`（理由 `core_restart`，細節列出中斷的項目與半成品），寫報告，並通知艾莉絲（種類 `restarted`，effort high）。通知提示要求她照列半成品檔告訴主人。
  - 艾莉絲說明停在哪裡、哪些項目已完成不重做、建議怎麼接續，然後等主人 `/plan resume`。
  - 不自動接續。

### 11.3 報告檔（C3-5、Q27）

- 計畫 `completed`／`paused`／`cancelled`（含重啟暫停）時寫 `data/reports/<本地日期>-<短 id>.md`。同一計畫覆寫同一檔，只存本機，不進版控。
- 內容：
  - 目標、狀態、時間。
  - 各項目的狀態、執行者、嘗試次數、結果摘要、變更檔案、錯誤。
  - 暫停理由。
  - 用量（依任務與頻道彙總）。
  - 回寫候選。
- 艾莉絲的通知推理會附上報告檔與回寫候選檔的路徑。

### 11.4 知識庫回寫候選（C3-1、Q24）

- 來源有三個，都取「回寫候選：」段落（同一行，或緊接的條列行；「無」不算）：
  - 唯讀部下的回覆。
  - 審查部下的回覆。
  - 執行者報告的 `notes`。
- Codex 與 Claude 寫檔 worker 的固定規則要求把候選寫進 notes，開頭標「回寫候選：」。
- 有候選時寫 `data/writeback/<本地日期>-<短 id>.md`，每條附來源項目與專案。
- 艾莉絲**不寫入知識庫**，由主人決定是否轉交知識庫管理員。

### 11.5 自我改進建議（C3-2、Q23）

區塊格式：

```
<<<ALICE_SUGGEST
{"title":"一句話（≤ 80 字）","reason":"…","impact":"…","proposal":"…"}
ALICE_SUGGEST>>>
```

- 驗證：四個欄位都必填，不可有其他欄位。
- 寫入：
  - Core 只附加到 `suggestionsPath`（預設 `docs/艾莉絲的建議.md`）。檔案不存在時先寫標頭。
  - 每則附時間與「主人決定：（未決定）」，並寫一則 `system` 訊息。
  - 格式錯誤時不記錄，改寫一則 `system` 訊息說明原因。
- 區塊不會出現在回覆與串流中。
- 系統提示常駐「# 自我改進建議」段落：不自己改、有具體依據才提、一則回覆最多一個。

### 11.6 單一任務的 repo 衝突提示（C2 觀察 → C3）

- `ALICE_TASK` 建立後，`permission.request` 附上 `dirtyFiles`（`git status` 的未提交檔案）。
- 命令列在確認畫面顯示「⚠ 這個 repo 有未提交的改動…」，由主人決定是否核准。

## 12. R2：開放真實專案寫入

依規劃紀錄 §21 的主人決定（R2-1～R2-4）。

### 12.1 設定欄位

`config.tools.codex.repos` 與 `alice.local.json` 的專案都可設定下列欄位：

| 欄位 | 說明 | 預設 |
| --- | --- | --- |
| `forbiddenPatterns` | 禁改路徑樣式，比對方式同 `highRiskPatterns` | `[]` |
| `watchPaths` | git 看不到、要另外用檔案雜湊監看的路徑（repo 相對，可以是 symlink；略過 `node_modules`、`.git`） | `[]` |
| `claudeFallback` | `auto`：Codex 不可用時自動改派 Claude（K7）。`ask`：一律暫停問主人 | `auto` |
| `changeLogDraft` | 報告附更改紀錄草稿 | `false` |

例：某個工具專案的本機設定（不進版控）：
- `testCommands`：`npx vue-tsc --noEmit`、`npm run test:<合約測試>`。
- `highRiskPatterns`：預設清單，加上 `src/<核心目錄>/**`、`src/config/**`。
- `forbiddenPatterns`：`data/**`、`<共用函式庫>/**`。
- `watchPaths`：`<共用函式庫>`（symlink）。
- `claudeFallback`：`ask`。
- `changeLogDraft`：`true`。

### 12.2 Core 驗收測試（R2-2）

- 每個 modify 項目開工前，Core 在 repo 依序執行 `testCommands`，記下失敗清單作為基準。
  - 項目先標為執行中再跑基準，不會卡住其他計畫的排程。
  - 以 shell 執行；每條指令逾時 2 分鐘，輸出上限 2 MB。
- 失敗清單的來源：
  - TAP 的 `not ok` 名稱。
  - TypeScript 錯誤行，去掉行列號，避免改檔後行號位移造成誤判。
  - 都沒有時，結束碼不為 0 就算整條指令失敗；逾時也算失敗。
- 任務說明會附上兩件事：Core 會跑哪些測試，以及開工前已經失敗的項目（最多 30 條，並告知不是執行者造成的）。執行者不能跑測試時（例如沙箱不能開子行程），在 tests 標 `not_run`。
- 執行者回報成功、且監看路徑沒有變動時，Core 再跑一次 `testCommands` 與基準比較：
  - 有**新增失敗**：視為未通過，自動重試一次並附上新增的失敗項目。
  - 沒有新增失敗：測試通過。執行者自述的測試結果只記錄，不作數。
- 結果存進項目結果的 `verification`（各指令結束碼、耗時、失敗數、新增與減少的失敗），報告顯示為「Core 驗收」一行。
- 沒有設定 `testCommands`（空陣列）時，沿用舊規則：執行者回報的測試有 `fail` 就算失敗。

### 12.3 禁改路徑與監看路徑（R2-1）

- 任務說明附「## 禁止修改」段，列出 `forbiddenPatterns` 與每個 `watchPaths` 的 `<路徑>/**`。
- 判定時先檢查兩件事，任一成立就暫停，理由 `forbidden_path`，不重試：
  - 快照的新增、修改、刪除檔案符合 `forbiddenPatterns`。
  - `watchPaths` 前後的檔案雜湊不同。

### 12.4 Claude 代寫策略（R2-3）

- `claudeFallback: "ask"` 的目標：
  - Codex 關閉或不可用、且計畫沒有預先授權時，暫停，理由 `codex_unavailable`。
  - 主人用 `/plan resume <id> claude` 授權後，才由 Claude 寫檔 worker 執行。
- 額度不足的處理不變：暫停，理由 `codex_quota`。
- 命令列的計畫確認畫面，會把「預先授權改由 Claude 寫程式」顯示成警示行，讓主人核准前看得到。

### 12.5 更改紀錄草稿（R2-4）

- `changeLogDraft: true` 的專案，報告末尾附「更改紀錄草稿（<專案>）」，依知識庫模板〈更改紀錄頁〉「紀錄」段的寫法：
  - 依日期分節，同一天依類別分組：設定表、程式、統計、驗證腳本、文件。類別由變更路徑判斷。
  - 每筆寫粗體標題，下面兩行：
    - 「改動」：新增、修改、刪除的檔案，加上計畫短 id、項目、執行者。
    - 「結果」：Core 驗收摘要；有審查就附「審查通過」；最後標「（未提交）」。
- 草稿由主人或工程師貼進該專案的更改紀錄（知識庫外）。艾莉絲不寫入。

### 12.6 艾莉絲的系統提示

- 「# 計畫」的可修改目標清單，每個目標附上三項：Core 驗收測試、禁改路徑、「Codex 不可用時先問主人」。
- 新增兩條規則：
  - 驗收標準寫行為與結果；測試由 Core 自動比對基準。
  - 不要安排修改禁改路徑的項目；真的需要時寫進 decisions。

## 13. 派工給同事 session、直接傳訊、跨計畫依賴（§27）

### 13.1 郵差：待送信件與轉接 session

- Core 不能用 Claude Code 的 `SendMessage`。艾莉絲要傳出去的訊息先放進「待送信件」（資料表 `outbox`），由轉接 session（`relaySession`，預設 `ALICE`）代送。
- 轉接 session 用 Bash 背景執行 `say.js --wait`（§42；原本用 `Monitor` 跑 `--watch`，但 Monitor 最多 30 分鐘就到期，每次到期都會吵醒 session）：
  - 有待送信件或待推播才結束，轉接 session 因此被喚醒；沒有時間上限。
  - Core 沒開或重啟時自動重連；連上後會再查一次，避免錯過連線前的事件。
  - 計畫暫停會變成推播；計畫結束不再另外印，到 Web Studio 看。
- 被喚醒後的流程：
  0. 執行 `say.js --check` 列出要處理的事，處理完再開新的 `--wait`。
  1. 執行 `say.js --outbox`，取出全文。
  2. 用 `SendMessage` 照收件人送出，內容一字不改。
  3. 送出成功就執行 `--sent <id>`；送不出去就執行 `--failed <id> <原因>`。
- 每封信排入、送出、失敗都寫 system 訊息（📤、📨、⚠），Web Studio 看得到。
- HTTP API：
  - `GET /api/outbox?status=pending`。
  - `POST /api/outbox/:id/sent`。
  - `POST /api/outbox/:id/failed`（body 可帶 `reason`）。

### 13.2 對象：本機設定的 session 對應

- `alice.local.json` 的 `projects[].session` 填該專案（角色）對應的 session 名稱，例：
  - 工具專案 → `<Project> - dev`。
  - 文件專案 → `<Project> - writer`。
  - 知識庫 → `Library`。
- 換專案時改這裡。傳訊與派工的對象，可以寫 session 名稱、角色名稱或專案名稱。

### 13.3 直接傳訊（D-4）

- 區塊格式：

  ```
  <<<ALICE_SEND
  {"to":"Library","message":"..."}
  ALICE_SEND>>>
  ```

  一則回覆可以有多個；`message` 最多 4,000 字。
- 找不到對象時不送，寫 system 訊息列出可傳的對象。
- 信件開頭標「【ALICE 訊息】」，結尾說明「要回覆時傳給 ALICE；ALICE 不能替主人做決定或核准」。
- 對方回覆時走現有的轉接流程，艾莉絲把它當成同事訊息處理。

### 13.4 session 項目（#1）

- 計畫項目可以用 `kind: "session"`，`project` 填有設定 session 的專案。
- 排程：
  - session 項目不占「同時 2 個項目」的上限。
  - 同一專案一次只派一個 session 或 modify 項目，因為兩者都可能改檔。
- 派工流程：
  1. 可修改的專案，先記下驗收基準（`testCommands`）、未提交檔清單、監看指紋。這些存在項目結果裡，Core 重啟也不會遺失。
  2. 排入信件，開頭「【ALICE 派工 <計畫短 id>-<key>】」，內容包括：
     - 工作說明、前置項目結果、驗收標準。
     - Core 會跑的測試與禁改路徑。
     - 規則：照自己的角色規則做事、改檔前要問主人的照樣問；不 commit、不寫知識庫。
     - 回報格式：第一行「【回報 <tag>】完成／卡住／需要主人決定」，最後加「規格衝突／發現的差異／回寫候選」三段。
  3. 派出後 30 分鐘沒回報，寫 system 訊息提醒主人，不自動重送。
- 回報處理：同事訊息經轉接送進 Core 時，`ConversationService` 先交給 `PlanService.handleSessionReport`，處理結果寫成 system 訊息，艾莉絲看得到。
  - 回報的 session 必須是派工的那一個，否則忽略並記錄。項目已經不在執行中時，只記錄、不改變計畫。
  - 「卡住」：暫停，理由 `session_blocked`。
  - 「需要主人決定」：暫停，理由 `decision_needed`。
  - 「完成」：可修改的專案依序做三項檢查：
    1. 新出現的未提交檔或監看指紋碰到禁改路徑 → `forbidden_path`。
    2. 驗收測試有新增失敗 → `session_verify_failed`。
    3. 回報裡有規格衝突 → `spec_conflict`。
  - 三項都通過才算完成。結果包括回報全文、`from`、變更檔、驗收、發現的差異、回寫候選；改到高風險路徑時，自動加入審查。
- resume：失敗的 session 項目重新派工，工作說明附上「上一次的回報」。
- 計畫取消：通知正在做的同事「不用再做；已改的檔案先不要還原，等主人決定」。
- 信件送不出去：該項目失敗，暫停，理由 `session_send_failed`。
- Core 重啟：
  - 等待回報中的 session 項目維持執行中。
  - 計畫裡只有這類項目在執行時，不因重啟暫停。

### 13.5 跨計畫依賴（#3）

- 計畫區塊可以加 `"after": ["<計畫 id 或前 8 碼>"]`，最多 5 份。
  - 建立時檢查：被等待的計畫必須存在，而且還沒有取消或結束。
  - 存在 `plans.after_plans`。
- 依賴的計畫還沒完成時：
  - 核准或 resume 後進入 `queued`，system 訊息寫「等待計畫 X 完成後才開始」。
  - 遞補時只選依賴都完成的計畫。
- 被等待的計畫取消時：等它的計畫改為暫停，理由 `dependency_failed`，並通知主人。主人可以 resume 不等直接開始，或取消。
- 被等待的計畫暫停時：只留紀錄，等它的計畫繼續排隊。
- 單一計畫仍最多 10 項；大工作拆成多份計畫，用 `after` 串接。
