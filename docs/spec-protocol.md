# 規格 ③：Client ↔ Core 訊息格式

> v1.3（2026-09-29 主人確認）。v1.3：工具相關（`Message.role` 加 `system`、任務 API 與事件、錯誤碼 `not_found`／`conflict`），細節見 `spec-tools.md` §10。v1.2：推理引擎改為 `claude -p`（訂閱），狀態行移到系統提示末尾。v1.1：提示組裝順序調整、新增錯誤碼 `refused`。

## 0. 前提（Q5、Q6 粗定）

- **Q6 對話串**：所有 Client 共用**一條**對話串（同一個艾莉絲、同一段對話）。每則訊息記錄來源 Client。一個 Client 送出的訊息與回覆，會推送給所有在線 Client。
- **Q5 記憶**：階段 A 只有兩類。
  | 類別 | 存放 | 誰寫 | 主人能否查看、修改 |
  | --- | --- | --- | --- |
  | 對話紀錄 | SQLite | Core 自動寫 | 可查看（API）；刪除延後 |
  | 事實檔（關於主人的事實與偏好） | `memory/facts.md` | 主人手寫；艾莉絲階段 A 不自動寫 | 直接編輯檔案 |
  
  專案知識、自動萃取事實、向量檢索延後。
- 提示組裝（v1.2，推理引擎為 `claude -p`）：**系統提示**＝人格設定檔 → 事實檔 → `# 目前狀態` 狀態行；**stdin**＝最近 N 則對話紀錄 → 本次訊息。狀態行放在 stdin 時，T5 有 30～40% 的回覆外漏內部分析（量測 20 次中 7 次異常）；移到系統提示末尾後 0/10（2026-09-29 實測，見規劃紀錄 §13）。v1.1 的「mid-conversation system 訊息＋cache breakpoint」只適用 Claude API，已不採用。
- 對話紀錄只存文字，不存、不回放 thinking 區塊。

## 1. 連線與安全

- Core 只綁定 `127.0.0.1`，預設埠 **7788**（可設定）。
- HTTP 基底：`http://127.0.0.1:7788/api`；WebSocket：`ws://127.0.0.1:7788/ws`。
- 為避免任意網頁從瀏覽器打本機 API，所有請求須帶 token：Core 首次啟動時產生隨機 token，寫入 `%APPDATA%/alice/token`。HTTP 用 `Authorization: Bearer <token>`，WebSocket 用 `?token=<token>`。另外檢查 `Origin`，只允許白名單內的來源。階段 A 就做。

## 2. 分工

- **HTTP**：Client 主動的操作（送訊息、讀歷史、讀狀態）。
- **WebSocket**：Core 推送（串流回覆、狀態變更、其他 Client 的訊息）。階段 A 的 WebSocket 只有 Core → Client 方向（心跳除外）。

## 3. HTTP API

| 方法 | 路徑 | 用途 | 回應 |
| --- | --- | --- | --- |
| GET | `/api/health` | Core 是否在線（不需 token） | `{ ok: true, version }` |
| GET | `/api/state` | 目前狀態 | `State`（見 §5） |
| GET | `/api/messages?before=<seq>&limit=<n>` | 讀對話紀錄（新到舊，`limit` 預設 50、上限 200） | `{ messages: Message[] }` |
| POST | `/api/messages` | 送出主人訊息 | `202 { messageId, replyId }`；回覆經 WebSocket 串流 |

### POST /api/messages

```json
{ "clientMsgId": "c-8f3a…", "text": "早安", "clientId": "cli" }
```

- `clientMsgId`：Client 產生的 UUID，用於去重。同一 id 重送時回傳原本的 `messageId`，不會重複回覆。
- `clientId`：來源識別，例 `cli`、`web`、`pet`。
- 前一則回覆還在產生時又送訊息：排隊，依序回覆（不中斷前一則）。

### 錯誤格式（HTTP 與 WebSocket 共用）

```json
{ "error": { "code": "reasoning_unavailable", "message": "推理引擎無法連線", "retryable": true } }
```

| code | 意義 | retryable |
| --- | --- | --- |
| `bad_request` | 參數錯誤 | false |
| `unauthorized` | token 錯誤 | false |
| `reasoning_unavailable` | 推理引擎連不上或驗證失敗 | true |
| `rate_limited` | 推理引擎限流 | true |
| `refused` | 主模型與 fallback 模型都拒答（`stop_reason: "refusal"`） | false |
| `internal` | Core 內部錯誤 | true |

## 4. WebSocket 事件

### 共同外框

```json
{ "v": 1, "type": "reply.delta", "seq": 1024, "ts": "2026-09-29T08:12:03.120+08:00", "data": { } }
```

- `seq`：Core 遞增序號（連線內）。
- Client 斷線重連後，會先收到 `hello`，再以 `GET /api/messages` 補齊缺漏的訊息。串流中途斷線，以補讀到的完整訊息為準。

### 事件列表

| type | 時機 | data |
| --- | --- | --- |
| `hello` | 連線建立 | `{ coreVersion, state: State, lastMessageSeq }` |
| `message.created` | 任何 Client 的主人訊息寫入紀錄後（讓其他 Client 同步） | `Message` |
| `reply.start` | 開始產生回覆 | `{ replyId, inReplyTo: messageId }` |
| `reply.delta` | 串流片段 | `{ replyId, text }`（增量文字） |
| `reply.end` | 回覆完成並寫入紀錄 | `{ replyId, message: Message }`（完整內容） |
| `reply.error` | 回覆失敗 | `{ replyId, error }`（格式同 §3） |
| `state.changed` | 狀態變更 | `State` |
| `ping` / `pong` | 心跳，Core 每 30 秒送 `ping`，Client 回 `pong` | `{}` |

### 預留（階段 A 不實作，僅佔名稱）

| type | 用途 |
| --- | --- |
| `task.created` / `task.progress` / `task.done` / `task.cancelled` | 長時間工具任務（Q7） |
| `permission.request` / `permission.resolved` | 副作用操作確認（Q8）；Client 以 HTTP 回覆同意或拒絕 |

## 5. 資料型別

```ts
type Message = {
  id: string;            // Core 產生
  seq: number;           // 對話紀錄內遞增，用於分頁
  role: "user" | "alice" | "system"; // system：Core 產生的通知（v1.3）
  text: string;
  clientId?: string;     // role=user 時的來源
  mode?: "work" | "chat";// role=alice 時由 Core 記錄（可選）
  createdAt: string;     // ISO 8601
};

type State = {
  activity: "idle" | "talking" | "busy" | "sleeping";
  sleepReason?: "idle_timeout" | "night" | "reasoning_unavailable";
  energy: "low" | "normal" | "high";
  changedAt: string;
};
```

## 6. 已確認（2026-09-29）

1. token 與 Origin 檢查在階段 A 就做。
2. 回覆產生中又送訊息：排隊。
3. 埠號 7788。

## 7. 工具（v1.3）

任務相關的 HTTP 端點、WebSocket 事件（`task.created`、`permission.request`、`permission.resolved`、`task.rejected`、`task.started`、`task.progress`、`task.done`）與錯誤碼 `not_found`、`conflict`，定義在 `spec-tools.md` §4、§10，以該檔為準。§4 的「預留」表中任務與權限事件已轉為正式。
