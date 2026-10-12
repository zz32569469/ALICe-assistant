# ALICE 選取翻譯（Chrome 插件）

選取網頁上的文字，按旁邊的「譯」按鈕或 **Alt+T**，翻譯結果出現在選取的文字旁邊（下方放不下就放上方，捲動時跟著文字移動），不開新分頁。

- 中文以外的內容 → 繁體中文；選到中文 → 英文。
- 翻譯由本機的 ALICE Core 用 Claude Code（Max 訂閱、Haiku）完成，**不用 API、不另外付費**。
- 團隊的固定用語照 `alice.local.json` 的 `translateGlossary` 翻（例：`["pull request / PR", "合併請求"]`）。
- 一次約 3～5 秒（多半是 Claude Code 啟動時間）；最多 3,000 字。
- 卡片 20 秒後自動收起（滑鼠停在卡片上不收）；Esc 關閉；可以一鍵複製譯文。

## 安裝（只要做一次）

1. Chrome 網址列輸入 `chrome://extensions`，右上角打開「開發人員模式」。
2. 按「載入未封裝項目」，選這個資料夾：`alice/extension`。
3. 工具列上點「ALICE 選取翻譯」圖示（或在擴充功能頁按「詳細資料 → 擴充功能選項」），打開設定頁：
   - Core 網址：預設 `http://127.0.0.1:7788`。
   - Token：打開 `%APPDATA%\alice\token`（檔案總管網址列貼上 `%APPDATA%\alice` 就能進資料夾），用記事本開 `token`，整串複製貼上。
4. 按「儲存並測試」，看到「成功：…」就可以用了。
5. 已經開著的分頁要重新整理一次，插件才會在那些頁面出現。

## 注意

- ALICE Core 要在執行中；沒開時卡片會顯示「連不到 ALICE Core」。
- 選取的文字會送到 Anthropic（跟平常用 Claude 一樣）。公司未公開的內容依公司規定判斷要不要翻。
- 插件只連本機（`127.0.0.1`／`localhost`），token 只存在這台電腦的 Chrome。Core 只讓插件的來源呼叫翻譯 API，其他 API 一律拒絕。
- 更新插件後，在 `chrome://extensions` 按插件卡片上的重新載入，並重新整理開著的分頁。
- Chrome 的 PDF 檢視器、`chrome://` 頁面與 Chrome 線上應用程式商店不允許插件執行，這些地方不能用。


