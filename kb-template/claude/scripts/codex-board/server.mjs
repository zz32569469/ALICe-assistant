#!/usr/bin/env node
// Codex 任務看板的本機伺服器（只綁 127.0.0.1）。由 codex-board.mjs 啟動，不經過 Claude。
// 讀 codex-plugin-cc 的任務紀錄（*.json / *.log），以 SSE 推送更新給瀏覽器。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRoleForDirectory, readRoles } from './roles.mjs';
import {
  listJobs,
  findJob,
  effectiveStatus,
  failReason,
  jobLabel,
  durationMin,
  notifyDone,
  DONE,
  SNAP_ROOT,
} from '../codex-notify.mjs';

export const PORT = Number(process.env.CODEX_BOARD_PORT || 47777);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.dirname(HERE);
const STARTED = new Date().toISOString();
const IDLE_EXIT_MS = 2 * 60 * 60 * 1000; // 沒有瀏覽器連線且沒有執行中任務 2 小時後自動結束

// ---------- log 解析 ----------
const cache = new Map(); // logFile -> { size, events, final }

function cleanCmd(s) {
  return s
    .replace(/^"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe"\s+(-NoProfile\s+)?-Command\s+/i, '')
    .replace(/^"C:\\\\WINDOWS\\\\system32\\\\cmd\.exe"\s+\/c\s+/i, '')
    .replace(/^"C:\\\\Program Files\\\\Git\\\\usr\\\\bin\\\\bash\.exe"\s+-c\s+/i, 'bash ')
    .replace(/^['"]/, '');
}

function parseLog(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { events: [], final: '' };
  }
  const hit = cache.get(file);
  if (hit && hit.size === stat.size) return hit;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const events = [];
  let final = null;
  let block = null; // 正在收集的多行內容（Assistant message / Final output）
  const TS = /^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\] (.*)$/;
  for (const line of lines) {
    const m = line.match(TS);
    if (!m) {
      if (block) block.push(line);
      continue;
    }
    if (block && block.target) block.target.text = block.join('\n').trim();
    block = null;
    const [, t, body] = m;
    let ev = null;
    if (final !== null) {
      // Final output 之後的時間戳行不再是事件
      continue;
    }
    if (body.startsWith('Assistant message captured:')) continue;
    if (body === 'Assistant message') {
      ev = { t, kind: 'msg', text: '' };
      block = [];
      block.target = ev;
    } else if (body === 'Final output') {
      final = '';
      block = [];
      block.target = { set text(v) { final = v; } };
      ev = { t, kind: 'final', text: 'Codex 輸出最終回報' };
    } else if (body.startsWith('Running command: ')) {
      ev = { t, kind: 'cmd', text: cleanCmd(body.slice(17)) };
    } else if (body.startsWith('Command completed: ')) {
      const x = body.match(/\(exit (-?\d+)\)$/);
      ev = { t, kind: 'cmd-ok', text: cleanCmd(body.slice(19).replace(/\s*\(exit -?\d+\)$/, '')), exit: x ? +x[1] : 0 };
    } else if (body.startsWith('Command failed: ')) {
      const x = body.match(/\(exit (-?\d+)\)$/);
      ev = { t, kind: 'cmd-fail', text: cleanCmd(body.slice(16).replace(/\s*\(exit -?\d+\)$/, '')), exit: x ? +x[1] : 1 };
    } else if (/^Applying \d+ file change/.test(body)) {
      ev = { t, kind: 'edit', text: body, n: +body.match(/\d+/)[0] };
    } else if (body.startsWith('File changes completed')) {
      ev = { t, kind: 'edit-done', text: '檔案修改完成' };
    } else if (body.startsWith('Codex error:')) {
      ev = { t, kind: 'error', text: body.slice(12).trim() };
    } else if (body.startsWith('Turn failed')) {
      ev = { t, kind: 'error', text: 'Codex 回合失敗' };
    } else if (body.startsWith('Turn completion') || body.startsWith('Turn completed')) {
      ev = { t, kind: 'done', text: 'Codex 回合結束' };
    } else if (body.startsWith('Turn started')) {
      ev = { t, kind: 'info', text: '開始工作' };
    } else if (body.startsWith('Starting Codex Task')) {
      ev = { t, kind: 'info', text: '任務建立' };
    } else if (body.startsWith('Thread ready')) {
      ev = { t, kind: 'info', text: 'Codex 對話就緒' };
    } else {
      ev = { t, kind: 'info', text: body };
    }
    if (ev) events.push(ev);
  }
  if (block && block.target) block.target.text = block.join('\n').trim();
  const out = { size: stat.size, events, final: final ?? '' };
  cache.set(file, out);
  return out;
}

function counts(events) {
  const c = { cmd: 0, cmdFail: 0, edits: 0, msgs: 0 };
  for (const e of events) {
    if (e.kind === 'cmd') c.cmd++;
    else if (e.kind === 'cmd-fail') c.cmdFail++;
    else if (e.kind === 'edit') c.edits += e.n || 0;
    else if (e.kind === 'msg') c.msgs++;
  }
  return c;
}

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAP_ROOT, id, 'delegate.json'), 'utf8'));
  } catch {
    return null;
  }
}

function stripHeader(p) {
  p = String(p || '');
  return p.startsWith('## 委派規則') ? p.replace(/^## 委派規則[\s\S]*?\n\n/, '') : p;
}

function summarize(job) {
  const { events } = parseLog(job.logFile);
  const last = [...events].reverse().find(e => e.kind !== 'final');
  const lastMsg = [...events].reverse().find(e => e.kind === 'msg');
  const meta = readMeta(job.id);
  return {
    id: job.id,
    label: jobLabel(job),
    repo: path.basename(String(job.workspaceRoot || '')),
    repoPath: job.workspaceRoot,
    status: effectiveStatus(job),
    rawStatus: job.status,
    phase: job.phase || '',
    write: job.write !== false && !(meta && meta.readOnly),
    createdAt: job.createdAt,
    startedAt: job.startedAt || job.createdAt,
    completedAt: job.completedAt || null,
    durationMin: Number(durationMin(job)),
    failReason: DONE.includes(job.status) && effectiveStatus(job) !== 'completed' ? failReason(job) : '',
    counts: counts(events),
    tokens: jobTokens(job),
    by: jobRole(job),
    lastEventAt: last ? last.t : null,
    lastEvent: last ? { kind: last.kind, text: String(last.text).slice(0, 140) } : null,
    lastMsg: lastMsg ? String(lastMsg.text).split('\n')[0].slice(0, 160) : '',
    hasSnapshot: fs.existsSync(path.join(SNAP_ROOT, job.id, 'snapshot.json')),
  };
}

function detail(id) {
  const f = findJob(id);
  if (!f) return null;
  const job = JSON.parse(fs.readFileSync(f, 'utf8'));
  const { events, final } = parseLog(job.logFile);
  return {
    ...summarize(job),
    logFile: job.logFile,
    threadId: job.threadId,
    prompt: stripHeader(job.request?.prompt),
    events,
    finalOutput: job.result?.rawOutput || final || '',
    touchedFiles: job.result?.touchedFiles || [],
  };
}

// ---------- HTTP ----------
const clients = new Set();
let lastJobsJson = '';
let lastActivity = Date.now();
const doneAtStart = new Set(listJobs().filter(j => DONE.includes(j.status)).map(j => j.id));

// ---------- Codex 剩餘額度 ----------
// Codex 每次回應後會在 session 紀錄（~/.codex/sessions/YYYY/MM/DD/*.jsonl）寫入 token_count 事件，
// 其中 rate_limits.primary（5 小時）/ secondary（每週）有已用百分比與重置時間。取最新一筆。
const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
let quotaCache = { file: '', mtime: 0, value: null };
let lastQuotaJson = '';

function newestSessionFiles(limit = 5) {
  const files = [];
  const walk = (dir, depth) => {
    let names;
    try {
      names = fs.readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const n of names) {
      if (files.length >= limit * 4) return;
      const p = path.join(dir, n);
      if (depth < 3) walk(p, depth + 1);
      else if (n.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(SESSIONS, 0);
  return files
    .map(f => ({ f, t: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit);
}

function quotaFromFile(file) {
  const size = fs.statSync(file).size;
  const len = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    try {
      const o = JSON.parse(lines[i]);
      const rl = o.payload && o.payload.rate_limits;
      if (rl && (rl.primary || rl.secondary)) return { at: o.timestamp, primary: rl.primary || null, secondary: rl.secondary || null };
    } catch {
      // 讀取區塊開頭可能是半行，略過
    }
  }
  return null;
}

function quotaPayload() {
  try {
    const recent = newestSessionFiles();
    if (!recent.length) return null;
    const head = recent[0];
    if (quotaCache.file === head.f && quotaCache.mtime === head.t) return quotaCache.value;
    let value = null;
    for (const { f } of recent) {
      value = quotaFromFile(f);
      if (value) break;
    }
    quotaCache = { file: head.f, mtime: head.t, value };
    return value;
  } catch {
    return null;
  }
}

// ---------- 單一任務的 token 用量 ----------
// 任務紀錄的 threadId 對應 ~/.codex/sessions/.../rollout-<時間>-<threadId>.jsonl；
// 同一對話可被 --resume 接續多次，所以以任務的 turnId 切出該回合：
// 用量 = 回合內最後一筆 total_token_usage − 回合開始前最後一筆（新對話為 0）。
const rolloutPath = new Map(); // threadId -> 檔案路徑
const rolloutState = new Map(); // 檔案路徑 -> 增量解析狀態

function findRollout(threadId, createdAt) {
  if (rolloutPath.has(threadId)) return rolloutPath.get(threadId);
  const suffix = `-${threadId}.jsonl`;
  const days = new Set();
  const base = createdAt ? new Date(createdAt) : new Date();
  for (const off of [0, -1, 1]) {
    const d = new Date(base.getTime() + off * 86400000);
    const pad = n => String(n).padStart(2, '0');
    days.add(path.join(SESSIONS, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  for (const dir of days) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const n = names.find(x => x.endsWith(suffix));
    if (n) {
      const f = path.join(dir, n);
      rolloutPath.set(threadId, f);
      return f;
    }
  }
  return null; // 不快取：執行中的任務檔案可能稍後才出現
}

const ZERO = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };

function readRollout(file) {
  let st = rolloutState.get(file);
  if (!st) {
    st = { offset: 0, rest: '', lastTotal: ZERO, lastRl: null, cur: null, turns: new Map() };
    rolloutState.set(file, st);
  }
  const size = fs.statSync(file).size;
  if (size <= st.offset) return st;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - st.offset);
  try {
    fs.readSync(fd, buf, 0, buf.length, st.offset);
  } finally {
    fs.closeSync(fd);
  }
  st.offset = size;
  const lines = (st.rest + buf.toString('utf8')).split('\n');
  st.rest = lines.pop();
  for (const l of lines) {
    if (!l) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    const p = o.payload || {};
    if (p.type === 'task_started' && p.turn_id) {
      st.cur = { start: st.lastTotal, end: st.lastTotal, calls: 0, ctx: 0, ctxWindow: p.model_context_window || 0, rlStart: st.lastRl, rlEnd: st.lastRl };
      st.turns.set(p.turn_id, st.cur);
    } else if (p.type === 'task_complete') {
      st.cur = null;
    } else if ((p.type === 'function_call' || p.type === 'custom_tool_call') && st.cur) {
      st.cur.calls++;
    } else if (p.type === 'token_count') {
      if (p.info && p.info.total_token_usage) {
        st.lastTotal = p.info.total_token_usage;
        if (st.cur) {
          st.cur.end = st.lastTotal;
          st.cur.ctx = p.info.last_token_usage?.input_tokens || st.cur.ctx;
          if (p.info.model_context_window) st.cur.ctxWindow = p.info.model_context_window;
        }
      }
      if (p.rate_limits && (p.rate_limits.primary || p.rate_limits.secondary)) {
        // 額度用盡時的事件可能缺 primary / secondary，保留上一筆的值
        const prev = st.lastRl || {};
        st.lastRl = { primary: p.rate_limits.primary || prev.primary || null, secondary: p.rate_limits.secondary || prev.secondary || null };
        if (st.cur) {
          if (!st.cur.rlStart) st.cur.rlStart = st.lastRl;
          st.cur.rlEnd = st.lastRl;
        }
      }
    }
  }
  return st;
}

function jobTokens(job) {
  if (!job.threadId) return null;
  try {
    const f = findRollout(job.threadId, job.createdAt);
    if (!f) return null;
    const st = readRollout(f);
    const turn = job.turnId ? st.turns.get(job.turnId) : null;
    if (!turn) return null;
    const d = k => (turn.end[k] || 0) - (turn.start[k] || 0);
    const input = d('input_tokens');
    const cached = d('cached_input_tokens');
    const pct = (rl, k) => (rl && rl[k] ? rl[k].used_percent : null);
    return {
      input,
      cached,
      uncached: input - cached,
      output: d('output_tokens'),
      reasoning: d('reasoning_output_tokens'),
      calls: turn.calls,
      ctx: turn.ctx,
      ctxWindow: turn.ctxWindow,
      resumed: (turn.start.input_tokens || 0) > 0,
      primary: [pct(turn.rlStart, 'primary'), pct(turn.rlEnd, 'primary')],
      weekly: [pct(turn.rlStart, 'secondary'), pct(turn.rlEnd, 'secondary')],
    };
  } catch {
    return null;
  }
}

// ---------- 委派的角色 ----------
// 任務紀錄的 sessionId 是委派它的 Claude Code session；該 session 的 transcript
// （~/.claude/projects/<目錄>/<sessionId>.jsonl）記有工作目錄與 session 名稱（custom-title）。
// 角色依工作目錄對應知識庫〈Claude Code 與 Codex 分工〉的角色表。
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const ROLE_CONFIG = path.join(HERE, 'roles.json');
// session 名稱照角色慣例：Library 是知識庫管理員；「<Project> - <角色>」取 - 後面的角色名稱（接手的「<角色> 2」去掉編號）。
const ROLE_BY_NAME = [
  [/^Library$/i, '知識庫管理員'],
  [/知識庫管理員/, '知識庫管理員'],
];
const roleFromTitle = (title) => /\s-\s*(.+?)(?:\s+\d+)?$/u.exec(title)?.[1]?.trim() ?? '';
const sessionCache = new Map(); // sessionId -> { file, checkedAt, mtime, cwd, title }

function findTranscript(sessionId) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(PROJECTS);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function jobRole(job) {
  const sid = job.sessionId;
  if (!sid) return null;
  let s = sessionCache.get(sid);
  const now = Date.now();
  if (s && now - s.checkedAt < 60000) return s.out;
  try {
    const file = (s && s.file) || findTranscript(sid);
    if (!file) {
      sessionCache.set(sid, { checkedAt: now, out: null });
      return null;
    }
    const mtime = fs.statSync(file).mtimeMs;
    if (s && s.file === file && s.mtime === mtime) {
      s.checkedAt = now;
      return s.out;
    }
    const text = fs.readFileSync(file, 'utf8');
    const cwdM = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    const cwd = cwdM ? JSON.parse(`"${cwdM[1]}"`) : '';
    let title = '';
    const re = /"customTitle":"((?:[^"\\]|\\.)*)"/g;
    for (let m; (m = re.exec(text)); ) title = m[1];
    if (title) title = JSON.parse(`"${title}"`);
    // session 名稱照角色慣例（`Library`、`<Project> - <角色>`）優先，其次看工作目錄
    const byName = ROLE_BY_NAME.find(([re2]) => re2.test(title));
    const byDirectory = findRoleForDirectory(cwd, readRoles(ROLE_CONFIG));
    const out = { role: byName ? byName[1] : byDirectory || roleFromTitle(title), session: title, cwd };
    sessionCache.set(sid, { file, checkedAt: now, mtime, out });
    return out;
  } catch {
    return null;
  }
}

function jobsPayload() {
  return listJobs()
    .slice(0, 100)
    .map(summarize);
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function broadcast(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) c.write(data);
}

function openWithShell(target) {
  spawn('cmd.exe', ['/c', 'start', '""', target], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).unref();
}

const server = http.createServer((req, res) => {
  lastActivity = Date.now();
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(HERE, 'index.html'), 'utf8'), 'text/html; charset=utf-8');
    }
    if (p === '/api/ping') return send(res, 200, { ok: true, pid: process.pid, startedAt: STARTED, clients: clients.size, port: PORT });
    if (p === '/api/jobs') return send(res, 200, jobsPayload());
    if (p === '/api/quota') return send(res, 200, quotaPayload());
    let m;
    if ((m = p.match(/^\/api\/jobs\/(task-[a-z0-9-]+)$/))) {
      const d = detail(m[1]);
      return d ? send(res, 200, d) : send(res, 404, { error: 'not found' });
    }
    if ((m = p.match(/^\/api\/jobs\/(task-[a-z0-9-]+)\/diff$/))) {
      const snap = path.join(SNAP_ROOT, m[1]);
      if (!fs.existsSync(path.join(snap, 'snapshot.json'))) return send(res, 200, { text: '這個任務沒有工作區快照（不是透過 /delegate 啟動）。' });
      let text;
      try {
        text = execFileSync('node', [path.join(SCRIPTS, 'agent-snapshot.mjs'), 'diff', snap], { encoding: 'utf8', timeout: 60000 });
      } catch (e) {
        text = String(e.stdout || '') + String(e.message || '');
      }
      return send(res, 200, { text });
    }
    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'jobs', jobs: jobsPayload() })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'quota', quota: quotaPayload() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    // 會開啟本機程式的動作：只接受 POST + 自訂標頭，避免其他網頁觸發
    if (req.method === 'POST' && req.headers['x-codex-board'] === '1') {
      if ((m = p.match(/^\/api\/jobs\/(task-[a-z0-9-]+)\/open-(log|repo|watch)$/))) {
        const f = findJob(m[1]);
        if (!f) return send(res, 404, { error: 'not found' });
        const job = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (m[2] === 'log') openWithShell(job.logFile);
        else if (m[2] === 'repo') openWithShell(job.workspaceRoot);
        else {
          const inner = `chcp 65001 >nul & node "${path.join(SCRIPTS, 'codex-watch.mjs')}" ${job.id} --all`;
          spawn('cmd.exe', ['/c', 'start', '"Codex 進度"', 'cmd', '/k', inner], { detached: true, stdio: 'ignore', shell: false }).unref();
        }
        return send(res, 200, { ok: true });
      }
      if ((m = p.match(/^\/api\/focus\/(task-[a-z0-9-]+)$/))) {
        broadcast({ type: 'focus', id: m[1] });
        return send(res, 200, { ok: true, clients: clients.size });
      }
      if (p === '/api/stop') {
        send(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return;
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e && e.message) });
  }
});

setInterval(() => {
  const jobs = jobsPayload();
  const json = JSON.stringify(jobs);
  if (json !== lastJobsJson) {
    lastJobsJson = json;
    broadcast({ type: 'jobs', jobs });
  }
  const quota = JSON.stringify(quotaPayload());
  if (quota !== lastQuotaJson) {
    lastQuotaJson = quota;
    broadcast({ type: 'quota', quota: JSON.parse(quota) });
  }
  for (const j of jobs) {
    if (DONE.includes(j.rawStatus) && !doneAtStart.has(j.id)) notifyDone(j.id);
  }
  const running = jobs.some(j => !DONE.includes(j.rawStatus));
  if (clients.size || running) lastActivity = Date.now();
  if (Date.now() - lastActivity > IDLE_EXIT_MS) process.exit(0);
}, 2000);

setInterval(() => {
  for (const c of clients) c.write(': ping\n\n');
}, 20000);

server.on('error', e => {
  console.error(`[codex-board] 無法啟動：${e.message}`);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[codex-board] http://127.0.0.1:${PORT}/ （pid ${process.pid}）`);
});
