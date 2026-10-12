import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelService, type WorkerExecutor } from "../src/channels/channelService.js";
import { ChannelStore } from "../src/channels/channelStore.js";
import type { WorkerRunInput, WorkerRunResult } from "../src/channels/workerRunner.js";
import { defaultConfig } from "../src/config.js";
import { ConversationService } from "../src/conversation/conversationService.js";
import type { LocalConfig } from "../src/localConfig.js";
import { EventHub } from "../src/protocol/eventHub.js";
import { ErrorLogger } from "../src/reliability/errorLog.js";
import { CharacterState } from "../src/state/characterState.js";
import { MessageStore } from "../src/store/messageStore.js";
import { UsageStore } from "../src/usage/usageStore.js";
import { FakeProvider, type FakeReply } from "./fakeProvider.js";

class StubWorker implements WorkerExecutor {
  readonly calls: WorkerRunInput[] = [];
  readonly results: Array<WorkerRunResult | Error>;
  available = true;

  constructor(results: Array<WorkerRunResult | Error>) {
    this.results = [...results];
  }

  canStart(): boolean {
    return this.available;
  }

  async run(input: WorkerRunInput, onDelta: (text: string) => void): Promise<WorkerRunResult> {
    this.calls.push(input);
    const result = this.results.shift();
    if (result === undefined) throw new Error("StubWorker has no queued result");
    if (result instanceof Error) throw result;
    onDelta(result.text);
    return result;
  }
}

type Fixture = ReturnType<typeof fixture>;

function fixture(replies: FakeReply[], workerResults: Array<WorkerRunResult | Error>) {
  const directory = mkdtempSync(join(tmpdir(), "alice-channel-flow-"));
  const vault = join(directory, "vault");
  const projectPath = join(directory, "project");
  const dataDir = join(directory, "data");
  mkdirSync(join(vault, "roles"), { recursive: true });
  mkdirSync(projectPath);
  mkdirSync(dataDir);
  writeFileSync(join(vault, "roles", "工程師.md"), "# 工程師\n角色內文", "utf8");
  writeFileSync(join(vault, "summary.md"), "# 摘要", "utf8");
  const personaPath = join(directory, "persona.md");
  const factsPath = join(directory, "facts.md");
  writeFileSync(personaPath, "# 人格\n人格本文", "utf8");
  writeFileSync(factsPath, "主人事實", "utf8");
  const databasePath = join(directory, "alice.db");
  const messages = new MessageStore(databasePath);
  const channelStore = new ChannelStore(databasePath);
  const usage = new UsageStore(databasePath);
  const errors = new ErrorLogger(dataDir);
  const local: LocalConfig = {
    path: join(directory, "alice.local.json"),
    knowledgeBase: { path: vault, summaryPage: "summary.md", rolesDir: "roles" },
    docRoots: [],
    codexAvailable: false,
    projects: [{ name: "工具專案", path: projectPath, role: "工程師", readDirs: [] }],
    workerTimeoutMin: 5,
    summaryEnabled: true,
    workersEnabled: true, dispatch: true, remoteOrigins: [], workflowFile: null, translateGlossary: [],
    reasons: [],
  };
  const config = {
    ...defaultConfig,
    dataDir,
    personaPath,
    factsPath,
    requireThinking: false,
  };
  const events = new EventHub();
  const eventTypes: string[] = [];
  const originalBroadcast = events.broadcast.bind(events);
  events.broadcast = ((type: string, data: unknown) => {
    eventTypes.push(type);
    originalBroadcast(type, data);
  }) as EventHub["broadcast"];
  const provider = new FakeProvider(replies);
  const worker = new StubWorker(workerResults);
  const channels = new ChannelService({ local, channels: channelStore, messages, runner: worker, events, usage, errors });
  const state = new CharacterState({ config, now: () => new Date(2026, 8, 30, 12, 0) });
  const conversation = new ConversationService({ config, store: messages, state, provider, events, channels, local });
  channels.setFollowupHandler((followup) => conversation.enqueueChannelFollowup(followup));
  return {
    directory, messages, channelStore, channels, provider, worker, conversation, eventTypes, usage,
    close: () => { usage.close(); channelStore.close(); messages.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

async function waitFor(check: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ask = (channelId: string | null, question = "請查架構") => [
  "<<<ALICE_ASK",
  JSON.stringify({ role: "工程師", project: "工具專案", question, channelId }),
  "ALICE_ASK>>>",
].join("\n");

// 測試 ALICE_ASK 從主回覆派工、worker 回報再以 high effort 進入同一對話佇列，最後關閉頻道並保存結論。
test("worker report re-enters the conversation queue and closes with a conclusion", async () => {
  const setup = fixture(
    [{ text: `我去確認。\n${ask(null)}` }, { text: "結論：已確認。" }],
    [{ text: "worker 回報內容", sessionId: "sid-1", permissionDeniedPaths: ["C:/denied"] }],
  );
  try {
    setup.conversation.submit({ clientMsgId: "msg-1", clientId: "test", text: "請查一下" });
    await waitFor(() => setup.channels.list()[0]?.status === "closed", "closed channel");
    const channel = setup.channels.list()[0]!;
    assert.equal(setup.channels.get(channel.id.slice(0, 8))?.channel.id, channel.id);
    assert.equal(channel.rounds, 1);
    assert.equal(channel.workerSessionId, "sid-1");
    assert.equal(setup.provider.calls, 2);
    assert.equal(setup.provider.options[1]?.effort, "high");
    // 艾莉絲的建議（2026-10-01 採用）：標題與結尾都給完整 channelId，追問才能沿用原頻道。
    assert.ok(setup.provider.prompts[1]!.transcript.includes(`（工作頻道 ${channel.id}・工程師）`));
    assert.match(setup.provider.prompts[1]!.transcript, /worker 回報內容/);
    assert.ok(setup.provider.prompts[1]!.transcript.endsWith(`（系統通知）請追問（ALICE_ASK 的 channelId 填 ${channel.id}）或向主人給結論。`));
    assert.ok(setup.messages.list().some((message) => message.role === "alice" && message.text === "結論：已確認。"));
    const channelMessages = setup.channels.get(channel.id)!.messages;
    assert.ok(channelMessages.some((message) => message.author === "system" && /C:\/denied/.test(message.text)));
    const relevant = setup.eventTypes.filter((type) => type.startsWith("channel."));
    assert.deepEqual(relevant, [
      "channel.created", "channel.message", "channel.delta", "channel.message",
      "channel.message", "channel.closed",
    ]);
  } finally {
    setup.close();
  }
});

// 測試艾莉絲在部下回報後用同一 channelId 追問，worker 會收到既有 session 且 rounds 增為 2。
test("follow-up ALICE_ASK resumes the same channel session", async () => {
  const setup = fixture([], [
    { text: "第一輪", sessionId: "sid-1", permissionDeniedPaths: [] },
    { text: "第二輪", sessionId: "sid-1", permissionDeniedPaths: [] },
  ]);
  try {
    const created = setup.channels.createFromBlock(ask(null));
    assert.ok(created);
    setup.provider.replies.push(
      { text: ask(created.id, "再確認細節") },
      { text: "最終結論" },
    );
    await waitFor(() => setup.channels.get(created.id)?.channel.status === "closed", "resumed channel closure");
    const channel = setup.channels.get(created.id)!.channel;
    assert.equal(channel.rounds, 2);
    assert.equal(setup.worker.calls.length, 2);
    assert.equal(setup.worker.calls[1]?.workerSessionId, "sid-1");
  } finally {
    setup.close();
  }
});

// 測試追問只給頻道 id 前 8 碼也能沿用原頻道（艾莉絲的建議，2026-10-01 採用；實測時三次因只有短 id 被擋）。
test("follow-up ALICE_ASK accepts the channel id prefix", async () => {
  const setup = fixture([], [
    { text: "第一輪", sessionId: "sid-1", permissionDeniedPaths: [] },
    { text: "第二輪", sessionId: "sid-1", permissionDeniedPaths: [] },
  ]);
  try {
    const created = setup.channels.createFromBlock(ask(null));
    assert.ok(created);
    setup.provider.replies.push(
      { text: ask(created.id.slice(0, 8), "再確認細節") },
      { text: "最終結論" },
    );
    await waitFor(() => setup.channels.get(created.id)?.channel.status === "closed", "resumed channel closure");
    assert.equal(setup.channels.get(created.id)!.channel.rounds, 2);
    assert.equal(setup.worker.calls[1]?.workerSessionId, "sid-1");
    assert.ok(!setup.messages.list().some((message) => /部下未派出/u.test(message.text)));
  } finally {
    setup.close();
  }
});

// 測試超過五輪、未知角色、未知專案與並行已滿都不會派工，並在主對話留下可供下一輪判讀的 system 訊息。
test("invalid and over-limit requests are rejected before worker dispatch", async () => {
  const setup = fixture([], [{ text: "完成", sessionId: "sid", permissionDeniedPaths: [] }]);
  try {
    setup.channels.createFromBlock(ask(null));
    const channel = setup.channels.list()[0]!;
    for (let round = 1; round < 5; round += 1) setup.channelStore.beginRound(channel.id);
    setup.channels.createFromBlock(ask(channel.id, "第六輪"));
    setup.channels.createFromBlock([
      "<<<ALICE_ASK", JSON.stringify({ role: "不存在", project: "工具專案", question: "查", channelId: null }), "ALICE_ASK>>>",
    ].join("\n"));
    setup.channels.createFromBlock([
      "<<<ALICE_ASK", JSON.stringify({ role: "工程師", project: "不存在", question: "查", channelId: null }), "ALICE_ASK>>>",
    ].join("\n"));
    setup.worker.available = false;
    setup.channels.createFromBlock(ask(null, "並行驗證"));
    const systems = setup.messages.list().filter((message) => message.role === "system").map((message) => message.text).join("\n");
    assert.match(systems, /5 輪上限/);
    assert.match(systems, /角色不存在/);
    assert.match(systems, /專案不存在/);
    assert.match(systems, /已達 2 個/);
    assert.equal(setup.worker.calls.length, 1);
    await waitFor(
      () => setup.channels.get(channel.id)!.messages.some((message) => message.author === "worker"),
      "initial worker completion",
    );
  } finally {
    setup.close();
  }
});

// 測試 @角色 優先送進最近的 open 頻道，沒有既有頻道時才用該角色第一個專案建立新頻道；角色名稱後接全形逗號也要能辨識。
test("role mentions reuse an open channel or create the first project channel", async () => {
  const setup = fixture([], [
    { text: "初答", sessionId: "sid-1", permissionDeniedPaths: [] },
    { text: "補答", sessionId: "sid-1", permissionDeniedPaths: [] },
  ]);
  try {
    setup.conversation.submit({ clientMsgId: "mention-1", clientId: "test", text: "@工程師 第一次" });
    await waitFor(() => setup.channels.list()[0]?.workerSessionId === "sid-1", "first mention worker");
    const first = setup.channels.list()[0]!;
    setup.conversation.submit({ clientMsgId: "mention-2", clientId: "test", text: "@工程師，補充" });
    await waitFor(() => setup.worker.calls.length === 2, "second mention worker");
    assert.equal(setup.channels.list().length, 1);
    assert.equal(setup.worker.calls[1]?.channelId, first.id);
    assert.equal(setup.worker.calls[1]?.workerSessionId, "sid-1");
    assert.equal(setup.messages.list().filter((message) => message.role === "user").length, 2);
    await waitFor(() => setup.channels.get(first.id)!.messages.filter((message) => message.author === "worker").length === 2, "second mention completion");
  } finally {
    setup.close();
  }
});

// 測試 worker 失敗會把頻道標為 failed 並用 high effort 觸發艾莉絲告知主人，避免失敗悄悄消失。
test("worker failure marks the channel failed and triggers Alice", async () => {
  const setup = fixture([{ text: "部下失敗了，我會改用其他方式。" }], [new Error("逾時")]);
  try {
    const created = setup.channels.createFromBlock(ask(null));
    assert.ok(created);
    await waitFor(() => setup.provider.calls === 1, "failure follow-up");
    assert.equal(setup.channels.get(created.id)?.channel.status, "failed");
    assert.equal(setup.provider.options[0]?.effort, "high");
    assert.ok(setup.messages.list().some((message) => message.role === "system" && /工作頻道.*失敗/.test(message.text)));
    await waitFor(() => setup.messages.list().some((message) => message.role === "alice"), "failure notice reply");
  } finally {
    setup.close();
  }
});

// 測試 worker 每一輪只寫一筆頻道用量，並保留 runner 回傳的模型、token、耗時與嘗試次數。
test("worker round writes one usage record", async () => {
  const setup = fixture(
    [{ text: `派工。\n${ask(null)}` }, { text: "收到結果。" }],
    [{
      text: "worker 完成", sessionId: "sid", permissionDeniedPaths: [],
      usage: {
        model: "worker-model", inputTokens: 12, outputTokens: 4,
        cacheReadInputTokens: 3, cacheCreationInputTokens: 2, durationMs: 250, attempts: 1,
      },
    }],
  );
  try {
    setup.conversation.submit({ clientMsgId: "worker-usage", clientId: "test", text: "請派工" });
    await waitFor(() => setup.usage.list().some((item) => item.kind === "worker"), "worker usage");
    const rows = setup.usage.list().filter((item) => item.kind === "worker");
    assert.equal(rows.length, 1);
    assert.deepEqual({
      model: rows[0]?.model,
      input: rows[0]?.inputTokens,
      output: rows[0]?.outputTokens,
      cacheRead: rows[0]?.cacheReadInputTokens,
      cacheCreate: rows[0]?.cacheCreationInputTokens,
      duration: rows[0]?.durationMs,
    }, { model: "worker-model", input: 12, output: 4, cacheRead: 3, cacheCreate: 2, duration: 250 });
  } finally {
    setup.close();
  }
});

// 測試 worker 失敗除了關閉頻道，也會寫入含來源與識別碼的 errors.log 稽核紀錄。
test("worker failure writes errors log", async () => {
  const setup = fixture(
    [{ text: `派工。\n${ask(null)}` }, { text: "已告知失敗。" }],
    [new Error("worker boom")],
  );
  try {
    setup.conversation.submit({ clientMsgId: "worker-error", clientId: "test", text: "請派工" });
    await waitFor(() => setup.usage.list().some((item) => item.kind === "worker"), "worker failure usage");
    const line = readFileSync(join(setup.directory, "data", "errors.log"), "utf8").trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.source, "worker");
    assert.equal(entry.kind, "worker");
    assert.equal(entry.message, "worker boom");
    assert.equal(entry.attempts, 1);
    assert.equal(typeof entry.replyId, "string");
  } finally {
    setup.close();
  }
});
