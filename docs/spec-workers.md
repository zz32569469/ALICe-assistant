# 規格 ⑤：部下（worker）與工作頻道（階段 C1）

> v1.1（2026-09-30）。v1.1：專案 `readDirs`；`@角色` 後可接中英文標點；Codex 額度往前找有 `rate_limits` 的 session。依規劃紀錄 §16（Q2、Q8、Q10、Q12、Q13、Q16、Q18、Q22）與 C1 開工決定（C1-1～C1-4）撰寫。C1 只做**唯讀** worker；修改類派工、計畫、審查在 C2。

## 0. 已查證的事實（2026-09-30，Claude Code 2.1.284）

- `claude -p` 以 `--resume <session_id>` 延續同一個 session：5 輪皆為同一 session、記憶正確、每輪約 4.7 秒、快取逐輪命中。第一輪**不可**加 `--no-session-persistence`（否則無法 resume）。
- 唯讀範圍：`--tools "Read,Grep,Glob" --permission-mode dontAsk --permission-prompts none --add-dir <目錄>` 時，只能讀「工作目錄＋`--add-dir` 目錄」；讀其他路徑被拒（列在 `result.permission_denials`），沒有任何寫入工具。
- Max 額度：`claude -p "/usage"`（`--safe-mode --tools "" --no-session-persistence`）輸出含 `Current session: N% used · resets …`、`Current week (all models): N% used · resets …`。在 Git Bash 下需 `MSYS_NO_PATHCONV=1`；Node `spawn` 不經 shell 時沒有這個問題。
- Codex 額度：`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 的 `token_count` 事件含 `rate_limits`（與 `/codex-usage` 同一來源）。

## 1. 設定（`alice.local.json`，不進 git）

```json
{
  "knowledgeBase": { "path": "<vault>", "summaryPage": "wiki/AI 協作/艾莉絲摘要.md", "rolesDir": "wiki/AI 協作/角色" },
  "codex": { "available": true },
  "projects": [ { "name": "<專案名稱>", "path": "<路徑>", "role": "<角色名稱，對應 rolesDir 下的 <角色>.md>", "readDirs": ["<可選：專案外也要唯讀的資料夾>"] } ]
}
```

- Core 啟動時讀取（位置：repo 根目錄；可由 `ALICE_LOCAL` 環境變數覆寫）；不存在時，知識庫摘要與部下功能停用，聊天照常。
- 角色頁：`<vault>/<rolesDir>/<role>.md`。
- `readDirs`（v1.1）：該專案的 worker 額外以 `--add-dir` 唯讀的資料夾，例如放在專案外的更改紀錄。

## 2. 艾莉絲的系統提示（新增段落）

順序：人格 → 事實檔 → **知識庫摘要** → **# 部下** → # 工具 → # 目前狀態。

- **知識庫摘要**：`summaryPage` 去掉 YAML frontmatter 後的內文，標題 `# 知識庫摘要（由知識庫管理員維護）`。以檔案修改時間快取，改了才重讀。
- **# 部下**（由設定產生，內容穩定）：可派的角色與專案清單（名稱、角色）、`ALICE_ASK` 區塊格式與範例、規則：
  - 需要查專案或知識庫細節時派部下，不要猜；部下只能讀，不能改。
  - 一則回覆最多一個 `ALICE_ASK` 區塊。
  - 同一個問題最多 5 輪；給主人結論時引用部下提供的檔案路徑。
  - 部下回報後，要嘛追問（同一頻道再出一個區塊），要嘛向主人給結論；結論用觀點格式（結論 → 理由 → 風險 → 替代方案 → 需要主人決定的事），簡單事實題可省略。

## 3. `ALICE_ASK` 區塊

```
<<<ALICE_ASK
{"role":"工程師","project":"工具專案","question":"……","channelId":null}
ALICE_ASK>>>
```

| 欄位 | 必填 | 說明 |
| --- | --- | --- |
| `role` | 是 | 設定中的角色 |
| `project` | 是 | 設定中的專案名稱（決定 worker 的工作目錄） |
| `question` | 是 | 給部下的問題或指示 |
| `channelId` | 否 | 追問既有頻道時填；null 表示開新頻道 |

- 串流過濾與任務區塊相同（不轉送、不存進艾莉絲的訊息）。同一則回覆同時有 `ALICE_TASK` 與 `ALICE_ASK` 時，兩者都處理。
- 驗證失敗（角色／專案不存在、頻道不存在或已結束、超過 5 輪、同時進行中的 worker 已達 2 個）→ 不派工，寫 `system` 訊息說明原因，艾莉絲下一輪看得到。
- 唯讀派工**不需要主人確認**。

## 4. 工作頻道

SQLite（資料庫 v3）：

- `channels`：`id`、`title`（問題前 40 字）、`project`、`role`、`workerSessionId`、`status`（`open`／`closed`／`failed`）、`rounds`、`createdAt`、`updatedAt`。
- `channel_messages`：`id`、`channelId`、`seq`、`author`（`alice`／`worker`／`user`／`system`）、`text`、`createdAt`。

流程：

1. 艾莉絲的回覆含 `ALICE_ASK` → Core 建立或取用頻道，寫一則 `author: alice` 的頻道訊息（問題），推送 `channel.message`。
2. 執行 worker（§5），回覆寫成 `author: worker` 的頻道訊息並推送（串流片段推 `channel.delta`）。
3. Core 把「部下回報」放進**對話佇列**觸發艾莉絲推理：transcript 結尾為 `（工作頻道 <短 id>・<角色>）` 加上該頻道最近的訊息（截斷至 12 KB），再加 `（系統通知）請追問或向主人給結論。` 這次推理 effort 用 `high`。
4. 艾莉絲的回覆若再含 `ALICE_ASK`（同一 `channelId`）→ 回到步驟 1（`rounds` +1）；若沒有 → 頻道標 `closed`，回覆就是給主人的結論，存進主對話。
5. 艾莉絲回覆中給主人看的文字（區塊以外的部分）照常存進主對話並推送。

## 5. worker 執行

- 指令：`claude -p --safe-mode --tools "Read,Grep,Glob" --disallowedTools "mcp__*" --permission-mode dontAsk --permission-prompts none --add-dir <vault> --model <config.model> --effort high --system-prompt-file <檔> --output-format stream-json --verbose --include-partial-messages`；第一輪不加 `--resume`，之後 `--resume <workerSessionId>`。
- 工作目錄：該專案的 `path`（角色為知識庫管理員時即 vault）。
- 環境：與艾莉絲相同，移除 API 憑證變數（`subscriptionOnlyEnv`）。
- stdin：第一輪為問題；之後為追問或主人的 `@` 發言。
- 系統提示（C1-4，不含艾莉絲人格）：角色頁（去掉 frontmatter）＋ worker 通用規則：
  - 你是艾莉絲（主人的秘書 AI）派來的〈角色〉；你**只能讀**，不能修改任何檔案或執行指令。
  - 回答要具體：結論在前，附引用的檔案路徑（`檔案:行號`）；不確定就說不確定並標明「未查證」。
  - 需要艾莉絲或主人決定的事，列在回覆最後的「需要決定」段落。
  - 不讀全域指引；知識庫依角色頁指示查詢。
- thinking 防護：不套用（worker 的輸出只給艾莉絲看，不直接給主人）；`requireThinking` 只作用於艾莉絲。
- 逾時：每輪 5 分鐘（`workerTimeoutMin`）；逾時或失敗 → 頻道標 `failed`，寫 `system` 頻道訊息，並觸發艾莉絲告知主人。
- 同時最多 2 個 worker 執行中（Q20）。
- `result.permission_denials` 非空時，寫一則 `system` 頻道訊息列出被拒的路徑（稽核用）。

## 6. 主人介入（`@角色`）

- 主人訊息以 `@<角色名稱>` 開頭：送到該角色**最近一個 `open` 的頻道**（沒有則開新頻道，專案取設定中該角色的第一個專案）。訊息寫成 `author: user` 的頻道訊息，並作為 worker 下一輪的 stdin；worker 回報後照 §4 步驟 3 觸發艾莉絲跟進。
- 同時也存進主對話（照常顯示）。

## 7. `/深想`

- 命令列 `/深想 <訊息>` → `POST /api/messages` 帶 `"deep": true` → 該則回覆 effort `high`。
- 部下流程（§4 步驟 3）自動 `high`。

## 8. 用量（Q13、Q22）

- 資料庫 `usage` 表：`id`、`ts`、`kind`（`alice`／`worker`／`codex`）、`refType`（`message`／`channel`／`task`）、`refId`、`model`、`inputTokens`、`outputTokens`、`cacheReadInputTokens`、`cacheCreationInputTokens`、`durationMs`、`attempts`。艾莉絲每則回覆、worker 每輪、Codex 每個任務（`turn.completed.usage`）各寫一筆（多模型時各一筆）。`usage.log` 照舊保留。
- `GET /api/usage?limit=` → 最近的頻道／任務／回覆彙總，以及額度：Max（解析 `/usage` 輸出的兩行）、Codex（最新 `rate_limits`）；額度快取 60 秒，讀取失敗時標「無法讀取」並附原因。
- 命令列 `/usage`：印出最近 10 筆工作（類型、標題、token 合計、耗時）與兩個額度。

## 9. 可靠性（待辦補上）

- 回覆失敗：寫入 `data/errors.log`（JSONL：時間、`replyId`、種類、訊息、`attempts`）。
- Core 重啟後的未回覆訊息：主對話最後一則艾莉絲訊息之後的主人訊息視為未回覆。30 分鐘內的（最多 3 則）重新放進佇列處理；更早的寫一則 `system` 訊息「Core 重啟前這些訊息沒有回覆：…」，艾莉絲下一輪會看到。
- `open` 頻道在重啟時標 `failed`（`Core 重啟，頻道中斷`），寫 `system` 訊息。

## 10. 命令列

- `channel.message`：`[頻道 <短 id>・<角色>] <作者>：<文字>`（worker 回覆長時只印前 600 字，並提示 `/channel <id>` 看全文）。
- `/channels`：最近頻道列表；`/channel <id>`：印出完整頻道紀錄。
- `@角色 …`、`/深想 …`、`/usage` 見上。

## 11. 協定（`spec-protocol.md` 升 v1.4 時同步）

- WebSocket 事件：`channel.created`、`channel.message`、`channel.delta`、`channel.closed`。
- HTTP：`GET /api/channels`、`GET /api/channels/:id`、`GET /api/usage`；`POST /api/messages` 新增 `deep`。
