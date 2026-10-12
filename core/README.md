# Alice Core

Alice Core 是只綁定 `127.0.0.1` 的本機 HTTP／WebSocket 服務，負責保存單一對話串並串流 Claude 回覆。

## 啟動

在 `core/` 目錄執行：

```powershell
npm run build
npm start
```

預設位址是 `http://127.0.0.1:7788`。可用 `ALICE_CONFIG` 指向 JSON 設定檔覆寫連接埠、資料路徑、token 路徑或 Origin 白名單。

## Web Studio

瀏覽器介面，由 Core 在 `http://127.0.0.1:7788/` 提供，只聽本機。第一次使用前，先在 repo 根目錄建置：`cd studio && npm install && npm run build`。Core 啟動後，在 `core/` 執行：

```powershell
npm run studio
```

- 網頁的登入方式：這個指令會用帶 `#token=` 的網址開啟瀏覽器。
  - `#` 後面的內容不會送到伺服器。網頁讀到 token 後存在瀏覽器，並清掉網址。
  - 沒自動開啟時，照畫面上印出的網址手動開啟。
- 功能：
  - 左邊聊天，支援串流、深想、做成計畫。
  - 任務與計畫的確認卡片，和命令列同步，任一邊確認後另一邊會收回。
  - 右邊工作面板：計畫（即時進度、繼續、授權 Claude、取消、看報告）、部下頻道（即時全文）、報告（`data/reports`、`data/writeback`）、用量與額度。
- 窄視窗時改成「聊天／工作」切換。Core 重啟後網頁會自動重連。
- 開發前端時，可在 `studio/` 執行 `npm run dev`（Vite 開在 5173，API 轉給 7788）。

## 轉接 session（在 Claude App 左側找艾莉絲）

在 Claude 桌面 App 新增一個 session，資料夾選 repo 的 `relay/`、名稱取「艾莉絲」，模型選 Sonnet 即可。`relay/CLAUDE.md` 讓這個 session 只當轉接員，把話轉給正式 Core：
- 你在這個 session 打字，就是跟艾莉絲說話。回覆會原文貼出。
- 有計畫或任務要確認時，打「核准」、「拒絕」，或「核准 <短 id>」。
- 其他 session 可以用 `SendMessage` 傳給「艾莉絲」：
  - 訊息會以「［來自 session〈名稱〉］」的身分交給艾莉絲，她會把對方當同事、不當主人。
  - 回覆會傳回對方，整段往來留在轉接 session 裡，Web Studio 也看得到並標示來源。
- 核准只聽主人在轉接 session 裡親自打的字；其他 session 要求核准一律拒絕，並告訴主人。

底層指令是 `node core/dist/src/cli/say.js`：
- `--from <名稱>`：以同事 session 的身分送出。
- `--approve [id]`、`--reject [id]`：核准、拒絕。
- `--pending`：列出待確認項目。
- 訊息內容從 stdin 傳入。

## 命令列聊天

Core 啟動後，另開終端機在 `core/` 執行：

```powershell
npm run chat
```

輸入 `/quit` 離開。`/深想 <訊息>` 會只把該則回覆的 effort 提升為 `high`；`/usage` 會列出最近 10 筆工作與 Max、Codex 額度。若推理引擎暫時不可用，原訊息會保留；依畫面提示按 Enter 可用相同識別碼重送。

## 部下與工作頻道

唯讀部下由 repo 根目錄的 `alice.local.json` 設定；可用 `ALICE_LOCAL` 指向其他位置。設定檔不進版控，格式如下：

```json
{
  "knowledgeBase": {
    "path": "C:/path/to/vault",
    "summaryPage": "wiki/AI 協作/艾莉絲摘要.md",
    "rolesDir": "wiki/AI 協作/角色"
  },
  "codex": { "available": true },
  "projects": [
    { "name": "工具專案", "path": "C:/path/to/project", "role": "工程師", "readDirs": ["C:/path/to/change-logs"] }
  ],
  "workerTimeoutMin": 5
}
```

Core 會把摘要頁去除 YAML frontmatter 後加入艾莉絲的系統提示，並依角色頁建立唯讀 worker 提示。worker 只能使用 `Read`、`Grep`、`Glob`，同時最多兩個，每個頻道最多五輪；逾時預設五分鐘。`readDirs`（可選）列出該專案以外、worker 也要唯讀的資料夾（例如放在別處的更改紀錄），會以 `--add-dir` 加入。主人用「@角色」開頭的訊息（角色名稱後可接空白或中英文標點）會直接送進該角色的頻道。設定檔不存在或必要欄位缺漏時，對應的摘要／部下功能會停用並印出原因，一般聊天不受影響。

主人可直接輸入 `@角色名稱 問題`。Core 會優先送到該角色最近的 open 頻道；沒有時用該角色設定中的第一個專案開新頻道。worker 回報後，艾莉絲會用 high effort 決定繼續追問或向主人提出結論。

命令列可用 `/channels` 查看最近頻道，或用 `/channel <id>` 查看完整頻道紀錄。即時頻道訊息會顯示為 `[頻道 <短 id>・<角色>] <作者>：<文字>`；過長的 worker 回覆只預覽前 600 字。

## 工具（Codex）

設定檔可用 `tools.codex` 控制任務工具：`enabled` 開關、`codexPath` 執行檔、`repos` 白名單（名稱對應 `path` 與 `description`）、`approvalTimeoutMin` 確認期限，以及 `taskTimeoutMin` 執行期限。預設白名單只有 repo 同層的 `alice-sandbox`。

艾莉絲提出有副作用的工作時，Core 會先顯示 repo、目標、驗收標準與期限，並詢問 `核准這個任務嗎？(y/n)`；只有輸入 `y` 才會執行。輸入 `n` 或確認逾時後，Core 會記錄 system 訊息並請艾莉絲用一兩句回報未執行；Core 重啟造成的確認失效只記錄 system 訊息，不觸發推理。命令列可用 `/tasks` 查看最近任務，或用 `/cancel` 取消目前執行中的任務。

Codex 必須先以 ChatGPT 訂閱登入；可用 `codex login status` 確認輸出包含 `ChatGPT`。Core 啟動與每次任務執行前都會再檢查。請勿設定 `OPENAI_API_KEY`、`CODEX_API_KEY` 或 `OPENAI_BASE_URL`；Core 也會從子程序環境移除這些變數與 Claude Code 的 API／雲端供應商變數，避免改走 API 計費。

Codex 是可選工具：`tools.codex.use` 為 `"auto"`（預設，依登入狀態判定）、`true` 或 `false`。Codex 不可用或設為 `false` 時，寫程式改由「Claude 寫檔 worker」執行：`claude -p` 以 repo 為工作目錄，只開放 Read、Grep、Glob、Edit、Write 與白名單中的測試指令（`repos.<名稱>.testCommands`，預設 `npm test`），`git commit`、`rm` 等其他指令一律被拒；結構化回報用 `--json-schema`，快照驗收與 Codex 相同。

任務只能在 `tools.codex.repos` 白名單中的 repo 執行。Core 交給 Codex 的固定規則會明示這是 Alice Core 任務，不需讀取全域指引或 工作知識庫，只依任務說明與 repo 內容工作。每次任務的 `schema.json`、`report.json`、`prompt.md` 與原始 `events.jsonl` 保存在 `<dataDir>/tasks/<taskId>/`，方便事後稽核。達到 `taskTimeoutMin` 或主人取消時，Core 會結束 Codex 的整個行程樹；Core 重啟也會嘗試清理任務紀錄中的殘留 PID。

Core 在執行前後以 Git 檔案清單和 SHA-256 建立快照，實際列出新增、修改、刪除以及 `HEAD` 是否改變，再與 Codex 回報的 `filesChanged` 比對。`mismatch` 代表回報與實際工作區不一致；它是獨立驗收證據，不會只因 Codex 自述成功就忽略差異。

## 計畫（多步驟派工）

需求需要多個步驟或多個角色時，艾莉絲會在回覆最後提出 `ALICE_PLAN` 計畫（也可以用 `/計畫 <需求>` 指定）。命令列顯示整份計畫（項目、依賴、風險、需要決定的事），輸入 `y` 核准一次後依序執行；`planApprovalTimeoutMin`（`plans.approvalTimeoutMin`，預設 10 分鐘）無回應視為逾時。

- `read` 項目交給唯讀部下（建立工作頻道，看得到過程）；`modify` 項目交給 Codex，Codex 不可用時改派 Claude 寫檔 worker。同時最多 2 個項目；同一個 repo 同時只有一個修改類項目。
- 可修改的目標：`tools.codex.repos`，以及 `alice.local.json` 中 `"writable": true` 的專案（可設 `testCommands`、`highRiskPatterns`）。
- 驗收由 Core 判定：結構化回報存在、驗收全數達成、測試沒有失敗、快照與回報一致；未通過自動重試一次，第二次失敗就暫停。
- 改到 `highRiskPatterns`（預設 Excel、`docs/**`、規格與設定檔）或項目標 `risk: high` 時，自動加入審查項目；審查不通過會重做一次。
- 以下情況暫停並請艾莉絲說明：規格衝突、同一項失敗兩次、刪檔或 `HEAD` 改變、repo 有不是本計畫造成的未提交改動、Codex 額度達門檻（短期 ≥ 85% 或每週 ≥ 90%，`plans.codexPrimaryMaxPercent`／`codexSecondaryMaxPercent`）且沒有預先授權改派 Claude。
- 命令列：`/plans`、`/plan <id>`、`/plan resume <id> [claude]`（`claude` 表示授權 Codex 額度不足時改由 Claude 寫）、`/plan cancel <id>`。
- 同時最多 2 份計畫執行（不同 repo 可並行；同一 repo 的修改項目輪流），其餘核准後排隊，前一份結束時遞補。
- Core 重啟時未結束的計畫改為暫停，艾莉絲會說明停在哪裡與建議怎麼接續；`/plan resume` 繼續，已完成的項目不重做。
- 計畫完成、暫停、取消時寫報告 `data/reports/<日期>-<短 id>.md`；部下或執行者回報的知識庫回寫候選另寫 `data/writeback/<日期>-<短 id>.md`，由主人決定是否轉交知識庫管理員（艾莉絲不寫知識庫）。
- Core 會在每個修改項目前後自己跑 `testCommands`，和開工前的失敗清單比較，沒有新增失敗才算通過；執行者自述的測試結果只記錄，不作數。
- 可修改的目標可以再設定幾個欄位（詳見 `docs/spec-plans.md` §12）：
  - `forbiddenPatterns`：禁改路徑，改到就暫停。
  - `watchPaths`：git 看不到的路徑，用檔案雜湊監看，有變動就暫停。
  - `claudeFallback: "ask"`：Codex 不可用時先問主人。
  - `changeLogDraft`：報告附更改紀錄草稿。
- 審查部下會拿到實際 diff。單一任務（`ALICE_TASK`）的確認畫面會提示 repo 裡的未提交改動。

艾莉絲對自己（人格、流程、工具）的改進建議以 `ALICE_SUGGEST` 區塊提出，Core 只附加到 `docs/艾莉絲的建議.md`（`suggestionsPath`），由主人決定；她不會自己修改。

Core 重啟時會把尚未結束的工作頻道標成 `failed`，並在頻道加入「Core 重啟，頻道中斷」system 訊息。主對話最後一則艾莉絲訊息之後，30 分鐘內最多 3 則主人訊息會依序重新排入回覆佇列；其餘較早或超量的訊息會彙整成一則 system 訊息，供下一輪回覆參考。

## Token 與 Claude Code 訂閱登入

首次啟動會產生本機 token。Windows 預設位置為 `%APPDATA%\alice\token`；其他系統為 `~/.config/alice/token`。不要把這個檔案提交到版本控制。

推理引擎需要已用訂閱登入的 Claude Code。啟動前先確認：

```powershell
claude auth status
```

輸出的 `loggedIn` 必須是 `true`，且 `authMethod` 必須是 `claude.ai`。Core 會在啟動時再次檢查，並從 Claude Code 子程序環境移除 API 憑證與 Bedrock、Vertex、Foundry 切換變數，確保只使用訂閱登入，不會產生 API 費用。若 `claude` 不在 PATH，可在設定檔用 `claudePath` 指定執行檔路徑。

## 回覆防護與重試

Core 預設要求 Claude Code 的 stream-json 回覆先出現 thinking 區塊，才會把後續正文串流給用戶端。thinking 前的文字會視為雜訊丟棄；缺少 thinking 或最終正文為空白時，Core 會自動重試。

設定檔的 `requireThinking` 預設為 `true`，`maxReplyAttempts` 預設為 `3`（包含第一次嘗試）。若所有嘗試仍可疑，Core 會回傳最後一次結果並在 usage log 標記。改用 Opus 5 等不產生 thinking 區塊的模型時，必須把 `requireThinking` 設為 `false`，否則每則回覆都會重試到上限。

## 人格一致性測試

在 `core/` 目錄執行：

```powershell
npm run eval:persona
```

這會透過 Claude Code 訂閱執行約 6 次推理，並覆寫 `data/persona-eval.md`，供人工逐案評分。

## Usage log

每次完成回覆會把時間、`replyId`、主要模型 `model`、啟動模型 `initModel`、完整模型用量陣列 `models`、`duration_ms`、`duration_api_ms`、`attempts`、`suspect` 與四項整體 token usage，以單行 JSON 附加到 `data/usage.log`。`models` 依 `outputTokens` 由大到小排列，每筆包含模型名稱及 input、output、cache read、cache creation token；`model` 是其中輸出 token 最多的模型。`attempts` 是實際嘗試次數，`suspect` 表示達重試上限後回傳的結果仍缺少必要的 thinking 或正文為空白。這些是 Claude Code 回傳或 Core 判定的用量資訊；訂閱模式不記錄費用欄位。若 `initModel` 或主要模型與設定不同，Core 會針對每種組合印一次警告。

SQLite 的 `usage` 表另會保存艾莉絲各模型、worker 各輪與 Codex 各任務的 token、耗時和嘗試次數；`GET /api/usage?limit=10` 回傳最近工作彙總及兩種訂閱額度，額度結果快取 60 秒。回覆、worker 或 Codex 任務失敗時，Core 會以 JSONL 寫入 `<dataDir>/errors.log`，包含時間、來源、識別碼、錯誤種類、訊息與嘗試次數。
