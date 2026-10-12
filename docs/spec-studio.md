# 規格 ⑦：Web Studio

> v1.0（2026-09-30）。依規劃紀錄 §22 的開工決定（W-1～W-4）撰寫。範圍：Chat 與 Agent Activity（§8）；Projects、Files、Notes、桌寵、手機、遠端存取不在本版。

## 1. 架構

- 前端在 `studio/`：Vue 3 + Vite + TypeScript。`npm run build` 輸出到 `studio/dist`，不進版控。
- Core 從 `studioDir` 提供靜態檔（設定欄位，預設 `studio/dist`）：
  - `/api/` 與 `/ws` 以外的 GET 都屬於網頁，不需要 token。網頁本身不含秘密，API 仍要 token。
  - 路徑限制在 `studioDir` 內，防止路徑穿越。沒有副檔名的路徑回 `index.html`（前端路由）；有副檔名但找不到的回 404。
  - `assets/` 內的檔名帶雜湊，可長期快取；其他檔 `no-cache`。
  - 回應標頭：
    - CSP：`default-src 'self'`；`connect-src` 允許本機 ws；`style-src 'self' 'unsafe-inline'`；`frame-ancestors 'none'`。
    - 另有 `nosniff` 與 `no-referrer`。
  - 還沒建置時回 404，並提示建置指令。
- 同源允許：除了 `allowedOrigins`，也允許 `http://127.0.0.1:<實際連接埠>` 與 `http://localhost:<實際連接埠>`，涵蓋 HTTP API 與 WebSocket。其他來源仍回 403。

## 2. 登入（W-2）

- `npm run studio`（`core/`）：
  1. 讀 token，確認 Core 在執行、網頁已建置。
  2. 用 `rundll32 url.dll,FileProtocolHandler` 開啟 `http://127.0.0.1:<port>/#token=<token>`，不經過 cmd 的字元解析。
  3. 同時印出網址，給自動開啟失敗時手動使用。
- 網頁啟動時從 `#token=` 取出 token 存進 `localStorage`，再用 `history.replaceState` 清掉網址。瀏覽器不允許儲存時，只存在記憶體。
- token 無效時，WebSocket 連不上後會查 `/api/state`；回 401 就顯示登入畫面，說明 `npm run studio`，也可以手動貼上 token。
- 「登出」清除瀏覽器存的 token。

## 3. 資料與事件

- 每次 WebSocket 連上（含重連），重新載入以下資料，補上斷線期間漏掉的事件：
  - 最近 60 則訊息。
  - 計畫清單，以及未結束計畫的詳情。
  - 等待確認的任務與計畫（還原確認卡片）。
  - 頻道清單。
- 重連採指數退避：1 秒起，最多 10 秒。收到 `ping` 回 `pong`。
- 事件的處理方式：
  - 訊息與回覆：`message.created`、`reply.start`／`delta`／`end`／`error` 更新聊天（串流）。
  - 確認：`permission.request`／`resolved`、`plan.permission.request`／`resolved` 顯示或收回確認卡片。任一個 client 確認都會收回所有 client 的卡片。
  - 計畫：`plan.created`／`updated` 更新計畫；`plan.progress` 累積進度（每份計畫保留最後 40 行，只記開啟網頁之後的）；`plan.paused`／`done`／`queued` 重新讀取計畫，完成、暫停、取消時通知報告分頁重新整理。
  - 頻道：`channel.created`／`closed`／`message` 更新頻道；`channel.delta` 顯示部下正在寫的文字。
  - 狀態：`hello`、`state.changed` 更新頂部的狀態列。
- 網頁送出動作時帶 `x-alice-client: studio`，送訊息時帶 `clientId: "studio"`。「做成計畫」與命令列 `/計畫` 相同：附上要求文字並用 `deep`。

## 4. 新增的 API

- `GET /api/reports`：列出 `data/reports`、`data/writeback` 的 `.md` 檔，格式為 `{ kind: "report"|"writeback", name, size, modifiedAt }`，新的在前。
- `GET /api/reports/:kind/:name`：讀取 `{ kind, name, text }`。
  - 檔名只接受 `[\w.-]+\.md`，不能穿越目錄。
  - 不存在時回 404。

## 5. 畫面（W-3）

- 頂部：艾莉絲（狀態：活動、精神、睡著原因）與連線狀態。
- 左欄「聊天」：
  - 訊息：艾莉絲的回覆用安全的 Markdown 顯示，直接產生 Vue 節點、不用 `v-html`，支援標題、段落、條列、表格、程式碼、引用、粗體、行內程式碼。system 訊息置中小字。
  - 串流中的回覆。
  - 回覆失敗的提示。
  - 確認卡片：
    - 任務：目標、repo、驗收、預估、未提交檔案警示。
    - 計畫：各項目、依賴、驗收、風險、需要決定的事、預先授權警示。
  - 輸入框：Enter 送出、Shift+Enter 換行、深想、做成計畫。
- 右欄「工作」：
  - 計畫：清單與詳情（項目狀態、執行者、嘗試、結果摘要與 Core 驗收、錯誤、進度），按鈕有「繼續」、「繼續（授權 Claude 寫）」、「取消計畫」、「看報告」。
  - 頻道：清單與全文，部下回覆即時顯示。
  - 報告：清單與內容，由「看報告」直接跳過來。
  - 用量：Max、Codex 額度條（達 85% 變紅）與最近工作的 token 用量。
- 窄視窗（≤ 820px）：頂部切換「聊天／工作」，只顯示一欄；有待確認或進行中計畫時顯示數字徽章。
- 淺色與深色主題依系統設定。
