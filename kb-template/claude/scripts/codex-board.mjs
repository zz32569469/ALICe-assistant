#!/usr/bin/env node
// 開啟 Codex 任務看板（不經過 Claude）。
// 用法：
//   node codex-board.mjs              確保伺服器在跑，並在瀏覽器開啟看板
//   node codex-board.mjs <jobId>      開啟並選取該任務（看板已開著時只切換，不另開分頁）
//   node codex-board.mjs --no-open    只確保伺服器在跑
//   node codex-board.mjs --status     顯示伺服器狀態
//   node codex-board.mjs --stop       關閉伺服器

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CODEX_BOARD_PORT || 47777);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'codex-board', 'server.mjs');
const URL_BASE = `http://127.0.0.1:${PORT}/`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(method, p) {
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method, headers: { 'X-Codex-Board': '1' }, timeout: 1500 },
      res => {
        let body = '';
        res.on('data', d => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

export async function ensureServer() {
  let ping = await request('GET', '/api/ping');
  if (ping) return { ping, started: false };
  spawn(process.execPath, [SERVER], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    ping = await request('GET', '/api/ping');
    if (ping) return { ping, started: true };
  }
  throw new Error('看板伺服器啟動失敗');
}

function openBrowser(url) {
  spawn('cmd.exe', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// 看板已有分頁開著：推送切換；否則開新分頁
export async function showBoard(jobId, { open = true } = {}) {
  const { ping } = await ensureServer();
  if (!open) return ping;
  if (jobId && ping.clients > 0) {
    await request('POST', `/api/focus/${jobId}`);
    return ping;
  }
  if (ping.clients > 0 && !jobId) {
    openBrowser(URL_BASE); // 使用者主動要求開啟時仍開一個分頁
    return ping;
  }
  openBrowser(URL_BASE + (jobId ? `#${jobId}` : ''));
  return ping;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const jobId = args.find(a => /^task-/.test(a));
  try {
    if (args.includes('--stop')) {
      const r = await request('POST', '/api/stop');
      console.log(r ? '看板伺服器已關閉' : '看板伺服器沒有在執行');
    } else if (args.includes('--status')) {
      const p = await request('GET', '/api/ping');
      console.log(p ? `執行中：${URL_BASE}（pid ${p.pid}，開著的分頁 ${p.clients}，啟動於 ${p.startedAt}）` : '沒有在執行');
    } else {
      const p = await showBoard(jobId, { open: !args.includes('--no-open') });
      console.log(`Codex 任務看板：${URL_BASE}${jobId ? '#' + jobId : ''}（pid ${p.pid}）`);
    }
  } catch (e) {
    console.error(`[codex-board] ${e.message}`);
    process.exit(1);
  }
}
