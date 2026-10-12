#!/usr/bin/env node
// 委派 Codex 的一站式腳本（/delegate skill 使用）。
// 用法：
//   node codex-delegate.mjs start --cwd <repo> --prompt-file <file> [--label <名稱>] [--resume] [--effort <level>] [--read-only] [--cmd] [--no-window] [--track <檔案>...]
//   node codex-delegate.mjs wait <jobId>
// start：快照工作區 → 加上固定開頭 → 背景啟動 Codex → 開看板（--cmd 另開 cmd 進度視窗）→ 輸出 jobId。
// wait：等待任務結束 → 輸出 Codex 最終回報與快照比對摘要（交給 Claude 驗收）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { notifyDone } from './codex-notify.mjs';
import { showBoard } from './codex-board.mjs';

const HOME = os.homedir();
const SCRIPTS = path.join(HOME, '.claude', 'scripts');
const STATE = path.join(HOME, '.claude', 'plugins', 'data', 'codex-openai-codex', 'state');
const SNAP_ROOT = path.join(HOME, '.claude', 'codex-snapshots');

function companionPath() {
  const base = path.join(HOME, '.claude', 'plugins', 'cache', 'openai-codex', 'codex');
  const versions = fs.readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return path.join(base, versions.at(-1), 'scripts', 'codex-companion.mjs');
}

const HEADER = `## 委派規則（Claude Code 指派，請遵守）
- 任務說明已列出需要的知識庫頁面路徑：直接讀這些頁面，不要執行 \`$kb\`，也不要讀知識庫的 CLAUDE.md；除非任務需要，不要載入其他 skill。
- 不寫入知識庫；發現值得保存的知識，列在回報最後的「知識庫回寫候選」。
- 不要 commit、不要切分支、不要 git stash / reset / checkout；不要還原或改寫工作區中既有的未提交改動。
- 知識庫不足、與程式碼矛盾、或做不到（例如 sandbox 限制）時，停下來在回報中說明，不要改用任務沒有允許的做法。
- 回報要附實際執行的測試指令與結果摘要。
- 省額度（每一輪都會重送整段對話）：同一批量測或檢查寫成一個指令或一支腳本一次跑完；完整結果寫進檔案，終端只印摘要（單次輸出不超過約 2,000 字元）；不整份印出 JSON、log 或原始碼，只取需要的欄位或行號範圍。
- 長時間指令：先用小樣本估時，設足夠的逾時後等它結束，中途不要反覆查看進度。
- 設定與程式都沒變時，不重跑已有結果的測試（任務說明提供的結果、或本次稍早跑過的），直接引用並註明來源。
- 讀檔先看任務說明指定的檔案與行號，不做全域搜尋；只讀需要的段落。

`;

function parseArgs(argv) {
  const o = { track: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') o.cwd = argv[++i];
    else if (a === '--prompt-file') o.promptFile = argv[++i];
    else if (a === '--effort') o.effort = argv[++i];
    else if (a === '--label') o.label = argv[++i];
    else if (a === '--resume') o.resume = true;
    else if (a === '--read-only') o.readOnly = true;
    else if (a === '--no-window') o.noWindow = true;
    else if (a === '--cmd') o.cmd = true;
    else if (a === '--track') {
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.track.push(argv[++i]);
    } else o._ = [...(o._ || []), a];
  }
  return o;
}

async function start(o) {
  if (!o.cwd || !o.promptFile) throw new Error('start 需要 --cwd 與 --prompt-file');
  const cwd = path.resolve(o.cwd);
  const tmpSnap = path.join(SNAP_ROOT, `pending-${Date.now()}`);
  execFileSync('node', [path.join(SCRIPTS, 'agent-snapshot.mjs'), 'save', cwd, tmpSnap, ...o.track], {
    stdio: 'inherit',
  });

  const prompt = HEADER + fs.readFileSync(o.promptFile, 'utf8');
  const args = [companionPath(), 'task', '--background'];
  if (!o.readOnly) args.push('--write');
  args.push(o.resume ? '--resume' : '--fresh');
  if (o.effort) args.push('--effort', o.effort);
  args.push(prompt);
  const out = execFileSync('node', args, { cwd, encoding: 'utf8' });
  const jobId = out.match(/task-[a-z0-9]+-[a-z0-9]+/)?.[0];
  if (!jobId) throw new Error(`無法取得 jobId：${out}`);

  const snapDir = path.join(SNAP_ROOT, jobId);
  fs.renameSync(tmpSnap, snapDir);
  // 通知與任務總表用的可讀名稱：--label，否則取任務說明第一個非空行
  const firstLine =
    fs
      .readFileSync(o.promptFile, 'utf8')
      .split(/\r?\n/)
      .map(l => l.replace(/^#+\s*/, '').trim())
      .find(Boolean) || '';
  const label = (o.label || `${path.basename(cwd)}：${firstLine}`).slice(0, 60);
  fs.writeFileSync(path.join(snapDir, 'delegate.json'), JSON.stringify({ jobId, label, cwd, promptFile: path.resolve(o.promptFile), readOnly: !!o.readOnly, startedAt: new Date().toISOString() }, null, 2));

  // 進度顯示：預設開看板（已開著就切到這個任務，不另開分頁）；--cmd 另開 cmd 進度視窗；--no-window 都不開
  if (!o.noWindow) {
    try {
      await showBoard(jobId);
    } catch (e) {
      console.log(`[delegate] 看板開啟失敗（${e.message}），改開 cmd 視窗`);
      o.cmd = true;
    }
  }
  if (!o.noWindow && o.cmd) {
    const watch = path.join(SCRIPTS, 'codex-watch.mjs');
    const inner = `chcp 65001 >nul & title Codex 進行中 ${label.replace(/[&|<>^%"]/g, ' ')} & node "${watch}" ${jobId} --all`;
    spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', `Start-Process cmd.exe -ArgumentList '/k', '${inner.replace(/'/g, "''")}'`],
      { detached: true, stdio: 'ignore' }
    ).unref();
  }

  console.log(`[delegate] jobId=${jobId}`);
  console.log(`[delegate] snapshot=${snapDir}`);
  console.log(`[delegate] 下一步：以背景 Bash 執行 node ${path.join(SCRIPTS, 'codex-delegate.mjs')} wait ${jobId}`);
}

function findJob(jobId) {
  for (const ws of fs.existsSync(STATE) ? fs.readdirSync(STATE) : []) {
    const f = path.join(STATE, ws, 'jobs', `${jobId}.json`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function wait(jobId) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let file = null;
  for (let i = 0; i < 60 && !(file = findJob(jobId)); i++) await sleep(1000);
  if (!file) throw new Error(`找不到任務 ${jobId}`);
  let job;
  while (true) {
    try {
      job = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (['completed', 'failed', 'cancelled', 'error'].includes(job?.status)) break;
    await sleep(5000);
  }
  const mins = ((new Date(job.completedAt || Date.now()) - new Date(job.startedAt)) / 60000).toFixed(1);
  console.log(`[delegate] ${jobId} 結束：${job.status}（${mins} 分鐘）`);
  notifyDone(jobId); // 進度視窗已通知過就不重複
  // Codex 中途失敗（額度、逾時）時 rawOutput 只是最後一則中途訊息，要把錯誤原因標出來
  try {
    const log = fs.readFileSync(job.logFile, 'utf8');
    const errs = log.split(/\r?\n/).filter(l => /Codex error:|Turn failed/.test(l));
    if (errs.length) {
      console.log('⚠ [delegate] Codex 未正常完成，以下回報只是中途訊息：');
      errs.slice(-3).forEach(l => console.log('  ' + l.replace(/^\[[^\]]+\] /, '')));
    }
  } catch {}
  console.log(`[delegate] log：${job.logFile}`);
  console.log(`[delegate] Codex 回報的修改檔案：${(job.result?.touchedFiles || []).join(', ') || '（無）'}`);
  console.log('\n===== Codex 最終回報 =====');
  console.log(job.result?.rawOutput || '（沒有最終輸出，請看 log）');
  const snapDir = path.join(SNAP_ROOT, jobId);
  if (fs.existsSync(snapDir)) {
    console.log('\n===== 工作區比對（以快照為準，不採信 Codex 自述） =====');
    execFileSync('node', [path.join(SCRIPTS, 'agent-snapshot.mjs'), 'diff', snapDir], { stdio: 'inherit' });
  }
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'start') await start(parseArgs(rest));
  else if (cmd === 'wait' && rest[0]) await wait(rest[0]);
  else {
    console.log('用法：codex-delegate.mjs start --cwd <repo> --prompt-file <file> [...] | wait <jobId>');
    process.exit(2);
  }
} catch (e) {
  console.error(`[delegate] 失敗：${e.message}`);
  process.exit(1);
}
