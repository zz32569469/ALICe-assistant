#!/usr/bin/env node
// Codex 委派任務總表（不經過 Claude，不花 token）。
// 用法：
//   node codex-jobs.mjs              列出最近 15 個任務
//   node codex-jobs.mjs --all        列出全部
//   node codex-jobs.mjs --watch      每 3 秒更新（Ctrl+C 離開）；有任務結束時會跳通知
//   node codex-jobs.mjs <jobId>      單一任務詳情與 log 位置

import fs from 'node:fs';
import { listJobs, findJob, effectiveStatus, failReason, jobLabel, durationMin, notifyDone, DONE } from './codex-notify.mjs';

const args = process.argv.slice(2);
const ICON = { completed: '✅', failed: '❌', cancelled: '⛔', error: '❌', running: '⏳', queued: '🕒' };

const pad = (s, n) => {
  s = String(s);
  let w = 0;
  let out = '';
  for (const ch of s) {
    const cw = /[ᄀ-￿]/.test(ch) || ch.codePointAt(0) > 0xffff ? 2 : 1;
    if (w + cw > n) break;
    out += ch;
    w += cw;
  }
  return out + ' '.repeat(Math.max(0, n - w));
};
const hhmm = t => (t ? new Date(t).toLocaleString('zh-TW', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');

function table(limit) {
  const jobs = listJobs().slice(0, limit);
  const lines = [];
  lines.push(`${pad('狀態', 16)}${pad('開始', 13)}${pad('分鐘', 7)}${pad('任務', 52)}jobId`);
  lines.push('-'.repeat(114));
  for (const j of jobs) {
    const st = effectiveStatus(j);
    const phase = DONE.includes(j.status) ? st : `${j.status}/${j.phase || ''}`;
    lines.push(`${pad(`${ICON[st] || '・'} ${phase}`, 16)}${pad(hhmm(j.startedAt || j.createdAt), 13)}${pad(durationMin(j), 7)}${pad(jobLabel(j), 52)}${j.id}`);
    if (st !== 'completed' && DONE.includes(j.status)) {
      const r = failReason(j);
      if (r) lines.push(`${' '.repeat(16)}└ ${r.slice(0, 90)}`);
    }
  }
  if (!jobs.length) lines.push('（沒有任務紀錄）');
  return lines.join('\n');
}

function detail(id) {
  const f = findJob(id);
  if (!f) return console.log(`找不到任務 ${id}`);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const st = effectiveStatus(j);
  console.log(`${ICON[st] || '・'} ${jobLabel(j)}`);
  console.log(`狀態：${st}（外掛紀錄 ${j.status} / ${j.phase || '-'}）`);
  console.log(`時間：${hhmm(j.startedAt)} → ${hhmm(j.completedAt) || '進行中'}，${durationMin(j)} 分鐘`);
  console.log(`repo：${j.workspaceRoot}`);
  if (st !== 'completed' && DONE.includes(j.status)) console.log(`原因：${failReason(j) || '見 log'}`);
  console.log(`log：${j.logFile}`);
  console.log(`即時進度：node ~/.claude/scripts/codex-watch.mjs ${id} --all`);
}

const limit = args.includes('--all') ? Infinity : 15;
if (args[0] && !args[0].startsWith('--')) {
  detail(args[0]);
} else if (args.includes('--watch')) {
  process.stdout.write('\x1b]0;Codex 任務總表\x07');
  // 開啟時已結束的任務不補發通知，只通知「開著總表期間」才結束的任務
  const doneAtStart = new Set(listJobs().filter(j => DONE.includes(j.status)).map(j => j.id));
  const tick = () => {
    for (const j of listJobs().slice(0, 30)) if (DONE.includes(j.status) && !doneAtStart.has(j.id)) notifyDone(j.id);
    process.stdout.write('\x1b[2J\x1b[H');
    console.log(`Codex 任務總表（每 3 秒更新，Ctrl+C 離開）  ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}\n`);
    console.log(table(limit));
  };
  tick();
  setInterval(tick, 3000);
} else {
  console.log(table(limit));
}
