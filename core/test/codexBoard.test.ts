import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexBoard, isRunningJob, jobsForGame, type CodexJob } from "../src/codex/codexBoard.js";
import { codexJobLine } from "../src/games/progress.js";

const job = (fields: Partial<CodexJob>): CodexJob => ({ id: "task-a", label: "任務", repo: "r", status: "completed", ...fields });

function fakeFetch(routes: Record<string, unknown>, calls: string[], up: () => boolean): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = new URL(url).pathname;
    if (!up() || !(path in routes)) return new Response("{}", { status: up() ? 404 : 503 });
    return new Response(JSON.stringify(routes[path]), { status: 200 });
  }) as typeof fetch;
}

// 測試 §65：看板沒在跑時用腳本啟動一次再取資料；任務清單會快取給進度資料；任務 id 格式不對直接拒絕。
test("CodexBoard starts the board server when needed and caches jobs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-codex-board-"));
  const script = join(directory, "codex-board.mjs");
  writeFileSync(script, "");
  let running = false;
  const spawned: string[] = [];
  const calls: string[] = [];
  const routes = { "/api/ping": { ok: true }, "/api/jobs": [job({ id: "task-x1" })], "/api/quota": { primary: { used_percent: 7 } } };
  try {
    const board = new CodexBoard({
      url: "http://127.0.0.1:47777/", script,
      fetch: fakeFetch(routes, calls, () => running),
      spawnServer: (path) => { spawned.push(path); running = true; },
    });
    assert.equal(board.configured, true);
    assert.deepEqual(board.cachedJobs(), []);
    const result = await board.jobs();
    assert.deepEqual(spawned, [script]);
    assert.deepEqual(result.jobs.map((entry) => entry.id), ["task-x1"]);
    assert.deepEqual(result.quota, { primary: { used_percent: 7 } });
    assert.deepEqual(board.cachedJobs().map((entry) => entry.id), ["task-x1"]);
    await assert.rejects(board.job("../etc"), /格式不對/u);
    assert.equal(new CodexBoard({ url: "http://x", script: join(directory, "missing.mjs") }).configured, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 §65：任務對到專案（委派的 session 在卡片 sessions 裡，或名稱含專案名或代號）；進度資料的一行寫狀態、種類、時間、失敗原因。
test("Codex jobs are matched to games and formatted for progress", () => {
  const game = { name: "測試專案", code: "testProject", sessions: ["Test App - dev"] };
  const jobs = [
    job({ id: "task-1", label: "其他工作", by: { session: "Test App - dev" } }),
    job({ id: "task-2", label: "testProject 購買審查" }),
    job({ id: "task-3", label: "別的專案", by: { session: "Other - dev" } }),
    // 接手的 session 結尾多編號，一樣算同一個專案
    job({ id: "task-4", label: "接手後的工作", by: { session: "test app - dev 2" } }),
    job({ id: "task-5", label: "名稱不同", by: { session: "Test App - dev2" } }),
  ];
  assert.deepEqual(jobsForGame(jobs, game).map((entry) => entry.id), ["task-1", "task-2", "task-4"]);
  assert.equal(isRunningJob(job({ status: "running" })), true);
  assert.equal(isRunningJob(job({ status: "failed" })), false);
  assert.match(codexJobLine(job({ label: "匯出骨架", write: false, status: "completed", completedAt: "2026-10-06T03:21:41Z", durationMin: 9.5, by: { session: "Test App - dev" } })),
    /〔完成〕匯出骨架（Test App - dev，唯讀審查，2026-10-06 \d\d:21 結束，9\.5 分）/u);
  assert.match(codexJobLine(job({ label: "實作", status: "failed", failReason: "Turn failed" })), /〔失敗〕實作（實作，時間不明 結束）：Turn failed/u);
  assert.match(codexJobLine(job({ label: "跑中", status: "running", startedAt: "2026-10-06T03:00:00Z" })), /〔執行中〕跑中（實作，開始 2026-10-06/u);
});
