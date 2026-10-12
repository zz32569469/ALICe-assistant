import type { Config } from "../config.js";
import { EventHub } from "../protocol/eventHub.js";
import { ErrorLogger } from "../reliability/errorLog.js";
import { CharacterState } from "../state/characterState.js";
import { MessageStore, type Message } from "../store/messageStore.js";
import type { UsageStore } from "../usage/usageStore.js";
import { TASK_BLOCK_MARKERS } from "./taskBlockFilter.js";
import type { TaskRunner, TaskRunnerHooks } from "./taskRunner.js";
import { TaskStore, type Task, type TaskStatus } from "./taskStore.js";

type TaskRequest = {
  tool: "codex";
  repo: string;
  goal: string;
  instructions: string;
  acceptance: string[];
  estimateMin?: number;
  planId?: string;
};

type CompletionHandler = (message: Message, task: Task) => void;
export type TaskRepoStatusReader = (repoPath: string) => Promise<string[]>;

export class TaskServiceError extends Error {
  readonly code: "not_found" | "conflict";
  constructor(code: "not_found" | "conflict", message: string) {
    super(message);
    this.name = "TaskServiceError";
    this.code = code;
  }
}

function parseRequest(blockText: string): TaskRequest {
  if (!blockText.startsWith(TASK_BLOCK_MARKERS.start) || !blockText.endsWith(TASK_BLOCK_MARKERS.end)) {
    throw new Error("任務區塊標記不完整");
  }
  const jsonText = blockText
    .slice(TASK_BLOCK_MARKERS.start.length, -TASK_BLOCK_MARKERS.end.length)
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error("任務區塊 JSON 格式錯誤");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("任務內容必須是 JSON 物件");
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(["tool", "repo", "goal", "instructions", "acceptance", "estimateMin", "planId"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) {
    throw new Error("任務包含不支援的欄位");
  }
  if (item.tool !== "codex") throw new Error("tool 必須是 codex");
  for (const key of ["repo", "goal", "instructions"] as const) {
    if (typeof item[key] !== "string" || item[key].trim() === "") {
      throw new Error(`${key} 必須是非空白字串`);
    }
  }
  if (
    !Array.isArray(item.acceptance) || item.acceptance.length < 1 || item.acceptance.length > 10 ||
    item.acceptance.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error("acceptance 必須包含 1～10 條非空白字串");
  }
  if (item.estimateMin !== undefined &&
      (typeof item.estimateMin !== "number" || !Number.isFinite(item.estimateMin) || item.estimateMin <= 0)) {
    throw new Error("estimateMin 必須是正數");
  }
  if (item.planId !== undefined && (typeof item.planId !== "string" || item.planId.trim() === "")) {
    throw new Error("planId 必須是非空白字串");
  }
  return item as TaskRequest;
}

function terminal(status: TaskStatus): boolean {
  return ["succeeded", "failed", "cancelled", "rejected", "expired"].includes(status);
}

export class TaskService {
  readonly #config: Config;
  readonly #tasks: TaskStore;
  readonly #messages: MessageStore;
  readonly #state: CharacterState;
  readonly #runner: TaskRunner;
  readonly #events: EventHub;
  readonly #usage: UsageStore | undefined;
  readonly #errors: ErrorLogger;
  readonly #now: () => Date;
  readonly #killOrphan: (pid: number) => void | Promise<void>;
  readonly #repoStatus: TaskRepoStatusReader | undefined;
  readonly #approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #progress = new Map<string, { second: number; texts: string[]; timer?: ReturnType<typeof setTimeout> }>();
  #completionHandler: CompletionHandler | undefined;

  constructor(options: {
    config: Config;
    tasks: TaskStore;
    messages: MessageStore;
    state: CharacterState;
    runner: TaskRunner;
    events: EventHub;
    now?: () => Date;
    killOrphan?: (pid: number) => void | Promise<void>;
    repoStatus?: TaskRepoStatusReader;
    usage?: UsageStore;
    errors?: ErrorLogger;
  }) {
    this.#config = options.config;
    this.#tasks = options.tasks;
    this.#messages = options.messages;
    this.#state = options.state;
    this.#runner = options.runner;
    this.#events = options.events;
    this.#now = options.now ?? (() => new Date());
    this.#killOrphan = options.killOrphan ?? (() => undefined);
    this.#repoStatus = options.repoStatus;
    this.#usage = options.usage;
    this.#errors = options.errors ?? new ErrorLogger(options.config.dataDir, this.#now);
  }

  setCompletionHandler(handler: CompletionHandler): void {
    this.#completionHandler = handler;
  }

  createFromBlock(blockText: string, sourceMessageId: string): Task | undefined {
    let request: TaskRequest;
    try {
      request = parseRequest(blockText);
      if (!this.#config.tools.codex.enabled) throw new Error("Codex 工具未啟用");
      const repo = this.#config.tools.codex.repos[request.repo];
      if (repo === undefined) throw new Error("repo 不在白名單");
      if (this.#tasks.active() !== undefined) throw new Error("已有任務等待確認或執行中");

      const createdAt = this.#now().toISOString();
      const task = this.#tasks.create({
        planId: request.planId ?? null,
        sourceMessageId,
        tool: request.tool,
        repo: request.repo,
        repoPath: repo.path,
        goal: request.goal,
        instructions: request.instructions,
        acceptance: request.acceptance,
        estimateMin: request.estimateMin ?? null,
        createdAt,
      });
      const expiresAt = new Date(
        this.#now().getTime() + this.#config.tools.codex.approvalTimeoutMin * 60_000,
      ).toISOString();
      this.#events.broadcast("task.created", task);
      const permissionRequest = {
        taskId: task.id,
        tool: task.tool,
        repo: task.repo,
        repoPath: task.repoPath,
        goal: task.goal,
        acceptance: task.acceptance,
        estimateMin: task.estimateMin,
        expiresAt,
      };
      if (this.#repoStatus === undefined) {
        this.#events.broadcast("permission.request", permissionRequest);
      } else {
        void this.#repoStatus(task.repoPath)
          .catch(() => [] as string[])
          .then((dirtyFiles) => this.#events.broadcast("permission.request", { ...permissionRequest, dirtyFiles }));
      }
      this.#scheduleExpiry(task);
      return task;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#events.broadcast("task.rejected", { reason });
      this.#appendSystem(`任務未建立：${reason}`);
      return undefined;
    }
  }

  list(limit?: number): Task[] {
    return this.#tasks.list(limit);
  }

  get(id: string): Task {
    const task = this.#tasks.get(id);
    if (task === undefined) throw new TaskServiceError("not_found", "任務不存在");
    return task;
  }

  active(): Task | undefined {
    return this.#tasks.active();
  }

  approve(id: string, clientId: string): Task {
    const task = this.#requirePending(id);
    this.#clearApprovalTimer(id);
    const decidedAt = this.#now().toISOString();
    this.#tasks.update(id, { status: "approved", decidedAt, decidedBy: clientId });
    this.#events.broadcast("permission.resolved", { taskId: id, result: "approved", decidedAt, decidedBy: clientId });
    return this.#start(task.id);
  }

  reject(id: string, clientId: string, reason?: string): Task {
    const task = this.#requirePending(id);
    this.#clearApprovalTimer(id);
    const decidedAt = this.#now().toISOString();
    const updated = this.#tasks.update(id, {
      status: "rejected", decidedAt, decidedBy: clientId,
      error: reason?.trim() === "" ? null : reason ?? null,
    });
    this.#events.broadcast("permission.resolved", {
      taskId: id, result: "rejected", decidedAt, decidedBy: clientId, ...(reason ? { reason } : {}),
    });
    const message = this.#appendSystem(`主人拒絕了任務：${task.goal}${reason ? `（${reason}）` : ""}`);
    this.#completionHandler?.(message, updated);
    return updated;
  }

  async cancel(id: string): Promise<Task> {
    const task = this.get(id);
    if (task.status !== "running") throw new TaskServiceError("conflict", "只有執行中的任務可以取消");
    try {
      await this.#runner.cancel(id);
    } catch (error) {
      console.warn("Task runner cancel failed:", error instanceof Error ? error.message : error);
    }
    return this.#finish(id, { status: "cancelled" });
  }

  async recover(): Promise<void> {
    for (const task of this.#tasks.listByStatuses(["pending_approval"])) {
      this.#expire(task, "Core 重啟，確認失效", false);
    }
    for (const task of this.#tasks.listByStatuses(["running", "approved"])) {
      if (task.pid !== null) {
        try {
          await this.#killOrphan(task.pid);
        } catch (error) {
          console.warn("Unable to kill orphan task process:", error instanceof Error ? error.message : error);
        }
      }
      this.#finish(task.id, { status: "failed", error: "Core 重啟，任務中斷" });
    }
  }

  close(): void {
    for (const timer of this.#approvalTimers.values()) clearTimeout(timer);
    this.#approvalTimers.clear();
    for (const item of this.#progress.values()) if (item.timer !== undefined) clearTimeout(item.timer);
    this.#progress.clear();
  }

  #requirePending(id: string): Task {
    const task = this.get(id);
    if (task.status !== "pending_approval") {
      throw new TaskServiceError("conflict", "任務狀態不允許此操作");
    }
    return task;
  }

  #scheduleExpiry(task: Task): void {
    const delay = Math.max(0, this.#config.tools.codex.approvalTimeoutMin * 60_000);
    const timer = setTimeout(() => {
      const current = this.#tasks.get(task.id);
      if (current?.status === "pending_approval") this.#expire(current);
    }, delay);
    timer.unref();
    this.#approvalTimers.set(task.id, timer);
  }

  #clearApprovalTimer(id: string): void {
    const timer = this.#approvalTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#approvalTimers.delete(id);
  }

  #expire(task: Task, reason?: string, notify = true): Task {
    this.#clearApprovalTimer(task.id);
    const decidedAt = this.#now().toISOString();
    const updated = this.#tasks.update(task.id, {
      status: "expired", decidedAt, decidedBy: "system", error: reason ?? null,
    });
    this.#events.broadcast("permission.resolved", {
      taskId: task.id, result: "expired", decidedAt, decidedBy: "system",
    });
    const message = this.#appendSystem(`任務確認逾時：${task.goal}`);
    if (notify) this.#completionHandler?.(message, updated);
    return updated;
  }

  #start(id: string): Task {
    const startedAt = this.#now().toISOString();
    const task = this.#tasks.update(id, { status: "running", startedAt });
    this.#state.onTaskStart();
    this.#events.broadcast("task.started", { taskId: id, startedAt });
    const hooks: TaskRunnerHooks = {
      onStarted: (details) => {
        if (this.#tasks.get(id)?.status !== "running") return;
        this.#tasks.update(id, {
          ...(details.codexThreadId === undefined ? {} : { codexThreadId: details.codexThreadId }),
          ...(details.pid === undefined ? {} : { pid: details.pid }),
        });
      },
      onProgress: (text) => this.#queueProgress(id, text),
      onFinished: (result) => { this.#finish(id, result); },
    };
    try {
      const started = this.#runner.start(task, hooks);
      if (started instanceof Promise) {
        void started.catch((error: unknown) => this.#finish(id, {
          status: "failed", error: error instanceof Error ? error.message : String(error),
        }));
      }
    } catch (error) {
      this.#finish(id, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
    return this.#tasks.get(id)!;
  }

  #queueProgress(id: string, text: string): void {
    if (this.#tasks.get(id)?.status !== "running" || text.trim() === "") return;
    const second = Math.floor(this.#now().getTime() / 1000);
    const current = this.#progress.get(id);
    if (current !== undefined && current.second !== second) this.#flushProgress(id);
    const item = this.#progress.get(id) ?? { second, texts: [] };
    item.texts.push(text.trim());
    if (item.timer === undefined) {
      item.timer = setTimeout(() => this.#flushProgress(id), 1_000);
      item.timer.unref();
    }
    this.#progress.set(id, item);
  }

  #flushProgress(id: string): void {
    const item = this.#progress.get(id);
    if (item === undefined) return;
    if (item.timer !== undefined) clearTimeout(item.timer);
    this.#progress.delete(id);
    const text = Array.from(item.texts.join("；")).slice(0, 200).join("");
    if (text !== "") this.#events.broadcast("task.progress", { taskId: id, text });
  }

  #finish(id: string, result: Parameters<TaskRunnerHooks["onFinished"]>[0]): Task {
    const current = this.#tasks.get(id);
    if (current === undefined) throw new TaskServiceError("not_found", "任務不存在");
    if (terminal(current.status)) return current;
    if (current.status !== "running" && current.status !== "approved") {
      throw new TaskServiceError("conflict", "任務狀態不允許完成");
    }
    this.#flushProgress(id);
    const endedAt = this.#now().toISOString();
    const task = this.#tasks.update(id, {
      status: result.status,
      endedAt,
      report: result.report ?? null,
      reportError: result.reportError ?? null,
      diff: result.diff ?? null,
      mismatch: result.mismatch ?? null,
      error: result.error ?? null,
    });
    const startedMs = task.startedAt === null ? new Date(task.createdAt).getTime() : new Date(task.startedAt).getTime();
    const durationMs = Math.max(0, new Date(endedAt).getTime() - startedMs);
    this.#usage?.append({
      kind: "codex",
      refType: "task",
      refId: task.id,
      model: result.usage?.model ?? "codex",
      inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0,
      cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: result.usage?.cacheCreationInputTokens ?? 0,
      reasoningTokens: result.usage?.reasoningTokens ?? 0,
      durationMs,
      attempts: result.usage?.attempts ?? 1,
      ts: endedAt,
    });
    if (task.status === "failed") {
      this.#errors.write({
        replyId: task.id,
        kind: "codex",
        message: task.error ?? "Codex 任務失敗",
        attempts: result.usage?.attempts ?? 1,
        source: "codex",
      });
    }
    this.#state.onTaskEnd();
    this.#events.broadcast("task.done", {
      taskId: id, status: task.status, report: task.report, reportError: task.reportError, diff: task.diff,
      mismatch: task.mismatch, error: task.error,
    });
    const message = this.#appendSystem(`任務 ${id.slice(0, 8)} ${task.status}：${task.goal}`);
    // 計畫的任務由 PlanService 回報（重啟時是 restarted 通知）；這裡再通知會讓艾莉絲用過時的計畫狀態多回一次（C3 實測）。
    if (task.planId === null) this.#completionHandler?.(message, task);
    return task;
  }

  #appendSystem(text: string): Message {
    const message = this.#messages.append({ role: "system", text });
    this.#events.broadcast("message.created", message);
    return message;
  }
}

export { parseRequest as parseTaskRequest };
