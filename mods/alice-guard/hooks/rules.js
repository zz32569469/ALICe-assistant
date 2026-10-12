// alice-guard 的判斷規則：純函式，不碰 $，方便測試。
// 團隊 repo 名稱、知識庫路徑、角色頁都來自本機設定 guard.local.json（不進 git），這裡不寫任何名稱。

/** 路徑統一成小寫、正斜線、去掉結尾斜線，方便比對（Windows 不分大小寫）。 */
export function norm(path) {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** path 是否在 root 裡（含 root 本身）。 */
export function isInside(path, root) {
  const p = norm(path)
  const r = norm(root)
  return r !== '' && (p === r || p.startsWith(r + '/'))
}

/** 文字裡有沒有提到某個 repo 資料夾：路徑段等於名稱，或是「名稱-xxx」的副本（例：驗證用的 clone）。 */
export function mentionsRepo(text, names) {
  const segments = norm(text).split(/[/\s"'`;&|()]+/)
  return names.some((name) => {
    const n = String(name).toLowerCase()
    return segments.some((segment) => segment === n || segment.startsWith(n + '-'))
  })
}

/** 這個指令是不是在團隊 repo 裡跑：session 開在團隊 repo，或指令裡 cd／git -C 到團隊 repo。 */
export function inTeamRepo(cwd, command, config) {
  const names = config.teamRepos ?? []
  if (names.length === 0) return false
  return mentionsRepo(cwd, names) || mentionsRepo(command, names)
}

/** 團隊 repo 的提交說明只寫標題，不加 Co-Authored-By。 */
export function hasCoAuthor(command) {
  return /\bcommit\b/i.test(command) && /co-authored-by/i.test(command)
}

/** 會丟掉修改、改寫歷史或對外的 git 指令；回傳說明，沒有就回 undefined。 */
export function riskyGit(command) {
  const c = String(command)
  const rules = [
    [/\bgit\b[^\n;&|]*\breset\b[^\n;&|]*--hard\b/i, 'git reset --hard 會丟掉未提交的修改'],
    [/\bgit\b[^\n;&|]*\bcheckout\b[^\n;&|]*(\s--(\s|$)|\s\.(\s|$)|\s-f\b|--force\b)/i, 'git checkout 會覆蓋工作區的修改'],
    [/\bgit\b[^\n;&|]*\bclean\b[^\n;&|]*\s-[a-z]*f/i, 'git clean -f 會刪掉未追蹤的檔案'],
    [/\bgit\b[^\n;&|]*\bbranch\b[^\n;&|]*\s-D\b/, 'git branch -D 會強制刪掉分支'],
    [/\bgit\b[^\n;&|]*\bstash\b[^\n;&|]*\b(drop|clear)\b/i, 'git stash drop／clear 會丟掉暫存的修改'],
    [/\bgit\b[^\n;&|]*\brebase\b/i, 'git rebase 會改寫歷史'],
    [/\bgit\b[^\n;&|]*\bpush\b/i, 'git push 會推到團隊的遠端 repo（主人說了才推）'],
  ]
  for (const [pattern, reason] of rules) if (pattern.test(c)) return reason
  // restore 只有 --staged（不含 --worktree）時只動暫存區，不算。
  const restore = /\bgit\b[^\n;&|]*\brestore\b([^\n;&|]*)/i.exec(c)
  if (restore && (!/--staged\b/.test(restore[1]) || /--worktree\b/.test(restore[1]))) return 'git restore 會覆蓋工作區的修改'
  return undefined
}

/** 檔案工具（Write、Edit…）要改的路徑。 */
export function editedPath(e) {
  return e.file_path ?? e.notebook_path ?? e.path
}

/** Bash／PowerShell 指令看起來會寫入知識庫：提到知識庫路徑，而且有寫入動作。 */
export function shellWritesVault(command, vault) {
  if (!vault) return false
  const c = norm(command)
  const v = norm(vault)
  const folder = v.split('/').pop()
  if (!c.includes(v) && !(folder && c.includes('/' + folder))) return false
  return /(^|[^0-9&2])>{1,2}(?!\s*&)|\btee\b|\b(cp|mv|rm|rmdir|mkdir|touch|ln)\s|\bsed\b[^\n]*\s-i|\b(set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|rename-item)\b|\bgit\b[^\n]*\b(add|commit|push|checkout|reset|restore|clean|mv|rm)\b|writefilesync|\.write\(/i.test(command)
}

/** 依 session 的資料夾找角色頁：設定裡第一個符合的。 */
export function roleFor(cwd, config) {
  for (const role of config.roles ?? []) {
    const hit = role.path ? isInside(cwd, role.path) : mentionsRepo(cwd, [role.repo])
    if (hit) return role
  }
  return undefined
}

/** §59：寄件 session 的名稱，照 Core 的同事訊息規則（1～40 字、不含換行與「〉」）；沒有名稱時用資料夾名。 */
export function senderName(title, cwd) {
  const clean = (value) => String(value ?? '').replace(/[〉\r\n]/g, ' ').trim().slice(0, 40)
  const name = clean(title)
  if (name !== '') return name
  const folder = clean(norm(cwd).split('/').filter(Boolean).pop())
  return folder === '' ? '同事 session' : folder
}

/** §59：送進 Core 的同事訊息（和轉接 session 的 say.js --from 同一個格式）。 */
export function peerRequest(name, text, id) {
  return {
    clientMsgId: id,
    clientId: `session:${name}`,
    text: `［來自 session〈${name}〉］\n${text}`,
  }
}
