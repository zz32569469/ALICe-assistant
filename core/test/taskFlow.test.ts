import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import WebSocket from "ws";

import { defaultConfig, type Config } from "../src/config.js";
import { ConversationService } from "../src/conversation/conversationService.js";
import { EventHub, type EventEnvelope } from "../src/protocol/eventHub.js";
import { AliceHttpServer } from "../src/server/httpServer.js";
import { CharacterState } from "../src/state/characterState.js";
import { MessageStore } from "../src/store/messageStore.js";
import { CodexRunner, type CodexReport, type CodexSpawn } from "../src/tasks/codexRunner.js";
import type { TaskRunner, TaskRunnerHooks } from "../src/tasks/taskRunner.js";
import { TaskService } from "../src/tasks/taskService.js";
import { TaskStore, type Task } from "../src/tasks/taskStore.js";
import { UsageStore } from "../src/usage/usageStore.js";
import { FakeProvider, type FakeReply } from "./fakeProvider.js";

type CollectedEvent = EventEnvelope<Record<string, unknown>>;

class FakeRunner implements TaskRunner {
  readonly starts: Task[] = [];
  readonly cancelCalls: string[] = [];
  readonly hooks = new Map<string, TaskRunnerHooks>();
  autoResult?: Parameters<TaskRunnerHooks["onFinished"]>[0];

  start(task: Task, hooks: TaskRunnerHooks): void {
    this.starts.push(task);
    this.hooks.set(task.id, hooks);
    hooks.onStarted({ codexThreadId: `thread-${task.id}`, pid: 1234 });
    if (this.autoResult !== undefined) hooks.onFinished(this.autoResult);
  }

  cancel(taskId: string): void {
    this.cancelCalls.push(taskId);
  }
}

class EventCollector {
  readonly events: CollectedEvent[] = [];
  readonly #socket: WebSocket;
  readonly #listeners = new Set<() => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (raw) => {
      this.events.push(JSON.parse(raw.toString()) as CollectedEvent);
      for (const listener of this.#listeners) listener();
    });
  }

  static async connect(url: string): Promise<EventCollector> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new EventCollector(socket);
  }

  async waitFor(predicate: (events: CollectedEvent[]) => boolean, timeoutMs = 3_000): Promise<void> {
    if (predicate(this.events)) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#listeners.delete(check);
        reject(new Error(`Timed out waiting for: ${this.events.map((event) => event.type).join(", ")}`));
      }, timeoutMs);
      const check = (): void => {
        if (!predicate(this.events)) return;
        clearTimeout(timeout);
        this.#listeners.delete(check);
        resolve();
      };
      this.#listeners.add(check);
    });
  }

  close(): void { this.#socket.close(); }
}

type RunningCore = {
  baseUrl: string;
  token: string;
  provider: FakeProvider;
  runner: FakeRunner;
  state: CharacterState;
  messages: MessageStore;
  tasks: TaskService;
  usage: UsageStore;
  close: () => Promise<void>;
};

async function startCore(
  directory: string,
  replies: FakeReply[],
  options: {
    runner?: FakeRunner;
    runnerFactory?: (config: Config) => TaskRunner;
    approvalTimeoutMin?: number;
  } = {},
): Promise<RunningCore> {
  const personaPath = join(directory, "persona.md");
  const factsPath = join(directory, "facts.md");
  const databasePath = join(directory, "alice.db");
  writeFileSync(personaPath, "# Alice\n\n人格", "utf8");
  writeFileSync(factsPath, "主人喜歡測試", "utf8");
  const config: Config = {
    ...defaultConfig,
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    tokenPath: join(directory, "token"),
    personaPath,
    factsPath,
    tools: {
      codex: {
        ...defaultConfig.tools.codex,
        approvalTimeoutMin: options.approvalTimeoutMin ?? 5,
        repos: { sandbox: { path: directory, description: "測試 repo" } },
      },
    },
  };
  const token = "task-test-token";
  const messages = new MessageStore(databasePath);
  const taskStore = new TaskStore(databasePath);
  const usage = new UsageStore(databasePath);
  const state = new CharacterState({ now: () => new Date(), config });
  const provider = new FakeProvider(replies);
  const events = new EventHub();
  const runner = options.runner ?? new FakeRunner();
  const taskRunner = options.runnerFactory?.(config) ?? runner;
  const tasks = new TaskService({ config, tasks: taskStore, messages, state, runner: taskRunner, events, usage });
  const conversation = new ConversationService({ config, store: messages, state, provider, events, tasks, usage });
  tasks.setCompletionHandler((message, task) => conversation.enqueueTaskCompletion(message, task));
  const server = new AliceHttpServer({ config, token, store: messages, state, conversation, events, tasks });
  const unsubscribe = state.subscribe((next) => events.broadcast("state.changed", next));
  const port = await server.listen();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    provider,
    runner,
    state,
    messages,
    tasks,
    usage,
    close: async () => {
      unsubscribe();
      await server.close();
      tasks.close();
      usage.close();
      taskStore.close();
      messages.close();
    },
  };
}

function headers(core: RunningCore): Record<string, string> {
  return {
    authorization: `Bearer ${core.token}`,
    "content-type": "application/json",
    "x-alice-client": "test-client",
  };
}

async function postMessage(core: RunningCore, id: string, text: string): Promise<void> {
  const response = await fetch(`${core.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(core),
    body: JSON.stringify({ clientMsgId: id, clientId: "test-client", text }),
  });
  assert.equal(response.status, 202);
}

function taskReply(goal = "新增功能", repo = "sandbox"): string {
  return [
    "我會先請主人確認。",
    "<<<ALICE_TASK",
    JSON.stringify({
      tool: "codex", repo, goal, instructions: "修改指定檔案", acceptance: ["測試通過"], estimateMin: 3,
    }),
    "ALICE_TASK>>>",
  ].join("\n");
}

async function action(core: RunningCore, id: string, name: string, body: object = {}): Promise<Response> {
  return await fetch(`${core.baseUrl}/api/tasks/${id}/${name}`, {
    method: "POST",
    headers: headers(core),
    body: JSON.stringify(body),
  });
}

// 測試合格任務從建立、核准、執行成功到自動回報均走同一對話佇列，且任務區塊不會落入可見訊息。
test("approved task completes and triggers a queued Alice report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-success-"));
  const runner = new FakeRunner();
  runner.autoResult = {
    status: "succeeded",
    report: { summary: "完成 slugify" },
    diff: { added: ["src/slugify.ts"] },
    mismatch: [],
    usage: {
      model: "codex", inputTokens: 100, cacheReadInputTokens: 40,
      outputTokens: 30, cacheCreationInputTokens: 0, reasoningTokens: 10, attempts: 1,
    },
  };
  const core = await startCore(directory, [
    { text: taskReply("新增 slugify") },
    { text: "已完成，測試也通過。" },
  ], { runner });
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await postMessage(core, "task-success", "請新增 slugify");
    await collector.waitFor((events) => events.some((event) => event.type === "permission.request"));
    const created = collector.events.find((event) => event.type === "task.created")!;
    const taskId = String((created.data as { id: string }).id);
    const approved = await action(core, taskId, "approve");
    assert.equal(approved.status, 200);
    await collector.waitFor((events) =>
      events.some((event) => event.type === "task.done") &&
      events.filter((event) => event.type === "reply.end").length === 2,
    );

    const types = collector.events.map((event) => event.type);
    assert.ok(types.indexOf("task.created") < types.indexOf("permission.request"));
    assert.ok(types.indexOf("permission.request") < types.indexOf("task.started"));
    assert.ok(types.indexOf("task.started") < types.indexOf("task.done"));
    const streamed = collector.events
      .filter((event) => event.type === "reply.delta")
      .map((event) => String(event.data.text)).join("");
    assert.doesNotMatch(streamed, /ALICE_TASK/);

    const chronological = core.messages.list({ limit: 20 }).reverse();
    assert.deepEqual(chronological.map((message) => message.role), ["user", "alice", "system", "alice"]);
    assert.equal(chronological[1]?.text, "我會先請主人確認。\n");
    assert.match(chronological[2]?.text ?? "", /^任務 [0-9a-f]{8} succeeded：新增 slugify$/);
    assert.equal(chronological[3]?.text, "已完成，測試也通過。");

    const completionPrompt = core.provider.prompts[1]!;
    assert.ok(completionPrompt.transcript.endsWith("（系統通知）任務完成，請向主人回報。"));
    assert.match(completionPrompt.systemPrompt, /完成 slugify/);
    assert.match(completionPrompt.systemPrompt, /src\/slugify\.ts/);
    const completionStart = collector.events.find((event) =>
      event.type === "reply.start" && event.data.inReplyTo === chronological[2]?.id,
    );
    assert.ok(completionStart);

    const listed = await fetch(`${core.baseUrl}/api/tasks?limit=200`, { headers: headers(core) });
    assert.equal(listed.status, 200);
    const task = await fetch(`${core.baseUrl}/api/tasks/${taskId}`, { headers: headers(core) });
    assert.equal(task.status, 200);
    const taskUsage = core.usage.list().find((item) => item.kind === "codex");
    assert.deepEqual({
      refType: taskUsage?.refType,
      refId: taskUsage?.refId,
      input: taskUsage?.inputTokens,
      cacheRead: taskUsage?.cacheReadInputTokens,
      output: taskUsage?.outputTokens,
      reasoning: taskUsage?.reasoningTokens,
    }, { refType: "task", refId: taskId, input: 100, cacheRead: 40, output: 30, reasoning: 10 });
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試真實 CodexRunner 介面以假子程序接入 B1 TaskService，核准後能完成任務並觸發完成通知推理。
test("approved task completes through CodexRunner and triggers completion reasoning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-codex-integration-"));
  const report: CodexReport = {
    summary: "完成整合修改",
    filesChanged: [],
    tests: [{ command: "npm test", result: "pass", detail: "全部通過" }],
    acceptance: [{ criterion: "測試通過", met: true, evidence: "npm test 通過" }],
    unfinished: [],
    notes: "無",
  };
  const core = await startCore(directory, [
    { text: taskReply("整合 CodexRunner") },
    { text: "CodexRunner 已完成，結果已驗收。" },
  ], {
    runnerFactory: (config) => {
      const spawn: CodexSpawn = (_command, args) => {
        const child = new EventEmitter() as EventEmitter & {
          stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number;
          exitCode: number | null; signalCode: NodeJS.Signals | null;
        };
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = 2468;
        child.exitCode = null;
        child.signalCode = null;
        child.stdin.once("finish", () => {
          writeFileSync(args.at(-1)!, JSON.stringify(report), "utf8");
          child.stdout.write(`${JSON.stringify({ type: "thread.started", id: "integration-thread" })}\n`);
          child.exitCode = 0;
          child.emit("close", 0, null);
        });
        return child as never;
      };
      let snapshotCalls = 0;
      return new CodexRunner(config, {
        spawn,
        authExec: async () => ({ stdout: "Logged in using ChatGPT", stderr: "" }),
        snapshotter: {
          take: async () => {
            snapshotCalls += 1;
            return { head: "same", files: {} };
          },
        },
      });
    },
  });
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await postMessage(core, "codex-integration", "請執行整合任務");
    await collector.waitFor((events) => events.some((event) => event.type === "permission.request"));
    const taskId = String(collector.events.find((event) => event.type === "permission.request")!.data.taskId);
    assert.equal((await action(core, taskId, "approve")).status, 200);
    await collector.waitFor((events) =>
      events.some((event) => event.type === "task.done" && event.data.status === "succeeded")
      && events.filter((event) => event.type === "reply.end").length === 2,
    );

    const completed = core.tasks.get(taskId);
    assert.equal(completed.codexThreadId, "integration-thread");
    assert.deepEqual(completed.report, report);
    assert.match(core.provider.prompts[1]?.systemPrompt ?? "", /完成整合修改/);
    assert.match(core.provider.prompts[1]?.transcript ?? "", /任務完成，請向主人回報/);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試主人拒絕會記錄決定者、推送 resolved、寫入 system 訊息，且結束或不存在的任務回正確 HTTP 錯誤碼。
test("reject records the decision, reports it through Alice, and enforces status conflicts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-reject-"));
  const core = await startCore(directory, [
    { text: taskReply("不要執行") },
    { text: taskReply("不應建立的拒絕回覆任務") },
  ]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await postMessage(core, "task-reject", "提出任務");
    await collector.waitFor((events) => events.some((event) => event.type === "permission.request"));
    const request = collector.events.find((event) => event.type === "permission.request")!;
    const taskId = String(request.data.taskId);
    const rejected = await action(core, taskId, "reject", { reason: "現在不要" });
    assert.equal(rejected.status, 200);
    await collector.waitFor((events) => events.some((event) =>
      event.type === "permission.resolved" && event.data.result === "rejected",
    ) && events.filter((event) => event.type === "reply.end").length === 2);
    const task = core.tasks.get(taskId);
    assert.equal(task.decidedBy, "test-client");
    assert.equal(task.status, "rejected");
    const systemMessage = core.messages.list().find((message) => message.role === "system");
    assert.match(systemMessage?.text ?? "", /主人拒絕了任務.*現在不要/);
    const notificationStart = collector.events.filter((event) => event.type === "reply.start").at(-1);
    assert.equal(notificationStart?.data.inReplyTo, systemMessage?.id);
    assert.equal(core.runner.starts.length, 0);
    assert.equal(core.provider.calls, 2);
    assert.ok(core.provider.prompts[1]?.transcript.endsWith(
      "（系統通知）任務未執行：主人拒絕，請用一兩句告知主人。",
    ));
    assert.equal(core.tasks.list().length, 1);

    const conflict = await action(core, taskId, "approve");
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, "conflict");
    const missing = await action(core, "missing-task", "approve");
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, "not_found");
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試白名單、格式與單一進行中任務限制都會拒絕建立，避免未授權或重複執行 Codex。
test("invalid and concurrent task requests are rejected before runner execution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-invalid-"));
  const core = await startCore(directory, [
    { text: taskReply("越界", "other") },
    { text: "格式錯誤\n<<<ALICE_TASK\n{bad json}\nALICE_TASK>>>" },
    { text: taskReply("合法待確認") },
    { text: taskReply("重複任務") },
  ]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await postMessage(core, "invalid-repo", "第一個");
    await collector.waitFor((events) => events.filter((event) => event.type === "task.rejected").length === 1);
    await postMessage(core, "invalid-json", "第二個");
    await collector.waitFor((events) => events.filter((event) => event.type === "task.rejected").length === 2);
    await postMessage(core, "valid-pending", "第三個");
    await collector.waitFor((events) => events.some((event) => event.type === "permission.request"));
    await postMessage(core, "concurrent", "第四個");
    await collector.waitFor((events) => events.filter((event) => event.type === "task.rejected").length === 3);

    const reasons = collector.events
      .filter((event) => event.type === "task.rejected")
      .map((event) => String(event.data.reason));
    assert.match(reasons[0]!, /白名單/);
    assert.match(reasons[1]!, /JSON/);
    assert.match(reasons[2]!, /已有任務/);
    assert.equal(core.tasks.list().length, 1);
    assert.equal(core.runner.starts.length, 0);
    assert.equal(core.messages.list().filter((message) => message.role === "system").length, 3);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試確認逾時會自動標成 expired、發出 resolved 並寫入 system 訊息，不會啟動 runner。
test("pending approval expires and Alice reports it without starting the runner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-expiry-"));
  const core = await startCore(directory, [
    { text: taskReply("等待逾時") },
    { text: taskReply("不應建立的逾時回覆任務") },
  ], { approvalTimeoutMin: 0.001 });
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await postMessage(core, "task-expiry", "提出任務");
    await collector.waitFor((events) => events.some((event) =>
      event.type === "permission.resolved" && event.data.result === "expired",
    ) && events.filter((event) => event.type === "reply.end").length === 2);
    assert.equal(core.tasks.list()[0]?.status, "expired");
    assert.equal(core.runner.starts.length, 0);
    const systemMessage = core.messages.list().find((message) => message.role === "system");
    assert.match(systemMessage?.text ?? "", /任務確認逾時/);
    const notificationStart = collector.events.filter((event) => event.type === "reply.start").at(-1);
    assert.equal(notificationStart?.data.inReplyTo, systemMessage?.id);
    assert.equal(core.provider.calls, 2);
    assert.ok(core.provider.prompts[1]?.transcript.endsWith(
      "（系統通知）任務未執行：確認逾時，請用一兩句告知主人。",
    ));
    assert.equal(core.tasks.list().length, 1);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試任務執行中聊天會暫時切到 talking、回覆後回 busy，取消會呼叫 runner 並回到 idle。
test("chatting during a running task preserves busy state and cancellation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-cancel-"));
  let releaseChat!: () => void;
  const chatGate = new Promise<void>((resolve) => { releaseChat = resolve; });
  const runner = new FakeRunner();
  const core = await startCore(directory, [
    { text: taskReply("長任務") },
    { text: "聊天回覆", waitFor: chatGate },
    { text: "任務已取消。" },
  ], { runner });
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await postMessage(core, "long-task", "開始長任務");
    await collector.waitFor((events) => events.some((event) => event.type === "permission.request"));
    const taskId = String(collector.events.find((event) => event.type === "permission.request")!.data.taskId);
    assert.equal((await action(core, taskId, "approve")).status, 200);
    assert.equal(core.state.getState().activity, "busy");

    await postMessage(core, "chat-during-task", "任務做到哪了？");
    await collector.waitFor((events) => events.filter((event) => event.type === "reply.start").length === 2);
    assert.equal(core.state.getState().activity, "talking");
    releaseChat();
    await collector.waitFor((events) => events.filter((event) => event.type === "reply.end").length === 2);
    assert.equal(core.state.getState().activity, "busy");

    assert.equal((await action(core, taskId, "cancel")).status, 200);
    await collector.waitFor((events) =>
      events.some((event) => event.type === "task.done" && event.data.status === "cancelled") &&
      events.filter((event) => event.type === "reply.end").length === 3,
    );
    assert.deepEqual(core.runner.cancelCalls, [taskId]);
    assert.equal(core.tasks.get(taskId).status, "cancelled");
    assert.equal(core.state.getState().activity, "idle");
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試服務重建會讓待確認任務過期、執行中任務失敗，並透過掛勾清理已記錄的殘留 PID。
test("recovery expires pending tasks and fails running tasks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-recovery-"));
  const databasePath = join(directory, "alice.db");
  const messages = new MessageStore(databasePath);
  const store = new TaskStore(databasePath);
  const pending = store.create({
    planId: null, sourceMessageId: "source-1", tool: "codex", repo: "sandbox", repoPath: directory,
    goal: "待確認", instructions: "a", acceptance: ["a"], estimateMin: null,
  });
  const runningBase = store.create({
    planId: null, sourceMessageId: "source-2", tool: "codex", repo: "sandbox", repoPath: directory,
    goal: "執行中", instructions: "b", acceptance: ["b"], estimateMin: null,
  });
  store.update(runningBase.id, { status: "running", pid: 9876, startedAt: new Date().toISOString() });
  const killed: number[] = [];
  const completed: Task[] = [];
  // 錯誤紀錄寫到測試資料夾，不要寫進 repo 的 data/errors.log。
  const config = { ...defaultConfig, dataDir: directory };
  const service = new TaskService({
    config,
    tasks: store,
    messages,
    state: new CharacterState({ now: () => new Date(), config }),
    runner: new FakeRunner(),
    events: new EventHub(),
    killOrphan: (pid) => { killed.push(pid); },
  });
  service.setCompletionHandler((_message, task) => { completed.push(task); });
  try {
    await service.recover();
    assert.equal(store.get(pending.id)?.status, "expired");
    assert.equal(store.get(runningBase.id)?.status, "failed");
    assert.equal(store.get(runningBase.id)?.error, "Core 重啟，任務中斷");
    assert.deepEqual(killed, [9876]);
    assert.deepEqual(completed.map((task) => task.id), [runningBase.id]);
    assert.equal(messages.list().filter((message) => message.role === "system").length, 2);
  } finally {
    service.close();
    store.close();
    messages.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 Core 重啟造成的確認失效只寫 system 訊息，不會把 expired 通知送進推理佇列。
test("recovery expiry does not call the reasoning provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-task-recovery-expiry-"));
  const databasePath = join(directory, "alice.db");
  const messages = new MessageStore(databasePath);
  const store = new TaskStore(databasePath);
  store.create({
    planId: null, sourceMessageId: "source", tool: "codex", repo: "sandbox", repoPath: directory,
    goal: "待確認", instructions: "a", acceptance: ["a"], estimateMin: null,
  });
  const provider = new FakeProvider([]);
  const events = new EventHub();
  const config = { ...defaultConfig, dataDir: directory };
  const state = new CharacterState({ now: () => new Date(), config });
  const service = new TaskService({
    config, tasks: store, messages, state, runner: new FakeRunner(), events,
  });
  const conversation = new ConversationService({
    config, store: messages, state, provider, events, tasks: service,
  });
  service.setCompletionHandler((message, task) => conversation.enqueueTaskCompletion(message, task));
  try {
    await service.recover();
    assert.equal(provider.calls, 0);
    assert.equal(store.list()[0]?.status, "expired");
    assert.equal(messages.list().filter((message) => message.role === "system").length, 1);
  } finally {
    service.close();
    store.close();
    messages.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
