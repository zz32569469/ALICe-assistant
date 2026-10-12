# 全域指引（Codex）

使用者的全域指引與 Claude Code 共用，唯一權威是 `{{USERPROFILE}}/.claude/CLAUDE.md`。

**每個 session 開始時先讀該檔，並視同本檔內容遵守。** 其中的「工作知識庫」段落規定：
- 知識庫位置：`{{KB_PATH}}`
- 何時要先查知識庫、怎麼查、回答時如何註明引用
- 知識庫預設唯讀，回寫前必須先詢問使用者

對應關係：
- Claude Code 的 `/kb` 指令在 Codex 是 `$kb` skill（`~/.codex/skills/kb/`）。
- 知識庫 vault 的規範檔是其根目錄的 `CLAUDE.md`（vault 內的 `AGENTS.md` 只負責轉址）。
