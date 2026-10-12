#!/usr/bin/env node
// 即時追蹤 codex-plugin-cc 背景任務的進度。
// 用法：node codex-watch.mjs <jobId> [--all]
// 每行輸出一個進度事件；任務結束（completed / failed / cancelled）時輸出結果並退出。
// --all：輸出所有指令（預設只輸出 Codex 說明、檔案修改、測試/建置指令與失敗）。
// 結束時改視窗標題、印出醒目結果，並發 Windows 通知與提示音（codex-notify.mjs）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveStatus, failReason, jobLabel, durationMin, notifyDone } from './codex-notify.mjs';

const jobId = process.argv[2];
const showAll = process.argv.includes('--all');
const stateDir = path.join(os.homedir(), '.claude/plugins/data/codex-openai-codex/state');
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!jobId) {
  console.log('用法：node codex-watch.mjs <jobId> [--all]');
  process.exit(2);
}

// 任務紀錄依工作目錄分開存放，用 jobId 找出所在資料夾
function findJob() {
  if (!fs.existsSync(stateDir)) return null;
  for (const ws of fs.readdirSync(stateDir)) {
    const json = path.join(stateDir, ws, 'jobs', `${jobId}.json`);
    if (fs.existsSync(json)) return json;
  }
  return null;
}

const KEEP = showAll
  ? /Assistant message captured|Applying \d+ file|File changes|Running command|exit [1-9]\d*\)|Turn (completed|failed)|error|failed|cancel/i
  : /Assistant message captured|Applying \d+ file|File changes|Running command: .*(npm|npx|node |git diff)|exit [1-9]\d*\)|Turn (completed|failed)|error|failed|cancel/i;

function format(line) {
  return line
    .replace(/^\[[\d-]+T([\d:]+)\.\d+Z\] /, '$1 ')
    .replace(/"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe" -Command /, '')
    .replace('Assistant message captured: ', '💬 ')
    .replace('Running command: ', '▶ ')
    .replace('Command completed: ', '✔ ')
    .slice(0, 180);
}

let jsonPath = null;
for (let i = 0; i < 30 && !jsonPath; i++) {
  jsonPath = findJob();
  if (!jsonPath) await sleep(1000);
}
if (!jsonPath) {
  console.log(`[codex-watch] 找不到任務 ${jobId}`);
  process.exit(1);
}
const logPath = jsonPath.replace(/\.json$/, '.log');

let offset = 0;
let rest = '';
function drain() {
  if (!fs.existsSync(logPath)) return;
  const size = fs.statSync(logPath).size;
  if (size <= offset) return;
  const fd = fs.openSync(logPath, 'r');
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const lines = (rest + buf.toString('utf8')).split(/\r?\n/);
  rest = lines.pop();
  for (const line of lines) {
    if (line.startsWith('[') && KEEP.test(line)) console.log(format(line));
  }
}

while (true) {
  drain();
  let status = '';
  try {
    status = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).status ?? '';
  } catch {}
  if (['completed', 'failed', 'cancelled', 'error'].includes(status)) {
    drain();
    const job = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const st = effectiveStatus(job);
    const ok = st === 'completed';
    const mark = ok ? '✅ 完成' : '❌ 未完成';
    // 視窗標題（cmd / Windows Terminal 支援 OSC 0）
    process.stdout.write(`\x1b]0;${mark} Codex ${jobLabel(job)}\x07`);
    console.log('');
    console.log(`==================== ${mark}（${st}，${durationMin(job)} 分鐘） ====================`);
    if (!ok) console.log(`原因：${failReason(job) || '見 log'}`);
    console.log(`[codex-watch] 任務 ${jobId} 結束。Claude 會在背景自動驗收。`);
    notifyDone(jobId);
    process.exit(0);
  }
  await sleep(1000);
}
