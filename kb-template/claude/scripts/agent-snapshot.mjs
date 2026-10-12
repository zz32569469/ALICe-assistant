#!/usr/bin/env node
// 委派前後的工作區快照與比對，只輸出摘要。
// 用法：
//   node agent-snapshot.mjs save <repo> <snapDir> [額外檔案...]
//   node agent-snapshot.mjs diff <snapDir>
// save：記錄 git HEAD、git status，以及「所有已修改 / 未追蹤檔案 + 額外指定檔案」的 sha256 與副本。
// diff：比對目前狀態，列出 agent 新增、修改、刪除的檔案；原本就有未提交改動的檔案被動到時特別標示。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [cmd, a1, a2, ...extra] = process.argv.slice(2);

const git = (repo, args) =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'], // 略過 LF/CRLF 等警告
  });

const sha = file => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

// git status --porcelain -z，回傳 { 相對路徑: 狀態碼 }
function status(repo) {
  const out = git(repo, ['status', '--porcelain', '-z', '--untracked-files=all']);
  const map = {};
  const parts = out.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    map[file] = code;
    if (code[0] === 'R' || code[0] === 'C') i++; // rename 會多一個來源路徑
  }
  return map;
}

function save(repo, snapDir) {
  repo = path.resolve(repo);
  fs.mkdirSync(path.join(snapDir, 'files'), { recursive: true });
  const st = status(repo);
  const files = new Set(Object.keys(st));
  for (const f of extra) files.add(path.relative(repo, path.resolve(repo, f)).replace(/\\/g, '/'));
  const hashes = {};
  for (const f of files) {
    const abs = path.join(repo, f);
    hashes[f] = sha(abs);
    if (hashes[f]) {
      const dest = path.join(snapDir, 'files', f);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    }
  }
  const meta = {
    repo,
    head: git(repo, ['rev-parse', '--short', 'HEAD']).trim(),
    branch: git(repo, ['branch', '--show-current']).trim(),
    savedAt: new Date().toISOString(),
    status: st,
    hashes,
  };
  fs.writeFileSync(path.join(snapDir, 'snapshot.json'), JSON.stringify(meta, null, 2));
  console.log(
    `[snapshot] ${meta.branch}@${meta.head}，未提交 ${Object.keys(st).length} 檔，已備份 ${Object.values(hashes).filter(Boolean).length} 檔 → ${snapDir}`
  );
}

function diff(snapDir) {
  const meta = JSON.parse(fs.readFileSync(path.join(snapDir, 'snapshot.json'), 'utf8'));
  const { repo } = meta;
  const notes = [];

  const head = git(repo, ['rev-parse', '--short', 'HEAD']).trim();
  const branch = git(repo, ['branch', '--show-current']).trim();
  if (head !== meta.head || branch !== meta.branch) {
    notes.push(`⚠ HEAD/分支改變：${meta.branch}@${meta.head} → ${branch}@${head}`);
  }

  const st = status(repo);
  const all = new Set([...Object.keys(meta.hashes), ...Object.keys(st)]);
  const rows = { added: [], changed: [], preDirtyChanged: [], removed: [], cleanChanged: [] };

  for (const f of all) {
    const before = meta.hashes[f];
    const abs = path.join(repo, f);
    const now = fs.existsSync(abs) ? sha(abs) : null;
    const wasTracked = f in meta.hashes;
    if (!wasTracked) {
      // 快照時是乾淨檔案（或不存在）
      if (st[f]?.startsWith('??')) rows.added.push(f);
      else if (st[f]) rows.cleanChanged.push(f);
      continue;
    }
    if (before === now) continue;
    if (now === null) rows.removed.push(f);
    else if (meta.status[f]) rows.preDirtyChanged.push(f);
    else rows.changed.push(f);
  }

  const stat = f => {
    try {
      const s = git(repo, ['diff', '--numstat', '--', f]).trim().split('\t');
      return s[0] === '-' ? '二進位' : s.length > 1 ? `+${s[0]} -${s[1]}（相對 HEAD）` : '';
    } catch {
      return '';
    }
  };

  console.log(`[snapshot diff] ${repo}（快照 ${meta.savedAt}）`);
  notes.forEach(n => console.log(n));
  const print = (title, list, withStat) => {
    if (!list.length) return;
    console.log(`${title}（${list.length}）`);
    for (const f of list.sort()) console.log(`  ${f}${withStat ? '  ' + stat(f) : ''}`);
  };
  print('新增（未追蹤）', rows.added, false);
  print('修改（快照時乾淨）', rows.cleanChanged, true);
  print('修改（指定追蹤檔）', rows.changed, false);
  print('⚠ 原本已有未提交改動、又被修改', rows.preDirtyChanged, false);
  print('⚠ 刪除', rows.removed, false);
  if (!Object.values(rows).some(l => l.length)) console.log('無任何變更');
  console.log(`備份副本：${path.join(snapDir, 'files')}`);
}

if (cmd === 'save' && a1 && a2) save(a1, a2);
else if (cmd === 'diff' && a1) diff(a1);
else {
  console.log('用法：agent-snapshot.mjs save <repo> <snapDir> [額外檔案...] | diff <snapDir>');
  process.exit(2);
}
