#!/usr/bin/env node
'use strict';

// 新電腦一鍵安裝（§29）：
//   node scripts/setup.cjs --kb <知識庫路徑> [--skip-kb] [--claude-home <路徑>] [--codex-home <路徑>] [--codex auto|yes|no] [--yes]
// 依序：檢查 Node → 安裝並建置 Core、Web Studio → 建知識庫與本機設定（已有本機設定就略過）→ 複製事實檔範例 → 健康檢查。
// 已存在的檔案一律不覆寫。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline/promises');

const { check, versionAtLeast } = require('./doctor.cjs');

const repoRoot = path.resolve(__dirname, '..');
const KB_PASSTHROUGH = ['--kb', '--claude-home', '--codex-home', '--codex', '--workspace', '--install-claude', '--global-claude-md'];

function parseArgs(argv) {
  const options = { passthrough: [], skipKb: false, yes: false, kb: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-kb') options.skipKb = true;
    else if (arg === '--yes') {
      options.yes = true;
      options.passthrough.push(arg);
    } else if (KB_PASSTHROUGH.includes(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一個值`);
      if (arg === '--kb') options.kb = value;
      options.passthrough.push(arg, value);
      index += 1;
    } else {
      throw new Error(`不支援的參數：${arg}`);
    }
  }
  return options;
}

function step(title, command, args, cwd) {
  console.log(`\n▶ ${title}`);
  const started = Date.now();
  // 只有 npm 需要 shell（Windows 上是 npm.cmd）；node 的路徑含空白（C:\Program Files），走 shell 會被拆開（新電腦實測）。
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && command === 'npm' });
  if (result.status !== 0) throw new Error(`${title}失敗（結束碼 ${result.status}）`);
  console.log(`  完成（${Math.round((Date.now() - started) / 1000)} 秒）`);
}

/** §84：alice.local.json 裡的知識庫路徑（還沒建立就是 undefined）。 */
function knowledgeVault(localPath) {
  try {
    const value = JSON.parse(fs.readFileSync(localPath, 'utf8')).knowledgeBase?.path;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** §84：新電腦的 guard.local.json：知識庫、知識庫管理員角色頁（知識庫範本內建）、Core 的 token 路徑（和 Core 的預設相同）。 */
function guardConfig(vault) {
  const slash = (value) => value.replace(/\\/g, '/');
  const tokenPath = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'alice', 'token')
    : path.join(os.homedir(), '.config', 'alice', 'token');
  return {
    teamRepos: [],
    vault: slash(vault),
    roles: [{ name: '知識庫管理員', path: slash(vault), page: slash(path.join(vault, 'wiki', 'AI 協作', '角色', '知識庫管理員.md')) }],
    alice: { name: 'ALICE', url: 'http://127.0.0.1:7788', tokenPath: slash(tokenPath) },
  };
}

async function askKbPath() {
  if (!process.stdin.isTTY) return undefined;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('知識庫（Obsidian vault）要建在哪個資料夾？（留空則略過）：')).trim();
    return answer === '' ? undefined : answer;
  } finally {
    rl.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!versionAtLeast(process.version, [20, 19, 0])) throw new Error(`Node.js ${process.version} 太舊，需要 20.19 以上`);
  console.log(`Node.js ${process.version}`);

  step('安裝 Core 相依套件', 'npm', ['install'], path.join(repoRoot, 'core'));
  step('建置 Core', 'npm', ['run', 'build'], path.join(repoRoot, 'core'));
  step('安裝 Web Studio 相依套件', 'npm', ['install'], path.join(repoRoot, 'studio'));
  step('建置 Web Studio', 'npm', ['run', 'build'], path.join(repoRoot, 'studio'));

  const localPath = path.join(repoRoot, 'alice.local.json');
  if (fs.existsSync(localPath)) {
    console.log('\n▶ 知識庫與本機設定：alice.local.json 已存在，略過（要重建知識庫範本請直接執行 scripts/setup-kb.cjs）');
  } else if (options.skipKb) {
    console.log('\n▶ 知識庫與本機設定：依 --skip-kb 略過；之後照 alice.local.example.json 自己建立');
  } else {
    let passthrough = options.passthrough;
    if (options.kb === undefined) {
      const kb = await askKbPath();
      if (kb === undefined) {
        console.log('\n▶ 知識庫與本機設定：沒有指定 --kb，略過；之後執行 node scripts/setup-kb.cjs --kb <路徑>');
        passthrough = undefined;
      } else {
        passthrough = [...passthrough, '--kb', kb];
      }
    }
    if (passthrough !== undefined) {
      step('建立知識庫範本與本機設定', process.execPath, [path.join(__dirname, 'setup-kb.cjs'), ...passthrough], repoRoot);
      if (!fs.existsSync(localPath)) throw new Error('知識庫步驟結束了，但沒有寫出 alice.local.json；請直接執行 node scripts/setup-kb.cjs --kb <路徑> 看錯誤訊息');
    }
  }

  const facts = path.join(repoRoot, 'memory', 'facts.md');
  if (!fs.existsSync(facts)) {
    fs.copyFileSync(path.join(repoRoot, 'memory', 'facts.example.md'), facts);
    console.log('\n▶ 已從範例建立 memory/facts.md，請填寫你的長期偏好');
  }

  const guard = path.join(repoRoot, 'mods', 'alice-guard', 'guard.local.json');
  if (!fs.existsSync(guard)) {
    const vault = knowledgeVault(localPath);
    if (vault === undefined) {
      fs.copyFileSync(path.join(repoRoot, 'mods', 'alice-guard', 'guard.example.json'), guard);
      console.log('\n▶ 已從範例建立 mods/alice-guard/guard.local.json，請填團隊 repo、知識庫路徑、角色頁與 Core 的 token 路徑');
    } else {
      fs.writeFileSync(guard, `${JSON.stringify(guardConfig(vault), null, 2)}\n`);
      console.log('\n▶ 已建立 mods/alice-guard/guard.local.json（知識庫、知識庫管理員角色頁與 Core 的 token 路徑已填好；團隊 repo 與其他角色之後照 guard.example.json 補）');
    }
  }

  console.log('\n▶ 健康檢查');
  const checks = await check();
  for (const entry of checks) {
    if (entry.level === 'ok') continue;
    console.log(`${entry.level === 'error' ? '❌' : '⚠ '} ${entry.item}：${entry.detail}`);
    if (entry.fix) console.log(`     → ${entry.fix}`);
  }
  const errors = checks.filter((entry) => entry.level === 'error').length;
  console.log(errors === 0 ? '  全部通過（提醒項目可之後處理）' : `  有 ${errors} 個錯誤，請先處理再啟動`);

  console.log([
    '',
    '下一步：',
    '1. 啟動 Core：cd core && npm start',
    '2. 另開終端開 Web Studio：cd core && npm run studio',
    '3. 啟用 alice-guard（守門規則、自動帶入角色頁、同事直接傳給 ALICE）：在 ~/.claude/settings.json 的 env 設 CLAUDE_CODE_PLUGIN_DIRS 為 mods/alice-guard 的絕對路徑（見 mods/alice-guard/README.md）',
    '4. 要用手機或其他電腦開 Web Studio：見 docs/手機連線.md',
    '5. 之後更新：node scripts/update.cjs',
  ].join('\n'));
  process.exitCode = errors === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(`\n安裝失敗：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
