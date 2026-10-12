// Codex 用量總表：列出指定期間每個 Codex 對話的指令數與 token，並顯示目前額度
// 用法：node usage.cjs [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--cwd <路徑片段>]
// 資料：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl（最後一筆 token_count 為累計值）
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const today = new Date();
const defSince = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
const since = opt('--since') || defSince;
const until = opt('--until') || '9999-12-31';
const cwdFilter = (opt('--cwd') || '').toLowerCase().replace(/\\/g, '/');

const root = path.join(os.homedir(), '.codex', 'sessions');
function listFiles() {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const y of fs.readdirSync(root)) for (const m of fs.readdirSync(path.join(root, y))) for (const d of fs.readdirSync(path.join(root, y, m))) {
    const day = `${y}-${m}-${d}`;
    if (day < since || day > until) continue;
    for (const f of fs.readdirSync(path.join(root, y, m, d))) if (f.startsWith('rollout-')) out.push(path.join(root, y, m, d, f));
  }
  return out.sort();
}

const fmtM = n => (n / 1e6).toFixed(2) + 'M';
const fmtK = n => (n / 1e3).toFixed(0) + 'k';
const localTime = s => new Date(s * 1000).toLocaleString('zh-TW', { hour12: false });

let latest = null;
const rows = [];
for (const f of listFiles()) {
  const text = fs.readFileSync(f, 'utf8');
  let cwd = '', title = '', calls = 0, last = null, maxCtx = 0, rl = null, rlTime = '';
  for (const l of text.split('\n')) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const p = o.payload || {};
    if (!cwd && p.cwd) cwd = p.cwd;
    if (p.type === 'function_call' || p.type === 'custom_tool_call') calls++;
    if (!title && p.type === 'message' && p.role === 'user') {
      const m = JSON.stringify(p.content || '').match(/(?:^|\\n)# ([^\\"]{1,60})/);
      if (m && !/委派規則|AGENTS|全域指引/.test(m[1])) title = m[1];
    }
    if (p.type === 'token_count' && p.info) {
      last = p.info.total_token_usage;
      maxCtx = Math.max(maxCtx, p.info.last_token_usage?.input_tokens || 0);
      if (p.rate_limits) { rl = p.rate_limits; rlTime = o.timestamp; }
    }
  }
  if (!last) continue;
  if (cwdFilter && !cwd.toLowerCase().replace(/\\/g, '/').includes(cwdFilter)) continue;
  if (rl && (!latest || rlTime > latest.time)) latest = { time: rlTime, rl };
  rows.push({ start: path.basename(f).slice(8, 27), cwd: path.basename(cwd || '?'), title: title || '-', calls,
    input: last.input_tokens, uncached: last.input_tokens - (last.cached_input_tokens || 0), output: last.output_tokens, maxCtx });
}

console.log(`期間 ${since}～${until === '9999-12-31' ? '今天' : until}${cwdFilter ? `，cwd 含「${cwdFilter}」` : ''}，共 ${rows.length} 個對話`);
console.log('開始時間 | 目錄 | 任務標題 | 指令數 | 輸入 | 未快取 | 輸出 | 最大對話長度');
let sum = 0;
for (const r of rows) {
  sum += r.input;
  console.log([r.start, r.cwd, r.title, r.calls, fmtM(r.input), fmtK(r.uncached), fmtK(r.output), fmtK(r.maxCtx)].join(' | '));
}
console.log(`輸入合計 ${fmtM(sum)}`);
if (latest) {
  const { primary, secondary } = latest.rl;
  const show = (name, w) => w ? `${name} 已用 ${w.used_percent}%（每 ${w.window_minutes} 分鐘，${w.resets_at ? localTime(w.resets_at) + ' 重置' : '重置時間不明'}）` : '';
  console.log(`額度（${latest.time} 的紀錄）：${show('短期', primary)}；${show('每週', secondary)}`);
}
