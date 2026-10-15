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

// 分支守衛：本款由 session 名稱認出，games 表給各款在各 repo 的分支。
const games = {
  'Alpha Quest': { 'team-a': 'brandx/alphaQuest', 'team-b': 'feature/alpha' },
  'Beta Rush': { 'team-a': 'brandx/betaRush' },
}
const others = rules.otherBranches(games, 'team-a', 'Alpha Quest')
const call = (command) => rules.gitCalls(command)[0]

test('branch guard: session name and repo lookup', () => {
  assert.equal(rules.gameNameOf('Alpha Quest - dev'), 'Alpha Quest')
  assert.equal(rules.gameNameOf('Alpha Quest - dev 2'), 'Alpha Quest')
  assert.equal(rules.gameNameOf('Library'), undefined)
  assert.equal(rules.findGame('alpha quest', games), 'Alpha Quest')
  assert.equal(rules.findGame('Gamma', games), undefined)
  assert.equal(rules.repoInPath('C:/work/worktree/team-a-beta/src', ['team-a', 'team-b']), 'team-a')
  assert.equal(rules.repoInPath('C:/work/team-a/team-b', ['team-a', 'team-b']), 'team-b')
  assert.equal(rules.repoInPath('C:/work/alice', ['team-a']), undefined)
  assert.deepEqual([...others], [['brandx/betaRush', 'Beta Rush']])
  assert.deepEqual(rules.gitCalls('cd ../team-a && git -C "C:/x y/team-a" commit -m "a; b"'), [{ dir: 'C:/x y/team-a', sub: 'commit', args: ['-m', 'a; b'] }])
  assert.deepEqual(rules.gitCalls('cd ../team-a && git status')[0].dir, '../team-a')
})

test('branch guard: writes on the own branch pass, writes on another game are blocked', () => {
  // 本款分支：都放行
  for (const command of ['git commit -m x', 'git push origin brandx/alphaQuest', 'git tag brandx/alphaQuest/v1.0.0.1', 'git merge main', 'git checkout brandx/alphaQuest']) {
    assert.equal(rules.branchViolation(call(command), 'brandx/alphaQuest', others), undefined, command)
  }
  // 目前在別款分支：寫入擋
  for (const command of ['git commit -m x', 'git merge main', 'git rebase main', 'git cherry-pick abc123', 'git push', 'git tag v1']) {
    assert.match(rules.branchViolation(call(command), 'brandx/betaRush', others) ?? '', /Beta Rush/, command)
  }
  // 目標是別款：擋
  for (const command of ['git checkout brandx/betaRush', 'git switch origin/brandx/betaRush', 'git merge brandx/betaRush', 'git push origin brandx/betaRush', 'git push origin HEAD:refs/heads/brandx/betaRush', 'git push origin brandx/betaRush/v1.0.0.1', 'git tag brandx/betaRush/v2 HEAD', 'git tag v9 brandx/betaRush']) {
    assert.match(rules.branchViolation(call(command), 'brandx/alphaQuest', others) ?? '', /Beta Rush/, command)
  }
})

test('branch guard: reads, file checkout, new branches, aborts and unlisted branches pass', () => {
  for (const command of [
    'git show brandx/betaRush:src/a.ts', 'git diff brandx/betaRush', 'git log brandx/betaRush', 'git blame a.ts',
    'git checkout brandx/betaRush -- src/a.ts', 'git checkout brandx/betaRush src/a.ts', 'git checkout -b brandx/gamma brandx/betaRush',
    'git checkout main', 'git checkout backup/old', 'git tag -l', 'git tag', 'git push origin main',
  ]) {
    const parsed = call(command)
    assert.equal(rules.branchViolation(parsed, 'brandx/alphaQuest', others), undefined, command)
  }
  for (const command of ['git rebase --abort', 'git merge --abort', 'git cherry-pick --abort']) {
    assert.equal(rules.branchViolation(call(command), 'brandx/betaRush', others), undefined, command)
  }
  // 查不到目前分支（detached）：只看目標
  assert.equal(rules.branchViolation(call('git commit -m x'), undefined, others), undefined)
  // 只讀的子指令不在需要查分支的清單
  assert.equal(rules.BRANCH_WRITES.includes('show'), false)
  // games 表沒有本款（session 名稱對不到）時，別款清單就是全部，由 register 決定不擋只提示
  assert.equal(rules.findGame(rules.gameNameOf('Library'), games), undefined)
})
