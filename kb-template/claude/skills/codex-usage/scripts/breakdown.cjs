// Codex 對話的輸入 token 拆解：每一步新加入對話的內容 × 之後還要重送的輪數，依指令類型歸類
// 用法：node breakdown.cjs <rollout 檔名片段，例 2026-09-24T10-23-53> [...更多]
// 說明：Codex 每執行一個指令就重送整段對話，花費 ≈ Σ(每一輪的對話長度)。
//       固定開頭 = 第一輪長度 × 輪數；其餘每一步的增量歸到該步執行的指令類型。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const want = process.argv.slice(2);
if (!want.length) { console.log('用法：node breakdown.cjs <rollout 檔名片段> [...]'); process.exit(1); }
const root = path.join(os.homedir(), '.codex', 'sessions');
function walk(d, out = []) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }
const all = walk(root).filter(f => path.basename(f).startsWith('rollout-'));

function classify(cmd) {
  const c = String(cmd || '');
  if (/\*\*\* Begin Patch|apply_patch/.test(c)) return '改檔';
  if (/\bnode\s+-e\b|\bnode\s+-\s|python\S*\s+-c\b|<<\s*['"]?\w+|@'/.test(c)) return '臨時內嵌腳本';
  if (/\b(node|npm|npx|pnpm|yarn|python\S*|pytest|go\s+test|cargo|dotnet|java)\b/.test(c)) return '執行腳本／測試';
  if (/Get-Content|\bcat\b|\bsed\s+-n|\brg\b|\bgrep\b|Select-String|\btype\b|Get-ChildItem|\bls\b|\bfind\b|git\s+show|Test-Path|Get-Item|\bhead\b|\btail\b/.test(c)) return '讀檔／搜尋';
  if (/\bgit\b/.test(c)) return 'git';
  return '其他指令';
}

const total = {};
for (const w of want) {
  const f = all.find(x => x.includes(w));
  if (!f) { console.log(`找不到：${w}`); continue; }
  const steps = [];
  let pending = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!l) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const p = o.payload || {};
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      let cmd = p.arguments || p.input || '';
      try { const a = JSON.parse(cmd); if (a.command) cmd = [].concat(a.command).join(' '); } catch { /* 非 JSON 參數（例 apply_patch）照原文 */ }
      pending.push(classify(cmd));
    }
    if (p.type === 'token_count' && p.info?.last_token_usage) {
      steps.push({ input: p.info.last_token_usage.input_tokens, cats: pending });
      pending = [];
    }
  }
  const s = steps.filter((x, i) => i === 0 || x.input !== steps[i - 1].input || x.cats.length);
  if (!s.length) { console.log(`${w}：沒有 token 紀錄`); continue; }
  const n = s.length;
  const per = { '固定開頭（系統指示＋任務說明）': s[0].input * n };
  for (let i = 0; i < n - 1; i++) {
    const delta = Math.max(0, s[i + 1].input - s[i].input);
    const cats = s[i + 1].cats.length ? s[i + 1].cats : ['模型思考／回覆'];
    for (const c of cats) per[c] = (per[c] || 0) + delta * (n - 1 - i) / cats.length;
  }
  const sum = Object.values(per).reduce((a, b) => a + b, 0);
  console.log(`== ${w}：${n} 輪，估算 ${(sum / 1e6).toFixed(2)}M，開頭 ${(s[0].input / 1e3).toFixed(0)}k`);
  for (const [k, v] of Object.entries(per).sort((a, b) => b[1] - a[1])) {
    if (v < 1) continue;
    console.log(`   ${k}：${(v / 1e6).toFixed(2)}M（${(v / sum * 100).toFixed(0)}%）`);
    total[k] = (total[k] || 0) + v;
  }
}
if (want.length > 1) {
  const ts = Object.values(total).reduce((a, b) => a + b, 0);
  console.log(`== 合計 ${(ts / 1e6).toFixed(2)}M`);
  for (const [k, v] of Object.entries(total).sort((a, b) => b[1] - a[1])) console.log(`   ${k}：${(v / 1e6).toFixed(2)}M（${(v / ts * 100).toFixed(0)}%）`);
}
