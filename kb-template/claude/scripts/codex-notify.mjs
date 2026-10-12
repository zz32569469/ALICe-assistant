// Codex 委派任務的共用工具：找任務紀錄、判斷真正的結束狀態、取標籤、發 Windows 通知。
// 被 codex-watch.mjs、codex-delegate.mjs、codex-jobs.mjs 引用；也可單獨執行：
//   node codex-notify.mjs <jobId>   （對已結束的任務補發通知）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
export const STATE = path.join(HOME, '.claude', 'plugins', 'data', 'codex-openai-codex', 'state');
export const SNAP_ROOT = path.join(HOME, '.claude', 'codex-snapshots');
export const DONE = ['completed', 'failed', 'cancelled', 'error'];

export function findJob(jobId) {
  if (!fs.existsSync(STATE)) return null;
  for (const ws of fs.readdirSync(STATE)) {
    const f = path.join(STATE, ws, 'jobs', `${jobId}.json`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function listJobs() {
  const out = [];
  if (!fs.existsSync(STATE)) return out;
  for (const ws of fs.readdirSync(STATE)) {
    const dir = path.join(STATE, ws, 'jobs');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
      } catch {}
    }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// 外掛把「額度用完、中途失敗」也記成 completed，要看 log 才知道
export function effectiveStatus(job) {
  if (!job) return 'unknown';
  if (!DONE.includes(job.status)) return job.status || 'unknown';
  if (job.status === 'completed' && job.logFile && fs.existsSync(job.logFile)) {
    const log = fs.readFileSync(job.logFile, 'utf8');
    if (/Codex error:|\] Turn failed\./.test(log)) return 'failed';
  }
  return job.status;
}

export function failReason(job) {
  try {
    const line = fs
      .readFileSync(job.logFile, 'utf8')
      .split(/\r?\n/)
      .reverse()
      .find(l => /Codex error:/.test(l));
    return line ? line.replace(/^\[[^\]]+\] Codex error: /, '').slice(0, 120) : '';
  } catch {
    return '';
  }
}

export function jobLabel(job) {
  const meta = path.join(SNAP_ROOT, job.id, 'delegate.json');
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m.label) return m.label;
  } catch {}
  // 舊任務沒有 delegate.json：從任務說明取第一個非空行，跳過 codex-delegate 的固定開頭
  const repo = path.basename(String(job.workspaceRoot || ''));
  let text = String(job.request?.prompt || job.summary || job.title || '');
  if (text.startsWith('## 委派規則')) text = text.replace(/^## 委派規則[\s\S]*?\n\n/, '');
  const first = text
    .split(/\r?\n/)
    .map(l => l.replace(/^#+\s*/, '').trim())
    .find(Boolean) || '';
  return `${repo}：${first}`.slice(0, 60);
}

export function durationMin(job) {
  const end = job.completedAt ? new Date(job.completedAt) : new Date();
  const start = new Date(job.startedAt || job.createdAt);
  return ((end - start) / 60000).toFixed(1);
}

function toast(title, body) {
  const ps = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $tpl.GetElementsByTagName('text')
$t.Item(0).AppendChild($tpl.CreateTextNode($env:CN_TITLE)) > $null
$t.Item(1).AppendChild($tpl.CreateTextNode($env:CN_BODY)) > $null
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($tpl))
`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    env: { ...process.env, CN_TITLE: title, CN_BODY: body },
    stdio: 'ignore',
    timeout: 15000,
  });
  return r.status === 0;
}

function beep(ok) {
  // 成功一聲、失敗三聲
  const n = ok ? 1 : 3;
  spawnSync('powershell.exe', ['-NoProfile', '-Command', `1..${n} | % { [console]::beep(${ok ? 880 : 440},250); Start-Sleep -m 120 }`], {
    stdio: 'ignore',
    timeout: 5000,
  });
}

// 同一任務只通知一次（進度視窗與背景等待都會呼叫）
export function notifyDone(jobId) {
  const file = findJob(jobId);
  if (!file) return false;
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!DONE.includes(job.status)) return false;
  const markDir = path.join(SNAP_ROOT, jobId);
  const mark = path.join(markDir, '.notified');
  if (fs.existsSync(mark)) return false;
  fs.mkdirSync(markDir, { recursive: true });
  fs.writeFileSync(mark, new Date().toISOString());
  const st = effectiveStatus(job);
  const ok = st === 'completed';
  const title = `${ok ? '✅ Codex 完成' : '❌ Codex 未完成'}（${durationMin(job)} 分）`;
  const body = `${jobLabel(job)}${ok ? '' : `\n${st} ${failReason(job)}`}`;
  toast(title, body);
  beep(ok);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = process.argv[2];
  if (!id) {
    console.log('用法：node codex-notify.mjs <jobId>');
    process.exit(2);
  }
  const mark = path.join(SNAP_ROOT, id, '.notified');
  if (process.argv.includes('--force') && fs.existsSync(mark)) fs.rmSync(mark);
  console.log(notifyDone(id) ? '已通知' : '未通知（任務未結束、找不到，或已通知過；加 --force 重發）');
}
