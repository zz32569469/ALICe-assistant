// alice-guard：把 CLAUDE.md 裡三條靠自覺的規則改成程式擋（§52）。
// 1. 團隊 repo 的提交規則：不加 Co-Authored-By；會丟掉修改或推送的 git 指令先問主人。
// 2. 知識庫唯讀：只有開在知識庫裡的 session（知識庫管理員）可以寫入。
// 3. 自動帶入角色指引：依 session 開在哪個資料夾，把對應的角色頁放進第一則訊息的背景資料。
// 4. 直接送給 ALICE（§59）：SendMessage 傳給轉接 session（設定 alice.name）的訊息，改由 mod 直接送進 Core，
//    不用轉接 session；Core 連不上時照原本方式送給轉接 session。ALICE 的回覆在 Web Studio，不會傳回寄件的 session。
// 設定在本機 guard.local.json（不進 git），格式見 guard.example.json；沒有設定檔時三條都不作用。

import { editedPath, hasCoAuthor, inTeamRepo, isInside, peerRequest, riskyGit, roleFor, senderName, shellWritesVault } from './rules.js'

let cached
/** 這個 session 的名稱（SessionStart 帶來的標題），送訊息給 ALICE 時當寄件人。 */
let sessionTitle = ''

/** 讀本機設定；讀不到就當成沒有設定（全部放行）。 */
async function loadConfig($) {
  if (cached !== undefined) return cached
  try {
    cached = JSON.parse(await $.fs.read(`${$.plugin.root}/guard.local.json`))
  } catch {
    cached = {}
  }
  return cached
}

/** 問主人要不要執行；沒人能回答（claude -p）或關掉問題都當成不執行。 */
async function confirm($, question) {
  try {
    return (await $.ui.ask(question, ['執行', '不要執行'])) === '執行'
  } catch {
    return false
  }
}

export function register(on) {
  // 1＋2：Bash／PowerShell 指令。
  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const config = await loadConfig($)
    const cwd = await $.session.cwd()
    const command = String(e.command ?? '')
    if (inTeamRepo(cwd, command, config)) {
      if (hasCoAuthor(command)) {
        return { deny: 'alice-guard：團隊 repo 的提交說明只寫標題，不加 Co-Authored-By。請拿掉那一行再提交。' }
      }
      const risk = riskyGit(command)
      if (risk !== undefined && !(await confirm($, `團隊 repo：${risk}。要執行嗎？\n${command}`))) {
        return { deny: `alice-guard：${risk}，主人沒有同意執行。先說明理由並等主人決定，不要換個寫法再試。` }
      }
    }
    if (config.vault && !isInside(cwd, config.vault) && shellWritesVault(command, config.vault)) {
      if (!(await confirm($, `這個指令看起來會寫入知識庫（只有知識庫管理員可以寫）。要執行嗎？\n${command}`))) {
        return { deny: 'alice-guard：知識庫對這個 session 唯讀。回寫候選記在更改紀錄「待回寫」，整批傳給 Library。' }
      }
    }
    return next(e)
  })

  // 2：檔案工具寫入知識庫一律拒絕（開在知識庫裡的 session 除外）。
  on('tool.call', { tool: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] }, async ($, e, next) => {
    const config = await loadConfig($)
    const target = editedPath(e)
    if (config.vault && target && isInside(target, config.vault) && !isInside(await $.session.cwd(), config.vault)) {
      return { deny: 'alice-guard：知識庫對這個 session 唯讀，只有知識庫管理員（Library）可以寫入。回寫候選記在更改紀錄「待回寫」，整批傳給 Library。' }
    }
    return next(e)
  })

  // 1：在團隊 repo 裡，Claude Code 不再提示要加提交署名。
  on('attribution.text', { kind: ['commit', 'pr'] }, async ($, e, next) => {
    const config = await loadConfig($)
    if (inTeamRepo(await $.session.cwd(), '', config)) return { text: '' }
    return next(e)
  })

  // 4：記下 session 名稱。
  on('classic.SessionStart', async ($, e, next) => {
    if (typeof e.session_title === 'string') sessionTitle = e.session_title
    return next(e)
  })

  // 4：送給 ALICE 的訊息直接送進 Core。
  on('session.send', async ($, e, next) => {
    const config = await loadConfig($)
    const alice = config.alice
    if (!alice?.name || String(e.to).trim() !== alice.name) return next(e)
    try {
      const token = (await $.fs.read(alice.tokenPath)).trim()
      const name = senderName(sessionTitle, await $.session.cwd())
      const response = await $.http.fetch(`${alice.url ?? 'http://127.0.0.1:7788'}/api/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-alice-client': 'alice-guard' },
        body: JSON.stringify(peerRequest(name, String(e.text), crypto.randomUUID())),
      })
      if (response.ok) {
        $.ui.log(`已直接送進 ALICE（Core），寄件人「${name}」；回覆在 Web Studio`)
        return { isDelivered: true }
      }
      $.ui.log(`Core 拒收（HTTP ${response.status}），改送轉接 session`)
    } catch (error) {
      $.ui.log(`Core 連不上（${error instanceof Error ? error.message : String(error)}），改送轉接 session`)
    }
    return next(e)
  })

  // 3：第一則訊息的背景資料加上角色頁。
  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    const config = await loadConfig($)
    const role = roleFor(await $.session.cwd(), config)
    if (role === undefined) return result
    let page
    try {
      page = await $.fs.read(role.page)
    } catch {
      $.ui.log(`找不到角色頁：${role.page}`)
      return result
    }
    const text = [
      `這個 session 的角色是〈${role.name}〉。以下是知識庫的角色頁（alice-guard 自動帶入，開工時不必再讀一次這頁；頁中列的其他必讀頁照常讀）：`,
      '',
      page,
    ].join('\n')
    return { ...result, blocks: [...result.blocks, { name: 'aliceRole', text }] }
  })
}
