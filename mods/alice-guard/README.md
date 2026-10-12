# alice-guard

ALICE 的守門 mod（Claude Code mods，需要 v2.1.287 以上）。把三條原本只寫在 CLAUDE.md、靠 Claude 自覺遵守的規則改成程式擋：

1. **團隊 repo 的提交規則**
   - 提交說明含 `Co-Authored-By` 時拒絕，請 Claude 拿掉再提交；Claude Code 的提交署名提示在團隊 repo 裡清空。
   - 會丟掉修改或改寫歷史的 git 指令（`reset --hard`、`checkout --`／`.`／`-f`、`restore`、`clean -f`、`branch -D`、`stash drop/clear`、`rebase`）和 `push`，先跳出問題問主人；沒人能回答（`claude -p`）時不執行。
2. **知識庫唯讀**：開在知識庫以外的 session，Write／Edit 寫入知識庫一律拒絕；Bash／PowerShell 指令看起來會寫入知識庫時先問主人。開在知識庫裡的 session（知識庫管理員）不受限。
3. **自動帶入角色指引**：依 session 開在哪個資料夾，把對應的角色頁放進第一則訊息的背景資料。
4. **直接送給 ALICE**：SendMessage 傳給轉接 session（設定 `alice.name`）的訊息，改由 mod 直接送進 Core（寄件人是 session 標題，拿不到時用資料夾名），不經過轉接 session；Core 連不上時照原本送給轉接 session。ALICE 的回覆在 Web Studio，不會傳回寄件的 session。

## 設定

複製 `guard.example.json` 成 `guard.local.json`（不進 git），填團隊 repo 資料夾名稱、知識庫路徑與角色頁。沒有設定檔時三條都不作用。

- `teamRepos`：資料夾名稱；路徑中有一段等於名稱或「名稱-xxx」（副本、worktree 也算）就算在團隊 repo。
- `roles`：依序比對，第一個符合的生效；`path` 比對資料夾本身與底下，`repo` 比對路徑段。
- `alice`：`name`（轉接 session 的名稱，例 ALICE）、`url`（Core，預設 http://127.0.0.1:7788）、`tokenPath`（Core 的 token 檔）。沒有這段就不攔截。

## 載入

- 試用一個 session：`claude --plugin-dir <這個資料夾>`
- 每個 session 都載入（含桌面 App）：在 `~/.claude/settings.json` 的 `env` 設 `CLAUDE_CODE_PLUGIN_DIRS` 為這個資料夾的絕對路徑。

## 測試

```bash
node --test mods/alice-guard/tests/
```

規則都在 `hooks/rules.js`（純函式）；`hooks/register.js` 只負責接事件。
