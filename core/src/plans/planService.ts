import { execFile } from "node:child_process";

import { DEFAULT_HIGH_RISK_PATTERNS, DEFAULT_TEST_COMMANDS, type Config } from "../config.js";
import type { ChannelStore } from "../channels/channelStore.js";
import type { WorkerRunner } from "../channels/workerRunner.js";
import type { LocalConfig, WorkerProjectConfig } from "../localConfig.js";
import type { EventHub } from "../protocol/eventHub.js";
import type { ErrorLogger } from "../reliability/errorLog.js";
import type { CharacterState } from "../state/characterState.js";
import type { Message, MessageStore } from "../store/messageStore.js";
import { validateCodexReport, type CodexReport } from "../tasks/codexRunner.js";
import type { SnapshotDiff, SnapshotMismatch } from "../tasks/snapshot.js";
import type { TaskRunner, TaskRunnerHooks } from "../tasks/taskRunner.js";
import type { Task, TaskStore } from "../tasks/taskStore.js";
import type { Quotas } from "../usage/quota.js";
import type { UsageStore } from "../usage/usageStore.js";
import { highRiskPaths } from "./pathPatterns.js";
import {
  extractDifferences, extractReviewVerdict, extractSpecConflict, extractWritebackCandidates, parsePlanBlock, SPEC_CONFLICT_RULE,
  type PlanRequest,
} from "./planParser.js";
import { writePlanFiles } from "./planReport.js";
import {
  changedWatchedFiles, compareVerification, executeCommand, hashWatchedPaths, runVerification,
  type CommandExecutor, type VerifyResult,
} from "./verification.js";
import type { OutboxService } from "../relay/outboxService.js";
import type { CreatePlanItemInput, Plan, PlanExecutor, PlanItem, PlanStore } from "./planStore.js";

export type PlanNotificationKind = "completed" | "paused" | "rejected" | "expired" | "cancelled" | "restarted";
export type PlanFiles = { reportPath: string; writebackPath: string | undefined };
export type PlanNotificationHandler = (
  message: Message,
  kind: PlanNotificationKind,
  plan: Plan,
  items: PlanItem[],
  files?: PlanFiles,
) => void;

export type RepoStatusReader = (repoPath: string) => Promise<string[]>;
/** 取 repo 目前相對 HEAD 的 diff 文字（審查用）。 */
export type RepoDiffReader = (repoPath: string, paths: string[]) => Promise<string>;

export const gitDiffText: RepoDiffReader = async (repoPath, paths) =>
  await new Promise((resolvePromise) => {
    if (paths.length === 0) {
      resolvePromise("");
      return;
    }
    execFile("git", ["-C", repoPath, "diff", "--no-color", "--", ...paths],
      { shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        resolvePromise(error === null ? stdout : "");
      });
  });

const MAX_RUNNING_PLANS = 2;

export class PlanServiceError extends Error {
  readonly code: "not_found" | "conflict";
  constructor(code: "not_found" | "conflict", message: string) {
    super(message);
    this.name = "PlanServiceError";
    this.code = code;
  }
}

type WritableTarget = {
  name: string;
  path: string;
  testCommands: string[];
  highRiskPatterns: string[];
  forbiddenPatterns: string[];
  watchPaths: string[];
  claudeFallback: "auto" | "ask";
  changeLogDraft: boolean;
  role: string | null;
  readDirs: string[];
};

type PreRun = { baseline: VerifyResult; watch: Map<string, string> };

/** Core 驗收結果（存進項目結果、報告與更改紀錄草稿）。 */
export type ItemVerification = {
  commands: Array<{ command: string; exitCode: number | null; timedOut: boolean; durationMs: number; failures: number }>;
  newFailures: string[];
  fixed: string[];
  baselineFailures: number;
  afterFailures: number;
};

type ItemOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; pause?: string; retryable: boolean; feedback: string };

const MAX_CONCURRENT_ITEMS = 2;
const MAX_ATTEMPTS = 2;
/** session 項目派出後多久沒回報就提醒主人（§27，不自動重送）。 */
const SESSION_REMINDER_MIN = 30;

function terminalPlan(status: Plan["status"]): boolean {
  return ["completed", "cancelled", "rejected", "expired", "failed"].includes(status);
}

/** 給執行者：Core 會自己跑哪些測試、開工前已失敗哪些（R2-2）。 */
function verificationBrief(target: WritableTarget, baseline: VerifyResult): string {
  if (target.testCommands.length === 0) return "";
  const failures = baseline.commands.flatMap((entry) => entry.failures);
  return [
    "## Core 的驗收（自動執行）",
    `你完成後，Core 會自己在 repo 執行 ${target.testCommands.map((command) => `\`${command}\``).join("、")}，並和開工前比較；沒有新增失敗就算測試通過。`,
    failures.length === 0 ? "開工前這些測試沒有失敗。"
      : `開工前已經失敗的項目（共 ${failures.length} 項；不是你造成的，除非任務要求，不要去修）：\n${failures.slice(0, 30).map((key) => `- ${key}`).join("\n")}${failures.length > 30 ? "\n- …" : ""}`,
    "測試能跑就跑並照實回報；不能跑（例如沙箱不能開子行程）就在 tests 標 not_run 並說明，驗收標準裡的測試項目交給 Core 判定，不要因此標成未達成。",
  ].join("\n");
}

/** 給執行者：禁改路徑（R2-1）。 */
function forbiddenBrief(target: WritableTarget): string {
  const patterns = [...new Set([...target.forbiddenPatterns, ...target.watchPaths.map((path) => `${path.replace(/\/+$/u, "")}/**`)])];
  if (patterns.length === 0) return "";
  return ["## 禁止修改", `不可新增、修改或刪除符合這些路徑的檔案：${patterns.join("、")}。需要改時停下來，寫進 notes 說明原因。`].join("\n");
}

function short(id: string): string {
  return id.slice(0, 8);
}

function diffPaths(value: unknown): string[] {
  const diff = value as SnapshotDiff | null;
  return diff === null ? [] : [...diff.added, ...diff.modified];
}

/** 重啟時中斷項目的半成品說明；undefined 表示不適用（唯讀項目或無法檢查）。 */
function leftoverNote(item: PlanItem, leftovers: string[] | undefined): string {
  if (leftovers === undefined) return "";
  if (leftovers.length === 0) return `，${item.project} 沒有看到這一項留下的未提交檔`;
  return `，${item.project} 可能留下的半成品（未提交，重做時會在這些檔之上繼續）：${leftovers.slice(0, 10).join("、")}${leftovers.length > 10 ? " 等" : ""}`;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/** `git status --porcelain -z` 的路徑（含未追蹤；改名取新路徑）。 */
export const gitStatusPaths: RepoStatusReader = async (repoPath) =>
  await new Promise((resolvePromise, rejectPromise) => {
    execFile("git", ["-C", repoPath, "status", "--porcelain", "-z", "--untracked-files=all"],
      { shell: false, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }
        const entries = stdout.split("\0").filter((entry) => entry !== "");
        const paths: string[] = [];
        for (let index = 0; index < entries.length; index += 1) {
          const entry = entries[index]!;
          const status = entry.slice(0, 2);
          paths.push(entry.slice(3).replaceAll("\\", "/"));
          if (status.startsWith("R") || status.startsWith("C")) index += 1;
        }
        resolvePromise(paths);
      });
  });

export class PlanService {
  readonly #config: Config;
  readonly #local: LocalConfig;
  readonly #plans: PlanStore;
  readonly #tasks: TaskStore;
  readonly #messages: MessageStore;
  readonly #channels: ChannelStore | undefined;
  readonly #events: EventHub;
  readonly #state: CharacterState;
  readonly #worker: Pick<WorkerRunner, "canStart" | "run"> | undefined;
  readonly #codexRunner: TaskRunner | undefined;
  readonly #claudeRunner: TaskRunner;
  readonly #quotas: { read(): Promise<Quotas> } | undefined;
  readonly #repoStatus: RepoStatusReader;
  readonly #repoDiff: RepoDiffReader;
  readonly #usage: UsageStore | undefined;
  readonly #errors: ErrorLogger | undefined;
  readonly #now: () => Date;
  readonly #approvalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #runningTasks = new Map<string, { runner: TaskRunner; taskId: string }>();
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #notify: PlanNotificationHandler | undefined;
  #pumping = false;
  #pumpAgain = false;
  readonly #verifyExecutor: CommandExecutor;
  /** 修改項目開工前的基準（task id → 基準測試與監看路徑雜湊）。 */
  readonly #preRun = new Map<string, PreRun>();
  readonly #outbox: OutboxService | undefined;
  /** session 項目的 30 分鐘提醒（item id → timer）。 */
  readonly #sessionTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: {
    config: Config;
    local: LocalConfig;
    plans: PlanStore;
    tasks: TaskStore;
    messages: MessageStore;
    channels?: ChannelStore;
    events: EventHub;
    state: CharacterState;
    worker?: Pick<WorkerRunner, "canStart" | "run">;
    codexRunner?: TaskRunner;
    claudeRunner: TaskRunner;
    quotas?: { read(): Promise<Quotas> };
    repoStatus?: RepoStatusReader;
    repoDiff?: RepoDiffReader;
    verifyExecutor?: CommandExecutor;
    outbox?: OutboxService;
    usage?: UsageStore;
    errors?: ErrorLogger;
    now?: () => Date;
  }) {
    this.#config = options.config;
    this.#local = options.local;
    this.#plans = options.plans;
    this.#tasks = options.tasks;
    this.#messages = options.messages;
    this.#channels = options.channels;
    this.#events = options.events;
    this.#state = options.state;
    this.#worker = options.worker;
    this.#codexRunner = options.codexRunner;
    this.#claudeRunner = options.claudeRunner;
    this.#quotas = options.quotas;
    this.#repoStatus = options.repoStatus ?? gitStatusPaths;
    this.#repoDiff = options.repoDiff ?? gitDiffText;
    this.#verifyExecutor = options.verifyExecutor ?? executeCommand;
    this.#outbox = options.outbox;
    this.#outbox?.setFailedHandler((message) => {
      if (message.kind === "task" && message.itemId !== null) this.#sessionSendFailed(message.itemId, message.error ?? "未知原因");
    });
    this.#usage = options.usage;
    this.#errors = options.errors;
    this.#now = options.now ?? (() => new Date());
  }

  setNotificationHandler(handler: PlanNotificationHandler): void {
    this.#notify = handler;
  }

  /** 計畫可修改的目標（spec-plans §1）。 */
  writableTargets(): WritableTarget[] {
    const targets = new Map<string, WritableTarget>();
    for (const [name, repo] of Object.entries(this.#config.tools.codex.repos)) {
      const local = this.#local.projects.find((project) => project.name === name);
      targets.set(name, {
        name,
        path: repo.path,
        testCommands: repo.testCommands ?? DEFAULT_TEST_COMMANDS,
        highRiskPatterns: repo.highRiskPatterns ?? DEFAULT_HIGH_RISK_PATTERNS,
        forbiddenPatterns: repo.forbiddenPatterns ?? [],
        watchPaths: repo.watchPaths ?? [],
        claudeFallback: repo.claudeFallback ?? "auto",
        changeLogDraft: repo.changeLogDraft === true,
        role: local?.role ?? null,
        readDirs: local?.readDirs ?? [],
      });
    }
    for (const project of this.#local.projects) {
      if (project.writable !== true) continue;
      targets.set(project.name, {
        name: project.name,
        path: project.path,
        testCommands: project.testCommands ?? DEFAULT_TEST_COMMANDS,
        highRiskPatterns: project.highRiskPatterns ?? DEFAULT_HIGH_RISK_PATTERNS,
        forbiddenPatterns: project.forbiddenPatterns ?? [],
        watchPaths: project.watchPaths ?? [],
        claudeFallback: project.claudeFallback ?? "auto",
        changeLogDraft: project.changeLogDraft === true,
        role: project.role,
        readDirs: project.readDirs,
      });
    }
    return [...targets.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  active(): { plan: Plan; items: PlanItem[] } | undefined {
    const plan = this.#plans.active();
    return plan === undefined ? undefined : { plan, items: this.#plans.items(plan.id) };
  }

  activeAll(): Array<{ plan: Plan; items: PlanItem[] }> {
    return this.#plans.activeAll().map((plan) => ({ plan, items: this.#plans.items(plan.id) }));
  }

  list(limit?: number): Plan[] {
    return this.#plans.list(limit);
  }

  get(idOrPrefix: string): { plan: Plan; items: PlanItem[] } {
    const plan = this.#plans.get(idOrPrefix) ?? this.#plans.findByPrefix(idOrPrefix);
    if (plan === undefined) throw new PlanServiceError("not_found", "計畫不存在");
    return { plan, items: this.#plans.items(plan.id) };
  }

  createFromBlock(blockText: string, sourceMessageId: string): Plan | undefined {
    try {
      const request = parsePlanBlock(blockText);
      this.#validate(request);
      const afterPlans = this.#resolveAfter(request.after);
      if (this.#plans.listByStatuses(["pending_approval"]).length > 0) throw new Error("已有計畫等待主人確認；請先核准或拒絕");
      const items: CreatePlanItemInput[] = request.items.map((item) => ({
        key: item.key,
        title: item.title,
        kind: item.kind,
        project: item.project,
        role: item.role ?? null,
        instructions: item.instructions,
        acceptance: item.acceptance,
        dependsOn: item.dependsOn,
        risk: item.risk,
        estimateMin: item.estimateMin ?? null,
      }));
      const { plan, items: created } = this.#plans.create({
        goal: request.goal,
        risks: request.risks,
        decisions: request.decisions,
        preauthorizeClaudeFallback: request.preauthorizeClaudeFallback,
        sourceMessageId,
        items,
        afterPlans,
        createdAt: this.#now().toISOString(),
      });
      const expiresAt = new Date(this.#now().getTime() + this.#config.plans.approvalTimeoutMin * 60_000).toISOString();
      this.#events.broadcast("plan.created", { plan, items: created });
      this.#events.broadcast("plan.permission.request", { plan, items: created, expiresAt });
      this.#scheduleExpiry(plan.id);
      return plan;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#events.broadcast("plan.rejected", { reason });
      this.#appendSystem(`計畫未建立：${reason}`);
      return undefined;
    }
  }

  approve(idOrPrefix: string, clientId: string): Plan {
    const { plan } = this.get(idOrPrefix);
    if (plan.status !== "pending_approval") throw new PlanServiceError("conflict", "計畫狀態不允許核准");
    this.#clearApprovalTimer(plan.id);
    const decidedAt = this.#now().toISOString();
    // C3-3：同時最多 2 份計畫執行，其餘核准後排隊。
    const queued = this.#plans.listByStatuses(["running"]).length >= MAX_RUNNING_PLANS || !this.#depsDone(plan);
    const updated = this.#plans.update(plan.id, { status: queued ? "queued" : "running", decidedAt, decidedBy: clientId });
    this.#events.broadcast("plan.permission.resolved", { planId: plan.id, result: "approved", decidedAt, decidedBy: clientId });
    this.#appendSystem(`主人核准了計畫 ${short(plan.id)}：${plan.goal}${queued ? this.#queueReason(plan) : ""}`);
    if (queued) this.#events.broadcast("plan.queued", { planId: plan.id, goal: plan.goal });
    this.#broadcastUpdate(plan.id);
    this.#pump();
    return updated;
  }

  reject(idOrPrefix: string, clientId: string, reason?: string): Plan {
    const { plan } = this.get(idOrPrefix);
    if (plan.status !== "pending_approval") throw new PlanServiceError("conflict", "計畫狀態不允許拒絕");
    this.#clearApprovalTimer(plan.id);
    const decidedAt = this.#now().toISOString();
    const updated = this.#plans.update(plan.id, {
      status: "rejected", decidedAt, decidedBy: clientId, endedAt: decidedAt,
      ...(reason?.trim() ? { pauseDetail: reason.trim() } : {}),
    });
    this.#events.broadcast("plan.permission.resolved", { planId: plan.id, result: "rejected", decidedAt, decidedBy: clientId });
    const message = this.#appendSystem(`主人拒絕了計畫：${plan.goal}${reason?.trim() ? `（${reason.trim()}）` : ""}`);
    this.#notify?.(message, "rejected", updated, this.#plans.items(plan.id));
    return updated;
  }

  resume(idOrPrefix: string, clientId: string, options: { executor?: "claude" } = {}): Plan {
    const { plan, items } = this.get(idOrPrefix);
    if (plan.status !== "paused") throw new PlanServiceError("conflict", "只有暫停中的計畫可以繼續");
    for (const item of items) {
      if (item.status === "failed") {
        // session 項目重做時，把同事上一次的回報附在工作說明，讓它知道從哪裡接續（§27）。
        const instructions = item.kind === "session" && item.error !== null
          ? `${item.instructions}\n\n## 上一次的回報（主人讓這一項重做）\n${item.error}`
          : item.instructions;
        this.#plans.updateItem(item.id, { status: "pending", attempts: 0, error: null, instructions });
      }
    }
    const queued = this.#plans.listByStatuses(["running"]).length >= MAX_RUNNING_PLANS || !this.#depsDone(plan);
    const updated = this.#plans.update(plan.id, {
      status: queued ? "queued" : "running", pauseReason: null, pauseDetail: null,
      ...(options.executor === "claude" ? { preauthorizeClaudeFallback: true } : {}),
    });
    this.#appendSystem(`主人讓計畫 ${short(plan.id)} 繼續執行${options.executor === "claude" ? "（授權改由 Claude 寫程式）" : ""}${queued ? this.#queueReason(plan) : ""}（${clientId}）`);
    if (queued) this.#events.broadcast("plan.queued", { planId: plan.id, goal: plan.goal });
    this.#broadcastUpdate(plan.id);
    this.#pump();
    return updated;
  }

  async cancel(idOrPrefix: string, clientId: string): Promise<Plan> {
    const { plan, items } = this.get(idOrPrefix);
    if (terminalPlan(plan.status)) throw new PlanServiceError("conflict", "計畫已結束");
    this.#clearApprovalTimer(plan.id);
    const endedAt = this.#now().toISOString();
    const updated = this.#plans.update(plan.id, { status: "cancelled", endedAt });
    for (const item of items) {
      if (item.status === "pending") this.#plans.updateItem(item.id, { status: "cancelled", endedAt });
    }
    for (const [itemId, running] of this.#runningTasks) {
      if (this.#plans.item(itemId)?.planId !== plan.id) continue;
      try {
        await running.runner.cancel(running.taskId);
      } catch (error) {
        console.warn("Plan item cancel failed:", error instanceof Error ? error.message : error);
      }
    }
    this.#notifySessionsCancelled(plan.id);
    this.#events.broadcast("plan.done", { planId: plan.id, status: "cancelled" });
    this.#broadcastUpdate(plan.id);
    const files = this.#writeFiles(plan.id);
    const message = this.#appendSystem(`主人取消了計畫 ${short(plan.id)}：${plan.goal}（${clientId}）`);
    this.#notify?.(message, "cancelled", updated, this.#plans.items(plan.id), files);
    this.#dependencyEnded(plan.id, "取消");
    this.#promoteQueued();
    return updated;
  }

  /** Core 重啟：等待確認的計畫失效；執行中的計畫暫停，進行中的項目改回 pending（C3 再做自動接續）。 */
  async recover(): Promise<void> {
    for (const plan of this.#plans.listByStatuses(["pending_approval"])) {
      const endedAt = this.#now().toISOString();
      this.#plans.update(plan.id, { status: "expired", decidedAt: endedAt, decidedBy: "system", endedAt });
      this.#appendSystem(`計畫確認因 Core 重啟失效：${plan.goal}`);
    }
    for (const plan of this.#plans.listByStatuses(["running", "queued", "paused"])) {
      const interrupted: string[] = [];
      for (const item of this.#plans.items(plan.id)) {
        if (item.status !== "running") continue;
        if (item.kind === "session") continue; // 同事 session 還在做，等它回報
        const leftovers = await this.#adoptInterruptedChanges(plan.id, item);
        interrupted.push(`${item.key}（${item.title}）${leftoverNote(item, leftovers)}`);
        this.#plans.updateItem(item.id, { status: "pending", startedAt: null, error: "Core 重啟時中斷，重新執行" });
      }
      if (plan.status === "paused") continue;
      const waitingOnSession = this.#plans.items(plan.id).some((item) => item.kind === "session" && item.status === "running");
      if (interrupted.length === 0 && waitingOnSession && plan.status === "running") continue;
      // Q26／C3-4：不自動接續；暫停並請艾莉絲說明停在哪裡、建議從哪接續，等主人 /plan resume。
      const detail = interrupted.length > 0
        ? `Core 重啟，計畫中斷；中斷的項目：${interrupted.join("、")}（會從頭重做），已完成的項目不重做`
        : "Core 重啟，計畫中斷；已完成的項目不重做";
      const updated = this.#plans.update(plan.id, { status: "paused", pauseReason: "core_restart", pauseDetail: detail });
      const files = this.#writeFiles(plan.id);
      const message = this.#appendSystem(`計畫 ${short(plan.id)} 因 Core 重啟暫停；可用 /plan resume ${short(plan.id)} 繼續`);
      this.#notify?.(message, "restarted", updated, this.#plans.items(plan.id), files);
    }
  }

  /**
   * 重啟時被中斷的修改項目，執行者可能已改了一半：把當下 repo 的未提交檔案記在該任務的快照差異，
   * 視為「本計畫造成的改動」，resume 時才不會被 repo 衝突檢查誤擋。
   */
  async #adoptInterruptedChanges(planId: string, item: PlanItem): Promise<string[] | undefined> {
    if (item.kind !== "modify" || item.refType !== "task" || item.refId === null) return undefined;
    const task = this.#tasks.get(item.refId);
    if (task === undefined || task.diff !== null) return undefined;
    try {
      const dirty = await this.#repoStatus(task.repoPath);
      this.#tasks.update(task.id, { diff: { added: [], modified: dirty, deleted: [], headChanged: false, interrupted: true } });
      // 扣掉本計畫其他任務已記錄的改動，剩下的才可能是這一項的半成品（重啟通知要讓主人知道）。
      const known = new Set(this.#tasks.list(100)
        .filter((other) => other.planId === planId && other.id !== task.id && other.repo === task.repo)
        .flatMap((other) => diffPaths(other.diff)));
      return dirty.filter((path) => !known.has(path));
    } catch (error) {
      console.warn("Unable to record interrupted plan changes:", error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  close(): void {
    for (const timer of this.#sessionTimers.values()) clearTimeout(timer);
    this.#sessionTimers.clear();
    for (const timer of this.#approvalTimers.values()) clearTimeout(timer);
    this.#approvalTimers.clear();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
  }

  // ─── 驗證 ───────────────────────────────────────────────────────────────

  #validate(request: PlanRequest): void {
    const writable = new Map(this.writableTargets().map((target) => [target.name, target]));
    for (const item of request.items) {
      if (item.kind === "session") {
        if (this.#outbox === undefined) throw new Error("轉接功能未啟用，無法派工給同事 session");
        if (this.#outbox.resolve(item.project) === undefined) throw new Error(`「${item.project}」沒有設定對應的同事 session`);
        continue;
      }
      if (item.kind === "read") {
        if (!this.#local.workersEnabled || this.#worker === undefined) throw new Error("部下功能未啟用，無法執行 read 項目");
        const project = this.#local.projects.find((candidate) => candidate.name === item.project);
        if (project === undefined) throw new Error(`專案不存在：${item.project}`);
        if (!this.#local.projects.some((candidate) => candidate.role === item.role)) throw new Error(`角色不存在：${item.role}`);
      } else {
        if (!writable.has(item.project)) throw new Error(`「${item.project}」不在可修改的白名單`);
        if (item.role !== undefined && !this.#local.projects.some((candidate) => candidate.role === item.role)) {
          throw new Error(`角色不存在：${item.role}`);
        }
      }
    }
  }

  // ─── 排程 ───────────────────────────────────────────────────────────────

  #pump(): void {
    // 排程進行中又有項目完成時，記下請求，這一輪結束後再跑一輪，避免漏掉後續項目。
    if (this.#pumping) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumping = true;
    this.#pumpAgain = false;
    void this.#pumpOnce().catch((error: unknown) => {
      console.error("Plan scheduler failed:", error instanceof Error ? error.message : error);
    }).finally(() => {
      this.#pumping = false;
      if (this.#pumpAgain) this.#pump();
    });
  }

  async #pumpOnce(): Promise<void> {
    // 同時執行的項目上限與「同一 repo 只有一個修改類項目」跨所有計畫計算（C3-3）。
    const runningAll = (): PlanItem[] => this.#plans.listByStatuses(["running"])
      .flatMap((candidate) => this.#plans.items(candidate.id))
      .filter((item) => item.status === "running");
    let blocked = false;
    for (const plan of this.#plans.listByStatuses(["running"])) {
      const items = this.#plans.items(plan.id);
      if (items.every((item) => item.status === "done")) {
        this.#complete(plan.id);
        continue;
      }
      const doneKeys = new Set(items.filter((item) => item.status === "done").map((item) => item.key));
      let running = runningAll();
      for (const item of items) {
        if (item.status !== "pending") continue;
        if (item.kind !== "session" && running.filter((other) => other.kind !== "session").length >= MAX_CONCURRENT_ITEMS) continue;
        if (!item.dependsOn.every((key) => doneKeys.has(key))) continue;
        const writes = (kind: PlanItem["kind"]): boolean => kind === "modify" || kind === "session";
        if (writes(item.kind) && running.some((other) => writes(other.kind) && other.project === item.project)) {
          blocked = true;
          continue;
        }
        if (item.kind !== "modify" && item.kind !== "session" && this.#worker?.canStart() === false) {
          blocked = true;
          continue;
        }
        const current = this.#plans.get(plan.id);
        if (current?.status !== "running") break;
        const started = await this.#startItem(current, item);
        if (started) running = runningAll();
      }
    }
    if (blocked) this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== undefined) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#pump();
    }, 5_000);
    this.#retryTimer.unref();
  }

  /** 回傳是否已開始執行（暫停時回傳 false）。 */
  async #startItem(plan: Plan, item: PlanItem): Promise<boolean> {
    if (item.kind === "modify") return await this.#startModify(plan, item);
    if (item.kind === "session") return await this.#startSession(plan, item);
    this.#startWorkerItem(plan, item);
    return true;
  }

  // ─── read／review ─────────────────────────────────────────────────────────

  #startWorkerItem(plan: Plan, item: PlanItem): void {
    const startedAt = this.#now().toISOString();
    this.#plans.updateItem(item.id, {
      status: "running", executor: "worker", startedAt, attempts: item.attempts + 1, error: null,
    });
    this.#broadcastUpdate(plan.id);
    void this.#runWorkerItem(plan, this.#plans.item(item.id)!).catch((error: unknown) => {
      this.#finishItem(plan.id, item.id, {
        ok: false, error: error instanceof Error ? error.message : String(error), retryable: false, feedback: "",
        pause: "item_failed",
      });
    });
  }

  async #runWorkerItem(plan: Plan, item: PlanItem): Promise<void> {
    const project = this.#workerProjectFor(item);
    const role = item.role ?? project.role;
    const question = item.kind === "review" ? await this.#reviewQuestion(plan, item, project.path) : this.#readQuestion(plan, item);
    const channel = this.#channels?.create({
      title: `計畫 ${short(plan.id)}・${item.key} ${item.title}`, project: project.name, role,
    });
    if (channel !== undefined) {
      this.#events.broadcast("channel.created", channel);
      const asked = this.#channels!.appendMessage(channel.id, "alice", question);
      this.#events.broadcast("channel.message", { ...asked, role });
      this.#channels!.beginRound(channel.id);
      this.#plans.updateItem(item.id, { refType: "channel", refId: channel.id });
    }
    const channelId = channel?.id ?? `plan-${item.id}`;
    const startedMs = this.#now().getTime();
    try {
      const result = await this.#worker!.run({
        channelId, role, project: { ...project, role }, question, workerSessionId: null,
      }, (text) => this.#events.broadcast("channel.delta", { channelId, text }));
      if (channel !== undefined) {
        const reply = this.#channels!.appendMessage(channel.id, "worker", result.text);
        this.#events.broadcast("channel.message", { ...reply, role });
        if (result.permissionDeniedPaths.length > 0) {
          const audit = this.#channels!.appendMessage(channel.id, "system", `權限拒絕：${result.permissionDeniedPaths.join("、")}`);
          this.#events.broadcast("channel.message", { ...audit, role });
        }
        this.#events.broadcast("channel.closed", this.#channels!.update(channel.id, { status: "closed", workerSessionId: result.sessionId }));
      }
      this.#usage?.append({
        kind: "worker", refType: "channel", refId: channelId, model: result.usage?.model ?? "claude-worker",
        inputTokens: result.usage?.inputTokens ?? 0, outputTokens: result.usage?.outputTokens ?? 0,
        cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: result.usage?.cacheCreationInputTokens ?? 0, reasoningTokens: 0,
        durationMs: result.usage?.durationMs ?? Math.max(0, this.#now().getTime() - startedMs),
        attempts: 1, ts: this.#now().toISOString(),
      });
      const conflict = extractSpecConflict(result.text);
      if (item.kind === "review") {
        const verdict = extractReviewVerdict(result.text);
        if (verdict === undefined) {
          this.#finishItem(plan.id, item.id, {
            ok: false, error: "審查回覆沒有「審查結論：通過／不通過」", retryable: true,
            feedback: "上一次的回覆缺少最後一行「審查結論：通過」或「審查結論：不通過（理由）」。",
          });
        } else if (!verdict.passed) {
          this.#reviewRejected(plan.id, item, verdict.reason || clip(result.text, 400));
        } else if (conflict !== undefined) {
          this.#finishItem(plan.id, item.id, {
            ok: false, error: `規格衝突：${conflict}`, retryable: false, feedback: "", pause: "spec_conflict",
          });
        } else {
          this.#finishItem(plan.id, item.id, {
            ok: true,
            result: {
              text: clip(result.text, 4_000), channelId, verdict: "通過",
              writeback: extractWritebackCandidates(result.text), differences: extractDifferences(result.text),
            },
          });
        }
        return;
      }
      if (conflict !== undefined) {
        this.#finishItem(plan.id, item.id, {
          ok: false, error: `規格衝突：${conflict}`, retryable: false, feedback: "", pause: "spec_conflict",
        });
        return;
      }
      this.#finishItem(plan.id, item.id, {
        ok: true,
        result: {
          text: clip(result.text, 4_000), channelId,
          writeback: extractWritebackCandidates(result.text), differences: extractDifferences(result.text),
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (channel !== undefined) {
        const system = this.#channels!.appendMessage(channel.id, "system", `worker 失敗：${reason}`);
        this.#events.broadcast("channel.message", { ...system, role });
        this.#events.broadcast("channel.closed", this.#channels!.update(channel.id, { status: "failed" }));
      }
      this.#errors?.write({ replyId: channelId, kind: "worker", message: reason, attempts: item.attempts, source: "worker" });
      this.#finishItem(plan.id, item.id, { ok: false, error: reason, retryable: true, feedback: `上一次執行失敗：${reason}` });
    }
  }

  #workerProjectFor(item: PlanItem): WorkerProjectConfig {
    const local = this.#local.projects.find((project) => project.name === item.project);
    if (local !== undefined) return local;
    const target = this.writableTargets().find((candidate) => candidate.name === item.project);
    if (target === undefined) throw new Error(`專案不存在：${item.project}`);
    const role = item.role ?? target.role ?? this.#local.projects[0]?.role;
    if (role === undefined) throw new Error("沒有可用的審查角色");
    return { name: target.name, path: target.path, role, readDirs: target.readDirs };
  }

  #dependencySummary(plan: Plan, item: PlanItem): string {
    const items = this.#plans.items(plan.id);
    const lines: string[] = [];
    for (const key of item.dependsOn) {
      const dependency = items.find((candidate) => candidate.key === key);
      if (dependency === undefined) continue;
      const result = dependency.result as Record<string, unknown> | null;
      const text = typeof result?.text === "string" ? result.text
        : typeof result?.summary === "string" ? result.summary : JSON.stringify(result ?? {});
      lines.push(`### ${dependency.key}：${dependency.title}`, clip(text, 1_500), "");
    }
    return lines.length === 0 ? "" : ["## 前置項目的結果", "", ...lines].join("\n");
  }

  #readQuestion(plan: Plan, item: PlanItem): string {
    return [
      `# 計畫：${plan.goal}`,
      `## 你的工作（${item.key}：${item.title}）`,
      item.instructions,
      "## 驗收標準",
      ...item.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
      this.#dependencySummary(plan, item),
      "請依角色規則唯讀調查並回報。回報最後加上「需要決定：」「規格衝突：」「發現的差異：」「回寫候選：」四段（沒有就寫「無」；回寫候選是值得存進知識庫的新知識或踩坑，每條一行）。",
      SPEC_CONFLICT_RULE,
    ].filter((line) => line !== "").join("\n");
  }

  async #reviewQuestion(plan: Plan, item: PlanItem, repoPath: string): Promise<string> {
    const original = this.#plans.items(plan.id).find((candidate) => candidate.key === item.reviewOf);
    const result = (original?.result ?? {}) as { summary?: string; diff?: SnapshotDiff; tests?: unknown; highRisk?: string[] };
    // C2 的觀察：審查部下只能讀檔、看不到變更內容；這裡附上實際 diff（未追蹤的新檔只列路徑）。
    const changed = result.diff === undefined ? [] : [...result.diff.modified];
    let diffText = "";
    try {
      diffText = await this.#repoDiff(repoPath, changed);
    } catch {
      diffText = "";
    }
    const diffSection = diffText.trim() === "" ? [] : [
      "## 實際 diff（相對 HEAD，可能包含同一計畫前面項目的改動）",
      "```diff",
      Buffer.byteLength(diffText, "utf8") <= 8 * 1024
        ? diffText.trimEnd()
        : `${Buffer.from(diffText, "utf8").subarray(0, 8 * 1024).toString("utf8")}\n…（已截斷，請直接讀檔）`,
      "```",
    ];
    return [
      `# 審查：${original?.title ?? item.title}`,
      `計畫目標：${plan.goal}`,
      "## 原項目的說明",
      original?.instructions ?? "",
      "## 驗收標準",
      ...(original?.acceptance ?? []).map((criterion, index) => `${index + 1}. ${criterion}`),
      "## 變更",
      `- 新增：${result.diff?.added.join("、") || "無"}`,
      `- 修改：${result.diff?.modified.join("、") || "無"}`,
      ...(result.highRisk && result.highRisk.length > 0 ? [`- 高風險路徑：${result.highRisk.join("、")}`] : []),
      `- 執行者摘要：${result.summary ?? "（無）"}`,
      `- 測試：${JSON.stringify(result.tests ?? [])}`,
      ...diffSection,
      "## 請做",
      "讀 repo 中變更的檔案，檢查是否達成驗收標準、有沒有邏輯錯誤、是否與規格衝突（有就列在「規格衝突：」段落）。",
      SPEC_CONFLICT_RULE,
      "有值得存進知識庫的新知識或踩坑，列在「回寫候選：」段落（沒有就寫「無」）。",
      "回覆最後一行必須是「審查結論：通過」或「審查結論：不通過（理由）」。",
    ].join("\n");
  }

  #reviewRejected(planId: string, review: PlanItem, reason: string): void {
    const original = this.#plans.items(planId).find((candidate) => candidate.key === review.reviewOf);
    if (original === undefined || original.attempts >= MAX_ATTEMPTS) {
      this.#finishItem(planId, review.id, {
        ok: false, error: `審查不通過：${reason}`, retryable: false, feedback: "", pause: "review_failed",
      });
      return;
    }
    // 原項目重做一次（附審查意見），審查項目重設為 pending，等原項目完成後再審一次。
    this.#plans.updateItem(original.id, {
      status: "pending",
      instructions: `${original.instructions}\n\n## 上一次的審查意見（請修正）\n${reason}`,
      error: `審查不通過：${reason}`,
    });
    this.#plans.updateItem(review.id, { status: "pending", endedAt: this.#now().toISOString(), error: `審查不通過：${reason}` });
    this.#appendSystem(`計畫 ${short(planId)} 的「${original.title}」審查不通過，重做一次：${clip(reason, 120)}`);
    this.#broadcastUpdate(planId);
    this.#pump();
  }

  // ─── 跨計畫依賴（§27 #3）────────────────────────────────────────────────

  /** after 給的是 id 或前 8 碼；必須是存在、而且還有機會完成的計畫。 */
  #resolveAfter(ids: string[]): string[] {
    return ids.map((id) => {
      const plan = this.#plans.get(id) ?? this.#plans.findByPrefix(id);
      if (plan === undefined) throw new Error(`after 找不到計畫：${id}`);
      if (["rejected", "expired", "cancelled", "failed"].includes(plan.status)) {
        throw new Error(`after 的計畫 ${short(plan.id)} 已經${plan.status === "cancelled" ? "取消" : "結束"}，不會完成`);
      }
      return plan.id;
    });
  }

  #depsDone(plan: Plan): boolean {
    return plan.afterPlans.every((id) => this.#plans.get(id)?.status === "completed");
  }

  #queueReason(plan: Plan): string {
    const waiting = plan.afterPlans.filter((id) => this.#plans.get(id)?.status !== "completed");
    return waiting.length > 0
      ? `（等待計畫 ${waiting.map(short).join("、")} 完成後才開始）`
      : "（已有 2 份計畫執行中，排隊等候）";
  }

  #dependents(planId: string): Plan[] {
    return this.#plans.listByStatuses(["queued", "pending_approval"]).filter((plan) => plan.afterPlans.includes(planId));
  }

  /** 被等待的計畫取消或失敗：等它的計畫不會自動開始，改成暫停並通知主人。 */
  #dependencyEnded(planId: string, how: string): void {
    for (const dependent of this.#dependents(planId)) {
      if (dependent.status !== "queued") continue;
      const detail = `等待的計畫 ${short(planId)} 已${how}，這份計畫不會自動開始；可用 /plan resume ${short(dependent.id)} 不等它直接開始，或 /plan cancel ${short(dependent.id)}`;
      const updated = this.#plans.update(dependent.id, { status: "paused", pauseReason: "dependency_failed", pauseDetail: detail });
      this.#events.broadcast("plan.paused", { planId: dependent.id, reason: "dependency_failed", detail });
      this.#broadcastUpdate(dependent.id);
      const message = this.#appendSystem(`計畫 ${short(dependent.id)} 暫停（dependency_failed）：${detail}`);
      this.#notify?.(message, "paused", updated, this.#plans.items(dependent.id), this.#writeFiles(dependent.id));
    }
  }

  /** 被等待的計畫暫停：等它的計畫繼續排隊，只留紀錄讓主人知道。 */
  #dependencyPaused(planId: string): void {
    for (const dependent of this.#dependents(planId)) {
      this.#appendSystem(`計畫 ${short(dependent.id)} 在等的計畫 ${short(planId)} 暫停了；${short(planId)} 繼續並完成後才會開始`);
    }
  }

  // ─── session 項目（§27 #1）──────────────────────────────────────────────

  async #startSession(plan: Plan, item: PlanItem): Promise<boolean> {
    const target = this.#outbox?.resolve(item.project);
    if (this.#outbox === undefined || target === undefined) {
      this.#pause(plan.id, "item_failed", `「${item.project}」沒有設定對應的同事 session，無法派工`);
      return false;
    }
    const startedAt = this.#now().toISOString();
    this.#plans.updateItem(item.id, { status: "running", executor: "session", startedAt, attempts: item.attempts + 1, refType: null, refId: null });
    this.#broadcastUpdate(plan.id);
    void this.#prepareAndSend(plan.id, item.id, target.session).catch((error: unknown) => {
      this.#finishItem(plan.id, item.id, {
        ok: false, retryable: false, feedback: "", pause: "item_failed",
        error: `派工準備失敗：${error instanceof Error ? error.message : String(error)}`,
      });
    });
    return true;
  }

  /** D-3：可修改的專案先記下驗收基準、未提交檔與監看指紋，回報完成時比對。基準存在項目結果裡，Core 重啟也不會遺失。 */
  async #prepareAndSend(planId: string, itemId: string, session: string): Promise<void> {
    const plan = this.#plans.get(planId);
    const item = this.#plans.item(itemId);
    if (plan === undefined || item === undefined) return;
    const target = this.writableTargets().find((candidate) => candidate.name === item.project);
    if (target !== undefined) {
      this.#events.broadcast("plan.progress", { planId, itemKey: item.key, text: "⧗ Core 先記錄驗收基準，再派工給同事 session" });
      const baseline = target.testCommands.length > 0 ? await runVerification(target.path, target.testCommands, this.#verifyExecutor) : { commands: [] };
      const dirtyBefore = await this.#repoStatus(target.path).catch(() => [] as string[]);
      const watch = [...hashWatchedPaths(target.path, target.watchPaths)];
      this.#plans.updateItem(itemId, { result: { pending: { baseline, dirtyBefore, watch } } });
    }
    const current = this.#plans.item(itemId);
    if (current === undefined || current.status !== "running" || this.#plans.get(planId)?.status !== "running") return;
    const message = this.#outbox!.enqueue({
      recipient: session, kind: "task", planId, itemId, text: this.#sessionTaskText(plan, current),
    });
    this.#plans.updateItem(itemId, { refType: "outbox", refId: message.id });
    this.#events.broadcast("plan.progress", { planId, itemKey: item.key, text: `📤 派工給〈${session}〉` });
    this.#broadcastUpdate(planId);
    this.#scheduleSessionReminder(planId, itemId, session);
  }

  #sessionTaskText(plan: Plan, item: PlanItem): string {
    const tag = `${short(plan.id)}-${item.key}`;
    const relay = this.#outbox?.relaySession ?? "ALICE";
    const target = this.writableTargets().find((candidate) => candidate.name === item.project);
    return [
      `【ALICe 派工 ${tag}】${item.title}`,
      `計畫：${plan.goal}（主人已核准這份計畫）`,
      "",
      "## 工作",
      item.instructions,
      this.#dependencySummary(plan, item),
      "## 驗收標準",
      ...item.acceptance.map((criterion, index) => `${index + 1}. ${criterion}`),
      ...(target !== undefined && target.testCommands.length > 0
        ? ["", `完成後 Core 會在 repo 跑 ${target.testCommands.map((command) => `\`${command}\``).join("、")}，並和派工前的基準比較；不要動禁改路徑：${[...target.forbiddenPatterns, ...target.watchPaths.map((path) => `${path}/**`)].join("、") || "無"}。`]
        : []),
      "",
      "## 規則",
      "- 照你自己的角色規則做事（知識庫分工表、改檔前要先問主人的事照樣問主人）。主人核准計畫不代表核准你的每一步。",
      "- 不 commit、不寫知識庫；ALICe 不能替主人做決定或核准。",
      "",
      "## 回報方式（做完或卡住都要回）",
      `用 SendMessage 傳給「${relay}」，第一行固定寫：`,
      `【回報 ${tag}】完成`,
      `（或「【回報 ${tag}】卡住」、「【回報 ${tag}】需要主人決定」）`,
      "第二行起寫：結果摘要、改了哪些檔（沒有就寫無）、驗收結果，最後加「規格衝突：」「發現的差異：」「回寫候選：」三段（沒有就寫無）。",
    ].filter((line) => line !== "").join("\n");
  }

  #scheduleSessionReminder(planId: string, itemId: string, session: string): void {
    const existing = this.#sessionTimers.get(itemId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.#sessionTimers.delete(itemId);
      const item = this.#plans.item(itemId);
      if (item?.status !== "running") return;
      const text = `派給〈${session}〉的「${item.title}」超過 ${SESSION_REMINDER_MIN} 分鐘還沒回報（計畫 ${short(planId)}）；不會自動重送，主人可以去該 session 看看`;
      this.#appendSystem(text);
      this.#events.broadcast("plan.progress", { planId, itemKey: item.key, text: `⏰ ${text}` });
    }, SESSION_REMINDER_MIN * 60_000);
    timer.unref();
    this.#sessionTimers.set(itemId, timer);
  }

  /** 計畫取消時，通知正在處理 session 項目的同事不用再做。 */
  #notifySessionsCancelled(planId: string): void {
    for (const item of this.#plans.items(planId)) {
      if (item.kind !== "session" || item.status !== "running" || item.refId === null) continue;
      const timer = this.#sessionTimers.get(item.id);
      if (timer !== undefined) clearTimeout(timer);
      this.#sessionTimers.delete(item.id);
      const sent = this.#outbox?.get(item.refId);
      if (sent === undefined) continue;
      this.#outbox!.enqueue({
        recipient: sent.recipient, kind: "message", planId,
        text: this.#outbox!.directMessageText(`計畫 ${short(planId)} 已由主人取消，派工【${short(planId)}-${item.key}】${item.title} 不用再做，也不用回報。已經改了的檔案先不要還原，等主人決定。`),
      });
    }
  }

  /**
   * 同事 session 透過轉接送回的訊息（ConversationService 收到同事訊息時呼叫）。
   * 第一行是「【回報 <計畫短 id>-<key>】完成／卡住／需要主人決定」才處理；回傳給艾莉絲看的處理結果，不是回報就回傳 undefined。
   */
  handleSessionReport(text: string, from: string): string | undefined {
    const match = /^\s*【回報\s+([0-9a-f]{8})-([a-z0-9-]{1,20})】\s*(完成|卡住|需要主人決定)/u.exec(text);
    if (match === null) return undefined;
    const [, planPrefix, key, status] = match;
    const plan = this.#plans.findByPrefix(planPrefix!);
    const item = plan === undefined ? undefined : this.#plans.items(plan.id).find((candidate) => candidate.key === key);
    if (plan === undefined || item === undefined || item.kind !== "session") {
      return this.#appendSystem(`〈${from}〉回報了不存在的派工 ${planPrefix}-${key}，已忽略`).text;
    }
    const expected = item.refId === null ? undefined : this.#outbox?.get(item.refId).recipient;
    if (expected === undefined || expected.toLowerCase() !== from.trim().toLowerCase()) {
      return this.#appendSystem(`〈${from}〉回報了派給〈${expected ?? "（未派出）"}〉的項目 ${planPrefix}-${key}，不是它的派工，已忽略`).text;
    }
    if (item.status !== "running") {
      return this.#appendSystem(`〈${from}〉回報 ${planPrefix}-${key}，但這一項目前是「${item.status}」，已記錄但不改變計畫`).text;
    }
    const timer = this.#sessionTimers.get(item.id);
    if (timer !== undefined) clearTimeout(timer);
    this.#sessionTimers.delete(item.id);
    const body = text.slice(match[0].length).trim();
    if (status === "卡住" || status === "需要主人決定") {
      this.#finishItem(plan.id, item.id, {
        ok: false, retryable: false, feedback: "", pause: status === "卡住" ? "session_blocked" : "decision_needed",
        error: `〈${from}〉回報${status}：${clip(body, 1_500)}`,
      });
      return `已記錄：〈${from}〉回報 ${planPrefix}-${key} ${status}，計畫暫停等主人決定`;
    }
    void this.#finishSessionReport(plan.id, item.id, from, body).catch((error: unknown) => {
      this.#finishItem(plan.id, item.id, {
        ok: false, retryable: false, feedback: "", pause: "item_failed",
        error: `Core 驗收失敗：${error instanceof Error ? error.message : String(error)}`,
      });
    });
    return `已記錄：〈${from}〉回報 ${planPrefix}-${key} 完成，Core 驗收中`;
  }

  async #finishSessionReport(planId: string, itemId: string, from: string, body: string): Promise<void> {
    const item = this.#plans.item(itemId);
    if (item === undefined) return;
    const pending = (item.result as { pending?: { baseline: VerifyResult; dirtyBefore: string[]; watch: Array<[string, string]> } } | null)?.pending;
    const target = this.writableTargets().find((candidate) => candidate.name === item.project);
    let verification: ItemVerification | undefined;
    let changedFiles: string[] = [];
    if (target !== undefined && pending !== undefined) {
      this.#events.broadcast("plan.progress", { planId, itemKey: item.key, text: "⧗ Core 跑驗收測試並與派工前的基準比較" });
      const dirtyAfter = await this.#repoStatus(target.path).catch(() => [] as string[]);
      const before = new Set(pending.dirtyBefore);
      changedFiles = dirtyAfter.filter((path) => !before.has(path));
      const watchChanged = changedWatchedFiles(new Map(pending.watch), hashWatchedPaths(target.path, target.watchPaths));
      const forbidden = [...new Set([...highRiskPaths(changedFiles, target.forbiddenPatterns), ...watchChanged])].sort();
      if (forbidden.length > 0) {
        this.#finishItem(planId, itemId, {
          ok: false, retryable: false, feedback: "", pause: "forbidden_path",
          error: `〈${from}〉的改動碰到禁改路徑：${forbidden.slice(0, 10).join("、")}`,
        });
        return;
      }
      if (target.testCommands.length > 0) {
        const after = await runVerification(target.path, target.testCommands, this.#verifyExecutor);
        verification = {
          ...compareVerification(pending.baseline, after),
          commands: after.commands.map((entry) => ({
            command: entry.command, exitCode: entry.exitCode, timedOut: entry.timedOut, durationMs: entry.durationMs, failures: entry.failures.length,
          })),
        };
        if (verification.newFailures.length > 0) {
          this.#finishItem(planId, itemId, {
            ok: false, retryable: false, feedback: "", pause: "session_verify_failed",
            error: `〈${from}〉回報完成，但 Core 驗收有新增失敗（${verification.baselineFailures} → ${verification.afterFailures}）：${verification.newFailures.slice(0, 10).join("；")}`,
          });
          return;
        }
      }
    }
    const conflict = extractSpecConflict(body);
    if (conflict !== undefined) {
      this.#finishItem(planId, itemId, { ok: false, retryable: false, feedback: "", pause: "spec_conflict", error: `規格衝突：${conflict}` });
      return;
    }
    const highRisk = target === undefined ? [] : highRiskPaths(changedFiles, target.highRiskPatterns);
    this.#finishItem(planId, itemId, {
      ok: true,
      result: {
        text: clip(body, 4_000), from,
        diff: { added: [], modified: changedFiles, deleted: [], headChanged: false },
        highRisk, reviewNeeded: target !== undefined && (item.risk === "high" || highRisk.length > 0),
        writeback: extractWritebackCandidates(body), differences: extractDifferences(body),
        ...(verification === undefined ? {} : { verification }),
      },
    });
  }

  /** 派工信件送不出去：該項目失敗並暫停計畫。 */
  #sessionSendFailed(itemId: string, reason: string): void {
    const item = this.#plans.item(itemId);
    if (item === undefined || item.status !== "running") return;
    this.#finishItem(item.planId, itemId, {
      ok: false, retryable: false, feedback: "", pause: "session_send_failed", error: `派工送不出去：${reason}`,
    });
  }

  // ─── modify ─────────────────────────────────────────────────────────────

  async #startModify(plan: Plan, item: PlanItem): Promise<boolean> {
    const target = this.writableTargets().find((candidate) => candidate.name === item.project);
    if (target === undefined) {
      this.#pause(plan.id, "item_failed", `「${item.project}」不在可修改的白名單`);
      return false;
    }
    // Q21：有不是本計畫造成的未提交改動時先問主人。
    let dirty: string[];
    try {
      dirty = await this.#repoStatus(target.path);
    } catch (error) {
      this.#pause(plan.id, "repo_dirty", `無法檢查 ${target.name} 的 git 狀態：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    // 「本計畫造成的改動」= 本計畫在這個 repo 執行過的每一次任務（含失敗、重試）的快照差異。
    const ours = new Set(this.#tasks.list(100)
      .filter((task) => task.planId === plan.id && task.repo === item.project)
      .flatMap((task) => diffPaths(task.diff)));
    const foreign = dirty.filter((path) => !ours.has(path));
    if (foreign.length > 0) {
      this.#pause(plan.id, "repo_dirty", `${target.name} 有不是本計畫造成的未提交改動：${foreign.slice(0, 10).join("、")}${foreign.length > 10 ? " 等" : ""}`);
      return false;
    }

    const executor = await this.#chooseExecutor(plan, target);
    if (typeof executor !== "string") {
      this.#pause(plan.id, executor.reason, executor.detail);
      return false;
    }
    // 先標成執行中再跑基準（基準可能要幾十秒，不能卡住其他計畫的排程）。
    const startedAt = this.#now().toISOString();
    this.#plans.updateItem(item.id, { status: "running", executor, startedAt, attempts: item.attempts + 1, error: null, refType: null, refId: null });
    this.#broadcastUpdate(plan.id);
    if (target.testCommands.length > 0) {
      this.#events.broadcast("plan.progress", { planId: plan.id, itemKey: item.key, text: `⧗ Core 先跑測試記錄基準：${target.testCommands.join("、")}` });
    }
    void this.#prepareAndRun(plan.id, item.id, target, executor).catch((error: unknown) => {
      this.#finishItem(plan.id, item.id, {
        ok: false, retryable: false, feedback: "", pause: "item_failed",
        error: `Core 無法建立測試基準：${error instanceof Error ? error.message : String(error)}`,
      });
    });
    return true;
  }

  async #prepareAndRun(planId: string, itemId: string, target: WritableTarget, executor: "codex" | "claude"): Promise<void> {
    const baseline = await runVerification(target.path, target.testCommands, this.#verifyExecutor);
    const watch = hashWatchedPaths(target.path, target.watchPaths);
    const plan = this.#plans.get(planId);
    const item = this.#plans.item(itemId);
    if (plan === undefined || item === undefined || item.status !== "running") return;
    if (plan.status !== "running") {
      // 跑基準期間計畫被取消或暫停：取消就結束，暫停就退回 pending（這次不算嘗試）。
      this.#plans.updateItem(itemId, plan.status === "cancelled"
        ? { status: "cancelled", endedAt: this.#now().toISOString() }
        : { status: "pending", attempts: Math.max(0, item.attempts - 1), startedAt: null });
      this.#broadcastUpdate(planId);
      return;
    }
    this.#runModify(plan, item, target, executor, { baseline, watch });
  }

  async #chooseExecutor(plan: Plan, target: WritableTarget): Promise<"codex" | "claude" | { reason: string; detail: string }> {
    const codex = this.#config.tools.codex;
    if (codex.use === false || codex.available !== true || this.#codexRunner === undefined) {
      // R2-3：設定為 ask 的專案，Claude 代寫前一律先問主人（知識庫〈27-判斷分工表外的工作與例外〉）；計畫預先授權時照授權。
      if (target.claudeFallback === "ask" && !plan.preauthorizeClaudeFallback) {
        const why = codex.use === false ? "已關閉" : "不可用";
        return {
          reason: "codex_unavailable",
          detail: `Codex ${why}，${target.name} 設定為改由 Claude 寫程式前先問主人；可用 /plan resume ${short(plan.id)} claude 授權改派`,
        };
      }
      return "claude";
    }
    if (this.#quotas !== undefined) {
      try {
        const quota = (await this.#quotas.read()).codex;
        if (quota.status === "ok") {
          const primary = quota.primary?.usedPercent;
          const secondary = quota.secondary?.usedPercent;
          const exhausted = (primary !== undefined && primary >= this.#config.plans.codexPrimaryMaxPercent)
            || (secondary !== undefined && secondary >= this.#config.plans.codexSecondaryMaxPercent);
          if (exhausted) {
            return plan.preauthorizeClaudeFallback ? "claude" : {
              reason: "codex_quota",
              detail: `Codex 額度已達門檻，計畫沒有預先授權改由 Claude 寫程式；可用 /plan resume ${short(plan.id)} claude 授權改派`,
            };
          }
        }
      } catch {
        // 讀不到額度時視為可用（spec-plans §5）。
      }
    }
    return "codex";
  }

  #runModify(plan: Plan, item: PlanItem, target: WritableTarget, executor: "codex" | "claude", pre: PreRun): void {
    const startedAt = item.startedAt ?? this.#now().toISOString();
    const instructions = [
      item.instructions,
      this.#dependencySummary(plan, item),
      verificationBrief(target, pre.baseline),
      forbiddenBrief(target),
    ].filter((part) => part !== "").join("\n\n");
    const created = this.#tasks.create({
      planId: plan.id,
      sourceMessageId: plan.sourceMessageId,
      tool: executor,
      repo: target.name,
      repoPath: target.path,
      goal: `${item.title}（計畫 ${short(plan.id)}・${item.key}）`,
      instructions,
      acceptance: item.acceptance,
      estimateMin: item.estimateMin,
      createdAt: startedAt,
    });
    const task = this.#tasks.update(created.id, { status: "running", decidedAt: startedAt, decidedBy: "plan", startedAt });
    this.#plans.updateItem(item.id, { status: "running", executor, refType: "task", refId: task.id, startedAt, error: null });
    this.#preRun.set(task.id, pre);
    this.#state.onTaskStart();
    this.#broadcastUpdate(plan.id);
    const runner = executor === "codex" ? this.#codexRunner! : this.#claudeRunner;
    this.#runningTasks.set(item.id, { runner, taskId: task.id });
    const hooks: TaskRunnerHooks = {
      onStarted: (details) => {
        this.#tasks.update(task.id, {
          ...(details.codexThreadId === undefined ? {} : { codexThreadId: details.codexThreadId }),
          ...(details.pid === undefined ? {} : { pid: details.pid }),
        });
      },
      onProgress: (text) => {
        if (text.trim() !== "") this.#events.broadcast("plan.progress", { planId: plan.id, itemKey: item.key, text: clip(text.trim(), 200) });
      },
      onFinished: (result) => this.#modifyFinished(plan.id, item.id, task, executor, target, result),
    };
    try {
      const started = runner.start(task, hooks);
      if (started instanceof Promise) {
        void started.catch((error: unknown) => hooks.onFinished({
          status: "failed", error: error instanceof Error ? error.message : String(error),
        }));
      }
    } catch (error) {
      hooks.onFinished({ status: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  }

  #modifyFinished(
    planId: string,
    itemId: string,
    task: Task,
    executor: "codex" | "claude",
    target: WritableTarget,
    result: Parameters<TaskRunnerHooks["onFinished"]>[0],
  ): void {
    this.#runningTasks.delete(itemId);
    const endedAt = this.#now().toISOString();
    this.#tasks.update(task.id, {
      status: result.status, endedAt, report: result.report ?? null, reportError: result.reportError ?? null,
      diff: result.diff ?? null, mismatch: result.mismatch ?? null, error: result.error ?? null,
    });
    this.#state.onTaskEnd();
    const durationMs = Math.max(0, new Date(endedAt).getTime() - new Date(task.startedAt ?? task.createdAt).getTime());
    this.#usage?.append({
      kind: executor === "codex" ? "codex" : "worker", refType: "task", refId: task.id,
      model: result.usage?.model ?? executor, inputTokens: result.usage?.inputTokens ?? 0,
      outputTokens: result.usage?.outputTokens ?? 0, cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: result.usage?.cacheCreationInputTokens ?? 0,
      reasoningTokens: result.usage?.reasoningTokens ?? 0, durationMs, attempts: 1, ts: endedAt,
    });
    if (result.status === "failed") {
      this.#errors?.write({
        replyId: task.id, kind: executor, message: result.error ?? "修改項目失敗", attempts: 1,
        source: executor === "codex" ? "codex" : "worker",
      });
    }

    const plan = this.#plans.get(planId);
    const item = this.#plans.item(itemId);
    if (plan === undefined || item === undefined) return;
    if (result.status === "cancelled" || plan.status === "cancelled") {
      this.#plans.updateItem(itemId, { status: "cancelled", endedAt, error: "已取消" });
      this.#broadcastUpdate(planId);
      return;
    }
    // Codex 在執行中因額度失敗：有預先授權就改派 Claude（不算一次嘗試），否則暫停。
    if (executor === "codex" && result.status === "failed" && /usage limit|額度/iu.test(result.error ?? "")) {
      if (plan.preauthorizeClaudeFallback) {
        this.#plans.updateItem(itemId, { status: "pending", attempts: Math.max(0, item.attempts - 1), error: result.error ?? null });
        this.#appendSystem(`計畫 ${short(planId)} 的「${item.title}」：Codex 額度不足，依預先授權改由 Claude 寫程式`);
        this.#broadcastUpdate(planId);
        this.#pump();
      } else {
        this.#plans.updateItem(itemId, { status: "failed", endedAt, error: result.error ?? null });
        this.#pause(planId, "codex_quota", `Codex 執行中額度用完：${clip(result.error ?? "", 200)}；可用 /plan resume ${short(planId)} claude 授權改派`);
      }
      return;
    }
    void this.#verifyAndFinish(planId, itemId, task, target, result).catch((error: unknown) => {
      this.#finishItem(planId, itemId, {
        ok: false, retryable: false, feedback: "", pause: "item_failed",
        error: `Core 驗收失敗：${error instanceof Error ? error.message : String(error)}`,
      });
    });
  }

  /** R2-2：執行者完成後 Core 自己跑 testCommands 與開工前比較；R2-1：比對監看路徑。 */
  async #verifyAndFinish(
    planId: string, itemId: string, task: Task, target: WritableTarget,
    result: Parameters<TaskRunnerHooks["onFinished"]>[0],
  ): Promise<void> {
    const pre = this.#preRun.get(task.id);
    this.#preRun.delete(task.id);
    let verification: ItemVerification | undefined;
    let watchChanged: string[] = [];
    if (pre !== undefined) {
      watchChanged = changedWatchedFiles(pre.watch, hashWatchedPaths(target.path, target.watchPaths));
      if (result.status === "succeeded" && target.testCommands.length > 0 && watchChanged.length === 0) {
        const item = this.#plans.item(itemId);
        if (item !== undefined) this.#events.broadcast("plan.progress", { planId, itemKey: item.key, text: "⧗ Core 跑驗收測試並與基準比較" });
        const after = await runVerification(target.path, target.testCommands, this.#verifyExecutor);
        verification = {
          ...compareVerification(pre.baseline, after),
          commands: after.commands.map((entry) => ({
            command: entry.command, exitCode: entry.exitCode, timedOut: entry.timedOut, durationMs: entry.durationMs, failures: entry.failures.length,
          })),
        };
      }
    }
    const item = this.#plans.item(itemId);
    if (item === undefined) return;
    // 本計畫先前的任務在這個 repo 動過的檔（重做時用來判斷「回報新增、快照修改」是否合理）。
    const earlierPaths = new Set(this.#tasks.list(100)
      .filter((other) => other.planId === planId && other.id !== task.id && other.repo === task.repo)
      .flatMap((other) => diffPaths(other.diff)));
    this.#finishItem(planId, itemId, this.#evaluateModify(item, target, result, verification, watchChanged, earlierPaths));
  }

  /** Core 判定修改結果（spec-plans §4 第 4～7 點），不採信自述。 */
  #evaluateModify(
    item: PlanItem, target: WritableTarget, result: Parameters<TaskRunnerHooks["onFinished"]>[0],
    verification?: ItemVerification, watchChanged: string[] = [], earlierPaths: ReadonlySet<string> = new Set(),
  ): ItemOutcome {
    const diff = result.diff as SnapshotDiff | undefined;
    const rawMismatch = result.mismatch as SnapshotMismatch | undefined;
    // 重做時，前一次嘗試已建立的檔在快照看來是「修改」（或這次沒再動而「未改變」），執行者依 git（仍未追蹤）回報「新增」；
    // 這兩種都不算不一致（R2 實測發現）。
    const mismatch = rawMismatch === undefined ? undefined : {
      ...rawMismatch,
      reportedButUnchanged: rawMismatch.reportedButUnchanged.filter((entry) => !earlierPaths.has(entry.path)),
      kindDiffers: rawMismatch.kindDiffers.filter((entry) =>
        !(entry.reported === "added" && entry.actual === "modified" && earlierPaths.has(entry.path))),
    };
    const report: CodexReport | undefined = validateCodexReport(result.report) ? result.report : undefined;
    const diffText = diff === undefined ? "（沒有快照差異）"
      : `新增 ${diff.added.join("、") || "無"}；修改 ${diff.modified.join("、") || "無"}；刪除 ${diff.deleted.join("、") || "無"}`;
    // R2-1：禁改路徑與監看路徑，一律暫停（不重試）。
    const touched = diff === undefined ? [] : [...diff.added, ...diff.modified, ...diff.deleted];
    const forbidden = [...new Set([...highRiskPaths(touched, target.forbiddenPatterns), ...watchChanged])].sort();
    if (forbidden.length > 0) {
      return {
        ok: false, retryable: false, feedback: "", pause: "forbidden_path",
        error: `改到禁改路徑：${forbidden.slice(0, 10).join("、")}${forbidden.length > 10 ? " 等" : ""}`,
      };
    }
    if (diff !== undefined && (diff.deleted.length > 0 || diff.headChanged)) {
      return {
        ok: false, retryable: false, feedback: "", pause: "repo_destructive",
        error: diff.headChanged ? "HEAD 被改變（可能有 commit／切分支）" : `有檔案被刪除：${diff.deleted.join("、")}`,
      };
    }
    const problems: string[] = [];
    if (result.status !== "succeeded") problems.push(`執行失敗：${result.error ?? "未知原因"}`);
    if (report === undefined) problems.push(`沒有合格的結構化回報${result.reportError ? `（${result.reportError}）` : ""}`);
    const unmet = report?.acceptance.filter((entry) => !entry.met) ?? [];
    if (unmet.length > 0) problems.push(`未達成的驗收：${unmet.map((entry) => entry.criterion).join("；")}`);
    if (verification !== undefined) {
      // R2-2：有 Core 驗收時以它為準（執行者自述的測試結果只記錄）。
      if (verification.newFailures.length > 0) {
        problems.push(`Core 驗收測試新增失敗（開工前 ${verification.baselineFailures} 項 → 現在 ${verification.afterFailures} 項）：${verification.newFailures.slice(0, 10).join("；")}`);
      }
    } else {
      const failedTests = report?.tests.filter((entry) => entry.result === "fail") ?? [];
      if (failedTests.length > 0) problems.push(`測試失敗：${failedTests.map((entry) => entry.command).join("、")}`);
    }
    if (mismatch !== undefined && (mismatch.reportedButUnchanged.length + mismatch.changedButUnreported.length + mismatch.kindDiffers.length) > 0) {
      problems.push(`回報與快照不一致：${JSON.stringify(mismatch)}`);
    }
    const conflict = report === undefined ? undefined : extractSpecConflict(report.notes);
    if (conflict !== undefined) {
      return { ok: false, retryable: false, feedback: "", pause: "spec_conflict", error: `規格衝突：${conflict}` };
    }
    if (problems.length > 0) {
      return {
        ok: false, retryable: true, error: problems.join("；"),
        feedback: [`## 上一次沒有通過驗收（請修正）`, ...problems.map((problem) => `- ${problem}`), `- 快照差異：${diffText}`].join("\n"),
      };
    }
    const changed = diff === undefined ? [] : [...diff.added, ...diff.modified];
    const highRisk = highRiskPaths(changed, target.highRiskPatterns);
    return {
      ok: true,
      result: {
        summary: report!.summary, tests: report!.tests, acceptance: report!.acceptance, unfinished: report!.unfinished,
        writeback: extractWritebackCandidates(report!.notes),
        differences: extractDifferences(report!.notes),
        diff, highRisk, reviewNeeded: item.risk === "high" || highRisk.length > 0,
        ...(verification === undefined ? {} : { verification }),
      },
    };
  }

  // ─── 結束項目、暫停、完成 ────────────────────────────────────────────────

  #finishItem(planId: string, itemId: string, outcome: ItemOutcome): void {
    const endedAt = this.#now().toISOString();
    const item = this.#plans.item(itemId);
    const plan = this.#plans.get(planId);
    if (item === undefined || plan === undefined) return;
    if (plan.status === "cancelled") {
      this.#plans.updateItem(itemId, { status: "cancelled", endedAt });
      return;
    }
    if (outcome.ok) {
      this.#plans.updateItem(itemId, { status: "done", result: outcome.result, endedAt, error: null });
      const result = outcome.result as { reviewNeeded?: boolean } | null;
      if ((item.kind === "modify" || item.kind === "session") && result?.reviewNeeded === true) this.#ensureReview(plan, this.#plans.item(itemId)!);
      this.#events.broadcast("plan.progress", { planId, itemKey: item.key, text: `✓ ${item.title}` });
      this.#broadcastUpdate(planId);
      this.#pump();
      return;
    }
    if (outcome.pause !== undefined) {
      this.#plans.updateItem(itemId, { status: "failed", endedAt, error: outcome.error });
      this.#pause(planId, outcome.pause, `「${item.title}」：${outcome.error}`);
      return;
    }
    if (outcome.retryable && item.attempts < MAX_ATTEMPTS) {
      // C2-5：自動重試一次，把錯誤與差異附給執行者。
      this.#plans.updateItem(itemId, {
        status: "pending", endedAt, error: outcome.error,
        instructions: outcome.feedback === "" ? item.instructions : `${item.instructions}\n\n${outcome.feedback}`,
      });
      this.#events.broadcast("plan.progress", { planId, itemKey: item.key, text: `↻ 重試：${clip(outcome.error, 150)}` });
      this.#broadcastUpdate(planId);
      this.#pump();
      return;
    }
    this.#plans.updateItem(itemId, { status: "failed", endedAt, error: outcome.error });
    this.#pause(planId, "item_failed", `「${item.title}」失敗 ${item.attempts} 次：${outcome.error}`);
  }

  #ensureReview(plan: Plan, item: PlanItem): void {
    const key = `${item.key}-review`;
    const existing = this.#plans.items(plan.id).find((candidate) => candidate.key === key);
    if (existing !== undefined) {
      if (existing.status !== "pending") this.#plans.updateItem(existing.id, { status: "pending" });
      return;
    }
    const target = this.writableTargets().find((candidate) => candidate.name === item.project);
    const role = item.role ?? target?.role ?? this.#local.projects[0]?.role ?? null;
    if (role === null || this.#worker === undefined) {
      this.#appendSystem(`計畫 ${short(plan.id)} 的「${item.title}」需要審查，但沒有可用的部下；請主人自行檢查`);
      return;
    }
    this.#plans.insertAfter(plan.id, item.seq, {
      key, title: `審查：${item.title}`, kind: "review", project: item.project, role,
      instructions: "審查原項目的變更。", acceptance: ["審查結論為通過"], dependsOn: [item.key], risk: "normal",
      estimateMin: null, reviewOf: item.key,
    });
    this.#events.broadcast("plan.progress", { planId: plan.id, itemKey: key, text: `＋ 自動加入審查：${item.title}` });
  }

  #pause(planId: string, reason: string, detail: string): void {
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.status !== "running") return;
    const updated = this.#plans.update(planId, { status: "paused", pauseReason: reason, pauseDetail: detail });
    this.#events.broadcast("plan.paused", { planId, reason, detail });
    this.#broadcastUpdate(planId);
    const files = this.#writeFiles(planId);
    const message = this.#appendSystem(`計畫 ${short(planId)} 暫停（${reason}）：${detail}`);
    this.#notify?.(message, "paused", updated, this.#plans.items(planId), files);
    this.#dependencyPaused(planId);
    this.#promoteQueued();
  }

  #complete(planId: string): void {
    const endedAt = this.#now().toISOString();
    const plan = this.#plans.update(planId, { status: "completed", endedAt });
    this.#events.broadcast("plan.done", { planId, status: "completed" });
    this.#broadcastUpdate(planId);
    const files = this.#writeFiles(planId);
    const message = this.#appendSystem(`計畫 ${short(planId)} 完成：${plan.goal}`);
    this.#notify?.(message, "completed", plan, this.#plans.items(planId), files);
    this.#promoteQueued();
  }

  /** 有執行中名額時，讓最早排隊的計畫開始（C3-3）。 */
  #promoteQueued(): void {
    let promoted = false;
    while (this.#plans.listByStatuses(["running"]).length < MAX_RUNNING_PLANS) {
      const next = this.#plans.listByStatuses(["queued"]).find((candidate) => this.#depsDone(candidate));
      if (next === undefined) break;
      this.#plans.update(next.id, { status: "running" });
      this.#appendSystem(`排隊中的計畫 ${short(next.id)} 開始執行：${next.goal}`);
      this.#events.broadcast("plan.progress", { planId: next.id, itemKey: "-", text: "▶ 排隊結束，開始執行" });
      this.#broadcastUpdate(next.id);
      promoted = true;
    }
    if (promoted) this.#pump();
  }

  /** 寫報告檔與回寫候選檔；失敗只記警告，不影響計畫流程。 */
  #writeFiles(planId: string): PlanFiles | undefined {
    const plan = this.#plans.get(planId);
    if (plan === undefined) return undefined;
    try {
      const tasks = this.#tasks.list(100).filter((task) => task.planId === planId);
      const items = this.#plans.items(planId);
      const refIds = [...new Set([...tasks.map((task) => task.id), ...items.flatMap((item) => (item.refId === null ? [] : [item.refId]))])];
      const usage = this.#usage?.listByRefIds(refIds) ?? [];
      const changeLogProjects = this.writableTargets().filter((target) => target.changeLogDraft).map((target) => target.name);
      return writePlanFiles(this.#config.dataDir, { plan, items, tasks, usage, now: this.#now(), changeLogProjects });
    } catch (error) {
      console.warn("Unable to write plan report:", error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  #scheduleExpiry(planId: string): void {
    const timer = setTimeout(() => {
      const plan = this.#plans.get(planId);
      if (plan?.status !== "pending_approval") return;
      const endedAt = this.#now().toISOString();
      const updated = this.#plans.update(planId, { status: "expired", decidedAt: endedAt, decidedBy: "system", endedAt });
      this.#events.broadcast("plan.permission.resolved", { planId, result: "expired", decidedAt: endedAt, decidedBy: "system" });
      const message = this.#appendSystem(`計畫確認逾時：${plan.goal}`);
      this.#notify?.(message, "expired", updated, this.#plans.items(planId));
    }, Math.max(0, this.#config.plans.approvalTimeoutMin * 60_000));
    timer.unref();
    this.#approvalTimers.set(planId, timer);
  }

  #clearApprovalTimer(planId: string): void {
    const timer = this.#approvalTimers.get(planId);
    if (timer !== undefined) clearTimeout(timer);
    this.#approvalTimers.delete(planId);
  }

  #broadcastUpdate(planId: string): void {
    const plan = this.#plans.get(planId);
    if (plan !== undefined) this.#events.broadcast("plan.updated", { plan, items: this.#plans.items(planId) });
  }

  #appendSystem(text: string): Message {
    const message = this.#messages.append({ role: "system", text });
    this.#events.broadcast("message.created", message);
    return message;
  }
}

/** 給艾莉絲的計畫結果（通知推理用，截斷至 12 KB）。 */
export function planResultForPrompt(plan: Plan, items: PlanItem[]): string {
  const payload = {
    id: plan.id, shortId: short(plan.id), goal: plan.goal, status: plan.status,
    pauseReason: plan.pauseReason, pauseDetail: plan.pauseDetail,
    items: items.map((item) => ({
      key: item.key, title: item.title, kind: item.kind, project: item.project, status: item.status,
      attempts: item.attempts, executor: item.executor, error: item.error, result: item.result,
    })),
  };
  const text = JSON.stringify(payload, null, 1);
  return Buffer.byteLength(text, "utf8") <= 12 * 1024 ? text : `${Buffer.from(text, "utf8").subarray(0, 12 * 1024).toString("utf8")}…（已截斷）`;
}
