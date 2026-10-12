import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ChannelStore } from "../src/channels/channelStore.js";
import type { WorkerRunInput, WorkerRunResult } from "../src/channels/workerRunner.js";
import { defaultConfig, type Config, type WritableRepo } from "../src/config.js";
import { ConversationService } from "../src/conversation/conversationService.js";
import type { LocalConfig } from "../src/localConfig.js";
import { ClaudeWriterRunner, writerProgress, type WriterSpawn } from "../src/plans/claudeWriterRunner.js";
import { highRiskPaths, matchesAnyPattern } from "../src/plans/pathPatterns.js";
import { extractDifferences, extractReviewVerdict, extractSpecConflict, extractWritebackCandidates, parsePlanBlock } from "../src/plans/planParser.js";
import { PlanService, type PlanFiles, type PlanNotificationKind } from "../src/plans/planService.js";
import { PlanStore } from "../src/plans/planStore.js";
import { OutboxService } from "../src/relay/outboxService.js";
import { OutboxStore } from "../src/relay/outboxStore.js";
import { parseSendBlock } from "../src/relay/sendBlock.js";
import { AliceBlockFilter } from "../src/tasks/aliceBlockFilter.js";
import {
  changedWatchedFiles, compareVerification, failureKeys, GIT_WATCH_SUFFIX, hashWatchedPaths, runVerification, type CommandRun,
} from "../src/plans/verification.js";
import { loadLocalConfig } from "../src/localConfig.js";
import type { EventHub } from "../src/protocol/eventHub.js";
import { CharacterState } from "../src/state/characterState.js";
import { MessageStore } from "../src/store/messageStore.js";
import type { CodexReport } from "../src/tasks/codexRunner.js";
import type { RepoSnapshot, SnapshotDiff } from "../src/tasks/snapshot.js";
import { UnavailableRunner, type TaskRunner, type TaskRunnerHooks } from "../src/tasks/taskRunner.js";
import { TaskService } from "../src/tasks/taskService.js";
import { TaskStore, type Task } from "../src/tasks/taskStore.js";
import type { Quotas } from "../src/usage/quota.js";
import { UsageStore } from "../src/usage/usageStore.js";
import { appendSuggestion, parseSuggestBlock } from "../src/suggestions/suggestionLog.js";
import { formatGames } from "../src/prompt/promptBuilder.js";
import { FakeProvider } from "./fakeProvider.js";

// ─── 共用工具 ────────────────────────────────────────────────────────────

function planBlock(value: unknown): string {
  return `<<<ALICE_PLAN\n${JSON.stringify(value)}\nALICE_PLAN>>>`;
}

function report(options: { met?: boolean; files?: CodexReport["filesChanged"]; notes?: string; testsFail?: boolean } = {}): CodexReport {
  return {
    summary: "完成修改",
    filesChanged: options.files ?? [{ path: "src/a.js", change: "modified" }],
    tests: [{ command: "npm test", result: options.testsFail ? "fail" : "pass", detail: "ok" }],
    acceptance: [{ criterion: "npm test 全部通過", met: options.met ?? true, evidence: "8 passed" }],
    unfinished: [],
    notes: options.notes ?? "",
  };
}

function diff(partial: Partial<SnapshotDiff> = {}): SnapshotDiff {
  return { added: [], modified: ["src/a.js"], deleted: [], headChanged: false, ...partial };
}

type RunnerScript = (task: Task) => Parameters<TaskRunnerHooks["onFinished"]>[0];

class FakeTaskRunner implements TaskRunner {
  readonly tasks: Task[] = [];
  readonly scripts: RunnerScript[];

  constructor(scripts: RunnerScript[]) {
    this.scripts = [...scripts];
  }

  start(task: Task, hooks: TaskRunnerHooks): void {
    this.tasks.push(task);
    const script = this.scripts.shift();
    queueMicrotask(() => {
      if (script === undefined) {
        hooks.onFinished({ status: "failed", error: "沒有安排的結果" });
        return;
      }
      hooks.onProgress(`執行 ${task.goal}`);
      hooks.onFinished(script(task));
    });
  }

  cancel(): void {
    // 測試用：沒有外部行程。
  }
}

/** 開始後不自動結束，由測試呼叫 finish 放行；用來觀察同時執行與排隊（C3-3）。 */
class GatedRunner implements TaskRunner {
  readonly tasks: Task[] = [];
  readonly #hooks = new Map<string, TaskRunnerHooks>();

  start(task: Task, hooks: TaskRunnerHooks): void {
    this.tasks.push(task);
    this.#hooks.set(task.id, hooks);
  }

  finish(task: Task, script: RunnerScript): void {
    const hooks = this.#hooks.get(task.id);
    this.#hooks.delete(task.id);
    hooks?.onFinished(script(task));
  }

  cancel(): void {
    // 測試用：沒有外部行程。
  }
}

const success = (files?: CodexReport["filesChanged"], d?: Partial<SnapshotDiff>): RunnerScript => () => ({
  status: "succeeded",
  report: report(files === undefined ? {} : { files }),
  diff: diff(d),
  mismatch: { reportedButUnchanged: [], changedButUnreported: [], kindDiffers: [] },
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type Setup = {
  directory: string;
  local: LocalConfig;
  service: PlanService;
  plans: PlanStore;
  tasks: TaskStore;
  messages: MessageStore;
  channels: ChannelStore;
  codex: FakeTaskRunner;
  claude: FakeTaskRunner;
  workerCalls: WorkerRunInput[];
  events: Array<{ type: string; data: unknown }>;
  notes: PlanNotificationKind[];
  files: Array<PlanFiles | undefined>;
  dataDir: string;
  dirty: string[];
  repo: string;
  verifyCalls: Array<{ repoPath: string; command: string }>;
  outbox: OutboxService;
  outboxStore: OutboxStore;
  close: () => void;
};

/** 假的驗收指令執行器：依呼叫次序回傳輸出（預設全部通過）。 */
type VerifyScript = (command: string, call: number) => Partial<CommandRun>;

function setup(options: {
  codex?: RunnerScript[];
  claude?: RunnerScript[];
  worker?: Array<string | Error>;
  use?: "auto" | boolean;
  codexUsed?: number;
  approvalTimeoutMin?: number;
  codexRunner?: TaskRunner;
  repoDiff?: (repoPath: string, paths: string[]) => Promise<string>;
  verify?: VerifyScript;
  sandbox?: Partial<WritableRepo>;
} = {}): Setup {
  const directory = mkdtempSync(join(tmpdir(), "alice-plan-"));
  const repo = join(directory, "sandbox");
  const project = join(directory, "project");
  const vault = join(directory, "vault");
  const repo2 = join(directory, "sandbox2");
  mkdirSync(repo);
  mkdirSync(repo2);
  mkdirSync(project);
  mkdirSync(join(vault, "roles"), { recursive: true });
  const dbPath = join(directory, "alice.db");
  const messages = new MessageStore(dbPath);
  const tasks = new TaskStore(dbPath);
  const plans = new PlanStore(dbPath);
  const channels = new ChannelStore(dbPath);
  const events: Setup["events"] = [];
  const usage = new UsageStore(dbPath);
  const outboxStore = new OutboxStore(dbPath);
  const outboxEvents = { broadcast: (type: string, data: unknown) => { events.push({ type, data }); } } as unknown as EventHub;
  const outbox = new OutboxService({
    store: outboxStore, messages, events: outboxEvents, relaySession: "ALICE",
    targets: () => [
      { project: "sandbox", role: "工程師", session: "Sandbox Dev" },
      { project: "工具專案", role: "工程師", session: "Tool Dev" },
    ],
  });
  const config: Config = {
    ...defaultConfig,
    dataDir: join(directory, "data"),
    plans: { ...defaultConfig.plans, approvalTimeoutMin: options.approvalTimeoutMin ?? 10 },
    tools: {
      codex: {
        ...defaultConfig.tools.codex,
        use: options.use ?? "auto",
        available: options.use !== false,
        repos: {
          sandbox: { path: repo, description: "測試 repo", testCommands: ["npm test"], ...options.sandbox },
          sandbox2: { path: repo2, description: "第二個測試 repo", testCommands: ["npm test"] },
        },
      },
    },
  };
  const local: LocalConfig = {
    path: join(directory, "alice.local.json"),
    knowledgeBase: { path: vault, summaryPage: "summary.md", rolesDir: "roles" },
    docRoots: [],
    codexAvailable: true,
    projects: [{ name: "工具專案", path: project, role: "工程師", readDirs: [] }],
    workerTimeoutMin: 5,
    summaryEnabled: true,
    workersEnabled: true, dispatch: true, remoteOrigins: [], workflowFile: null, translateGlossary: [],
    reasons: [],
  };
  const hub = { broadcast: (type: string, data: unknown) => { events.push({ type, data }); } } as unknown as EventHub;
  const workerReplies = [...(options.worker ?? [])];
  const workerCalls: WorkerRunInput[] = [];
  const worker = {
    canStart: () => true,
    run: async (input: WorkerRunInput): Promise<WorkerRunResult> => {
      workerCalls.push(input);
      const reply = workerReplies.shift() ?? "查完了。\n需要決定：無\n規格衝突：無";
      if (reply instanceof Error) throw reply;
      return { text: reply, sessionId: "sid", permissionDeniedPaths: [] };
    },
  };
  const codex = new FakeTaskRunner(options.codex ?? []);
  const claude = new FakeTaskRunner(options.claude ?? []);
  const used = options.codexUsed ?? 10;
  const quotas = {
    read: async (): Promise<Quotas> => ({
      max: { status: "ok" },
      codex: { status: "ok", primary: { usedPercent: used, resets: "" }, secondary: { usedPercent: 5, resets: "" } },
    }),
  };
  const dirty: string[] = [];
  const verifyCalls: Setup["verifyCalls"] = [];
  const service = new PlanService({
    config, local, plans, tasks, messages, channels, events: hub,
    state: new CharacterState({ now: () => new Date(), config }),
    worker, codexRunner: options.codexRunner ?? codex, claudeRunner: claude, quotas,
    repoStatus: async () => [...dirty], usage, outbox,
    verifyExecutor: async (repoPath, command) => {
      verifyCalls.push({ repoPath, command });
      const scripted = options.verify?.(command, verifyCalls.length - 1) ?? {};
      return { command, exitCode: 0, timedOut: false, durationMs: 1, output: "", ...scripted };
    },
    ...(options.repoDiff === undefined ? {} : { repoDiff: options.repoDiff }),
  });
  const notes: PlanNotificationKind[] = [];
  const files: Array<PlanFiles | undefined> = [];
  service.setNotificationHandler((_message, kind, _plan, _items, planFiles) => { notes.push(kind); files.push(planFiles); });
  return {
    directory, service, plans, tasks, messages, channels, codex, claude, workerCalls, events, notes, files, dataDir: config.dataDir, dirty, repo, verifyCalls, outbox, outboxStore, local,
    close: () => {
      service.close();
      outboxStore.close();
      usage.close();
      channels.close();
      plans.close();
      tasks.close();
      messages.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const readThenModify = {
  goal: "分析後修改 sandbox",
  items: [
    { key: "a", title: "分析現況", kind: "read", project: "工具專案", role: "工程師", instructions: "查現況", acceptance: ["列出現況"] },
    { key: "b", title: "實作", kind: "modify", project: "sandbox", instructions: "改 src/a.js", acceptance: ["npm test 全部通過"], dependsOn: ["a"] },
  ],
  risks: ["可能影響既有測試"],
  decisions: [],
};

// ─── 解析與樣式 ──────────────────────────────────────────────────────────

// 測試計畫區塊的必填欄位、key 規則、依賴只能向前、read 必須有角色，錯誤都要被擋下並附原因。
test("parsePlanBlock validates structure and dependencies", () => {
  const parsed = parsePlanBlock(planBlock(readThenModify));
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(parsed.items[1]?.dependsOn, ["a"]);
  assert.equal(parsed.items[1]?.risk, "normal");
  assert.equal(parsed.preauthorizeClaudeFallback, false);
  const bad = (items: unknown[], pattern: RegExp): void => {
    assert.throws(() => parsePlanBlock(planBlock({ goal: "g", items })), pattern);
  };
  const base = { key: "a", title: "t", kind: "modify", project: "sandbox", instructions: "i", acceptance: ["x"] };
  bad([base, { ...base }], /重複/u);
  bad([{ ...base, dependsOn: ["z"] }], /只能引用前面/u);
  bad([{ ...base, kind: "read" }], /必須指定 role/u);
  bad([{ ...base, key: "a-review" }], /-review/u);
  bad([{ ...base, acceptance: [] }], /acceptance/u);
  bad([{ ...base, kind: "delete" }], /read、modify 或 session/u);
  assert.throws(() => parsePlanBlock("<<<ALICE_PLAN\n{bad json\nALICE_PLAN>>>"), /JSON/u);
  // 標題要主人看得懂（2026-10-01）：goal 40 字、項目 title 24 字，不放反引號。
  assert.throws(() => parsePlanBlock(planBlock({ goal: "長".repeat(41), items: [base] })), /goal 太長（41 字，上限 40 字）/u);
  bad([{ ...base, title: "長".repeat(25) }], /items\[0\]\.title 太長/u);
  bad([{ ...base, title: "修正 `fResult.maxWin`" }], /不要放程式碼/u);
  assert.equal(parsePlanBlock(planBlock({ goal: "確認上限觸發時會截斷輸出（工具端）", items: [base] })).goal, "確認上限觸發時會截斷輸出（工具端）");
});

// 測試規格衝突段落與審查結論的擷取：空白或「無」不算衝突，審查以最後一行為準。
test("spec conflict and review verdict extraction", () => {
  assert.equal(extractSpecConflict("結果\n規格衝突：無"), undefined);
  assert.match(extractSpecConflict("結果\n規格衝突：規格書寫 3 格，程式是 4 格")!, /3 格/u);
  assert.equal(extractSpecConflict("規格衝突：無\n審查結論：通過"), undefined);
  assert.equal(extractSpecConflict("規格衝突：\n- 上限不同\n- 名稱不同\n審查結論：通過"), "- 上限不同\n- 名稱不同");
  // 實測：標籤寫成粗體時，內容在下一行（一般文字或條列都要收），收到空行或下一個標籤為止。
  assert.equal(extractSpecConflict("**規格衝突：**\nTodoList 說截斷派彩，程式會重抽。\n- 出處 gameControl.js:219\n\n**回寫候選：** 無"), "TodoList 說截斷派彩，程式會重抽。\n- 出處 gameControl.js:219");
  assert.equal(extractSpecConflict("**規格衝突：** 上限是 5555"), "上限是 5555");
  assert.equal(extractSpecConflict("## 規格衝突：\n無\n## 回寫候選：\n- x"), undefined);
  assert.equal(extractSpecConflict("**規格衝突：**\n**發現的差異：** 名稱不同"), undefined);
  assert.deepEqual(extractReviewVerdict("看過了\n審查結論：通過"), { passed: true, reason: "" });
  assert.deepEqual(extractReviewVerdict("審查結論：通過\n再看一次\n審查結論：不通過（缺測試）"), { passed: false, reason: "缺測試" });
  assert.equal(extractReviewVerdict("沒有結論"), undefined);
});

// 測試高風險路徑樣式：** 跨資料夾、* 不跨、不分大小寫。
test("high risk path patterns", () => {
  assert.equal(matchesAnyPattern("docs/spec.md", ["docs/**"]), true);
  assert.equal(matchesAnyPattern("config/a.xls", ["**/*.xls"]), true);
  assert.equal(matchesAnyPattern("A.XLS", ["**/*.xls"]), true);
  assert.equal(matchesAnyPattern("src/a.js", ["**/*.xls", "docs/**"]), false);
  assert.equal(matchesAnyPattern("src/deep/x.js", ["src/*.js"]), false);
  assert.deepEqual(highRiskPaths(["src/a.js", "app/config/x.json"], ["**/config/**"]), ["app/config/x.json"]);
});

// ─── 計畫流程 ────────────────────────────────────────────────────────────

// 測試完整流程：建立 → 核准 → 唯讀項目 → 修改項目交給 Codex（任務寫入 tasks 表、附前置結果）→ 完成並通知艾莉絲。
test("plan runs read then modify with Codex and completes", async () => {
  const s = setup({ codex: [success()], worker: ["現況：a.js 有兩個函式。\n需要決定：無\n規格衝突：無"] });
  try {
    const plan = s.service.createFromBlock(planBlock(readThenModify), "msg-1")!;
    assert.equal(plan.status, "pending_approval");
    assert.ok(s.events.some((event) => event.type === "plan.permission.request"));
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "計畫完成");
    const items = s.plans.items(plan.id);
    assert.deepEqual(items.map((item) => item.status), ["done", "done"]);
    assert.equal(items[1]?.executor, "codex");
    assert.equal(s.codex.tasks.length, 1);
    assert.equal(s.codex.tasks[0]?.planId, plan.id);
    assert.match(s.codex.tasks[0]!.instructions, /前置項目的結果[\s\S]*a\.js 有兩個函式/u);
    assert.equal(s.tasks.get(s.codex.tasks[0]!.id)?.status, "succeeded");
    assert.equal(s.workerCalls.length, 1);
    assert.equal(s.channels.list().length, 1);
    assert.equal(s.plans.get(plan.id)?.status, "completed");
    assert.equal(s.claude.tasks.length, 0);
  } finally {
    s.close();
  }
});

// 測試 Codex 關閉（K7）時修改項目直接改派 Claude 寫檔 worker，不詢問。
test("codex disabled routes modify items to the Claude writer", async () => {
  const s = setup({ use: false, claude: [success()] });
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [readThenModify.items[1]!].map((item) => ({ ...item, dependsOn: [] })) }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "完成");
    assert.equal(s.codex.tasks.length, 0);
    assert.equal(s.claude.tasks.length, 1);
    assert.equal(s.plans.items(plan.id)[0]?.executor, "claude");
  } finally {
    s.close();
  }
});

// 測試 Codex 額度達門檻且沒有預先授權時暫停；主人以 resume claude 授權後改由 Claude 完成（C2-3、Q17 ⑤）。
test("codex quota threshold pauses until the owner authorizes Claude", async () => {
  const s = setup({ codexUsed: 90, claude: [success()] });
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [] }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "codex_quota");
    assert.equal(s.codex.tasks.length + s.claude.tasks.length, 0);
    s.service.resume(plan.id.slice(0, 8), "cli", { executor: "claude" });
    await waitFor(() => s.notes.includes("completed"), "完成");
    assert.equal(s.claude.tasks.length, 1);
    assert.equal(s.plans.get(plan.id)?.preauthorizeClaudeFallback, true);
  } finally {
    s.close();
  }
});

// 測試改到高風險路徑時自動插入審查項目，審查通過後計畫才完成（C2-4、Q14）。
test("high risk changes insert a review item", async () => {
  const diffPaths: string[][] = [];
  const s = setup({
    repoDiff: async (_repoPath, paths) => { diffPaths.push(paths); return "diff --git a/docs/spec.md\n+上限改成 10"; },
    codex: [success([{ path: "docs/spec.md", change: "modified" }], { modified: ["docs/spec.md"] })],
    worker: ["檢查過了，符合驗收。\n規格衝突：無\n審查結論：通過"],
  });
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [] }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "完成");
    const items = s.plans.items(plan.id);
    assert.deepEqual(items.map((item) => [item.key, item.kind, item.status]), [["b", "modify", "done"], ["b-review", "review", "done"]]);
    assert.match(s.workerCalls[0]!.question, /審查[\s\S]*docs\/spec\.md[\s\S]*審查結論/u);
    assert.match(s.workerCalls[0]!.question, /上限改成 10/u);
    assert.deepEqual(diffPaths, [["docs/spec.md"]]);
    assert.equal(s.workerCalls[0]?.project.path.endsWith("sandbox"), true);
  } finally {
    s.close();
  }
});

// 測試審查不通過時原項目帶著審查意見重做一次，重做後審查通過才完成。
test("review rejection redoes the original item once", async () => {
  const s = setup({
    codex: [success(undefined, {}), success(undefined, {})],
    worker: ["審查結論：不通過（缺少邊界測試）", "審查結論：通過"],
  });
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [], risk: "high" }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "完成");
    assert.equal(s.codex.tasks.length, 2);
    assert.match(s.codex.tasks[1]!.instructions, /審查意見[\s\S]*缺少邊界測試/u);
    assert.equal(s.workerCalls.length, 2);
  } finally {
    s.close();
  }
});

// 測試 repo 有不是本計畫造成的未提交改動時，派工前就暫停詢問主人（Q21）。
test("foreign uncommitted changes pause before dispatch", async () => {
  const s = setup({ codex: [success()] });
  try {
    s.dirty.push("notes/owner.md");
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [] }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "repo_dirty");
    assert.match(s.plans.get(plan.id)!.pauseDetail!, /notes\/owner\.md/u);
    assert.equal(s.codex.tasks.length, 0);
  } finally {
    s.close();
  }
});

// 測試快照顯示有檔案被刪除時立即暫停，不重試（Q17 ④）。
test("deleted files pause the plan", async () => {
  const s = setup({ codex: [success([{ path: "src/a.js", change: "deleted" }], { modified: [], deleted: ["src/a.js"] })] });
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [] }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "repo_destructive");
    assert.equal(s.codex.tasks.length, 1);
  } finally {
    s.close();
  }
});

// 測試驗收未達成時自動重試一次並附上問題（C2-5）；第二次成功則完成。
test("unmet acceptance retries once with feedback", async () => {
  const s = setup({
    codex: [
      () => ({ status: "succeeded", report: report({ met: false }), diff: diff(), mismatch: { reportedButUnchanged: [], changedButUnreported: [], kindDiffers: [] } }),
      success(),
    ],
  });
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [] }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "完成");
    assert.equal(s.codex.tasks.length, 2);
    assert.match(s.codex.tasks[1]!.instructions, /上一次沒有通過驗收[\s\S]*未達成的驗收/u);
  } finally {
    s.close();
  }
});

// 測試重試時，上一次嘗試留下的未提交改動算「本計畫造成的」，不會被 repo 衝突檢查擋下（實測發現的缺陷）。
test("retry is not blocked by changes left by an earlier attempt of the same plan", async () => {
  let dirty: string[] = [];
  const s = setup({
    codex: [
      () => {
        dirty.push("src/a.js");
        return { status: "succeeded", report: report({ met: false }), diff: diff(), mismatch: { reportedButUnchanged: [], changedButUnreported: [], kindDiffers: [] } };
      },
      success(),
    ],
  });
  dirty = s.dirty;
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [] }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.length > 0, "結束或暫停");
    assert.deepEqual(s.notes, ["completed"]);
    assert.equal(s.codex.tasks.length, 2);
  } finally {
    s.close();
  }
});

// 測試同一項失敗兩次就暫停問主人（Q17 ②），resume 會把失敗項目重設後再試。
test("two failures pause the plan and resume retries", async () => {
  const fail: RunnerScript = () => ({ status: "failed", error: "測試失敗" });
  const s = setup({ codex: [fail, fail, success()] });
  try {
    const plan = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [] }] }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "item_failed");
    assert.equal(s.codex.tasks.length, 2);
    s.service.resume(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "完成");
    assert.equal(s.codex.tasks.length, 3);
  } finally {
    s.close();
  }
});

// 測試部下回報規格衝突時暫停問主人（Q17 ①）。
test("spec conflict in a read item pauses", async () => {
  const s = setup({ worker: ["查到了。\n規格衝突：規格書寫上限 10，程式是 20"] });
  try {
    const plan = s.service.createFromBlock(planBlock(readThenModify), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "spec_conflict");
    assert.equal(s.codex.tasks.length, 0);
  } finally {
    s.close();
  }
});

// 測試驗證：修改不在白名單的專案、已有另一份計畫等待確認時都不建立，並寫 system 訊息讓艾莉絲看得到。
test("invalid or concurrent plans are rejected with a system message", () => {
  const s = setup();
  try {
    const outside = s.service.createFromBlock(planBlock({ goal: "g", items: [{ ...readThenModify.items[1]!, project: "工具專案", dependsOn: [] }] }), "m");
    assert.equal(outside, undefined);
    assert.match(s.messages.list({ limit: 1 })[0]!.text, /不在可修改的白名單/u);
    assert.ok(s.service.createFromBlock(planBlock(readThenModify), "m") !== undefined);
    assert.equal(s.service.createFromBlock(planBlock(readThenModify), "m"), undefined);
    assert.match(s.messages.list({ limit: 1 })[0]!.text, /已有計畫等待主人確認/u);
  } finally {
    s.close();
  }
});

// 測試拒絕與確認逾時都會通知艾莉絲，且不執行任何項目。
test("reject and approval timeout notify without running", async () => {
  const s = setup({ approvalTimeoutMin: 0.0005 });
  try {
    const rejected = s.service.createFromBlock(planBlock(readThenModify), "m")!;
    s.service.reject(rejected.id, "cli", "先不要");
    assert.equal(s.plans.get(rejected.id)?.status, "rejected");
    const expiring = s.service.createFromBlock(planBlock(readThenModify), "m")!;
    await waitFor(() => s.plans.get(expiring.id)?.status === "expired", "逾時");
    assert.deepEqual(s.notes, ["rejected", "expired"]);
    assert.equal(s.workerCalls.length + s.codex.tasks.length, 0);
  } finally {
    s.close();
  }
});

// 測試 Core 重啟時：等待確認的計畫失效、執行中的計畫暫停且進行中項目回到 pending。
test("recover expires pending plans and pauses running ones", async () => {
  const s = setup();
  try {
    const running = s.service.createFromBlock(planBlock(readThenModify), "m")!;
    s.plans.update(running.id, { status: "running" });
    const firstItem = s.plans.items(running.id)[0]!;
    s.plans.updateItem(firstItem.id, { status: "running" });
    await s.service.recover();
    assert.equal(s.plans.get(running.id)?.status, "paused");
    assert.equal(s.plans.get(running.id)?.pauseReason, "core_restart");
    assert.match(s.plans.get(running.id)!.pauseDetail!, /中斷的項目：a（分析現況）/u);
    assert.equal(s.plans.item(firstItem.id)?.status, "pending");
    assert.deepEqual(s.notes, ["restarted"]);
    assert.ok(existsSync(s.files[0]!.reportPath));
  } finally {
    s.close();
  }
});

// ─── Claude 寫檔 worker ───────────────────────────────────────────────────

type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; close: (code?: number) => void };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4321;
  child.close = (code = 0) => { child.emit("close", code, null); };
  return child;
}

// 測試 Claude 寫檔 worker 的參數只開放指定測試指令、以 repo 為 cwd，並用 structured_output 當結構化回報、快照比對一致。
test("ClaudeWriterRunner runs a restricted writer and reads structured output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-writer-"));
  const child = fakeChild();
  let args: string[] = [];
  let cwd = "";
  let stdin = "";
  child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
  const spawn: WriterSpawn = (_command, nextArgs, options) => {
    args = nextArgs;
    cwd = options.cwd;
    child.stdin.once("finish", () => {
      child.stdout.write(`${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/a.js" } }] },
      })}\n`);
      child.stdout.write(`${JSON.stringify({
        type: "result", is_error: false, result: "{}", structured_output: report(),
        usage: { input_tokens: 5, output_tokens: 7 }, modelUsage: { "claude-opus-5-5": { outputTokens: 7 } },
      })}\n`);
      child.close(0);
    });
    return child as never;
  };
  const snapshots: RepoSnapshot[] = [
    { head: "h", files: { "src/a.js": "1" } },
    { head: "h", files: { "src/a.js": "2" } },
  ];
  const snapshotter = { take: async () => snapshots.shift()! };
  const config = { ...defaultConfig, dataDir: join(directory, "data") };
  const runner = new ClaudeWriterRunner(config, { spawn, snapshotter, testCommandsFor: () => ["npm test", "npm run lint"] });
  const progress: string[] = [];
  let finished: Parameters<TaskRunnerHooks["onFinished"]>[0] | undefined;
  const task: Task = {
    id: "task-1", planId: "p", sourceMessageId: "m", tool: "claude", repo: "sandbox", repoPath: join(directory, "repo"),
    goal: "改 a", instructions: "改 src/a.js", acceptance: ["npm test 全部通過"], estimateMin: null, status: "running",
    createdAt: "", decidedAt: null, decidedBy: null, startedAt: null, endedAt: null, codexThreadId: null, pid: null,
    report: null, reportError: null, diff: null, mismatch: null, error: null,
  };
  try {
    await runner.start(task, {
      onStarted: () => undefined,
      onProgress: (text) => progress.push(text),
      onFinished: (result) => { finished = result; },
    });
    assert.equal(cwd, task.repoPath);
    const allowedAt = args.indexOf("--allowedTools");
    assert.deepEqual(args.slice(allowedAt, allowedAt + 5), ["--allowedTools", "Edit", "Write", "Bash(npm test)", "Bash(npm run lint)"]);
    assert.ok(args.includes("--json-schema"));
    assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.ok(!args.includes("--dangerously-skip-permissions"));
    assert.match(stdin, /只能執行這些指令：`npm test`、`npm run lint`/u);
    assert.deepEqual(progress, ["✎ src/a.js"]);
    assert.equal(finished?.status, "succeeded");
    assert.equal((finished?.report as CodexReport).summary, "完成修改");
    assert.deepEqual(finished?.diff, { added: [], modified: ["src/a.js"], deleted: [], headChanged: false });
    assert.equal(finished?.usage?.model, "claude-opus-5-5");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ─── 對話整合 ────────────────────────────────────────────────────────────

// 測試艾莉絲回覆同時含計畫與任務區塊時只建立計畫，且區塊不會出現在存下的回覆與串流中。
test("conversation creates a plan and ignores a task block in the same reply", async () => {
  const s = setup();
  const task = { tool: "codex", repo: "sandbox", goal: "g", instructions: "i", acceptance: ["x"] };
  const replyText = `我建議這樣做。${planBlock(readThenModify)}<<<ALICE_TASK\n${JSON.stringify(task)}\nALICE_TASK>>>`;
  const provider = new FakeProvider([{ text: replyText, deltas: [replyText.slice(0, 10), replyText.slice(10)] }]);
  const config = { ...defaultConfig, dataDir: join(s.directory, "data2") };
  const state = new CharacterState({ now: () => new Date(), config });
  const hub = { broadcast: (type: string, data: unknown) => { s.events.push({ type, data }); } } as unknown as EventHub;
  const taskService = new TaskService({ config, tasks: s.tasks, messages: s.messages, state, runner: new UnavailableRunner(), events: hub });
  const conversation = new ConversationService({ config, store: s.messages, state, provider, events: hub, tasks: taskService, plans: s.service, local: s.local });
  try {
    conversation.submit({ clientMsgId: "c1", clientId: "test", text: "幫我規劃" });
    await waitFor(() => s.plans.list().length === 1, "計畫建立");
    assert.equal(s.tasks.list().filter((item) => item.planId === null).length, 0);
    const alice = s.messages.list({ limit: 5 }).find((message) => message.role === "alice")!;
    assert.equal(alice.text, "我建議這樣做。");
    assert.match(provider.prompts[0]!.systemPrompt, /# 計畫[\s\S]*sandbox/u);
    const streamed = s.events.filter((event) => event.type === "reply.delta").map((event) => (event.data as { text: string }).text).join("");
    assert.equal(streamed, "我建議這樣做。");
  } finally {
    taskService.close();
    s.close();
  }
});

// 測試派工關閉（§57，本機設定 dispatch 預設 false）：提示裡沒有部下、計畫、Codex 任務、傳訊的段落。
test("conversation leaves dispatch sections out when dispatch is off", async () => {
  const s = setup();
  const provider = new FakeProvider([{ text: "好。" }]);
  const config = { ...defaultConfig, dataDir: join(s.directory, "data2") };
  const state = new CharacterState({ now: () => new Date(), config });
  const hub = { broadcast: () => undefined } as unknown as EventHub;
  const taskService = new TaskService({ config, tasks: s.tasks, messages: s.messages, state, runner: new UnavailableRunner(), events: hub });
  const conversation = new ConversationService({ config, store: s.messages, state, provider, events: hub, tasks: taskService, plans: s.service, local: { ...s.local, dispatch: false } });
  try {
    conversation.submit({ clientMsgId: "c1", clientId: "test", text: "各專案進度？" });
    await waitFor(() => provider.prompts.length === 1, "送出提示");
    assert.doesNotMatch(provider.prompts[0]!.systemPrompt, /# 部下|# 計畫|# 工具|# 同事 session 與傳訊|ALICE_ASK|ALICE_PLAN|ALICE_TASK|ALICE_SEND/u);
    const games = formatGames([], "ALICE", { enabled: false, projectNames: ["工具專案"] })!;
    assert.match(games, /repos 只能用這些專案名稱：工具專案/u);
    assert.doesNotMatch(games, /ALICE_SEND|# 部下/u);
  } finally {
    taskService.close();
    s.close();
  }
});

// ─── C3：多計畫、重啟接續、報告、回寫、建議 ─────────────────────────────

function modifyPlan(repo: string, goal: string): string {
  return planBlock({ goal, items: [{ key: "a", title: goal, kind: "modify", project: repo, instructions: "改 src/a.js", acceptance: ["npm test 全部通過"] }] });
}

// 測試不同 repo 的兩份計畫同時執行；第三份核准後排隊，前一份結束才遞補（C3-3、完成標準 ⑤）。
test("two plans on different repos run together and a third queues", async () => {
  const gated = new GatedRunner();
  const s = setup({ codexRunner: gated });
  try {
    const first = s.service.createFromBlock(modifyPlan("sandbox", "計畫一"), "m")!;
    s.service.approve(first.id, "cli");
    const second = s.service.createFromBlock(modifyPlan("sandbox2", "計畫二"), "m")!;
    s.service.approve(second.id, "cli");
    await waitFor(() => gated.tasks.length === 2, "兩份計畫同時開始");
    assert.deepEqual(gated.tasks.map((task) => task.repo).sort(), ["sandbox", "sandbox2"]);
    const third = s.service.createFromBlock(modifyPlan("sandbox2", "計畫三"), "m")!;
    assert.equal(s.service.approve(third.id, "cli").status, "queued");
    assert.match(s.messages.list({ limit: 1 })[0]!.text, /排隊等候/u);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(gated.tasks.length, 2);
    gated.finish(gated.tasks[0]!, success());
    await waitFor(() => s.plans.get(first.id)?.status === "completed", "計畫一完成");
    await waitFor(() => s.plans.get(third.id)?.status === "running", "計畫三遞補");
    // 計畫三與計畫二同 repo：計畫二的修改還沒結束前，計畫三的修改不能開始。
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(gated.tasks.length, 2);
    gated.finish(gated.tasks[1]!, success());
    await waitFor(() => gated.tasks.length === 3, "計畫三開始修改");
    assert.equal(gated.tasks[2]?.repo, "sandbox2");
    gated.finish(gated.tasks[2]!, success());
    await waitFor(() => s.plans.get(third.id)?.status === "completed", "計畫三完成");
  } finally {
    s.close();
  }
});

// 測試同一 repo 的兩份計畫都在執行時，同一時間只有一個修改項目（C3-3）。
test("two running plans on the same repo modify one at a time", async () => {
  const gated = new GatedRunner();
  const s = setup({ codexRunner: gated });
  try {
    const first = s.service.createFromBlock(modifyPlan("sandbox", "計畫一"), "m")!;
    s.service.approve(first.id, "cli");
    const second = s.service.createFromBlock(modifyPlan("sandbox", "計畫二"), "m")!;
    assert.equal(s.service.approve(second.id, "cli").status, "running");
    await waitFor(() => gated.tasks.length === 1, "第一個修改開始");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(gated.tasks.length, 1);
    gated.finish(gated.tasks[0]!, success());
    await waitFor(() => gated.tasks.length === 2, "第二個修改開始");
    assert.equal(gated.tasks[1]?.planId, second.id);
    gated.finish(gated.tasks[1]!, success());
    await waitFor(() => s.plans.get(second.id)?.status === "completed", "計畫二完成");
  } finally {
    s.close();
  }
});

// 測試重啟：修改項目做到一半被中斷時，當下的未提交檔案算本計畫的改動；resume 後不被 repo 衝突擋、已完成的項目不重做（完成標準 ①）。
test("restart mid-plan pauses and resume skips done items", async () => {
  const gated = new GatedRunner();
  const s = setup({ codexRunner: gated, worker: ["現況已查。\n需要決定：無\n規格衝突：無"] });
  try {
    const plan = s.service.createFromBlock(planBlock(readThenModify), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => gated.tasks.length === 1, "修改開始");
    s.dirty.push("src/a.js");
    // 模擬 Core 重啟：執行中任務由 TaskService.recover 標成失敗，計畫項目仍是 running。
    s.tasks.update(gated.tasks[0]!.id, { status: "failed", error: "Core 重啟" });
    await s.service.recover();
    assert.equal(s.plans.get(plan.id)?.status, "paused");
    assert.deepEqual(s.notes, ["restarted"]);
    assert.match(readFileSync(s.files[0]!.reportPath, "utf8"), /暫停/u);
    assert.equal((s.tasks.get(gated.tasks[0]!.id)!.diff as { interrupted?: boolean }).interrupted, true);
    assert.match(s.plans.get(plan.id)!.pauseDetail!, /b（實作），sandbox 可能留下的半成品[^；]*src\/a\.js/u);
    s.service.resume(plan.id, "cli");
    await waitFor(() => gated.tasks.length === 2, "中斷的項目重做");
    assert.equal(s.workerCalls.length, 1);
    gated.finish(gated.tasks[1]!, success());
    await waitFor(() => s.plans.get(plan.id)?.status === "completed", "完成");
    assert.deepEqual(s.notes, ["restarted", "completed"]);
  } finally {
    s.close();
  }
});

// 測試重啟通知的半成品清單：扣掉本計畫已完成項目改過的檔，只列中斷項目可能留下的檔；沒有就明說沒有（C3 實測缺口）。
test("restart detail lists only the interrupted item's leftovers", async () => {
  const twoModify = (goal: string): string => planBlock({ goal, items: [
    { key: "a", title: "改 a", kind: "modify", project: "sandbox", instructions: "改 src/a.js", acceptance: ["npm test 全部通過"] },
    { key: "b", title: "改 b", kind: "modify", project: "sandbox", instructions: "改 src/b.js", acceptance: ["npm test 全部通過"], dependsOn: ["a"] },
  ] });
  for (const leftover of [["src/b.js"], []]) {
    const gated = new GatedRunner();
    const s = setup({ codexRunner: gated });
    try {
      const plan = s.service.createFromBlock(twoModify("兩項修改"), "m")!;
      s.service.approve(plan.id, "cli");
      await waitFor(() => gated.tasks.length === 1, "a 開始");
      s.dirty.push("src/a.js");
      gated.finish(gated.tasks[0]!, success([{ path: "src/a.js", change: "modified" }], { modified: ["src/a.js"] }));
      await waitFor(() => gated.tasks.length === 2, "b 開始");
      s.dirty.push(...leftover);
      s.tasks.update(gated.tasks[1]!.id, { status: "failed", error: "Core 重啟" });
      await s.service.recover();
      const detail = s.plans.get(plan.id)!.pauseDetail!;
      if (leftover.length > 0) {
        assert.match(detail, /b（改 b），sandbox 可能留下的半成品[^；]*：src\/b\.js（會從頭重做）/u);
        assert.doesNotMatch(detail, /半成品[^；]*src\/a\.js/u);
      } else {
        assert.match(detail, /b（改 b），sandbox 沒有看到這一項留下的未提交檔/u);
      }
    } finally {
      s.close();
    }
  }
});

// 測試回寫候選：部下與執行者回報的候選收進報告與 data/writeback 檔（完成標準 ②③）。
test("reports and writeback candidates are written on completion", async () => {
  const s = setup({
    worker: ["現況已查。\n需要決定：無\n規格衝突：無\n回寫候選：\n- 設定表第 3 欄其實是權重\n- 無"],
    codex: [() => ({
      status: "succeeded",
      report: report({ notes: "改好了。\n回寫候選：npm test 要先 build 才會跑到新檔" }),
      diff: diff(),
      mismatch: { reportedButUnchanged: [], changedButUnreported: [], kindDiffers: [] },
    })],
  });
  try {
    assert.deepEqual(extractWritebackCandidates("回寫候選：無"), []);
    assert.deepEqual(extractWritebackCandidates("知識庫回寫候選：\n1. 甲\n2. 乙\n其他"), ["甲", "乙"]);
    const plan = s.service.createFromBlock(planBlock(readThenModify), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "完成");
    const files = s.files.at(-1)!;
    assert.ok(files.reportPath.startsWith(join(s.dataDir, "reports")));
    assert.match(files.reportPath, new RegExp(`${plan.id.slice(0, 8)}\\.md$`, "u"));
    const reportText = readFileSync(files.reportPath, "utf8");
    assert.match(reportText, /完成/u);
    assert.match(reportText, /設定表第 3 欄其實是權重/u);
    const writeback = readFileSync(files.writebackPath!, "utf8");
    assert.match(writeback, /（a．分析現況・工具專案）設定表第 3 欄其實是權重/u);
    assert.match(writeback, /npm test 要先 build/u);
    assert.doesNotMatch(writeback, /- （a[^\n]*）無/u);
  } finally {
    s.close();
  }
});

// 測試取消也會寫報告；沒有回寫候選時不建立候選檔。
test("cancel writes a report without a writeback file", async () => {
  const gated = new GatedRunner();
  const s = setup({ codexRunner: gated });
  try {
    const plan = s.service.createFromBlock(modifyPlan("sandbox", "要取消的計畫"), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => gated.tasks.length === 1, "開始");
    await s.service.cancel(plan.id, "cli");
    assert.deepEqual(s.notes, ["cancelled"]);
    assert.match(readFileSync(s.files[0]!.reportPath, "utf8"), /已取消/u);
    assert.equal(s.files[0]!.writebackPath, undefined);
  } finally {
    s.close();
  }
});

// 測試建議區塊的解析與只附加寫入（C3-2、完成標準 ④）。
test("suggestion blocks are validated and appended", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-suggest-"));
  try {
    const path = join(directory, "docs", "建議.md");
    const block = (value: unknown): string => `<<<ALICE_SUGGEST\n${JSON.stringify(value)}\nALICE_SUGGEST>>>`;
    const first = parseSuggestBlock(block({ title: "報告加上耗時", reason: "主人問了兩次", impact: "報告格式", proposal: "每項加耗時" }));
    appendSuggestion(path, first, new Date(2026, 8, 30, 9, 5));
    appendSuggestion(path, { ...first, title: "第二則" }, new Date(2026, 8, 30, 10, 0));
    const text = readFileSync(path, "utf8");
    assert.match(text, /^# 艾莉絲的建議/u);
    assert.match(text, /## 2026-09-30 09:05　報告加上耗時[\s\S]*主人決定：（未決定）[\s\S]*## 2026-09-30 10:00　第二則/u);
    assert.throws(() => parseSuggestBlock(block({ title: "t", reason: "r", impact: "i" })), /proposal/u);
    assert.throws(() => parseSuggestBlock(block({ title: "t", reason: "r", impact: "i", proposal: "p", edit: "x" })), /不支援/u);
    assert.throws(() => parseSuggestBlock("<<<ALICE_SUGGEST\n{bad\nALICE_SUGGEST>>>"), /JSON/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試對話中的建議區塊：不出現在回覆與串流，附加到建議檔並留 system 訊息。
test("conversation records a suggestion block", async () => {
  const s = setup();
  const suggestion = { title: "回覆太長", reason: "主人說看不完", impact: "說話方式", proposal: "先講結論" };
  const replyText = `好的。<<<ALICE_SUGGEST\n${JSON.stringify(suggestion)}\nALICE_SUGGEST>>>`;
  const provider = new FakeProvider([{ text: replyText, deltas: [replyText.slice(0, 8), replyText.slice(8)] }]);
  const suggestionsPath = join(s.directory, "建議.md");
  const config = { ...defaultConfig, dataDir: join(s.directory, "data2"), suggestionsPath };
  const state = new CharacterState({ now: () => new Date(), config });
  const hub = { broadcast: (type: string, data: unknown) => { s.events.push({ type, data }); } } as unknown as EventHub;
  const taskService = new TaskService({ config, tasks: s.tasks, messages: s.messages, state, runner: new UnavailableRunner(), events: hub });
  const conversation = new ConversationService({ config, store: s.messages, state, provider, events: hub, tasks: taskService });
  try {
    conversation.submit({ clientMsgId: "c1", clientId: "test", text: "你覺得呢" });
    await waitFor(() => existsSync(suggestionsPath), "建議寫入");
    assert.match(readFileSync(suggestionsPath, "utf8"), /回覆太長[\s\S]*先講結論/u);
    await waitFor(() => s.messages.list({ limit: 5 }).some((message) => message.role === "alice"), "回覆存檔");
    assert.equal(s.messages.list({ limit: 5 }).find((message) => message.role === "alice")!.text, "好的。");
    assert.ok(s.messages.list({ limit: 5 }).some((message) => message.role === "system" && /已記錄艾莉絲的建議：回覆太長/u.test(message.text)));
    assert.match(provider.prompts[0]!.systemPrompt, /# 自我改進建議/u);
  } finally {
    taskService.close();
    s.close();
  }
});

// 測試單一任務：repo 有未提交改動時，確認請求附上這些檔案讓主人先知道（完成標準 ⑥）。
test("single task permission request warns about uncommitted changes", async () => {
  const s = setup();
  const config = { ...defaultConfig, dataDir: join(s.directory, "data2"), tools: { codex: { ...defaultConfig.tools.codex, repos: { sandbox: { path: s.directory, description: "測試 repo" } } } } };
  const state = new CharacterState({ now: () => new Date(), config });
  const hub = { broadcast: (type: string, data: unknown) => { s.events.push({ type, data }); } } as unknown as EventHub;
  const taskService = new TaskService({
    config, tasks: s.tasks, messages: s.messages, state, runner: new UnavailableRunner(), events: hub,
    repoStatus: async () => ["notes/owner.md"],
  });
  try {
    const block = `<<<ALICE_TASK\n${JSON.stringify({ tool: "codex", repo: "sandbox", goal: "g", instructions: "i", acceptance: ["x"] })}\nALICE_TASK>>>`;
    assert.ok(taskService.createFromBlock(block, "m") !== undefined);
    await waitFor(() => s.events.some((event) => event.type === "permission.request"), "確認請求");
    const request = s.events.find((event) => event.type === "permission.request")!.data as { dirtyFiles?: string[] };
    assert.deepEqual(request.dirtyFiles, ["notes/owner.md"]);
  } finally {
    taskService.close();
    s.close();
  }
});

// 測試 Core 重啟時，計畫的任務標成失敗但不觸發單一任務的完成通知（由計畫的 restarted 通知回報；C3 實測發現重複回覆）。
test("task recover does not notify completion for plan tasks", async () => {
  const s = setup();
  const state = new CharacterState({ now: () => new Date(), config: defaultConfig });
  const hub = { broadcast: () => undefined } as unknown as EventHub;
  const taskService = new TaskService({ config: { ...defaultConfig, dataDir: join(s.directory, "data2") }, tasks: s.tasks, messages: s.messages, state, runner: new UnavailableRunner(), events: hub });
  const notified: string[] = [];
  taskService.setCompletionHandler((_message, task) => { notified.push(task.id); });
  try {
    const base = { sourceMessageId: "m", tool: "codex", repo: "sandbox", repoPath: s.directory, goal: "g", instructions: "i", acceptance: ["x"], estimateMin: null, createdAt: new Date().toISOString() };
    const planTask = s.tasks.create({ ...base, planId: "plan-1" });
    const single = s.tasks.create({ ...base, planId: null });
    s.tasks.update(planTask.id, { status: "running" });
    s.tasks.update(single.id, { status: "running" });
    await taskService.recover();
    assert.equal(s.tasks.get(planTask.id)?.status, "failed");
    assert.deepEqual(notified, [single.id]);
  } finally {
    taskService.close();
    s.close();
  }
});

// ─── R2：Core 驗收、禁改路徑、Claude 代寫策略、更改紀錄草稿 ──────────────

const singleModify = (extra: Record<string, unknown> = {}): string => planBlock({
  goal: "g", items: [{ ...readThenModify.items[1]!, dependsOn: [], ...extra }],
});

// 測試失敗清單的擷取：TAP 名稱、TypeScript 錯誤去掉行列號、沒有可辨識項目時以結束碼、逾時。
test("verification failure keys and baseline comparison", async () => {
  const run = (output: string, exitCode: number | null = 1, timedOut = false): CommandRun => ({ command: "t", exitCode, timedOut, durationMs: 1, output });
  assert.deepEqual(failureKeys(run("ok 1 - a\nnot ok 2 - b # skip\nnot ok 3 - c")), ["t：b", "t：c"]);
  assert.deepEqual(failureKeys(run("src/a.ts(12,5): error TS2322: Type 'x' is not assignable.")), ["t：src/a.ts：TS2322：Type 'x' is not assignable."]);
  assert.deepEqual(failureKeys(run("boom", 2)), ["t：結束碼 2"]);
  assert.deepEqual(failureKeys(run("", 0)), []);
  assert.deepEqual(failureKeys(run("", null, true)), ["t：逾時"]);
  const outputs = ["not ok 1 - old", "not ok 1 - old\nnot ok 2 - new"];
  const execute = async (_repo: string, command: string): Promise<CommandRun> => ({ command, exitCode: 1, timedOut: false, durationMs: 1, output: outputs.shift()! });
  const before = await runVerification("/repo", ["t"], execute);
  const after = await runVerification("/repo", ["t"], execute);
  assert.deepEqual(compareVerification(before, after), { newFailures: ["t：new"], fixed: [], baselineFailures: 1, afterFailures: 2 });
});

// 測試監看路徑的雜湊比對：改檔、新增都算變動，略過 node_modules。
test("watched path hashing detects changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-watch-"));
  try {
    mkdirSync(join(directory, "lib", "node_modules"), { recursive: true });
    writeFileSync(join(directory, "lib", "a.js"), "1");
    writeFileSync(join(directory, "lib", "node_modules", "x.js"), "1");
    const before = hashWatchedPaths(directory, ["lib", "missing"]);
    assert.deepEqual([...before.keys()], ["lib/a.js"]);
    writeFileSync(join(directory, "lib", "a.js"), "2");
    writeFileSync(join(directory, "lib", "b.js"), "1");
    assert.deepEqual(changedWatchedFiles(before, hashWatchedPaths(directory, ["lib"])), ["lib/a.js", "lib/b.js"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 Core 自己跑測試比對基準（R2-2）：新增失敗就重試並附原因；執行者自述的失敗不作數；指示附上開工前已失敗的項目。
test("core verification compares against the baseline", async () => {
  const outputs = [
    "not ok 1 - old", // 第一次開工前
    "not ok 1 - old\nnot ok 2 - new", // 第一次完成後：新增失敗
    "not ok 1 - old", // 第二次開工前
    "not ok 1 - old", // 第二次完成後：沒有新增
  ];
  const selfReportedFail: RunnerScript = () => ({
    status: "succeeded", report: report({ testsFail: true }), diff: diff(),
    mismatch: { reportedButUnchanged: [], changedButUnreported: [], kindDiffers: [] },
  });
  const s = setup({ codex: [success(), selfReportedFail], verify: () => ({ exitCode: 1, output: outputs.shift() ?? "" }) });
  try {
    const plan = s.service.createFromBlock(singleModify(), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.length > 0, "結束");
    assert.deepEqual(s.notes, ["completed"]);
    assert.equal(s.codex.tasks.length, 2);
    assert.equal(s.verifyCalls.length, 4);
    assert.ok(s.verifyCalls.every((call) => call.repoPath === s.repo && call.command === "npm test"));
    assert.match(s.codex.tasks[0]!.instructions, /Core 的驗收[\s\S]*開工前已經失敗的項目（共 1 項[\s\S]*npm test：old/u);
    assert.match(s.codex.tasks[1]!.instructions, /Core 驗收測試新增失敗（開工前 1 項 → 現在 2 項）：npm test：new/u);
    const result = s.plans.items(plan.id)[0]!.result as { verification: { newFailures: string[]; baselineFailures: number } };
    assert.deepEqual(result.verification.newFailures, []);
    assert.equal(result.verification.baselineFailures, 1);
  } finally {
    s.close();
  }
});

// 測試禁改路徑（R2-1）：快照顯示改到禁改樣式就暫停、不重試；指示中列出禁改路徑。
test("forbidden paths pause the plan", async () => {
  const s = setup({
    sandbox: { forbiddenPatterns: ["xls/**"] },
    codex: [success([{ path: "xls/a.xls", change: "modified" }], { modified: ["xls/a.xls"] })],
  });
  try {
    const plan = s.service.createFromBlock(singleModify(), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "forbidden_path");
    assert.match(s.plans.get(plan.id)!.pauseDetail!, /改到禁改路徑：xls\/a\.xls/u);
    assert.equal(s.codex.tasks.length, 1);
    assert.match(s.codex.tasks[0]!.instructions, /## 禁止修改[\s\S]*xls\/\*\*/u);
  } finally {
    s.close();
  }
});

// 測試監看路徑（R2-1）：git 看不到的資料夾被改動時也暫停，且不再跑完成後的測試。
test("watched paths outside git snapshots pause the plan", async () => {
  let repoPath = "";
  const s = setup({
    sandbox: { watchPaths: ["lib"] },
    codex: [() => {
      writeFileSync(join(repoPath, "lib", "shared.js"), "changed");
      return success()({} as Task);
    }],
  });
  repoPath = s.repo;
  mkdirSync(join(s.repo, "lib"));
  writeFileSync(join(s.repo, "lib", "shared.js"), "original");
  try {
    const plan = s.service.createFromBlock(singleModify(), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "forbidden_path");
    assert.match(s.plans.get(plan.id)!.pauseDetail!, /lib\/shared\.js/u);
    assert.match(s.codex.tasks[0]!.instructions, /## 禁止修改[\s\S]*lib\/\*\*/u);
    assert.equal(s.verifyCalls.length, 1);
  } finally {
    s.close();
  }
});

// 測試 Claude 代寫策略 ask（R2-3）：Codex 關閉時不自動改派，暫停等主人授權；resume claude 後才由 Claude 做。
test("claudeFallback ask pauses until the owner authorizes Claude", async () => {
  const s = setup({ use: false, sandbox: { claudeFallback: "ask" }, claude: [success()] });
  try {
    const plan = s.service.createFromBlock(singleModify(), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "codex_unavailable");
    assert.match(s.plans.get(plan.id)!.pauseDetail!, /Codex 已關閉，sandbox 設定為改由 Claude 寫程式前先問主人/u);
    assert.equal(s.claude.tasks.length, 0);
    assert.equal(s.plans.items(plan.id)[0]?.attempts, 0);
    s.service.resume(plan.id, "cli", { executor: "claude" });
    await waitFor(() => s.notes.includes("completed"), "完成");
    assert.equal(s.claude.tasks.length, 1);
  } finally {
    s.close();
  }
});

// 測試更改紀錄草稿（R2-4）：依模板「紀錄」段寫法，附 Core 驗收與審查結果，標（未提交）。
test("reports include a change log draft for configured projects", async () => {
  const s = setup({
    sandbox: { changeLogDraft: true },
    codex: [success([{ path: "src/a.js", change: "modified" }], { modified: ["src/a.js"] })],
    verify: () => ({ exitCode: 1, output: "not ok 1 - old" }),
  });
  try {
    const plan = s.service.createFromBlock(singleModify(), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.includes("completed"), "完成");
    const text = readFileSync(s.files.at(-1)!.reportPath, "utf8");
    assert.match(text, /- Core 驗收：`npm test` 失敗 1 項（沒有新增失敗，其餘與開工前相同）/u);
    assert.match(text, /## 更改紀錄草稿（sandbox）[\s\S]*### \d{4}-\d{2}-\d{2}\n\n#### 程式\n- \*\*實作\*\*\n  - 改動：修改 src\/a\.js（計畫 [0-9a-f]{8}・b，codex 執行）\n  - 結果：Core 驗收：`npm test` 失敗 1 項（沒有新增失敗，其餘與開工前相同）。（未提交）/u);
  } finally {
    s.close();
  }
});

// 測試本機設定的 R2 欄位驗證：claudeFallback 只接受 auto／ask。
test("local config validates R2 project fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-local-"));
  try {
    const path = join(directory, "alice.local.json");
    const project = { name: "p", path: directory, role: "r", writable: true, forbiddenPatterns: ["xls/**"], watchPaths: ["lib"], claudeFallback: "ask", changeLogDraft: true };
    writeFileSync(path, JSON.stringify({ projects: [project] }));
    const loaded = loadLocalConfig(path).projects[0]!;
    assert.deepEqual([loaded.forbiddenPatterns, loaded.watchPaths, loaded.claudeFallback, loaded.changeLogDraft], [["xls/**"], ["lib"], "ask", true]);
    writeFileSync(path, JSON.stringify({ projects: [{ ...project, claudeFallback: "never" }] }));
    assert.ok(loadLocalConfig(path).reasons.some((reason) => /claudeFallback 必須是 auto 或 ask/u.test(reason)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試審查不通過後重做：前一次建立的新檔在快照看來是「修改」、執行者回報「新增」，不算回報不一致（R2 實測發現）；
// 沒有前一次紀錄的同樣情況仍算不一致。
test("redo after review accepts files added by an earlier attempt", async () => {
  const added = [{ path: "docs/demo.md", change: "added" as const }];
  const redo = (mismatchPath: string): RunnerScript => () => ({
    status: "succeeded", report: report({ files: added }), diff: diff({ added: [], modified: [mismatchPath] }),
    mismatch: { reportedButUnchanged: [], changedButUnreported: [], kindDiffers: [{ path: mismatchPath, reported: "added", actual: "modified" }] },
  });
  const unchanged: RunnerScript = () => ({
    status: "succeeded", report: report({ files: added }), diff: diff({ added: [], modified: [] }),
    mismatch: { reportedButUnchanged: [{ path: "docs/demo.md", change: "added" }], changedButUnreported: [], kindDiffers: [] },
  });
  // 重做時兩種情況：檔案再被改（快照「修改」）、檔案這次沒再動（快照「未改變」）。
  for (const second of [redo("docs/demo.md"), unchanged]) {
    const s = setup({
      codex: [success(added, { added: ["docs/demo.md"], modified: [] }), second],
      worker: ["審查結論：不通過（內容與實際不符）", "審查結論：通過"],
      sandbox: { changeLogDraft: true },
    });
    try {
      const plan = s.service.createFromBlock(singleModify({ risk: "high" }), "m")!;
      s.service.approve(plan.id, "cli");
      await waitFor(() => s.notes.length > 0, "結束");
      assert.deepEqual(s.notes, ["completed"]);
      assert.equal(s.codex.tasks.length, 2);
      // 更改紀錄草稿以 git 的角度寫「新增」，不因最後一次快照是修改而寫成修改。
      const draft = readFileSync(s.files.at(-1)!.reportPath, "utf8");
      assert.match(draft, /#### 文件\n- \*\*實作\*\*\n  - 改動：新增 docs\/demo\.md（/u);
    } finally {
      s.close();
    }
  }
  const fresh = setup({ codex: [redo("src/other.js"), success()] });
  try {
    const plan = fresh.service.createFromBlock(singleModify(), "m")!;
    fresh.service.approve(plan.id, "cli");
    await waitFor(() => fresh.notes.includes("completed"), "完成");
    assert.equal(fresh.codex.tasks.length, 2);
    assert.match(fresh.codex.tasks[1]!.instructions, /回報與快照不一致/u);
  } finally {
    fresh.close();
  }
});

// 測試寫檔 worker 的進度行：repo 內的檔案顯示成相對路徑，repo 外維持原樣（Web Studio 實測：絕對路徑太長）。
test("writer progress shows repo-relative paths", () => {
  const repo = join(tmpdir(), "alice-progress-repo");
  const event = (filePath: string) => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Write", input: { file_path: filePath } }, { type: "tool_use", name: "Bash", input: { command: "npm test" } }] },
  });
  assert.deepEqual(writerProgress(event(join(repo, "src", "a.js")), repo), ["✎ src/a.js", "$ npm test"]);
  const outside = join(tmpdir(), "elsewhere.js");
  assert.deepEqual(writerProgress(event(outside), repo), [`✎ ${outside}`, "$ npm test"]);
  assert.deepEqual(writerProgress(event(join(repo, "b.js"))), [`✎ ${join(repo, "b.js")}`, "$ npm test"]);
});

// 測試「發現的差異」（艾莉絲的建議，主人採用）：不影響答案的差異記在結果與報告，計畫照常完成；
// 派工指示說明什麼才算規格衝突；真正的規格衝突仍暫停（見 spec conflict in a read item pauses）。
test("differences in a read item are recorded without pausing", async () => {
  const s = setup({
    worker: ["共有 8 個領域。\n需要決定：無\n規格衝突：無\n發現的差異：\n- 摘要把 Vite 放在前端，知識庫放在工程化\n回寫候選：無"],
    codex: [success()],
  });
  try {
    assert.deepEqual(extractDifferences("規格衝突：無\n發現的差異：無"), []);
    const plan = s.service.createFromBlock(planBlock(readThenModify), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => s.notes.length > 0, "結束");
    assert.deepEqual(s.notes, ["completed"]);
    assert.match(s.workerCalls[0]!.question, /「發現的差異：」[\s\S]*只寫會影響這一題答案/u);
    const result = s.plans.items(plan.id)[0]!.result as { differences: string[] };
    assert.deepEqual(result.differences, ["摘要把 Vite 放在前端，知識庫放在工程化"]);
    assert.match(readFileSync(s.files.at(-1)!.reportPath, "utf8"), /發現的差異（不影響本項目，未暫停）：\n  - 摘要把 Vite 放在前端/u);
  } finally {
    s.close();
  }
});

// 測試 git 監看（R3-1）：監看路徑是 git repo 時以 HEAD＋git status 當指紋，未提交改動與新 commit 都算變動。
test("watched git repositories detect working tree changes and new commits", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-gitwatch-"));
  const core = join(directory, "core");
  const git = (...args: string[]): void => {
    execFileSync("git", ["-C", core, ...args], { stdio: "ignore" });
  };
  try {
    mkdirSync(core);
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(core, "a.js"), "1");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const before = hashWatchedPaths(directory, ["core"]);
    assert.deepEqual([...before.keys()], [`core${GIT_WATCH_SUFFIX}`]);
    assert.deepEqual(changedWatchedFiles(before, hashWatchedPaths(directory, ["core"])), []);
    writeFileSync(join(core, "a.js"), "2");
    const dirty = hashWatchedPaths(directory, ["core"]);
    assert.deepEqual(changedWatchedFiles(before, dirty), [`core${GIT_WATCH_SUFFIX}`]);
    git("commit", "-q", "-am", "change");
    const committed = hashWatchedPaths(directory, ["core"]);
    assert.deepEqual(changedWatchedFiles(dirty, committed), [`core${GIT_WATCH_SUFFIX}`]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// ─── §27：派工給同事 session、跨計畫依賴、傳訊 ───────────────────────────

const sessionPlan = (extra: Record<string, unknown> = {}): string => planBlock({
  goal: "跨 session 查證",
  items: [
    { key: "a", title: "工具端查證", kind: "session", project: "sandbox", instructions: "查 A", acceptance: ["回報 A"] },
    { key: "b", title: "文件端查證", kind: "session", project: "工具專案", instructions: "查 B", acceptance: ["回報 B"], dependsOn: ["a"] },
  ],
  ...extra,
});

const tasksFor = (s: Setup, session: string): string[] =>
  s.outboxStore.list({ limit: 50 }).filter((message) => message.recipient === session && message.kind === "task").map((message) => message.text).reverse();

// 測試 session 項目：依序派工、附回報格式；只有派到的 session 能回報；完成後 Core 驗收並派下一項，最後計畫完成。
test("session items dispatch in order and complete from the right session's report", async () => {
  const s = setup({ verify: () => ({ exitCode: 1, output: "not ok 1 - old" }) });
  try {
    const plan = s.service.createFromBlock(sessionPlan(), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => tasksFor(s, "Sandbox Dev").length === 1, "派工給 Sandbox Dev");
    const tag = `${plan.id.slice(0, 8)}-a`;
    const text = tasksFor(s, "Sandbox Dev")[0]!;
    assert.match(text, new RegExp(`^【ALICe 派工 ${tag}】工具端查證`, "u"));
    assert.match(text, new RegExp(`用 SendMessage 傳給「ALICE」[\\s\\S]*【回報 ${tag}】完成`, "u"));
    assert.match(text, /Core 會在 repo 跑 `npm test`/u);
    assert.equal(tasksFor(s, "Tool Dev").length, 0);
    assert.ok(s.messages.list({ limit: 10 }).some((message) => /📤 待送給〈Sandbox Dev〉/u.test(message.text)));

    const ignored = s.service.handleSessionReport(`【回報 ${tag}】完成\n不是我的`, "Tool Dev")!;
    assert.match(ignored, /不是它的派工，已忽略/u);
    assert.equal(s.plans.items(plan.id)[0]?.status, "running");
    assert.equal(s.service.handleSessionReport("一般聊天", "Sandbox Dev"), undefined);

    s.service.handleSessionReport(`【回報 ${tag}】完成\n查到了。\n規格衝突：無\n發現的差異：\n- 文件與程式名稱不同\n回寫候選：無`, "Sandbox Dev");
    await waitFor(() => tasksFor(s, "Tool Dev").length === 1, "派工給 Tool Dev");
    const first = s.plans.items(plan.id)[0]!;
    assert.equal(first.status, "done");
    const result = first.result as { from: string; differences: string[]; verification: { newFailures: string[] } };
    assert.equal(result.from, "Sandbox Dev");
    assert.deepEqual(result.differences, ["文件與程式名稱不同"]);
    assert.deepEqual(result.verification.newFailures, []);
    assert.match(tasksFor(s, "Tool Dev")[0]!, /前置項目的結果[\s\S]*查到了/u);

    s.service.handleSessionReport(`【回報 ${plan.id.slice(0, 8)}-b】完成\n也查到了。`, "Tool Dev");
    await waitFor(() => s.notes.includes("completed"), "計畫完成");
  } finally {
    s.close();
  }
});

// 測試同事回報「卡住」時暫停；resume 重新派工並附上上一次的回報。回報後新增驗收失敗時暫停。
test("blocked session reports pause and resume re-dispatches with the report", async () => {
  const outputs = ["", "", "not ok 9 - new"];
  const s = setup({ verify: () => ({ exitCode: outputs.length > 0 && outputs[0] === "" ? 0 : 1, output: outputs.shift() ?? "" }) });
  try {
    const plan = s.service.createFromBlock(planBlock({
      goal: "g", items: [{ key: "a", title: "改程式", kind: "session", project: "sandbox", instructions: "改 X", acceptance: ["完成"] }],
    }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => tasksFor(s, "Sandbox Dev").length === 1, "派工");
    s.service.handleSessionReport(`【回報 ${plan.id.slice(0, 8)}-a】卡住\n缺少規格`, "Sandbox Dev");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "session_blocked");
    s.service.resume(plan.id, "cli");
    await waitFor(() => tasksFor(s, "Sandbox Dev").length === 2, "重新派工");
    assert.match(tasksFor(s, "Sandbox Dev")[1]!, /上一次的回報[\s\S]*缺少規格/u);
    s.service.handleSessionReport(`【回報 ${plan.id.slice(0, 8)}-a】完成\n改好了`, "Sandbox Dev");
    await waitFor(() => s.notes.filter((note) => note === "paused").length === 2, "驗收失敗暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "session_verify_failed");
    assert.match(s.plans.get(plan.id)!.pauseDetail!, /新增失敗[\s\S]*npm test：new/u);
  } finally {
    s.close();
  }
});

// 測試跨計畫依賴（#3）：B 等 A，A 完成前 B 排隊；另一組 A 取消時 B 暫停（dependency_failed）。
test("plans wait for the plans listed in after", async () => {
  const s = setup();
  try {
    const single = (goal: string, extra: Record<string, unknown> = {}): string => planBlock({
      goal, items: [{ key: "a", title: goal, kind: "session", project: "工具專案", instructions: "做", acceptance: ["完成"] }], ...extra,
    });
    const first = s.service.createFromBlock(single("A"), "m")!;
    s.service.approve(first.id, "cli");
    const second = s.service.createFromBlock(single("B", { after: [first.id.slice(0, 8)] }), "m")!;
    assert.deepEqual(s.plans.get(second.id)?.afterPlans, [first.id]);
    assert.equal(s.service.approve(second.id, "cli").status, "queued");
    assert.match(s.messages.list({ limit: 1 })[0]!.text, new RegExp(`等待計畫 ${first.id.slice(0, 8)} 完成後才開始`, "u"));
    await waitFor(() => tasksFor(s, "Tool Dev").length === 1, "A 派工");
    s.service.handleSessionReport(`【回報 ${first.id.slice(0, 8)}-a】完成\nok`, "Tool Dev");
    await waitFor(() => s.plans.get(second.id)?.status === "running", "B 開始");

    const third = s.service.createFromBlock(single("C"), "m")!;
    s.service.approve(third.id, "cli");
    const fourth = s.service.createFromBlock(single("D", { after: [third.id] }), "m")!;
    s.service.approve(fourth.id, "cli");
    await s.service.cancel(third.id, "cli");
    assert.equal(s.plans.get(fourth.id)?.status, "paused");
    assert.equal(s.plans.get(fourth.id)?.pauseReason, "dependency_failed");
    assert.throws(() => parsePlanBlock(planBlock({ goal: "g", items: [{ key: "a", title: "t", kind: "session", project: "sandbox", instructions: "i", acceptance: ["x"] }], after: ["nope"] })), /after 的計畫 id 格式錯誤/u);
    assert.equal(s.service.createFromBlock(single("E", { after: [third.id.slice(0, 8)] }), "m"), undefined);
    assert.match(s.messages.list({ limit: 1 })[0]!.text, /已經取消，不會完成/u);
  } finally {
    s.close();
  }
});

// 測試派工送不出去（轉接 session 回報失敗）時暫停；計畫取消時通知正在做的同事。
test("failed delivery pauses and cancellation notifies the colleague", async () => {
  const s = setup();
  try {
    const plan = s.service.createFromBlock(planBlock({
      goal: "g", items: [{ key: "a", title: "查", kind: "session", project: "工具專案", instructions: "查", acceptance: ["回報"] }],
    }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => tasksFor(s, "Tool Dev").length === 1, "派工");
    const sent = s.outboxStore.list({ status: "pending" })[0]!;
    s.outbox.markFailed(sent.id.slice(0, 8), "找不到 session");
    await waitFor(() => s.notes.includes("paused"), "暫停");
    assert.equal(s.plans.get(plan.id)?.pauseReason, "session_send_failed");

    const second = s.service.createFromBlock(planBlock({
      goal: "g2", items: [{ key: "a", title: "查二", kind: "session", project: "工具專案", instructions: "查", acceptance: ["回報"] }],
    }), "m")!;
    s.service.approve(second.id, "cli");
    await waitFor(() => tasksFor(s, "Tool Dev").length === 2, "第二份派工");
    await s.service.cancel(second.id, "cli");
    const notice = s.outboxStore.list({ limit: 10 }).find((message) => message.kind === "message" && message.planId === second.id)!;
    assert.match(notice.text, /已由主人取消[\s\S]*不用再做/u);
  } finally {
    s.close();
  }
});

// 測試 Core 重啟時，等待同事回報的 session 項目維持執行中，計畫不因此暫停。
test("recover keeps session items waiting for reports", async () => {
  const s = setup();
  try {
    const plan = s.service.createFromBlock(planBlock({
      goal: "g", items: [{ key: "a", title: "查", kind: "session", project: "工具專案", instructions: "查", acceptance: ["回報"] }],
    }), "m")!;
    s.service.approve(plan.id, "cli");
    await waitFor(() => tasksFor(s, "Tool Dev").length === 1, "派工");
    await s.service.recover();
    assert.equal(s.plans.get(plan.id)?.status, "running");
    assert.equal(s.plans.items(plan.id)[0]?.status, "running");
    s.service.handleSessionReport(`【回報 ${plan.id.slice(0, 8)}-a】完成\nok`, "Tool Dev");
    await waitFor(() => s.notes.includes("completed"), "完成");
  } finally {
    s.close();
  }
});

// 測試傳訊區塊（D-4）：對象可寫 session、角色或專案名稱；找不到時不送並說明；可以一次多封；送出與失敗都留紀錄。
test("send blocks queue messages for known sessions only", () => {
  const s = setup();
  try {
    const block = (value: unknown): string => `<<<ALICE_SEND\n${JSON.stringify(value)}\nALICE_SEND>>>`;
    const sent = s.outbox.sendFromBlock(block({ to: "工具專案", message: "請問 X 在哪裡？" }))!;
    assert.equal(sent.recipient, "Tool Dev");
    assert.match(sent.text, /^【ALICe 訊息】\n請問 X 在哪裡？[\s\S]*傳給「ALICE」/u);
    assert.equal(s.outbox.sendFromBlock(block({ to: "陌生人", message: "hi" })), undefined);
    assert.match(s.messages.list({ limit: 1 })[0]!.text, /找不到傳訊對象「陌生人」；可傳的對象：Sandbox Dev（工程師）、Tool Dev（工程師）/u);
    assert.throws(() => parseSendBlock(block({ to: "x" })), /message/u);
    s.outbox.markSent(sent.id);
    assert.match(s.messages.list({ limit: 1 })[0]!.text, /📨 已送給〈Tool Dev〉/u);
    assert.throws(() => s.outbox.markSent(sent.id), /已是 sent/u);
    const filter = new AliceBlockFilter(() => undefined);
    filter.push(`好。${block({ to: "a", message: "1" })}${block({ to: "b", message: "2" })}`);
    assert.equal(filter.finish().sendBlockTexts?.length, 2);
  } finally {
    s.close();
  }
});
