# alice-guard

ALICE 的守門 mod（Claude Code mods，需要 v2.1.287 以上）。把三條原本只寫在 CLAUDE.md、靠 Claude 自覺遵守的規則改成程式擋：

1. **團隊 repo 的提交規則**
   - 提交說明含 `Co-Authored-By` 時拒絕，請 Claude 拿掉再提交；Claude Code 的提交署名提示在團隊 repo 裡清空。
   - 會丟掉修改或改寫歷史的 git 指令（`reset --hard`、`checkout --`／`.`／`-f`、`restore`、`clean -f`、`branch -D`、`stash drop/clear`、`rebase`）和 `push`，先跳出問題問主人；沒人能回答（`claude -p`）時不執行。
2. **知識庫唯讀**：開在知識庫以外的 session，Write／Edit 寫入知識庫一律拒絕；Bash／PowerShell 指令看起來會寫入知識庫時先問主人。開在知識庫裡的 session（知識庫管理員）不受限。
3. **自動帶入角色指引**：依 session 開在哪個資料夾，把對應的角色頁放進第一則訊息的背景資料。
5. **分支守衛**（多款遊戲共用一個團隊 repo、用分支區分時）：session 名稱「<遊戲> - <角色>」（接手的「<遊戲> - <角色> 2」也算）認出本款，在團隊 repo 裡擋下寫到**別款遊戲分支**的 git 操作。目前分支用 `git rev-parse` 實際查。
   - 擋：目前在別款分支時 `commit`、`merge`、`rebase`、`cherry-pick`、不帶 ref 的 `push`、`tag`；`checkout`／`switch` 到別款分支；`merge`／`rebase` 別款分支；`push` 別款的分支或 tag（refspec 任一邊）；`tag` 用別款的名稱或打在別款分支上。
   - 不擋：`show`、`diff`、`log`、`blame` 等唯讀；`checkout <別款> -- 檔`（帶檔，不換分支）；`checkout -b` 開新分支；`--abort`／`--quit`／`--skip`；不在 games 表的分支（main、backup/…）；查不到目前分支（detached）。
   - session 名稱對不到 games 表（例 Library）：不擋，第一次在團隊 repo 寫 git 時提示一次「分支守衛未啟用」。
   - 擋下時寫明目前分支、本款應在的分支與原因，請 session 停下來問主人。
4. **直接送給 ALICE**：SendMessage 傳給轉接 session（設定 `alice.name`）的訊息，改由 mod 直接送進 Core（寄件人是 session 標題，拿不到時用資料夾名），不經過轉接 session；Core 連不上時照原本送給轉接 session。ALICE 的回覆在 Web Studio，不會傳回寄件的 session。

## 設定

複製 `guard.example.json` 成 `guard.local.json`（不進 git），填團隊 repo 資料夾名稱、知識庫路徑與角色頁。沒有設定檔時三條都不作用。

- `teamRepos`：資料夾名稱；路徑中有一段等於名稱或「名稱-xxx」（副本、worktree 也算）就算在團隊 repo。
- `roles`：依序比對，第一個符合的生效；`path` 比對資料夾本身與底下，`repo` 比對路徑段。
- `games`：`{ "<遊戲>": { "<團隊 repo 資料夾>": "<本款分支>" } }`，主人自己填（遊戲名和分支名不一定對得上，不推算）。遊戲名要和 session 名稱「 - 」前面那段相同（不分大小寫）；某款沒填某個 repo 就不算那個 repo 的別款。沒有這段時分支守衛不作用。
- `alice`：`name`（轉接 session 的名稱，例 ALICE）、`url`（Core，預設 http://127.0.0.1:7788）、`tokenPath`（Core 的 token 檔）。沒有這段就不攔截。

## 載入

- 試用一個 session：`claude --plugin-dir <這個資料夾>`
- 每個 session 都載入（含桌面 App）：在 `~/.claude/settings.json` 的 `env` 設 `CLAUDE_CODE_PLUGIN_DIRS` 為這個資料夾的絕對路徑。

## 測試

```bash
node --test mods/alice-guard/tests/
```

規則都在 `hooks/rules.js`（純函式）；`hooks/register.js` 只負責接事件。
