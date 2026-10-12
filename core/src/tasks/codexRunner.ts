import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";

import type { Config } from "../config.js";
import { subscriptionOnlyEnv } from "../subscriptionEnv.js";
import { checkCodexAuth, type CodexAuthExec } from "./codexAuth.js";
import {
  compareReportedFiles,
  diffSnapshots,
  Snapshotter,
  type RepoSnapshot,
  type ReportedFile,
  type SnapshotDiff,
  type SnapshotMismatch,
} from "./snapshot.js";
import type { TaskRunner, TaskRunnerHooks, TaskRunUsage } from "./taskRunner.js";
import type { Task } from "./taskStore.js";

type CodexSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  detached: boolean;
  stdio: ["pipe", "pipe", "pipe"];
};

export type CodexSpawn = (
  command: string,
  args: string[],
  options: CodexSpawnOptions,
) => ChildProcessWithoutNullStreams;

export type ProcessTreeKiller = (pid: number) => void | Promise<void>;

export type CodexReport = {
  summary: string;
  filesChanged: ReportedFile[];
  tests: Array<{ command: string; result: "pass" | "fail" | "not_run"; detail: string }>;
  acceptance: Array<{ criterion: string; met: boolean; evidence: string }>;
  unfinished: string[];
  notes: string;
};

export const CODEX_REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    filesChanged: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          change: { type: "string", enum: ["added", "modified", "deleted"] },
        },
        required: ["path", "change"],
      },
    },
    tests: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          command: { type: "string" },
          result: { type: "string", enum: ["pass", "fail", "not_run"] },
          detail: { type: "string" },
        },
        required: ["command", "result", "detail"],
      },
    },
    acceptance: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterion: { type: "string" },
          met: { type: "boolean" },
          evidence: { type: "string" },
        },
        required: ["criterion", "met", "evidence"],
      },
    },
    unfinished: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["summary", "filesChanged", "tests", "acceptance", "unfinished", "notes"],
} as const;

type ActiveRun = {
  child?: ChildProcessWithoutNullStreams;
  pid?: number;
  cancelled: boolean;
  timedOut: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
};

export type CodexRunnerOptions = {
  spawn?: CodexSpawn;
  authExec?: CodexAuthExec;
  snapshotter?: Pick<Snapshotter, "take">;
  killTree?: ProcessTreeKiller;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexTurnUsage(event: Record<string, unknown>): TaskRunUsage | undefined {
  if (event.type !== "turn.completed" || !isRecord(event.usage)) return undefined;
  const usage = event.usage;
  const token = (name: string): number => {
    const value = usage[name];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  };
  const output = token("output_tokens");
  const reasoning = token("reasoning_output_tokens");
  return {
    model: typeof event.model === "string" ? event.model : "codex",
    inputTokens: token("input_tokens"),
    cacheReadInputTokens: token("cached_input_tokens"),
    outputTokens: output + reasoning,
    cacheCreationInputTokens: 0,
    reasoningTokens: reasoning,
    attempts: 1,
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function validateCodexReport(value: unknown): value is CodexReport {
  if (!isRecord(value) || !hasExactKeys(value, [
    "summary", "filesChanged", "tests", "acceptance", "unfinished", "notes",
  ])) return false;
  if (typeof value.summary !== "string" || typeof value.notes !== "string" || !isStringArray(value.unfinished)) {
    return false;
  }
  if (!Array.isArray(value.filesChanged) || !value.filesChanged.every((item) =>
    isRecord(item) && hasExactKeys(item, ["path", "change"])
    && typeof item.path === "string"
    && ["added", "modified", "deleted"].includes(String(item.change)))) return false;
  if (!Array.isArray(value.tests) || !value.tests.every((item) =>
    isRecord(item) && hasExactKeys(item, ["command", "result", "detail"])
    && typeof item.command === "string" && typeof item.detail === "string"
    && ["pass", "fail", "not_run"].includes(String(item.result)))) return false;
  return Array.isArray(value.acceptance) && value.acceptance.every((item) =>
    isRecord(item) && hasExactKeys(item, ["criterion", "met", "evidence"])
    && typeof item.criterion === "string" && typeof item.met === "boolean"
    && typeof item.evidence === "string");
}

export function taskPrompt(task: Task): string {
  const acceptance = task.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  return [
    "# 目標", task.goal, "", "# 驗收標準", acceptance, "", "# instructions", task.instructions, "",
    "# 固定規則",
    "- 這是 Alice Core 派的任務：不需要讀取全域指引（~/.claude/CLAUDE.md、~/.codex/AGENTS.md 提到的檔案）或 工作知識庫 知識庫，只依本任務說明與 repo 內容工作。",
    "- 不 commit。",
    "- 不切分支。",
    "- 不執行 git stash、git reset 或 git checkout。",
    "- 不還原或改寫工作區中既有的未提交改動。",
    "- 只修改 repo 內的檔案。",
    "- 做不到時立即停下，並在回報中說明原因。",
    "- 最後回覆必須符合指定的 JSON Schema。",
    "- acceptance 必須逐條對應本任務的驗收標準，並附上證據。",
    "- tests 必須附上實際執行的指令與結果。",
    "- 發現會影響這次修改、或與規格書、驗收標準互相矛盾的地方，寫進 notes，開頭標「規格衝突：」（計畫會暫停等主人決定）；不影響這次修改的差異寫「發現的差異：」，照常完成。",
    "- 發現值得存進知識庫的新知識或踩坑（前因後果與證據），寫進 notes，開頭標「回寫候選：」，每條一行；沒有就不寫。",
    "",
  ].join("\n");
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["message", "error", "detail"]) {
    const found = errorMessage(value[key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function progressFrom(event: Record<string, unknown>): string[] {
  if (event.type !== "item.completed") return [];
  const item = isRecord(event.item) ? event.item : isRecord(event.data) ? event.data : undefined;
  if (item === undefined) return [];
  const type = typeof item.type === "string" ? item.type.replaceAll("-", "_") : "";
  if (type === "command_execution") {
    const command = Array.isArray(item.command) ? item.command.join(" ")
      : typeof item.command === "string" ? item.command
        : typeof item.command_line === "string" ? item.command_line : undefined;
    const exitCode = typeof item.exit_code === "number" ? item.exit_code
      : typeof item.exitCode === "number" ? item.exitCode : undefined;
    return command === undefined ? [] : [`$ ${command}（結束碼 ${exitCode ?? "未知"}）`];
  }
  if (type === "file_change") {
    const paths: string[] = [];
    if (typeof item.path === "string") paths.push(item.path);
    if (Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (isRecord(change) && typeof change.path === "string") paths.push(change.path);
      }
    }
    return [...new Set(paths)].map((path) => `✎ ${path}`);
  }
  if (type === "agent_message") {
    const text = typeof item.text === "string" ? item.text
      : typeof item.message === "string" ? item.message
        : typeof item.content === "string" ? item.content : undefined;
    if (text === undefined) return [];
    let progressText = text;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && typeof parsed.summary === "string") progressText = parsed.summary;
    } catch {
      // 非 JSON 的 agent_message 沿用原始文字。
    }
    return [Array.from(progressText).slice(0, 120).join("")];
  }
  return [];
}

export async function killProcessTree(
  pid: number,
  targetPlatform: NodeJS.Platform = platform(),
  exec: typeof execFile = execFile,
): Promise<void> {
  if (targetPlatform !== "win32") {
    try { process.kill(-pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    return;
  }
  await new Promise<void>((resolvePromise, rejectPromise) => {
    exec("taskkill", ["/T", "/F", "/PID", String(pid)], { shell: false, windowsHide: true }, (error, _stdout, stderr) => {
      const code = (error as (Error & { code?: string | number }) | null)?.code;
      const missing = code === "ESRCH" || code === 128
        || /not found|找不到|沒有.*行程|不存在/i.test(stderr);
      if (error !== null && !missing) rejectPromise(error);
      else resolvePromise();
    });
  });
}

export class CodexRunner implements TaskRunner {
  readonly #config: Config;
  readonly #spawn: CodexSpawn;
  readonly #authExec: CodexAuthExec | undefined;
  readonly #snapshotter: Pick<Snapshotter, "take">;
  readonly #killTree: ProcessTreeKiller;
  readonly #platform: NodeJS.Platform;
  readonly #warn: (message: string) => void;
  readonly #active = new Map<string, ActiveRun>();

  constructor(config: Config, options: CodexRunnerOptions = {}) {
    this.#config = config;
    this.#spawn = options.spawn ?? (spawn as CodexSpawn);
    this.#authExec = options.authExec;
    this.#snapshotter = options.snapshotter ?? new Snapshotter();
    this.#platform = options.platform ?? platform();
    this.#killTree = options.killTree ?? ((pid) => killProcessTree(pid, this.#platform));
    this.#warn = options.warn ?? console.warn;
  }

  start(task: Task, hooks: TaskRunnerHooks): Promise<void> {
    if (this.#active.has(task.id)) throw new Error(`Task already running: ${task.id}`);
    let resolveFinished!: () => void;
    const finished = new Promise<void>((resolvePromise) => { resolveFinished = resolvePromise; });
    const active: ActiveRun = { cancelled: false, timedOut: false, finished, resolveFinished };
    this.#active.set(task.id, active);
    return this.#run(task, hooks, active);
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.#active.get(taskId);
    if (active === undefined) return;
    active.cancelled = true;
    if (active.pid !== undefined) await this.#killTree(active.pid);
    await active.finished;
  }

  async #run(task: Task, hooks: TaskRunnerHooks, active: ActiveRun): Promise<void> {
    let before: RepoSnapshot | undefined;
    try {
      try {
        await checkCodexAuth(this.#config, this.#authExec);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        hooks.onFinished({ status: "failed", error: `Codex 未以 ChatGPT 訂閱登入：${detail}` });
        return;
      }
      try {
        before = await this.#snapshotter.take(task.repoPath);
      } catch (error) {
        hooks.onFinished({
          status: "failed",
          error: error instanceof Error && error.message === "repo 不是 git repo"
            ? error.message : `無法建立執行前快照：${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
      if (active.cancelled) {
        await this.#finishWithSnapshot(task, hooks, before, { status: "cancelled" });
        return;
      }

      const directory = resolve(this.#config.dataDir, "tasks", task.id);
      const schemaPath = resolve(directory, "schema.json");
      const reportPath = resolve(directory, "report.json");
      const promptPath = resolve(directory, "prompt.md");
      const eventsPath = resolve(directory, "events.jsonl");
      const prompt = taskPrompt(task);
      mkdirSync(directory, { recursive: true });
      writeFileSync(schemaPath, `${JSON.stringify(CODEX_REPORT_SCHEMA, null, 2)}\n`, "utf8");
      writeFileSync(promptPath, prompt, "utf8");
      writeFileSync(eventsPath, "", "utf8");
      const args = [
        "exec", "--json", "-C", task.repoPath, "-s", "workspace-write",
        "--output-schema", schemaPath, "-o", reportPath,
      ];
      const child = this.#spawn(this.#config.tools.codex.codexPath, args, {
        cwd: directory,
        env: subscriptionOnlyEnv(),
        shell: false,
        detached: this.#platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      active.child = child;
      if (typeof child.pid === "number") {
        active.pid = child.pid;
        hooks.onStarted({ pid: child.pid });
      }

      await new Promise<void>((resolveClose) => {
        let stdoutBuffer = "";
        let stderrTail = Buffer.alloc(0);
        let turnFailure: string | undefined;
        let spawnError: string | undefined;
        let turnUsage: TaskRunUsage | undefined;
        let settled = false;
        const timeout = setTimeout(() => {
          active.timedOut = true;
          if (active.pid !== undefined) {
            void Promise.resolve(this.#killTree(active.pid)).catch((error: unknown) => {
              this.#warn(`Codex timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        }, Math.max(0, this.#config.tools.codex.taskTimeoutMin * 60_000));
        const handleLine = (line: string): void => {
          if (line.trim() === "") return;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
          if (event.type === "thread.started") {
            const threadId = typeof event.thread_id === "string" ? event.thread_id
              : typeof event.id === "string" ? event.id : undefined;
            if (threadId !== undefined) hooks.onStarted({ codexThreadId: threadId });
          } else if (event.type === "turn.failed") {
            turnFailure = errorMessage(event.error) ?? errorMessage(event.message) ?? "Codex turn failed";
          } else if (event.type === "turn.completed") {
            turnUsage = parseCodexTurnUsage(event) ?? turnUsage;
          } else {
            for (const text of progressFrom(event)) hooks.onProgress(text);
          }
        };
        const finish = (code: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (stdoutBuffer !== "") handleLine(stdoutBuffer);
          const base = active.cancelled ? { status: "cancelled" as const }
            : active.timedOut ? {
                status: "failed" as const,
                error: `逾時（上限 ${this.#config.tools.codex.taskTimeoutMin} 分鐘）`,
              }
              : turnFailure !== undefined || code !== 0 || spawnError !== undefined
                ? {
                    status: "failed" as const,
                    error: turnFailure ?? spawnError ?? (
                      stderrTail.toString("utf8").trim() || `Codex exited with code ${code ?? "unknown"}`
                    ),
                  }
                : undefined;
          void (base === undefined
              ? this.#finishSuccess(task, hooks, before!, reportPath, turnUsage)
              : this.#finishWithSnapshot(task, hooks, before!, { ...base, ...(turnUsage === undefined ? {} : { usage: turnUsage }) }))
            .finally(resolveClose);
        };
        child.stdout.on("data", (chunk: Buffer | string) => {
          const text = chunk.toString();
          appendFileSync(eventsPath, text, "utf8");
          const lines = `${stdoutBuffer}${text}`.split(/\r?\n/);
          stdoutBuffer = lines.pop() ?? "";
          for (const line of lines) handleLine(line);
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-2_048);
        });
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          this.#warn(`Codex stdin error: ${error.message}`);
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
          spawnError = `無法啟動 Codex：${error.message}`;
        });
        child.once("close", (code) => finish(code));
        child.stdin.end(prompt, "utf8");
      });
    } catch (error) {
      if (before === undefined) {
        hooks.onFinished({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      } else {
        await this.#finishWithSnapshot(task, hooks, before, {
          status: active.cancelled ? "cancelled" : "failed",
          ...(active.cancelled ? {} : { error: error instanceof Error ? error.message : String(error) }),
        });
      }
    } finally {
      this.#active.delete(task.id);
      active.resolveFinished();
    }
  }

  async #finishSuccess(
    task: Task,
    hooks: TaskRunnerHooks,
    before: RepoSnapshot,
    reportPath: string,
    usage?: TaskRunUsage,
  ): Promise<void> {
    let report: CodexReport | null = null;
    let reportError: string | undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
      if (!validateCodexReport(value)) throw new Error("report.json 不符合 schema");
      report = value;
    } catch (error) {
      reportError = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "找不到 report.json" : error instanceof SyntaxError
          ? "report.json 不是有效 JSON" : error instanceof Error ? error.message : String(error);
    }
    await this.#finishWithSnapshot(task, hooks, before, {
      status: "succeeded",
      report,
      ...(reportError === undefined ? {} : { reportError }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  async #finishWithSnapshot(
    task: Task,
    hooks: TaskRunnerHooks,
    before: RepoSnapshot,
    result: Parameters<TaskRunnerHooks["onFinished"]>[0],
  ): Promise<void> {
    let diff: SnapshotDiff | undefined;
    let mismatch: SnapshotMismatch | undefined;
    try {
      diff = diffSnapshots(before, await this.#snapshotter.take(task.repoPath));
      const report = validateCodexReport(result.report) ? result.report : undefined;
      mismatch = compareReportedFiles(diff, report?.filesChanged ?? []);
    } catch (error) {
      this.#warn(`Unable to create final task snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
    hooks.onFinished({ ...result, ...(diff === undefined ? {} : { diff, mismatch }) });
  }
}
