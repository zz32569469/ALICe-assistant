// §65 Codex 任務看板：Core 轉接本機的看板伺服器（~/.claude/scripts/codex-board，只聽 127.0.0.1），
// 給 Web Studio 的「Codex」分頁用（手機透過 Studio 也看得到），並快取任務清單給艾莉絲的進度資料。
// 看板伺服器沒在跑時，用看板腳本 --no-open 啟動它；找不到腳本就當成沒有看板。

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export type CodexJob = {
  id: string;
  label: string;
  repo: string;
  repoPath?: string;
  status: string;
  write?: boolean;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string | null;
  durationMin?: number;
  failReason?: string;
  by?: { role?: string; session?: string; cwd?: string } | null;
  lastEventAt?: string | null;
  lastMsg?: string;
  hasSnapshot?: boolean;
};

export type CodexBoardOptions = {
  url: string;
  script: string | null;
  fetch?: typeof fetch;
  spawnServer?: (script: string) => void;
  now?: () => number;
};

const JOB_ID = /^task-[a-z0-9-]+$/u;
/** 看板的結束狀態；其他（queued、running…）都算還在跑。 */
const DONE = new Set(["completed", "failed", "cancelled", "error"]);

export const isRunningJob = (job: Pick<CodexJob, "status">): boolean => !DONE.has(job.status);

export class CodexBoard {
  readonly #url: string;
  readonly #script: string | null;
  readonly #fetch: typeof fetch;
  readonly #spawnServer: (script: string) => void;
  readonly #now: () => number;
  #lastSpawnAt = 0;
  #cached: CodexJob[] = [];

  constructor(options: CodexBoardOptions) {
    this.#url = options.url.replace(/\/+$/u, "");
    this.#script = options.script !== null && existsSync(options.script) ? options.script : null;
    this.#fetch = options.fetch ?? fetch;
    this.#spawnServer = options.spawnServer ?? ((script) => {
      spawn(process.execPath, [script, "--no-open"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    });
    this.#now = options.now ?? Date.now;
  }

  /** 有沒有看板可用（找得到看板腳本）。 */
  get configured(): boolean {
    return this.#script !== null;
  }

  /** 最近一次取得的任務清單（給進度資料用，不等網路）。 */
  cachedJobs(): CodexJob[] {
    return this.#cached;
  }

  async #get<T>(path: string, timeoutMs = 5_000): Promise<T> {
    const response = await this.#fetch(`${this.#url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`看板回應 HTTP ${response.status}`);
    return await response.json() as T;
  }

  /** 看板伺服器沒回應時啟動它（一分鐘最多一次），再等它起來。 */
  async #ensureServer(): Promise<void> {
    try {
      await this.#get("/api/ping", 1_500);
      return;
    } catch {
      if (this.#script === null) throw new Error("找不到 Codex 看板腳本");
    }
    if (this.#now() - this.#lastSpawnAt > 60_000) {
      this.#lastSpawnAt = this.#now();
      this.#spawnServer(this.#script!);
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        await this.#get("/api/ping", 1_000);
        return;
      } catch {
        // 還沒起來，繼續等。
      }
    }
    throw new Error("Codex 看板伺服器沒有回應");
  }

  async jobs(): Promise<{ jobs: CodexJob[]; quota: unknown }> {
    await this.#ensureServer();
    const [jobs, quota] = await Promise.all([this.#get<CodexJob[]>("/api/jobs"), this.#get<unknown>("/api/quota").catch(() => null)]);
    this.#cached = Array.isArray(jobs) ? jobs : [];
    return { jobs: this.#cached, quota };
  }

  async job(id: string): Promise<unknown> {
    if (!JOB_ID.test(id)) throw new Error("任務 id 格式不對");
    await this.#ensureServer();
    return await this.#get(`/api/jobs/${id}`);
  }

  async diff(id: string): Promise<{ text: string }> {
    if (!JOB_ID.test(id)) throw new Error("任務 id 格式不對");
    await this.#ensureServer();
    return await this.#get(`/api/jobs/${id}/diff`, 60_000);
  }

/** §66：在這台電腦開該任務的進度視窗、log 或 repo 資料夾（看板要求 POST＋自訂標頭）。 */
  async open(id: string, target: "watch" | "log" | "repo"): Promise<void> {
    if (!JOB_ID.test(id)) throw new Error("任務 id 格式不對");
    await this.#ensureServer();
    const response = await this.#fetch(`${this.#url}/api/jobs/${id}/open-${target}`, {
      method: "POST", headers: { "X-Codex-Board": "1" }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`看板回應 HTTP ${response.status}`);
  }

  /** 背景更新快取（main 定時呼叫）；失敗就保留舊的。 */
  async refreshCache(): Promise<void> {
    try {
      await this.jobs();
    } catch {
      // 看板不可用時不影響其他功能。
    }
  }
}

/** session 名稱比對用：去掉接手時加的結尾編號（「<Project> - dev 2」算「<Project> - dev」），不分大小寫。 */
export const sessionBase = (name: string): string => name.trim().replace(/\s+\d+$/u, "").toLowerCase();

/** 一個專案相關的 Codex 任務：委派的 session 在卡片的 sessions 裡（接手的編號不算差別），或任務名稱含專案名稱或英文代號。 */
export function jobsForGame(jobs: CodexJob[], game: { name: string; code: string; sessions: string[] }): CodexJob[] {
  const name = game.name.toLowerCase();
  const code = game.code.toLowerCase();
  const sessions = new Set(game.sessions.map(sessionBase));
  return jobs.filter((job) => {
    if (job.by?.session && sessions.has(sessionBase(job.by.session))) return true;
    const label = job.label.toLowerCase();
    return (name !== "" && label.includes(name)) || (code !== "" && label.includes(code));
  });
}
