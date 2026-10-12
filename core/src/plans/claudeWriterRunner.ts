import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_TEST_COMMANDS, type Config } from "../config.js";
import { subscriptionOnlyEnv } from "../subscriptionEnv.js";
import {
  CODEX_REPORT_SCHEMA,
  killProcessTree,
  taskPrompt,
  validateCodexReport,
  type CodexReport,
  type ProcessTreeKiller,
} from "../tasks/codexRunner.js";
import {
  compareReportedFiles,
  diffSnapshots,
  Snapshotter,
  type RepoSnapshot,
  type SnapshotDiff,
  type SnapshotMismatch,
} from "../tasks/snapshot.js";
import type { TaskRunner, TaskRunnerHooks, TaskRunUsage } from "../tasks/taskRunner.js";
import type { Task } from "../tasks/taskStore.js";

type WriterSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  detached: boolean;
  stdio: ["pipe", "pipe", "pipe"];
};

export type WriterSpawn = (
  command: string,
  args: string[],
  options: WriterSpawnOptions,
) => ChildProcessWithoutNullStreams;

export type ClaudeWriterRunnerOptions = {
  spawn?: WriterSpawn;
  snapshotter?: Pick<Snapshotter, "take">;
  killTree?: ProcessTreeKiller;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
  /** 依任務取得可執行的測試指令（C2-1）；預設 ["npm test"]。 */
  testCommandsFor?: (task: Task) => string[];
};

type ActiveRun = {
  pid?: number;
  cancelled: boolean;
  timedOut: boolean;
  finished: Promise<void>;
  resolveFinished: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function writerPrompt(task: Task, testCommands: readonly string[]): string {
  return [
    taskPrompt(task),
    "# Claude 寫檔 worker 的額外規則",
    "- 你是艾莉絲（主人的秘書 AI）派來寫程式的 worker；Codex 目前不可用，所以由你直接修改檔案。",
    `- 你只能執行這些指令：${testCommands.map((command) => `\`${command}\``).join("、")}；其他指令都會被拒絕，不要嘗試繞過。`,
    "- 不刪除檔案；需要刪除時停下，在 unfinished 說明。",
    "",
  ].join("\n");
}

/** repo 內的路徑轉成 repo 相對路徑；repo 外的維持原樣。 */
function relativeInside(root: string, path: string): string {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath) ? path : relativePath.split("\\").join("/");
}

/**
 * 從 stream-json 的 assistant 訊息取出工具呼叫，轉成一行進度。
 * repo 內的檔案顯示成 repo 相對路徑（Web Studio 實測：絕對路徑太長）。
 */
export function writerProgress(event: Record<string, unknown>, repoPath?: string): string[] {
  if (event.type !== "assistant" || !isRecord(event.message) || !Array.isArray(event.message.content)) return [];
  const lines: string[] = [];
  for (const block of event.message.content) {
    if (!isRecord(block) || block.type !== "tool_use" || !isRecord(block.input)) continue;
    const input = block.input;
    if ((block.name === "Edit" || block.name === "Write") && typeof input.file_path === "string") {
      const shown = repoPath === undefined ? input.file_path : relativeInside(repoPath, input.file_path);
      lines.push(`✎ ${shown}`);
    } else if (block.name === "Bash" && typeof input.command === "string") {
      lines.push(`$ ${input.command}`);
    }
  }
  return lines;
}

export class ClaudeWriterRunner implements TaskRunner {
  readonly #config: Config;
  readonly #spawn: WriterSpawn;
  readonly #snapshotter: Pick<Snapshotter, "take">;
  readonly #killTree: ProcessTreeKiller;
  readonly #platform: NodeJS.Platform;
  readonly #warn: (message: string) => void;
  readonly #testCommandsFor: (task: Task) => string[];
  readonly #active = new Map<string, ActiveRun>();

  constructor(config: Config, options: ClaudeWriterRunnerOptions = {}) {
    this.#config = config;
    this.#spawn = options.spawn ?? (spawn as WriterSpawn);
    this.#snapshotter = options.snapshotter ?? new Snapshotter();
    this.#platform = options.platform ?? platform();
    this.#killTree = options.killTree ?? ((pid) => killProcessTree(pid, this.#platform));
    this.#warn = options.warn ?? console.warn;
    this.#testCommandsFor = options.testCommandsFor ?? (() => DEFAULT_TEST_COMMANDS);
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

      const testCommands = this.#testCommandsFor(task);
      const directory = resolve(this.#config.dataDir, "tasks", task.id);
      const prompt = writerPrompt(task, testCommands);
      const eventsPath = resolve(directory, "events.jsonl");
      mkdirSync(directory, { recursive: true });
      writeFileSync(resolve(directory, "prompt.md"), prompt, "utf8");
      writeFileSync(resolve(directory, "schema.json"), `${JSON.stringify(CODEX_REPORT_SCHEMA, null, 2)}\n`, "utf8");
      writeFileSync(eventsPath, "", "utf8");
      const args = [
        "-p",
        "--safe-mode",
        "--tools", "Read,Grep,Glob,Edit,Write,Bash",
        "--disallowedTools", "mcp__*",
        "--permission-mode", "dontAsk",
        "--permission-prompts", "none",
        "--allowedTools", "Edit", "Write", ...testCommands.map((command) => `Bash(${command})`),
        "--model", this.#config.model,
        "--effort", "high",
        "--json-schema", JSON.stringify(CODEX_REPORT_SCHEMA),
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
      ];
      const child = this.#spawn(this.#config.claudePath, args, {
        cwd: task.repoPath,
        env: subscriptionOnlyEnv(),
        shell: false,
        detached: this.#platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (typeof child.pid === "number") {
        active.pid = child.pid;
        hooks.onStarted({ pid: child.pid });
      }

      await new Promise<void>((resolveClose) => {
        let buffer = "";
        let stderrTail = Buffer.alloc(0);
        let resultEvent: Record<string, unknown> | undefined;
        let spawnError: string | undefined;
        let settled = false;
        const timeout = setTimeout(() => {
          active.timedOut = true;
          if (active.pid !== undefined) {
            void Promise.resolve(this.#killTree(active.pid)).catch((error: unknown) => {
              this.#warn(`Claude writer timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        }, Math.max(0, this.#config.tools.codex.taskTimeoutMin * 60_000));
        const handleLine = (line: string): void => {
          if (line.trim() === "") return;
          let event: Record<string, unknown>;
          try { event = JSON.parse(line) as Record<string, unknown>; } catch { return; }
          if (event.type === "result") resultEvent = event;
          for (const text of writerProgress(event, task.repoPath)) hooks.onProgress(text);
        };
        const finish = (code: number | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (buffer !== "") handleLine(buffer);
          const usage = this.#usageFrom(resultEvent);
          const withUsage = usage === undefined ? {} : { usage };
          let outcome: Promise<void>;
          if (active.cancelled) {
            outcome = this.#finishWithSnapshot(task, hooks, before!, { status: "cancelled", ...withUsage });
          } else if (active.timedOut) {
            outcome = this.#finishWithSnapshot(task, hooks, before!, {
              status: "failed", error: `逾時（上限 ${this.#config.tools.codex.taskTimeoutMin} 分鐘）`, ...withUsage,
            });
          } else if (spawnError !== undefined || resultEvent === undefined || resultEvent.is_error === true || code !== 0) {
            const detail = spawnError
              ?? (typeof resultEvent?.result === "string" && resultEvent.result.trim() !== "" ? resultEvent.result : undefined)
              ?? (stderrTail.toString("utf8").trim() || `Claude 寫檔 worker 結束碼 ${code ?? "unknown"}`);
            outcome = this.#finishWithSnapshot(task, hooks, before!, { status: "failed", error: detail, ...withUsage });
          } else {
            const structured = resultEvent.structured_output;
            const report: CodexReport | null = validateCodexReport(structured) ? structured : null;
            outcome = this.#finishWithSnapshot(task, hooks, before!, {
              status: "succeeded",
              report,
              ...(report === null ? { reportError: "structured_output 缺少或不符合 schema" } : {}),
              ...withUsage,
            });
          }
          void outcome.finally(resolveClose);
        };
        child.stdout.on("data", (chunk: Buffer | string) => {
          const text = chunk.toString();
          appendFileSync(eventsPath, text, "utf8");
          const lines = `${buffer}${text}`.split(/\r?\n/u);
          buffer = lines.pop() ?? "";
          for (const line of lines) handleLine(line);
        });
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-2_048);
        });
        child.stdin.on("error", (error: NodeJS.ErrnoException) => {
          this.#warn(`Claude writer stdin error: ${error.message}`);
        });
        child.once("error", (error: NodeJS.ErrnoException) => {
          spawnError = `無法啟動 Claude Code：${error.message}`;
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

  #usageFrom(result: Record<string, unknown> | undefined): TaskRunUsage | undefined {
    if (result === undefined) return undefined;
    const usage = isRecord(result.usage) ? result.usage : {};
    let model = this.#config.model;
    let topOutput = -1;
    if (isRecord(result.modelUsage)) {
      for (const [name, value] of Object.entries(result.modelUsage)) {
        const output = isRecord(value) ? numberValue(value.outputTokens) : 0;
        if (output > topOutput) { topOutput = output; model = name; }
      }
    }
    return {
      model,
      inputTokens: numberValue(usage.input_tokens),
      outputTokens: numberValue(usage.output_tokens),
      cacheReadInputTokens: numberValue(usage.cache_read_input_tokens),
      cacheCreationInputTokens: numberValue(usage.cache_creation_input_tokens),
      reasoningTokens: 0,
      attempts: 1,
    };
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
      this.#warn(`Unable to create final writer snapshot: ${error instanceof Error ? error.message : String(error)}`);
    }
    hooks.onFinished({ ...result, ...(diff === undefined ? {} : { diff, mismatch }) });
  }
}
