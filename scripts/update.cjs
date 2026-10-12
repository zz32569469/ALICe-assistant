#!/usr/bin/env node
'use strict';

// 一鍵更新（§29）：
//   node scripts/update.cjs [--no-pull]
// git pull（只允許快轉）→ 依變動的檔案重裝套件、重新建置 Core 與 Web Studio → 健康檢查 → 提醒要重啟或重開什麼。

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const { check } = require('./doctor.cjs');

const repoRoot = path.resolve(__dirname, '..');

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失敗：${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

function step(title, command, args, cwd) {
  console.log(`\n▶ ${title}`);
  // 只有 npm 需要 shell（Windows 上是 npm.cmd）；node 的路徑含空白（C:\Program Files），走 shell 會被拆開（新電腦實測）。
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  if (result.status !== 0) throw new Error(`${title}失敗（結束碼 ${result.status}）`);
}

/** 依變動的檔案決定要做哪些事（匯出供測試）。 */
function planUpdate(changed, options = {}) {
  const touched = (prefix) => changed.some((file) => file.startsWith(prefix));
  const packageChanged = (dir) => changed.some((file) => file === `${dir}/package.json` || file === `${dir}/package-lock.json`);
  const all = options.rebuildAll === true;
  return {
    installCore: all || packageChanged('core'),
    buildCore: all || touched('core/'),
    installStudio: all || packageChanged('studio'),
    buildStudio: all || touched('studio/'),
    restartCore: touched('core/') || touched('persona/') || all,
    reopenRelay: touched('relay/'),
    reopenSessions: touched('mods/'),
    kbTemplate: touched('kb-template/'),
  };
}

async function main() {
  const noPull = process.argv.includes('--no-pull');
  let changed = [];
  if (!noPull) {
    const dirty = git(['status', '--porcelain', '--untracked-files=no']);
    if (dirty !== '') throw new Error(`有未提交的改動，先處理再更新：\n${dirty}`);
    const before = git(['rev-parse', 'HEAD']);
    console.log('▶ git pull --ff-only');
    git(['pull', '--ff-only']);
    const after = git(['rev-parse', 'HEAD']);
    if (before === after) console.log('  已是最新版本');
    else {
      changed = git(['diff', '--name-only', before, after]).split(/\r?\n/u).filter(Boolean);
      console.log(`  ${before.slice(0, 7)} → ${after.slice(0, 7)}，${changed.length} 個檔案有變動`);
    }
  }
  const plan = planUpdate(changed, { rebuildAll: noPull });
  if (plan.installCore) step('安裝 Core 相依套件', 'npm', ['install'], path.join(repoRoot, 'core'));
  if (plan.buildCore) step('建置 Core', 'npm', ['run', 'build'], path.join(repoRoot, 'core'));
  if (plan.installStudio) step('安裝 Web Studio 相依套件', 'npm', ['install'], path.join(repoRoot, 'studio'));
  if (plan.buildStudio) step('建置 Web Studio', 'npm', ['run', 'build'], path.join(repoRoot, 'studio'));

  console.log('\n▶ 健康檢查');
  const checks = await check({ skipLogin: true });
  const problems = checks.filter((entry) => entry.level !== 'ok');
  for (const entry of problems) {
    console.log(`${entry.level === 'error' ? '❌' : '⚠ '} ${entry.item}：${entry.detail}`);
    if (entry.fix) console.log(`     → ${entry.fix}`);
  }
  if (problems.length === 0) console.log('  全部通過');

  const reminders = [
    plan.restartCore ? '重啟 Core（停掉正在跑的，再 cd core && npm start），新版才會生效' : '',
    plan.buildStudio && !plan.restartCore ? '已開著的 Web Studio 重新整理一次' : '',
    plan.reopenRelay ? '轉接規則有更新：有在用轉接 session（資料夾 relay/）的話，關掉再重開一個' : '',
    plan.reopenSessions ? 'alice-guard 有更新：已開著的 Claude Code session 重開才會載入新版（新開的 session 自動載入）' : '',
    plan.kbTemplate ? '知識庫範本有更新：既有知識庫不會自動改；需要時參考 kb-template/ 手動同步，或請知識庫管理員處理' : '',
  ].filter(Boolean);
  if (reminders.length > 0) console.log(`\n要做的事：\n${reminders.map((line, index) => `${index + 1}. ${line}`).join('\n')}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`\n更新失敗：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = { planUpdate };
