#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const { EMPTY_VAULT_DIRS, main } = require('./setup-kb.cjs');
const { scanCompanyTerms } = require('./check-company-terms.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_ROOT = path.join(REPO_ROOT, 'kb-template');

function makeTemp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alice-kb-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function allFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? allFiles(full) : [full];
  });
}

function baseArgs(root) {
  return [
    '--kb', path.join(root, 'vault'),
    '--workspace', path.join(root, 'workspace'),
    '--claude-home', path.join(root, 'claude-home'),
    '--codex-home', path.join(root, 'codex-home'),
    '--install-claude', 'yes',
    '--global-claude-md', 'yes',
    '--codex', 'yes',
    '--yes',
  ];
}

function runtime(root, lines = []) {
  return {
    repoRoot: path.join(root, 'alice'),
    templateRoot: TEMPLATE_ROOT,
    home: path.join(root, 'profile'),
    now: new Date(2026, 8, 30),
    output: line => lines.push(line),
    prompt: async () => { throw new Error('測試不應進入互動詢問'); },
  };
}

// 測試全新環境會產生完整 vault 與設定，並避免遺留未替換的佔位符。
test('全新目錄建立完整結構', async t => {
  const root = makeTemp(t);
  fs.mkdirSync(path.join(root, 'alice'), { recursive: true });
  await main(baseArgs(root), runtime(root));

  const expected = [
    'CLAUDE.md',
    'wiki/index.md',
    'wiki/AI 協作/角色/知識庫管理員.md',
    '.obsidian/app.json',
    ...EMPTY_VAULT_DIRS.map(relative => `${relative}/.gitkeep`),
  ];
  for (const relative of expected) {
    assert.equal(fs.existsSync(path.join(root, 'vault', relative)), true, relative);
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'vault', '.obsidian', 'app.json'), 'utf8')),
    { userIgnoreFilters: ['_meta/archive/'] },
  );

  const producedRoots = [
    path.join(root, 'vault'),
    path.join(root, 'claude-home'),
    path.join(root, 'codex-home'),
    path.join(root, 'alice'),
  ];
  for (const file of producedRoots.flatMap(allFiles)) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /\{\{[^}]+\}\}/, file);
  }
});

// 測試部分既有的 vault 只補齊缺少檔案，不會改寫使用者內容。
test('既有檔案保持不變並列入略過清單', async t => {
  const root = makeTemp(t);
  const vault = path.join(root, 'vault');
  fs.mkdirSync(path.join(vault, 'wiki'), { recursive: true });
  fs.mkdirSync(path.join(root, 'alice'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'CLAUDE.md'), '自訂 schema\n');
  fs.writeFileSync(path.join(vault, 'wiki', 'index.md'), '自訂 index\n');

  const result = await main(baseArgs(root), runtime(root));
  assert.equal(fs.readFileSync(path.join(vault, 'CLAUDE.md'), 'utf8'), '自訂 schema\n');
  assert.equal(fs.readFileSync(path.join(vault, 'wiki', 'index.md'), 'utf8'), '自訂 index\n');
  assert.equal(result.skipped.includes(path.join(vault, 'CLAUDE.md')), true);
  assert.equal(result.skipped.includes(path.join(vault, 'wiki', 'index.md')), true);
});

// 測試 dry-run 只回報規劃動作，不在任何目標位置建立檔案或資料夾。
test('dry-run 不產生檔案', async t => {
  const root = makeTemp(t);
  const args = [...baseArgs(root), '--dry-run'];
  const result = await main(args, runtime(root));

  assert.ok(result.created.length > 0);
  for (const target of ['vault', 'claude-home', 'codex-home', 'alice']) {
    assert.equal(fs.existsSync(path.join(root, target)), false, target);
  }
});

// 測試 Claude 元件能安裝到指定 home，且既有全域指引不會被範本覆蓋。
test('安裝 skills 與 scripts 且不覆寫 CLAUDE.md', async t => {
  const root = makeTemp(t);
  const claudeHome = path.join(root, 'claude-home');
  fs.mkdirSync(claudeHome, { recursive: true });
  fs.mkdirSync(path.join(root, 'alice'), { recursive: true });
  fs.writeFileSync(path.join(claudeHome, 'CLAUDE.md'), '保留我\n');

  const result = await main(baseArgs(root), runtime(root));
  assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'kb', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(claudeHome, 'scripts', 'codex-delegate.mjs')), true);
  assert.equal(fs.existsSync(path.join(claudeHome, 'scripts', 'codex-board', 'server.mjs')), true);
  assert.equal(fs.readFileSync(path.join(claudeHome, 'CLAUDE.md'), 'utf8'), '保留我\n');
  assert.equal(result.skipped.includes(path.join(claudeHome, 'CLAUDE.md')), true);
});

// 測試看板在沒有角色設定時安全回傳空值，有設定時才依資料夾名稱對應。
test('看板角色設定可缺省並正確對應', async t => {
  const root = makeTemp(t);
  const modulePath = path.join(TEMPLATE_ROOT, 'claude', 'scripts', 'codex-board', 'roles.mjs');
  const { findRoleForDirectory, readRoles } = await import(pathToFileURL(modulePath).href);
  const missing = path.join(root, 'roles.json');

  assert.deepEqual(readRoles(missing), []);
  assert.equal(findRoleForDirectory(path.join(root, 'alpha'), readRoles(missing)), '');
  fs.writeFileSync(missing, JSON.stringify([{ folder: 'alpha', role: '專案工程師' }]));
  assert.equal(findRoleForDirectory(path.join(root, 'alpha', 'src'), readRoles(missing)), '專案工程師');
  // 手動 worktree「<資料夾>-<名稱>」也算；只是開頭相同的別的資料夾不算。
  assert.equal(findRoleForDirectory(path.join(root, 'worktree', 'alpha-feature', 'src'), readRoles(missing)), '專案工程師');
  assert.equal(findRoleForDirectory(path.join(root, 'alphabet'), readRoles(missing)), '');
});

// 測試可攜範本與設定腳本不夾帶指定的組織專屬詞彙。
test('公司字眼檢查為零', () => {
  const hits = scanCompanyTerms([path.join(REPO_ROOT, 'kb-template'), path.join(REPO_ROOT, 'scripts')]);
  assert.deepEqual(hits, []);
});

function autoArgs(root) {
  const args = baseArgs(root);
  const codexIndex = args.indexOf('--codex');
  args.splice(codexIndex, 2);
  return args;
}

function assertWithoutCodex(root) {
  const claudeHome = path.join(root, 'claude-home');
  assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'kb', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(claudeHome, 'skills', 'grilling', 'SKILL.md')), true);
  for (const skill of ['delegate', 'board', 'codex-usage']) {
    assert.equal(fs.existsSync(path.join(claudeHome, 'skills', skill)), false, skill);
  }
  assert.equal(fs.existsSync(path.join(claudeHome, 'scripts')), false);
  assert.equal(fs.existsSync(path.join(root, 'codex-home', 'AGENTS.md')), false);
  const local = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'alice.local.json'), 'utf8'));
  assert.deepEqual(local.codex, { available: false });
  // 新電腦實測（2026-10-01）：少了 rolesDir、projects 時 Core 會停用知識庫摘要與部下。
  assert.equal(local.knowledgeBase.rolesDir, 'wiki/AI 協作/角色');
  assert.equal(local.projects[0].role, '知識庫管理員');
  assert.equal(local.projects[0].path, local.knowledgeBase.path);
}

// 測試自動偵測到 ChatGPT 登入的 Codex 時，會安裝全部委派工具並記錄為可用。
test('自動偵測到 Codex 時安裝完整工具', async t => {
  const root = makeTemp(t);
  fs.mkdirSync(path.join(root, 'alice'), { recursive: true });
  let calls = 0;
  const testRuntime = runtime(root);
  testRuntime.detectCodex = () => {
    calls += 1;
    return { available: true };
  };

  await main(autoArgs(root), testRuntime);

  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(root, 'claude-home', 'skills', 'delegate', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'claude-home', 'scripts', 'codex-delegate.mjs')), true);
  assert.equal(fs.existsSync(path.join(root, 'codex-home', 'AGENTS.md')), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'alice', 'alice.local.json'), 'utf8')).codex,
    { available: true },
  );
});

// 測試未安裝 Codex 時只保留 Claude Code 可獨立使用的兩個 skill，並輸出原因。
test('自動偵測未安裝 Codex 時略過專用工具', async t => {
  const root = makeTemp(t);
  const lines = [];
  fs.mkdirSync(path.join(root, 'alice'), { recursive: true });
  let calls = 0;
  const testRuntime = runtime(root, lines);
  testRuntime.detectCodex = () => {
    calls += 1;
    return { available: false, reason: '未安裝' };
  };

  await main(autoArgs(root), testRuntime);

  assert.equal(calls, 1);
  assertWithoutCodex(root);
  assert.equal(lines.includes('Codex 偵測：未安裝'), true);
  assert.equal(lines.some(line => line.startsWith('未偵測到 Codex：')), true);
});

// 測試 Codex 未登入時同樣略過專用工具，並把未登入原因寫入輸出。
test('自動偵測 Codex 未登入時略過專用工具', async t => {
  const root = makeTemp(t);
  const lines = [];
  fs.mkdirSync(path.join(root, 'alice'), { recursive: true });
  let calls = 0;
  const testRuntime = runtime(root, lines);
  testRuntime.detectCodex = () => {
    calls += 1;
    return { available: false, reason: '未登入' };
  };

  await main(autoArgs(root), testRuntime);

  assert.equal(calls, 1);
  assertWithoutCodex(root);
  assert.equal(lines.includes('Codex 偵測：未登入'), true);
});

// 測試明確停用 Codex 時不執行任何偵測，且仍完成 Claude Code 基本安裝。
test('--codex no 不呼叫偵測函式', async t => {
  const root = makeTemp(t);
  fs.mkdirSync(path.join(root, 'alice'), { recursive: true });
  let calls = 0;
  const testRuntime = runtime(root);
  testRuntime.detectCodex = () => {
    calls += 1;
    throw new Error('不應呼叫 Codex 偵測');
  };

  await main([...autoArgs(root), '--codex', 'no'], testRuntime);

  assert.equal(calls, 0);
  assertWithoutCodex(root);
});
