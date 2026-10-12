import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Config } from "../config.js";
import type { KnowledgeBaseConfig, WorkerProjectConfig } from "../localConfig.js";
import { stripYamlFrontmatter } from "../prompt/knowledgeSummary.js";
import { subscriptionOnlyEnv } from "../subscriptionEnv.js";
import { killProcessTree, type ProcessTreeKiller } from "../tasks/codexRunner.js";

type WorkerSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
};

export type WorkerSpawn = (
  command: string,
  args: string[],
  options: WorkerSpawnOptions,
) => ChildProcessWithoutNullStreams;

export type WorkerRunInput = {
  channelId: string;
  role: string;
  project: WorkerProjectConfig;
  question: string;
  workerSessionId: string | null;
};

export type WorkerRunResult = {
  text: string;
  sessionId: string | null;
  permissionDeniedPaths: string[];
  usage?: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    durationMs: number;
    attempts: number;
  };
};

export type WorkerRunnerOptions = {
  spawn?: WorkerSpawn;
  killTree?: ProcessTreeKiller;
  warn?: (message: string) => void;
};

export class WorkerRunner {
  readonly #config: Config;
  readonly #knowledgeBase: KnowledgeBaseConfig;
  readonly #timeoutMin: number;
  readonly #spawn: WorkerSpawn;
  readonly #killTree: ProcessTreeKiller;
  readonly #warn: (message: string) => void;
  #active = 0;

  constructor(
    config: Config,
    knowledgeBase: KnowledgeBaseConfig,
    timeoutMin = 5,
    options: WorkerRunnerOptions = {},
  ) {
    this.#config = config;
    this.#knowledgeBase = knowledgeBase;
    this.#timeoutMin = timeoutMin;
    this.#spawn = options.spawn ?? (spawn as WorkerSpawn);
    this.#killTree = options.killTree ?? killProcessTree;
    this.#warn = options.warn ?? console.warn;
  }

  canStart(): boolean {
    return this.#active < 2;
  }

  activeCount(): number {
    return this.#active;
  }

  async run(input: WorkerRunInput, onDelta: (text: string) => void): Promise<WorkerRunResult> {
    if (!this.canStart()) throw new Error("同時進行中的 worker 已達 2 個");
    this.#active += 1;
    try {
      return await this.#run(input, onDelta);
    } finally {
      this.#active -= 1;
    }
  }

  async #run(input: WorkerRunInput, onDelta: (text: string) => void): Promise<WorkerRunResult> {
    const directory = resolve(this.#config.dataDir, "workers", input.channelId);
    const systemPromptPath = resolve(directory, "system-prompt.md");
    const rolePath = resolve(this.#knowledgeBase.path, this.#knowledgeBase.rolesDir, `${input.role}.md`);
    const roleText = stripYamlFrontmatter(readFileSync(rolePath, "utf8"));
    const systemPrompt = [
      roleText,
      "# 唯讀部下通用規則",
      "",
      `- 你是艾莉絲（主人的秘書 AI）派來的「${input.role}」；你只能讀，不能修改任何檔案或執行指令。`,
      "- 回答要具體：結論在前，附引用的檔案路徑（檔案:行號）；不確定就說不確定並標明「未查證」。",
      "- 需要艾莉絲或主人決定的事，列在回覆最後的「需要決定」段落。",
      "- 不讀全域指引；知識庫依角色頁指示查詢。",
    ].join("\n");
    mkdirSync(directory, { recursive: true });
    writeFileSync(systemPromptPath, systemPrompt, "utf8");

    const args = [
      "-p",
      ...(input.workerSessionId === null ? [] : ["--resume", input.workerSessionId]),
      "--safe-mode",
      "--tools", "Read,Grep,Glob",
      "--disallowedTools", "mcp__*",
      "--permission-mode", "dontAsk",
      "--permission-prompts", "none",
      "--add-dir", this.#knowledgeBase.path,
      ...input.project.readDirs.flatMap((directory) => ["--add-dir", directory]),
      "--model", this.#config.model,
      "--effort", "high",
      "--system-prompt-file", systemPromptPath,
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];

    const child = this.#spawn(this.#config.claudePath, args, {
      cwd: input.project.path,
      env: subscriptionOnlyEnv(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    return await new Promise<WorkerRunResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      let buffer = "";
      let stderr = Buffer.alloc(0);
      let text = "";
      let sessionId: string | null = input.workerSessionId;
      let resultText = "";
      let resultError = false;
      let sawResult = false;
      let usage: WorkerRunResult["usage"];
      const permissionDeniedPaths = new Set<string>();

      const finishError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(error);
      };
      const handleLine = (line: string): void => {
        if (line.trim() === "") return;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.#warn(`Ignoring invalid worker stream line: ${line.slice(0, 200)}`);
          return;
        }
        if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
          sessionId = event.session_id;
          return;
        }
        if (event.type === "stream_event") {
          const streamEvent = event.event as Record<string, unknown> | undefined;
          const delta = streamEvent?.delta as Record<string, unknown> | undefined;
          if (streamEvent?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
            text += delta.text;
            onDelta(delta.text);
          }
          return;
        }
        if (event.type === "result") {
          sawResult = true;
          resultError = event.is_error === true;
          if (typeof event.result === "string") resultText = event.result;
          if (typeof event.session_id === "string") sessionId = event.session_id;
          const rawUsage = typeof event.usage === "object" && event.usage !== null
            ? event.usage as Record<string, unknown>
            : undefined;
          if (rawUsage !== undefined) {
            const token = (name: string): number => typeof rawUsage[name] === "number" ? rawUsage[name] as number : 0;
            usage = {
              model: typeof event.model === "string" ? event.model : this.#config.model,
              inputTokens: token("input_tokens"),
              outputTokens: token("output_tokens"),
              cacheReadInputTokens: token("cache_read_input_tokens"),
              cacheCreationInputTokens: token("cache_creation_input_tokens"),
              durationMs: typeof event.duration_ms === "number" ? event.duration_ms : 0,
              attempts: 1,
            };
          }
          if (Array.isArray(event.permission_denials)) {
            for (const denial of event.permission_denials) {
              const item = typeof denial === "object" && denial !== null ? denial as Record<string, unknown> : {};
              const inputValue = typeof item.tool_input === "object" && item.tool_input !== null
                ? item.tool_input as Record<string, unknown>
                : {};
              if (typeof inputValue.file_path === "string") permissionDeniedPaths.add(inputValue.file_path);
            }
          }
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        const pid = child.pid;
        if (pid !== undefined) {
          void Promise.resolve(this.#killTree(pid)).catch((error: unknown) => {
            this.#warn(`Unable to kill timed out worker: ${error instanceof Error ? error.message : String(error)}`);
          });
        } else {
          child.kill("SIGKILL");
        }
        finishError(new Error(`worker 逾時（${this.#timeoutMin} 分鐘）`));
      }, this.#timeoutMin * 60_000);

      child.stdout.on("data", (chunk: Buffer | string) => {
        const lines = `${buffer}${chunk.toString()}`.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-2_048);
      });
      child.stdin.on("error", (error: Error) => this.#warn(`worker stdin error: ${error.message}`));
      child.once("error", (error: Error) => finishError(new Error(`無法啟動 worker：${error.message}`)));
      child.once("close", (code) => {
        if (settled) return;
        if (buffer !== "") handleLine(buffer);
        settled = true;
        clearTimeout(timer);
        if (!sawResult) {
          rejectPromise(new Error(stderr.toString("utf8").trim() || "worker 未回傳 result 事件"));
          return;
        }
        if (code !== 0 || resultError) {
          rejectPromise(new Error(resultText || stderr.toString("utf8").trim() || `worker 結束碼 ${code ?? "unknown"}`));
          return;
        }
        resolvePromise({
          text: text || resultText,
          sessionId,
          permissionDeniedPaths: [...permissionDeniedPaths],
          ...(usage === undefined ? {} : { usage }),
        });
      });
      child.stdin.end(input.question, "utf8");
    });
  }
}
