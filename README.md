# ALICe

ALICe（艾莉絲）是在本機執行的個人助手。
- **Core**：常駐服務，負責對話、記憶、狀態、計畫與部下，以及本機資料存取。
- **操作介面**：Web Studio（瀏覽器，手機也能開，見 [手機連線](docs/手機連線.md)）與命令列。
- **alice-guard**：Claude Code 的 mod，每個 session 都載入：團隊 repo 的提交守門、知識庫唯讀、自動帶入角色頁、同事傳給 ALICE 直送 Core。
- **推理**：用 Claude Code 的訂閱登入，不用 API 金鑰、不額外付費。

## 新電腦三步驟

```powershell
git clone <這個 repo> alice
cd alice
node scripts/setup.cjs --kb <知識庫要放的資料夾>
```

`setup.cjs` 會依序做這些事：
1. 檢查 Node 版本。
2. 安裝並建置 Core 與 Web Studio。
3. 建立空的知識庫範本與本機設定 `alice.local.json`。
4. 複製個人事實檔範例。
5. 執行健康檢查，列出還缺什麼、怎麼補。

已存在的檔案一律不覆寫。安裝完照最後印出的「下一步」啟動。

**事前準備：**
- Node.js 20.19 以上。
- Claude Code，用 claude.ai 訂閱登入。
- Codex（選用），用 ChatGPT 訂閱登入；沒有 Codex 時寫程式改由 Claude 做。
- Obsidian，用來開知識庫。
- 不要設定任何 API 金鑰。

## 每天使用

```powershell
cd core
npm start          # 啟動 Core
npm run studio     # 另開終端：在瀏覽器開 Web Studio（第一次會自動登入）
npm run chat       # 或：命令列聊天
```

## Web Studio

- **左邊對話：** 分「工作」「聊天」兩個分頁，紀錄分開。工作分頁管專案；聊天分頁輕鬆聊，不帶專案資料、不改專案卡。兩個分頁都可以 Ctrl+V 貼上或拖曳截圖（最多 6 張），ALICe 會先看圖再回答；截圖存在本機 `data/uploads/`。
- **右邊分頁：** 專案、會議、Codex、占卜、用量。右上「更新進度」：ALICe 依各專案卡的任務清單核對進度，有變化直接更新卡片。
- **會議：** 一行登記（例：`專案名稱 - 10/08 1500 ~ 1530 API 對接會議`），也可以在對話裡請 ALICe 記；會議前 30 分鐘、10 分鐘各提醒一次（對話訊息＋Windows 桌面通知）。
- **長期記憶：** ALICe 聽到你的偏好、習慣或你說「記住…」的事會先記成筆記，每天 4 點後整理一次，寫進 `memory/facts.md` 最後的「ALICe 記住的事」（最多 40 條，過時或沒用的會刪掉，整理前先備份到 `data/memory-backups/`）。你手寫的部分不會動；整理區你也可以直接改。
- **占卜：** 塔羅牌，今日運勢（1 張，每天一次）與本週運勢（3 張，每週一次），CD 沒到停在上次的結果；牌由程式隨機抽，ALICe 解讀，娛樂性質。

「Codex」分頁：委派給 Codex 的任務清單、狀態、最終回報、改了哪些檔、工作區比對與 Codex 額度（Core 轉接本機的 Codex 看板 `~/.claude/scripts/codex-board`，沒在跑時自動啟動；手機透過 Studio 也看得到）。ALICe 核對進度時也會參考各專案最近 7 天的 Codex 任務。

## alice-guard（Claude Code mod）

需要 Claude Code 2.1.287 以上。設定一次，之後每個 session（含桌面 App）都會載入：
1. 複製 `mods/alice-guard/guard.example.json` 成 `guard.local.json`（setup.cjs 會自動建立），填團隊 repo 資料夾名稱、知識庫路徑、角色頁與 Core 的 token 路徑。這個檔不進版控。
2. 在 `~/.claude/settings.json` 的 `env` 加 `"CLAUDE_CODE_PLUGIN_DIRS": "<repo>/mods/alice-guard 的絕對路徑"`。
3. `node scripts/doctor.cjs` 會檢查版本、設定與有沒有載入。

它做的事（細節見 `mods/alice-guard/README.md`）：
- 團隊 repo：提交說明含 Co-Authored-By 就擋；push、reset --hard 這類指令先問你。
- 知識庫：只有開在知識庫裡的 session 能寫入。
- 開工自動帶入對應的角色頁。
- 同事用 SendMessage 傳給 `ALICE` 時，直接送進 Core，不需要轉接 session。

## 多專案與手機

ALICe 是參謀兼秘書。實作的事你直接找各同事 session，ALICe 負責管各專案的進度、等你決定的事和提醒（規格：`docs/spec-projects.md`）。

- **ALICe 的分工：** 你先找 ALICe 建專案卡、說明大概要做什麼（可以給最初的規格書），之後直接跟各同事 session 討論與實作。ALICe 負責追蹤每個任務的進度（同事用 SendMessage 傳【進度】給 ALICe、每天早上 9 點核對更改紀錄與 git，沒有變化就不呼叫模型），以及有新需求時更新專案卡、給同事傳話卡片。任務卡住或太久沒動靜時，她會直接傳訊追問負責的 session（只限這兩件事）。
- **派工功能：** 部下、計畫、Codex 任務預設關閉；要用時在 `alice.local.json` 設 `"dispatch": true` 再重啟 Core。
- **代理人模式：** Studio 頂端「代理人模式」開啟後，ALICe 可以把你在對話裡明確交代的指示直接傳給同事 session（開頭標「（ALICe 代主人轉達）」），不用再貼卡片；上傳、刪除、寫知識庫這類事對方仍會先回報、等你本人確認。不會自動關閉，用完按頂端的「關閉」。ALICe 送出的每則訊息都記在對話裡。
- **開新專案：** 跟 ALICe 說「開新專案 專案名稱」。她會一次問完欄位、建立專案卡；同事 session 由你自己開。
- **進度確認：** 同事回報任務做完、或某條線該換階段時，ALICe 不直接改，會在對話裡放一張「進度等你確認」卡片並跳桌面通知；按「確認更新」才更新專案卡。
- **問進度：** 問「各專案現在怎樣」或「某個專案卡在哪」。Core 會讀更改紀錄和 git 狀態，ALICe 整理成總覽，約半分鐘。
- **進度線可以自訂：** 內建一條「規劃 → 進行中 → 驗證 → 完成」。團隊有自己的流程（例如兩條並行的線、各自的階段、負責的 session、加進提示的規則），寫成一個 JSON，在 `alice.local.json` 設 `workflowFile` 指過去（格式見 `docs/spec-projects.md`）。每條線都到最後一個階段，這個版本就完成；之後有新需求再開新版本。
- **換階段、改截止日、開新版本：** 直接跟 ALICe 說。Web Studio 的「專案」分頁可以看所有卡片。
- **寫文件：** 請 ALICe 把整理的內容「寫成文件」，她會直接寫 Obsidian 可開的 .md 檔到 alice.local.json 的 docRoots 資料夾（例：規格疑問與矛盾整理）。已存在的檔案只有你明確說要覆蓋才會覆蓋，舊版會先備份。
- **讀網頁：** 給 ALICe 網址或請她看規格書，她會讀網頁；要登入的頁面會用你電腦上的 Chrome（Claude in Chrome）開新分頁讀，讀完關掉，不會點擊或輸入。Chrome 要開著。
- **手機：** 用 Tailscale 在手機上開 Web Studio，看進度、跟 ALICe 對話（見 [手機連線](docs/手機連線.md)）。
  - 選用：想在手機的 Claude App 找 ALICe、收推播，可以另開轉接 session（資料夾 `relay/`，名稱 `ALICE`，規則在 `relay/CLAUDE.md`）並開遠端控制；開著時，同事傳給 ALICE 的訊息仍由 alice-guard 直送 Core。

## Chrome 選取翻譯插件

選取網頁文字按「譯」或 Alt+T，ALICe Core 用 Claude 訂閱（Haiku）翻譯，結果顯示在選取的文字旁邊，不開新分頁、不用 API。中文以外翻繁中、中文翻英文；團隊的固定用語可以寫在 `alice.local.json` 的 `translateGlossary`。安裝與設定見 `extension/README.md`。

## 更新

在另一台電腦更新到最新版：

```powershell
node scripts/update.cjs
```

腳本做的事：
1. `git pull`，只允許快轉。
2. 依變動的檔案重裝套件、重新建置 Core 與 Web Studio。
3. 執行健康檢查。
4. 最後列出要做的事，例如重啟 Core、重開已開著的 session（alice-guard 有更新時）。

## 健康檢查

```powershell
node scripts/doctor.cjs
```

檢查以下項目，每項附修正方式：
- Node 版本，以及 Core、Web Studio 有沒有建置。
- 本機設定格式。
- 知識庫、摘要頁、角色頁、各專案與 `readDirs` 的路徑。
- 事實檔。
- Claude Code、Codex 的登入方式。
- alice-guard：Claude Code 版本、`guard.local.json`、角色頁、有沒有設定成每個 session 都載入。

Core 啟動時發現的設定問題，也會顯示在 Web Studio 頂端。

## 本機設定與多台電腦

- **每台電腦各自獨立：** 資料庫、對話紀錄、報告在 `data/`；知識庫、個人事實檔、本機設定 `alice.local.json` 也各有一份，都不進版控。git 裡只有程式、規格與範本。
- **公司電腦與個人電腦的知識不互通：** 個人電腦用自己的知識庫，不會帶入公司內容。
- **欄位說明：** 見 [docs/本機設定.md](docs/本機設定.md)。範例在 `alice.local.example.json`。

## 文件

- 各功能規格：`docs/spec-*.md`。
- Core 的功能說明：`core/README.md`。

目前只在 Windows 驗證過；程式有 macOS／Linux 的分支，但還沒實測。

## 授權

MIT，見 [LICENSE](LICENSE)。
