import type { Task } from "./taskStore.js";

export type TaskRunUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  attempts: number;
};

export type TaskRunnerHooks = {
  onStarted: (details: { codexThreadId?: string; pid?: number }) => void;
  onProgress: (text: string) => void;
  onFinished: (result: {
    status: "succeeded" | "failed" | "cancelled";
    report?: unknown;
    reportError?: string;
    diff?: unknown;
    mismatch?: unknown;
    error?: string;
    usage?: TaskRunUsage;
  }) => void;
};

export interface TaskRunner {
  start(task: Task, hooks: TaskRunnerHooks): void | Promise<void>;
  cancel(taskId: string): void | Promise<void>;
}

export class UnavailableRunner implements TaskRunner {
  readonly #reason: string;

  constructor(reason = "Codex 工具未啟用") {
    this.#reason = reason;
  }

  start(_task: Task, hooks: TaskRunnerHooks): void {
    queueMicrotask(() => hooks.onFinished({
      status: "failed",
      error: this.#reason,
    }));
  }

  cancel(_taskId: string): void {
    // B1 沒有外部行程可取消。
  }
}
