// alice-guard 規則測試：node mods/alice-guard/tests/rules.test.mjs
// rules.js 是給 Claude Code 載入的 ES module，這裡用 data: URL 匯入，不需要 package.json。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../hooks/rules.js', import.meta.url), 'utf8')
const rules = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

const config = {
  teamRepos: ['team-a', 'team-b'],
  vault: 'C:/Vault/kb',
  roles: [
    { name: '管理員', path: 'C:/Vault/kb', page: 'C:/Vault/kb/roles/manager.md' },
    { name: '工具', repo: 'team-a', page: 'C:/Vault/kb/roles/a.md' },
  ],
}

test('team repo detection: session folder, worktree, copy, or cd in the command', () => {
  assert.equal(rules.inTeamRepo('C:\\work\\team-a', 'git status', config), true)
  assert.equal(rules.inTeamRepo('C:/work/team-a/.claude/worktrees/x', 'git status', config), true)
  assert.equal(rules.inTeamRepo('C:/work/team-a-verify', 'git status', config), true)
  assert.equal(rules.inTeamRepo('C:/work/alice', 'cd ../team-b && git commit -m x', config), true)
  assert.equal(rules.inTeamRepo('C:/work/alice', 'git -C "C:/work/team-b" push', config), true)
  assert.equal(rules.inTeamRepo('C:/work/alice', 'git commit -m "team-abc"', config), false)
  assert.equal(rules.inTeamRepo('C:/work/alice', 'git push', config), false)
  assert.equal(rules.inTeamRepo('C:/work/team-a', 'x', {}), false)
})

test('co-author trailer in a commit', () => {
  assert.equal(rules.hasCoAuthor('git commit -m "fix\n\nCo-Authored-By: Claude <x>"'), true)
  assert.equal(rules.hasCoAuthor("git commit -F - <<'EOF'\nfix\nco-authored-by: a\nEOF"), true)
  assert.equal(rules.hasCoAuthor('git commit -m "fix"'), false)
})

test('risky git commands', () => {
  for (const command of [
    'git reset --hard HEAD~1', 'git checkout -- src/a.ts', 'git checkout .', 'git checkout -f main',
    'git restore src/a.ts', 'git restore --staged --worktree a', 'git clean -fd', 'git branch -D old',
    'git stash drop', 'git rebase main', 'git push origin feature', 'cd x && git push',
  ]) assert.notEqual(rules.riskyGit(command), undefined, command)
  for (const command of [
    'git status', 'git checkout -b feature', 'git checkout main', 'git restore --staged a.ts',
    'git commit -m x', 'git branch -d merged', 'git stash', 'git log --oneline', 'git diff',
  ]) assert.equal(rules.riskyGit(command), undefined, command)
})

test('vault writes from the shell', () => {
  assert.equal(rules.shellWritesVault('echo x > "C:/Vault/kb/wiki/a.md"', config.vault), true)
  assert.equal(rules.shellWritesVault('cp a.md C:\\Vault\\kb\\wiki\\', config.vault), true)
  assert.equal(rules.shellWritesVault('Set-Content -Path C:/Vault/kb/a.md -Value x', config.vault), true)
  assert.equal(rules.shellWritesVault('git -C C:/Vault/kb commit -m x', config.vault), true)
  assert.equal(rules.shellWritesVault('cat "C:/Vault/kb/wiki/index.md"', config.vault), false)
  assert.equal(rules.shellWritesVault('grep -rn TODO C:/Vault/kb/wiki 2>&1', config.vault), false)
  assert.equal(rules.shellWritesVault('echo x > out.md', config.vault), false)
  assert.equal(rules.shellWritesVault('echo x > /c/vault/kb/a.md', undefined), false)
})

test('file paths inside the vault', () => {
  assert.equal(rules.isInside('c:\\vault\\KB\\wiki\\a.md', config.vault), true)
  assert.equal(rules.isInside('C:/Vault/kb', config.vault), true)
  assert.equal(rules.isInside('C:/Vault/kb2/a.md', config.vault), false)
  assert.equal(rules.editedPath({ file_path: 'a' }), 'a')
  assert.equal(rules.editedPath({ notebook_path: 'b' }), 'b')
})

test('role by session folder', () => {
  assert.equal(rules.roleFor('C:/Vault/kb', config)?.name, '管理員')
  assert.equal(rules.roleFor('C:/work/team-a/.claude/worktrees/x', config)?.name, '工具')
  assert.equal(rules.roleFor('C:/work/alice', config), undefined)
})

test('message to ALICE: sender name and request body', () => {
  assert.equal(rules.senderName('Some App - dev', 'C:/w/x'), 'Some App - dev')
  assert.equal(rules.senderName('', 'C:/work/Team-A'), 'team-a')
  assert.equal(rules.senderName('壞〉名\n字', 'C:/w'), '壞 名 字')
  assert.equal(rules.senderName(undefined, ''), '同事 session')
  const body = rules.peerRequest('Lib', '【進度】測試專案\nT1 完成', 'id1')
  assert.deepEqual(body, { clientMsgId: 'id1', clientId: 'session:Lib', text: '［來自 session〈Lib〉］\n【進度】測試專案\nT1 完成' })
})
