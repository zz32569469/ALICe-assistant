#!/usr/bin/env node
'use strict';

// 健康檢查（§29）：逐項列出 Alice 在這台電腦缺什麼、怎麼補。
//   node scripts/doctor.cjs [--json]
// 有任何 ❌ 時結束碼為 1；⚠ 只提醒。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..');
const MIN_NODE = [20, 19, 0];

function versionAtLeast(version, minimum) {
  const parts = version.replace(/^v/u, '').split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if ((parts[index] ?? 0) > minimum[index]) return true;
    if ((parts[index] ?? 0) < minimum[index]) return false;
  }
  return true;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 20_000, ...options });
  return { ok: result.status === 0, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

async function check(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const checks = [];
  const add = (level, item, detail, fix) => checks.push({ level, item, detail, ...(fix ? { fix } : {}) });

  // 1. Node
  const nodeVersion = options.nodeVersion ?? process.version;
  if (versionAtLeast(nodeVersion, MIN_NODE)) add('ok', 'Node.js', nodeVersion);
  else add('error', 'Node.js', `${nodeVersion} 太舊`, `安裝 Node.js ${MIN_NODE.join('.')} 以上`);

  // 2. 建置
  const coreDist = path.join(root, 'core', 'dist', 'src', 'main.js');
  if (!fs.existsSync(path.join(root, 'core', 'node_modules'))) add('error', 'Core 相依套件', '尚未安裝', 'node scripts/setup.cjs（或 cd core && npm install）');
  else if (!fs.existsSync(coreDist)) add('error', 'Core 建置', '尚未建置', 'cd core && npm run build');
  else add('ok', 'Core 建置', path.relative(root, coreDist));
  if (!fs.existsSync(path.join(root, 'studio', 'dist', 'index.html'))) add('warn', 'Web Studio', '尚未建置，瀏覽器介面無法使用', 'cd studio && npm install && npm run build');
  else add('ok', 'Web Studio', '已建置');

  // 3. 本機設定
  const localPath = path.join(root, 'alice.local.json');
  let local;
  if (!fs.existsSync(localPath)) {
    add('error', '本機設定', 'alice.local.json 不存在：知識庫摘要與部下都會停用', 'node scripts/setup.cjs --kb <知識庫路徑>，或照 alice.local.example.json 自己建立');
  } else if (fs.existsSync(coreDist)) {
    try {
      const { loadLocalConfig } = await import(pathToFileURL(path.join(root, 'core', 'dist', 'src', 'localConfig.js')).href);
      local = loadLocalConfig(localPath, () => undefined);
      if (local.reasons.length === 0) add('ok', '本機設定', `${local.projects.length} 個專案`);
      else for (const reason of local.reasons) add('error', '本機設定', reason, '照 docs/本機設定.md 修正 alice.local.json');
    } catch (error) {
      add('error', '本機設定', `無法讀取：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    add('warn', '本機設定', 'Core 尚未建置，無法完整檢查格式');
  }

  // 4. 路徑：知識庫、摘要頁、角色頁、專案、readDirs、watchPaths
  if (local?.knowledgeBase) {
    const kb = local.knowledgeBase;
    if (!fs.existsSync(kb.path)) add('error', '知識庫', `資料夾不存在：${kb.path}`, 'node scripts/setup-kb.cjs --kb <路徑> 建立空知識庫，或修正 knowledgeBase.path');
    else {
      add('ok', '知識庫', kb.path);
      const summary = path.join(kb.path, kb.summaryPage);
      if (!fs.existsSync(summary)) add('warn', '艾莉絲摘要', `找不到 ${kb.summaryPage}：艾莉絲回覆時沒有知識庫摘要`, '請知識庫管理員建立這一頁');
      const rolesDir = path.join(kb.path, kb.rolesDir);
      for (const project of local.projects) {
        const rolePage = path.join(rolesDir, `${project.role}.md`);
        if (!fs.existsSync(rolePage)) add('error', `角色頁：${project.role}`, `找不到 ${path.relative(kb.path, rolePage)}；部下無法用這個角色`, `在 ${kb.rolesDir} 建立「${project.role}.md」，或改 projects 的 role`);
      }
    }
  }
  for (const project of local?.projects ?? []) {
    if (!fs.existsSync(project.path)) {
      add('error', `專案：${project.name}`, `資料夾不存在：${project.path}`, '修正 alice.local.json 的 path');
      continue;
    }
    const problems = [];
    for (const dir of project.readDirs ?? []) if (!fs.existsSync(dir)) problems.push(`readDirs 不存在：${dir}`);
    for (const watch of project.watchPaths ?? []) if (!fs.existsSync(path.resolve(project.path, watch))) problems.push(`watchPaths 不存在：${watch}`);
    if (project.writable && !fs.existsSync(path.join(project.path, '.git'))) problems.push('writable 專案必須是 git repo（Core 用 git 快照驗收）');
    if (problems.length === 0) add('ok', `專案：${project.name}`, `${project.role}${project.writable ? '・可修改' : ''}${project.session ? `・session ${project.session}` : ''}`);
    else for (const problem of problems) add('warn', `專案：${project.name}`, problem);
  }

  // 5. 個人事實檔
  if (!fs.existsSync(path.join(root, 'memory', 'facts.md'))) add('warn', '事實檔', 'memory/facts.md 不存在：艾莉絲不知道你的長期偏好', '複製 memory/facts.example.md 成 memory/facts.md 後填寫');
  else add('ok', '事實檔', 'memory/facts.md');

  // 6. 登入（只用訂閱，不設 API 金鑰）
  if (!options.skipLogin) {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY']) {
      if (process.env[key]) add('warn', `環境變數 ${key}`, '已設定；本專案只用訂閱登入，Core 啟動子行程時會移除它，但建議刪除', '從系統環境變數移除');
    }
    const claude = run('claude', ['auth', 'status']);
    if (claude.error || !claude.ok) add('error', 'Claude Code', '找不到 claude 指令或尚未登入', '安裝 Claude Code，執行 claude 後用 claude.ai 帳號登入');
    else {
      // 與 Core 啟動檢查相同：authMethod 必須是 claude.ai（訂閱），不能是 API 金鑰。
      let status;
      try {
        status = JSON.parse(claude.stdout);
      } catch {
        status = undefined;
      }
      if (status?.loggedIn === true && status.authMethod === 'claude.ai') add('ok', 'Claude Code', `已用訂閱登入（${status.subscriptionType ?? '方案未知'}）`);
      else add('error', 'Claude Code', `不是訂閱登入（authMethod：${status?.authMethod ?? '無法判斷'}），Core 會拒絕啟動`, '執行 claude 後用 claude.ai 帳號重新登入，不要用 API 金鑰');
    }
    if (local?.codexAvailable) {
      const codex = run('codex', ['login', 'status']);
      if (codex.error || !codex.ok) add('warn', 'Codex', '設定為可用，但找不到 codex 或尚未登入；寫程式會改由 Claude 執行', 'codex login，或把 codex.available 設為 false');
      else add('ok', 'Codex', 'ChatGPT 訂閱登入');
    } else add('ok', 'Codex', '未使用（寫程式由 Claude 執行）');
  }

  // 7. alice-guard mod（§52、§59）：Claude Code 版本、本機設定、每個 session 都載入。
  const modDir = path.join(root, 'mods', 'alice-guard');
  if (fs.existsSync(modDir)) {
    const guardPath = path.join(modDir, 'guard.local.json');
    let guard;
    if (!fs.existsSync(guardPath)) add('warn', 'alice-guard 設定', 'mods/alice-guard/guard.local.json 不存在：守門規則與直接傳給 ALICE 都不作用', '複製 guard.example.json 成 guard.local.json 後填寫');
    else {
      try {
        guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
        add('ok', 'alice-guard 設定', `團隊 repo ${(guard.teamRepos ?? []).length} 個、角色頁 ${(guard.roles ?? []).length} 個${guard.alice?.name ? `、傳給 ${guard.alice.name} 直送 Core` : ''}`);
      } catch (error) {
        add('error', 'alice-guard 設定', `guard.local.json 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`, '照 guard.example.json 修正');
      }
    }
    for (const role of guard?.roles ?? []) if (role.page && !fs.existsSync(role.page)) add('warn', `alice-guard 角色頁：${role.name}`, `找不到 ${role.page}`, '修正 guard.local.json 的 roles[].page');
    if (guard?.alice?.tokenPath && !fs.existsSync(guard.alice.tokenPath)) add('warn', 'alice-guard 直送 Core', `找不到 token：${guard.alice.tokenPath}`, '先啟動一次 Core（會建立 token），或修正 alice.tokenPath');
    const settingsPath = options.settingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
    let pluginDirs = '';
    try {
      pluginDirs = String(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).env?.CLAUDE_CODE_PLUGIN_DIRS ?? '');
    } catch {
      pluginDirs = '';
    }
    const normalize = (value) => path.resolve(value).toLowerCase();
    if (pluginDirs.split(path.delimiter).some((dir) => dir.trim() !== '' && normalize(dir.trim()) === normalize(modDir))) add('ok', 'alice-guard 載入', '每個 Claude Code session 都會載入');
    else add('warn', 'alice-guard 載入', '~/.claude/settings.json 的 env.CLAUDE_CODE_PLUGIN_DIRS 沒有指向 mods/alice-guard', `在 env 加 "CLAUDE_CODE_PLUGIN_DIRS": "${modDir.replace(/\\/g, '\\\\')}"`);
    if (!options.skipLogin) {
      const version = run('claude', ['--version']);
      const match = /(\d+)\.(\d+)\.(\d+)/u.exec(version.stdout ?? '');
      if (match && versionAtLeast(`v${match[1]}.${match[2]}.${match[3]}`, [2, 1, 287])) add('ok', 'Claude Code 版本', `${match[0]}（支援 mods）`);
      else add('warn', 'Claude Code 版本', `${match ? match[0] : '無法判斷'}；mods 需要 2.1.287 以上`, 'claude update；桌面 App 要更新 App 本身');
    }
  }

  // 8. 轉接 session（選用，§62 起不需要）
  if (fs.existsSync(path.join(root, 'relay', 'CLAUDE.md'))) add('ok', '轉接 session', '選用：同事傳給 ALICE 已由 alice-guard 直送 Core；只有想在手機 Claude App 找 ALICE 時才需要開（資料夾 relay/）');

  return checks;
}

const ICON = { ok: '✅', warn: '⚠ ', error: '❌' };

async function main() {
  const checks = await check();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(checks, null, 2));
  } else {
    for (const entry of checks) {
      console.log(`${ICON[entry.level]} ${entry.item}：${entry.detail}`);
      if (entry.fix) console.log(`     → ${entry.fix}`);
    }
    const errors = checks.filter((entry) => entry.level === 'error').length;
    const warnings = checks.filter((entry) => entry.level === 'warn').length;
    console.log(`\n健康檢查：${errors} 個錯誤、${warnings} 個提醒`);
  }
  process.exitCode = checks.some((entry) => entry.level === 'error') ? 1 : 0;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`健康檢查失敗：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { check, versionAtLeast };
