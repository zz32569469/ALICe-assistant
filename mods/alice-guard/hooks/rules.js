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

// ---------- 分支守衛（多款遊戲共用一個 repo，用分支區分）----------
// 設定 games：{ "<遊戲>": { "<團隊 repo 資料夾>": "<本款分支>" } }，由主人填（遊戲名與分支名不一定對得上，不推算）。
// session 名稱「<遊戲> - <角色>」（接手的「<遊戲> - <角色> 2」也算）認出本款；「別款」＝表裡其他遊戲的分支。

/** session 名稱「<遊戲> - <角色>」的遊戲部分；不是這個格式回 undefined。 */
export function gameNameOf(title) {
  const match = /^(.+?)\s+-\s+\S/.exec(String(title ?? '').trim())
  return match ? match[1].trim() : undefined
}

/** games 表裡的遊戲（名稱不分大小寫）；沒有回 undefined。 */
export function findGame(name, games) {
  if (!name) return undefined
  const key = String(name).toLowerCase()
  return Object.keys(games ?? {}).find((game) => game.toLowerCase() === key)
}

/** 路徑在哪個團隊 repo：從最深的一段往上找，等於名稱或「名稱-xxx」（worktree、副本）。 */
export function repoInPath(path, names) {
  const segments = norm(path).split('/').filter(Boolean).reverse()
  for (const segment of segments) {
    const exact = names.find((name) => segment === String(name).toLowerCase())
    if (exact) return exact
    const copy = names.find((name) => segment.startsWith(String(name).toLowerCase() + '-'))
    if (copy) return copy
  }
  return undefined
}

/** 把一段指令切成詞（處理單、雙引號）。 */
function words(text) {
  const out = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (let m; (m = re.exec(text)); ) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** 把指令依 &&、||、;、|、換行切段（引號裡的不切）。 */
function segments(command) {
  const out = []
  let current = ''
  let quote = ''
  const text = String(command)
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { current += ch + (text[i + 1] ?? ''); i += 1; continue }
      if (ch === quote) quote = ''
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue }
    if (ch === ';' || ch === '\n' || ch === '|' || (ch === '&' && text[i + 1] === '&')) {
      out.push(current)
      current = ''
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i += 1
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

/** 指令裡的 git 呼叫：{ dir（-C 或前面 cd 的路徑，沒有就是 undefined）, sub, args }。 */
export function gitCalls(command) {
  const calls = []
  let dir
  for (const part of segments(command)) {
    const w = words(part.trim())
    if (w[0] === 'cd' || w[0] === 'Set-Location' || w[0] === 'pushd') {
      if (w[1]) dir = w[1]
      continue
    }
    const at = w.indexOf('git')
    if (at < 0) continue
    let i = at + 1
    let callDir = dir
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C') { callDir = w[i + 1]; i += 2; continue }
      if (w[i] === '-c') { i += 2; continue }
      i += 1
    }
    if (i < w.length) calls.push({ dir: callDir, sub: w[i], args: w.slice(i + 1) })
  }
  return calls
}

/** 這些子指令才需要查分支（其他都是唯讀或與分支無關）。 */
export const BRANCH_WRITES = ['commit', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'push', 'tag']

const OPTIONS_WITH_VALUE = new Set(['-m', '-F', '-b', '-B', '-c', '-C', '--orphan', '-X', '-s', '--strategy', '-o', '--onto', '--exec', '-u', '--message', '--file', '--author', '--date'])

/** 不是選項的參數（略過選項本身與它帶的值）。 */
function positionals(args) {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--') break
    if (arg.startsWith('-')) {
      if (OPTIONS_WITH_VALUE.has(arg)) i += 1
      continue
    }
    out.push(arg)
  }
  return out
}

/** ref 去掉 origin/、refs/heads/ 等前綴。 */
function branchName(ref) {
  return String(ref).replace(/^\+/, '').replace(/^refs\/(heads|remotes\/[^/]+)\//, '').replace(/^(origin|upstream)\//, '')
}

/**
 * 一個 git 呼叫會不會寫到別款遊戲的分支；會的話回傳原因，不會回 undefined。
 * others：別款分支 → 遊戲名稱；current：目前分支（detached 或查不到是 undefined）。
 */
export function branchViolation(call, current, others) {
  const other = (ref) => {
    const name = branchName(ref)
    for (const [branch, game] of others) if (name === branch || name.startsWith(branch + '/')) return { branch, game }
    return undefined
  }
  const onOther = current === undefined ? undefined : other(current)
  const { sub, args } = call
  const pos = positionals(args)
  const has = (...flags) => args.some((arg) => flags.includes(arg))
  const here = onOther && `目前分支 ${current} 是〈${onOther.game}〉的分支`
  if (sub === 'commit' && onOther) return `${here}，提交會落到別款`
  if (sub === 'checkout' || sub === 'switch') {
    // 從別款帶檔（checkout <分支> -- 檔、或分支後面接檔案）只改工作區、不換分支，不擋；開新分支（-b 等）也不擋。
    if (args.includes('--') || has('-b', '-B', '-c', '-C', '--orphan', '--detach') || pos.length !== 1) return undefined
    const target = other(pos[0])
    return target && `${pos[0]} 是〈${target.game}〉的分支，切過去之後的操作會落到別款`
  }
  if (sub === 'merge' || sub === 'rebase' || sub === 'cherry-pick') {
    if (has('--abort', '--quit', '--skip')) return undefined
    if (onOther) return `${here}，${sub} 會改到別款的歷史`
    const target = pos.map(other).find(Boolean)
    return target && `${target.branch} 是〈${target.game}〉的分支，${sub} 會把別款的內容帶進來`
  }
  if (sub === 'push') {
    const refs = pos.slice(1).flatMap((spec) => spec.split(':')).filter(Boolean)
    const target = refs.map(other).find(Boolean)
    if (target) return `${target.branch} 是〈${target.game}〉的分支（或它的 tag），不能從這個 session 推`
    if (refs.length === 0 && onOther) return `${here}，push 會推別款的分支`
    return undefined
  }
  if (sub === 'tag') {
    if (has('-l', '--list', '-d', '--delete', '-v', '--verify') || pos.length === 0) return undefined
    const named = other(pos[0])
    if (named) return `tag ${pos[0]} 是〈${named.game}〉的 tag`
    const target = pos[1] ? other(pos[1]) : onOther && { branch: current, game: onOther.game }
    return target && `tag 會打在〈${target.game}〉的分支 ${target.branch} 上`
  }
  return undefined
}

/** games 表裡某個 repo 的別款分支：分支 → 遊戲名稱（不含本款）。 */
export function otherBranches(games, repo, own) {
  const out = new Map()
  for (const [game, branches] of Object.entries(games ?? {})) {
    if (game === own) continue
    const branch = branches?.[repo]
    if (typeof branch === 'string' && branch !== '') out.set(branch, game)
  }
  return out
}
