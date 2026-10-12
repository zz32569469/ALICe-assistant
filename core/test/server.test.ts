import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import WebSocket from "ws";

import { defaultConfig, type Config } from "../src/config.js";
import { ConversationService } from "../src/conversation/conversationService.js";
import { EventHub, type EventEnvelope } from "../src/protocol/eventHub.js";
import { AliceHttpServer } from "../src/server/httpServer.js";
import { ProxyMode } from "../src/conversation/proxyMode.js";
import { GameService } from "../src/games/gameService.js";
import { GameStore } from "../src/games/gameStore.js";
import { DEFAULT_WORKFLOW, useWorkflow } from "../src/games/workflow.js";
import { NotificationService, NotificationStore } from "../src/notify/notificationService.js";
import {
  checkWork, decide, formatPlanConfirmation, formatTaskConfirmation, markNotificationDelivered, notificationsPending, relayMessage, waitForWork,
} from "../src/relay/relayClient.js";
import { CharacterState } from "../src/state/characterState.js";
import { MessageStore } from "../src/store/messageStore.js";
import { QuotaService } from "../src/usage/quota.js";
import { UsageStore } from "../src/usage/usageStore.js";
import { TranslateService, type TranslateSpawn } from "../src/translate/translateService.js";
import { FakeProvider, type FakeReply } from "./fakeProvider.js";

type RunningCore = {
  baseUrl: string;
  token: string;
  provider: FakeProvider;
  state: CharacterState;
  store: MessageStore;
  usage: UsageStore;
  close: () => Promise<void>;
};

type CollectedEvent = EventEnvelope<Record<string, unknown>>;

class EventCollector {
  readonly events: CollectedEvent[] = [];
  readonly #socket: WebSocket;
  readonly #listeners = new Set<() => void>();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as CollectedEvent;
      this.events.push(event);
      for (const listener of this.#listeners) {
        listener();
      }
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

  async waitFor(predicate: (events: CollectedEvent[]) => boolean): Promise<CollectedEvent[]> {
    if (predicate(this.events)) {
      return this.events;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#listeners.delete(check);
        reject(new Error(`Timed out waiting for events: ${this.events.map((event) => event.type).join(", ")}`));
      }, 2_000);
      const check = (): void => {
        if (predicate(this.events)) {
          clearTimeout(timeout);
          this.#listeners.delete(check);
          resolve();
        }
      };
      this.#listeners.add(check);
    });
    return this.events;
  }

  close(): void {
    this.#socket.close();
  }
}

async function startCore(
  directory: string,
  replies: FakeReply[],
  databasePath = join(directory, "alice.db"),
  extra: { games?: GameService; notifications?: NotificationService; events?: EventHub; translate?: TranslateService; proxy?: ProxyMode } = {},
): Promise<RunningCore> {
  const personaPath = join(directory, "persona.md");
  const factsPath = join(directory, "facts.md");
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
    allowedOrigins: ["http://allowed.example", "https://pc.tail1.ts.net"],
    studioDir: join(directory, "studio"),
  };
  const token = "test-token";
  const store = new MessageStore(databasePath);
  const usage = new UsageStore(databasePath);
  const state = new CharacterState({ now: () => new Date(2026, 8, 29, 12, 0), config });
  const provider = new FakeProvider(replies);
  const events = extra.events ?? new EventHub();
  const conversation = new ConversationService({ config, store, state, provider, events, usage, ...(extra.games === undefined ? {} : { games: extra.games }) });
  const quotas = new QuotaService({
    loadMax: async () => "Current session: 1% used · resets soon\nCurrent week (all models): 2% used · resets later",
    loadCodex: async () => JSON.stringify({ type: "token_count", rate_limits: { primary: { used_percent: 3, resets_in_seconds: 60 } } }),
  });
  const server = new AliceHttpServer({ config, token, store, state, conversation, events, usage, quotas, ...extra });
  const unsubscribe = state.subscribe((next) => events.broadcast("state.changed", next));
  const port = await server.listen();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    provider,
    state,
    store,
    usage,
    close: async () => {
      unsubscribe();
      await server.close();
      usage.close();
      store.close();
    },
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function post(core: RunningCore, clientMsgId: string, text: string, deep?: boolean): Promise<{ messageId: string; replyId: string }> {
  const response = await fetch(`${core.baseUrl}/api/messages`, {
    method: "POST",
    headers: authHeaders(core.token),
    body: JSON.stringify({ clientMsgId, text, clientId: "test", ...(deep === undefined ? {} : { deep }) }),
  });
  assert.equal(response.status, 202);
  return await response.json() as { messageId: string; replyId: string };
}

// 測試 health 可匿名存取，而受保護端點會拒絕缺少 token 與不在白名單的瀏覽器 Origin。
test("HTTP authentication and Origin checks protect API routes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-auth-"));
  const core = await startCore(directory, []);
  try {
    const health = await fetch(`${core.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, version: "0.1.0" });

    const unauthorized = await fetch(`${core.baseUrl}/api/state`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json() as { error: { code: string } }).error.code, "unauthorized");

    const forbidden = await fetch(`${core.baseUrl}/api/state`, {
      headers: { authorization: `Bearer ${core.token}`, origin: "http://evil.example" },
    });
    assert.equal(forbidden.status, 403);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試完整串流事件依協定排序、回覆與 usage 都會落盤，且歷史 API 能讀回主人與 Alice 兩則訊息。
test("POST streams a reply and persists both messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-stream-"));
  const core = await startCore(directory, [{ text: "早安主人", deltas: ["早安", "主人"] }]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    const ids = await post(core, "stream-1", "早安");
    const events = await collector.waitFor((items) => items.some((event) => event.type === "reply.end"));
    const conversationEvents = events.filter((event) =>
      ["message.created", "reply.start", "reply.delta", "reply.end"].includes(event.type),
    );
    assert.deepEqual(conversationEvents.map((event) => event.type), [
      "message.created",
      "reply.start",
      "reply.delta",
      "reply.delta",
      "reply.end",
    ]);
    const deltaText = conversationEvents
      .filter((event) => event.type === "reply.delta")
      .map((event) => String(event.data.text))
      .join("");
    const end = conversationEvents.at(-1)?.data as { replyId: string; message: { text: string } };
    assert.equal(end.replyId, ids.replyId);
    assert.equal(end.message.text, deltaText);

    const history = await fetch(`${core.baseUrl}/api/messages`, { headers: authHeaders(core.token) });
    const body = await history.json() as { messages: unknown[] };
    assert.equal(body.messages.length, 2);
    const usage = JSON.parse(readFileSync(join(directory, "usage.log"), "utf8").trim()) as Record<string, unknown>;
    assert.deepEqual(
      {
        duration_ms: usage.duration_ms,
        duration_api_ms: usage.duration_api_ms,
        model: usage.model,
        initModel: usage.initModel,
        models: usage.models,
        attempts: usage.attempts,
        suspect: usage.suspect,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
      {
        duration_ms: 100,
        duration_api_ms: 80,
        model: "fake-model",
        initModel: "fake-model",
        models: [{
          model: "fake-model",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
        }],
        attempts: 1,
        suspect: false,
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
    );
    assert.equal("total_cost_usd" in usage, false);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試成功訊息以相同 clientMsgId 重送只回傳原識別碼，不會再次產生模型回覆。
test("duplicate clientMsgId is idempotent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-dedup-"));
  const core = await startCore(directory, [{ text: "唯一回覆" }]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    const first = await post(core, "same-id", "只送一次");
    await collector.waitFor((events) => events.some((event) => event.type === "reply.end"));
    const second = await post(core, "same-id", "只送一次");
    assert.deepEqual(second, first);
    assert.equal(core.provider.calls, 1);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試佇列嚴格序列化回覆，第二則 reply.start 必須在第一則 reply.end 之後。
test("queued messages receive sequential replies", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-queue-"));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const core = await startCore(directory, [
    { text: "第一答", waitFor: firstGate },
    { text: "第二答" },
  ]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    const first = await post(core, "queue-1", "第一問");
    const second = await post(core, "queue-2", "第二問");
    releaseFirst();
    const events = await collector.waitFor((items) =>
      items.filter((event) => event.type === "reply.end").length === 2,
    );
    const firstEnd = events.findIndex((event) =>
      event.type === "reply.end" && event.data.replyId === first.replyId,
    );
    const secondStart = events.findIndex((event) =>
      event.type === "reply.start" && event.data.replyId === second.replyId,
    );
    assert.ok(firstEnd >= 0 && secondStart > firstEnd);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 auth 失敗會映射錯誤並讓角色睡眠，且下一則成功訊息可在同一行程中恢復服務。
test("authentication failure sleeps and a later success recovers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-recovery-"));
  const core = await startCore(directory, [{ error: "auth" }, { text: "恢復了" }]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await post(core, "failure-1", "會失敗");
    const failedEvents = await collector.waitFor((events) => events.some((event) => event.type === "reply.error"));
    const failure = failedEvents.find((event) => event.type === "reply.error");
    assert.equal((failure?.data.error as { code: string }).code, "reasoning_unavailable");
    assert.deepEqual(
      { activity: core.state.getState().activity, reason: core.state.getState().sleepReason },
      { activity: "sleeping", reason: "reasoning_unavailable" },
    );
    const errorEntry = JSON.parse(readFileSync(join(directory, "errors.log"), "utf8").trim()) as Record<string, unknown>;
    assert.equal(errorEntry.replyId, failure?.data.replyId);
    assert.equal(errorEntry.kind, "auth");
    assert.equal(errorEntry.message, "fake auth");
    assert.equal(errorEntry.attempts, 1);
    assert.equal(errorEntry.source, "alice");

    await post(core, "failure-2", "再試一次");
    await collector.waitFor((events) => events.some((event) => event.type === "reply.end"));
    assert.equal(core.state.getState().activity, "idle");
    assert.equal(core.state.getState().sleepReason, undefined);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試失敗訊息可用相同 clientMsgId 與 replyId 重試，但不會重複新增主人訊息。
test("a failed request can retry with the same clientMsgId", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-retry-"));
  const core = await startCore(directory, [{ error: "network" }, { text: "重試成功" }]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    const first = await post(core, "retry-same-id", "保留這則");
    await collector.waitFor((events) => events.some((event) => event.type === "reply.error"));
    const second = await post(core, "retry-same-id", "保留這則");
    assert.deepEqual(second, first);
    await collector.waitFor((events) => events.some((event) => event.type === "reply.end"));
    assert.equal(core.provider.calls, 2);
    assert.equal(core.store.list().filter((message) => message.role === "user").length, 1);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試檔案資料庫重啟後仍把前一輪對話送入 prompt，避免 Core 重啟造成上下文遺失。
test("conversation history survives a service restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-restart-"));
  const databasePath = join(directory, "alice.db");
  try {
    const firstCore = await startCore(directory, [{ text: "第一輪回答" }], databasePath);
    const firstCollector = await EventCollector.connect(`${firstCore.baseUrl.replace("http", "ws")}/ws?token=${firstCore.token}`);
    await post(firstCore, "restart-1", "第一輪問題");
    await firstCollector.waitFor((events) => events.some((event) => event.type === "reply.end"));
    firstCollector.close();
    await firstCore.close();

    const secondCore = await startCore(directory, [{ text: "第二輪回答" }], databasePath);
    const secondCollector = await EventCollector.connect(`${secondCore.baseUrl.replace("http", "ws")}/ws?token=${secondCore.token}`);
    try {
      await post(secondCore, "restart-2", "第二輪問題");
      await secondCollector.waitFor((events) => events.some((event) => event.type === "reply.end"));
      const transcript = secondCore.provider.prompts[0]?.transcript ?? "";
      assert.match(transcript, /第一輪問題/);
      assert.match(transcript, /第一輪回答/);
    } finally {
      secondCollector.close();
      await secondCore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 deep 只覆寫指定訊息為 high effort，下一則一般訊息仍沿用設定預設值。
test("deep messages use high effort without changing normal messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-deep-"));
  const core = await startCore(directory, [{ text: "深想完成" }, { text: "一般完成" }]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await post(core, "deep-1", "請仔細想", true);
    await post(core, "normal-1", "一般問題");
    await collector.waitFor((items) => items.filter((event) => event.type === "reply.end").length === 2);
    assert.equal(core.provider.options[0]?.effort, "high");
    assert.equal(core.provider.options[1]?.effort, undefined);
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 usage API 把多模型一般回覆、worker 與 Codex 工作彙總，並同時回傳兩種額度。
test("usage API returns aggregated work and quotas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-server-usage-"));
  const core = await startCore(directory, [{
    text: "完成",
    result: {
      models: [
        { model: "model-a", inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 1 },
        { model: "model-b", inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 3, cacheCreationInputTokens: 0 },
      ],
    },
  }]);
  const collector = await EventCollector.connect(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`);
  try {
    await post(core, "usage-1", "記錄用量");
    await collector.waitFor((items) => items.some((event) => event.type === "reply.end"));
    core.usage.append({
      ts: "2026-09-30T12:01:00.000Z", kind: "worker", refType: "channel", refId: "channel-1", model: "worker-model",
      inputTokens: 4, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, reasoningTokens: 0,
      durationMs: 200, attempts: 1,
    });
    core.usage.append({
      ts: "2026-09-30T12:02:00.000Z", kind: "codex", refType: "task", refId: "task-1", model: "codex",
      inputTokens: 6, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 0, reasoningTokens: 2,
      durationMs: 300, attempts: 1,
    });

    const response = await fetch(`${core.baseUrl}/api/usage?limit=10`, { headers: authHeaders(core.token) });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      work: Array<{ kind: string; totalTokens: number; durationMs: number }>;
      quotas: { max: { status: string }; codex: { status: string } };
    };
    assert.equal(body.work.find((item) => item.kind === "alice")?.totalTokens, 42);
    assert.equal(body.work.find((item) => item.kind === "alice")?.durationMs, 100);
    assert.equal(core.usage.list().filter((item) => item.kind === "alice").length, 2);
    assert.equal(body.work.find((item) => item.kind === "worker")?.totalTokens, 7);
    assert.equal(body.work.find((item) => item.kind === "codex")?.totalTokens, 11);
    assert.equal(body.quotas.max.status, "ok");
    assert.equal(body.quotas.codex.status, "ok");
  } finally {
    collector.close();
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ─── Web Studio ─────────────────────────────────────────────────────────

function rawGet(baseUrl: string, path: string): Promise<{ status: number; body: string }> {
  // fetch 會把 ../ 正規化掉；用 http.get 送出原樣的路徑，測試路徑穿越防護。
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolvePromise, reject) => {
    httpGet({ hostname, port, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

// 測試 Web Studio 靜態檔：不需 token、前端路由回 index.html、帶 CSP、不能讀 studio 目錄以外的檔、未建置時提示。
test("Web Studio static files are served safely", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-studio-"));
  const core = await startCore(directory, []);
  try {
    const missing = await fetch(`${core.baseUrl}/`);
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Web Studio 尚未建置/u);

    mkdirSync(join(directory, "studio", "assets"), { recursive: true });
    writeFileSync(join(directory, "studio", "index.html"), "<!doctype html><title>Studio</title>");
    writeFileSync(join(directory, "studio", "assets", "app-1a2b.js"), "console.log(1)");
    writeFileSync(join(directory, "secret.txt"), "secret");

    const index = await fetch(`${core.baseUrl}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
    // §58：從其他裝置用 https 開時，WebSocket 走 wss，要列在 connect-src。
    assert.match(index.headers.get("content-security-policy") ?? "", /connect-src [^;]*wss:\/\/pc\.tail1\.ts\.net/u);
    assert.equal(index.headers.get("cache-control"), "no-cache");
    assert.match(await index.text(), /<title>Studio<\/title>/u);

    const route = await fetch(`${core.baseUrl}/plans/abc`);
    assert.match(await route.text(), /<title>Studio<\/title>/u);

    const asset = await fetch(`${core.baseUrl}/assets/app-1a2b.js`);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/u);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/u);

    assert.equal((await fetch(`${core.baseUrl}/assets/none.js`)).status, 404);
    const traversal = await rawGet(core.baseUrl, "/%2e%2e/secret.txt");
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(traversal.body, /secret/u);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試同源允許：Web Studio 自己的來源（127.0.0.1／localhost:<port>）可呼叫 API 與連 WebSocket，其他來源仍被擋。
test("Web Studio origin is allowed for API and WebSocket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-studio-"));
  const core = await startCore(directory, []);
  try {
    const port = new URL(core.baseUrl).port;
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
      const response = await fetch(`${core.baseUrl}/api/state`, { headers: { ...authHeaders(core.token), origin } });
      assert.equal(response.status, 200, origin);
    }
    const blocked = await fetch(`${core.baseUrl}/api/state`, { headers: { ...authHeaders(core.token), origin: "http://127.0.0.1:1" } });
    assert.equal(blocked.status, 403);

    const socket = new WebSocket(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`, { origin: `http://127.0.0.1:${port}` });
    await new Promise<void>((resolvePromise, reject) => {
      socket.once("open", () => resolvePromise());
      socket.once("error", reject);
    });
    socket.close();
    const rejected = new WebSocket(`${core.baseUrl.replace("http", "ws")}/ws?token=${core.token}`, { origin: "http://evil.example" });
    await new Promise<void>((resolvePromise) => {
      rejected.once("error", () => resolvePromise());
      rejected.once("open", () => resolvePromise());
    });
    assert.notEqual(rejected.readyState, WebSocket.OPEN);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試報告 API：列出報告與回寫候選（新的在前）、讀取內容、需要 token、檔名只接受 .md 且不能穿越目錄。
test("reports API lists and reads plan reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-studio-"));
  const core = await startCore(directory, []);
  try {
    mkdirSync(join(directory, "reports"));
    mkdirSync(join(directory, "writeback"));
    writeFileSync(join(directory, "reports", "2026-09-30-aaaa1111.md"), "# 計畫報告：舊");
    writeFileSync(join(directory, "writeback", "2026-09-30-bbbb2222.md"), "# 回寫候選");
    writeFileSync(join(directory, "reports", "notes.txt"), "不列出");
    utimesSync(join(directory, "reports", "2026-09-30-aaaa1111.md"), new Date(2026, 8, 30, 9), new Date(2026, 8, 30, 9));

    assert.equal((await fetch(`${core.baseUrl}/api/reports`)).status, 401);
    const list = await (await fetch(`${core.baseUrl}/api/reports`, { headers: authHeaders(core.token) })).json() as {
      reports: Array<{ kind: string; name: string }>;
    };
    assert.deepEqual(list.reports.map((report) => `${report.kind}/${report.name}`), [
      "writeback/2026-09-30-bbbb2222.md",
      "report/2026-09-30-aaaa1111.md",
    ]);
    const one = await (await fetch(`${core.baseUrl}/api/reports/report/2026-09-30-aaaa1111.md`, { headers: authHeaders(core.token) })).json() as { text: string };
    assert.equal(one.text, "# 計畫報告：舊");
    assert.equal((await fetch(`${core.baseUrl}/api/reports/report/notes.txt`, { headers: authHeaders(core.token) })).status, 404);
    assert.equal((await fetch(`${core.baseUrl}/api/reports/report/..%2Fwriteback%2F2026-09-30-bbbb2222.md`, { headers: authHeaders(core.token) })).status, 404);
    assert.equal((await fetch(`${core.baseUrl}/api/reports/other/x.md`, { headers: authHeaders(core.token) })).status, 404);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// ─── 轉接 session ────────────────────────────────────────────────────────

// 測試轉接用戶端：主人的訊息原文送出並取回回覆；同事 session 的訊息加上來源前綴與 clientId（S-1）。
test("relay client sends owner and peer messages and returns the reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-relay-"));
  const core = await startCore(directory, [
    { text: "主人，收到。", deltas: ["主人，", "收到。"] },
    { text: "知識庫管理員，可以，需要主人決定再動手。", deltas: ["知識庫管理員，可以，需要主人決定再動手。"] },
  ]);
  try {
    const connection = { baseUrl: core.baseUrl, token: core.token };
    const owner = await relayMessage(connection, "早安", { timeoutMs: 5_000 });
    assert.equal(owner.replyText, "主人，收到。");
    assert.equal(owner.timedOut, false);
    const peer = await relayMessage(connection, "摘要頁要更新嗎？", { from: "知識庫管理員", timeoutMs: 5_000 });
    assert.equal(peer.replyText, "知識庫管理員，可以，需要主人決定再動手。");
    const users = core.store.list({ limit: 10 }).filter((stored) => stored.role === "user");
    const peerMessage = users.find((stored) => stored.text.includes("摘要頁"))!;
    assert.equal(peerMessage.text, "［來自 session〈知識庫管理員〉］\n摘要頁要更新嗎？");
    assert.equal(peerMessage.clientId, "session:知識庫管理員");
    assert.equal(users.find((stored) => stored.text === "早安")?.clientId, "relay");
    assert.match(core.provider.prompts[1]!.transcript, /同事 session〈知識庫管理員〉的新訊息：\n摘要頁要更新嗎？$/u);
    assert.equal(await decide(connection, "approve"), "目前沒有待確認的計畫或任務。");
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試轉接用戶端等進度總覽（§30）：艾莉絲先說「我整理一下」並要進度資料，用戶端接著等整理後的總覽，一起帶回手機。
test("relay client waits for the progress overview", async () => {
  useWorkflow(DEFAULT_WORKFLOW);
  const directory = mkdtempSync(join(tmpdir(), "alice-relay-"));
  const gameStore = new GameStore(join(directory, "alice.db"));
  gameStore.create({ name: "測試專案", trackStages: { main: "進行中" } });
  const games = new GameService({ store: gameStore, projects: () => [] });
  const core = await startCore(directory, [
    { text: "我整理一下。<<<ALICE_PROGRESS\n{\"games\":[]}\nALICE_PROGRESS>>>" },
    { text: "測試專案：進行中，紀錄裡沒寫進度。" },
  ], join(directory, "alice.db"), { games });
  try {
    const outcome = await relayMessage({ baseUrl: core.baseUrl, token: core.token }, "各專案進度？", { timeoutMs: 5_000 });
    assert.equal(outcome.replyText, "我整理一下。\n\n測試專案：進行中，紀錄裡沒寫進度。");
    assert.ok(outcome.systemNotes.some((note) => /Core 已收集 測試專案 的進度資料/u.test(note)));
    assert.match(core.provider.prompts[1]!.transcript, /## 測試專案[\s\S]*階段：v1.0.0，進度：進行中/u);
  } finally {
    await core.close();
    gameStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試「更新進度」按鈕（§51）：排一輪進度核對，艾莉絲用 tasks 更新任務；上一輪還沒做完時回 409。
test("progress refresh API updates tasks", async () => {
  useWorkflow(DEFAULT_WORKFLOW);
  const directory = mkdtempSync(join(tmpdir(), "alice-refresh-"));
  const gameStore = new GameStore(join(directory, "alice.db"));
  const game = gameStore.create({ name: "測試專案", code: "testProject" });
  gameStore.addTask(game.id, { title: "規則確認", track: "prob", status: "進行中", version: "1.0.0.0" });
  const games = new GameService({ store: gameStore, projects: () => [] });
  let release!: () => void;
  const core = await startCore(directory, [
    { text: "測試專案：T1 完成。<<<ALICE_GAME\n{\"action\":\"update\",\"name\":\"testProject\",\"tasks\":[{\"op\":\"update\",\"id\":\"T1\",\"status\":\"完成\",\"note\":\"紀錄寫完成\"}]}\nALICE_GAME>>>", waitFor: new Promise<void>((resolve) => { release = resolve; }) },
  ], join(directory, "alice.db"), { games });
  try {
    const refresh = () => fetch(`${core.baseUrl}/api/games/refresh`, { method: "POST", headers: authHeaders(core.token), body: "{}" });
    assert.equal((await refresh()).status, 202);
    assert.equal((await refresh()).status, 409);
    release();
    for (let i = 0; i < 50 && gameStore.tasks(game.id)[0]!.status !== "完成"; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(gameStore.tasks(game.id)[0]!.status, "完成");
    assert.match(core.provider.prompts[0]!.transcript, /主人在 Studio 按了「更新進度」[\s\S]*## 測試專案/u);
  } finally {
    await core.close();
    gameStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試專案卡與推播 API（§30）：/api/games 列出卡片；推播排入後轉接用戶端取得並標成已送。
test("games and notifications APIs", async () => {
  useWorkflow(DEFAULT_WORKFLOW);
  const directory = mkdtempSync(join(tmpdir(), "alice-games-api-"));
  const gameStore = new GameStore(join(directory, "alice.db"));
  const notificationStore = new NotificationStore(join(directory, "alice.db"));
  gameStore.create({ name: "測試專案", code: "testProject", deadline: "2026-10-20" });
  const events = new EventHub();
  const games = new GameService({ store: gameStore, projects: () => [], events });
  const notifications = new NotificationService({ store: notificationStore, events, planGoal: () => "確認截斷", digestInput: () => ({ games: [], waitingDecisions: 0 }) });
  const core = await startCore(directory, [], join(directory, "alice.db"), { games, notifications, events });
  try {
    assert.equal((await fetch(`${core.baseUrl}/api/games`)).status, 401);
    const list = await (await fetch(`${core.baseUrl}/api/games`, { headers: authHeaders(core.token) })).json() as { games: Array<{ name: string; stages: Array<{ stage: string }> }> };
    assert.deepEqual(list.games.map((game) => [game.name, game.stages.map((entry) => entry.stage)]), [["測試專案", ["規劃"]]]);
    const connection = { baseUrl: core.baseUrl, token: core.token };
    // §42：背景等待在沒事時不結束，有推播才結束；--check 印出推播並標成已送，第二次就沒事。
    let waited = false;
    const waiting = waitForWork(connection).then(() => { waited = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(waited, false);
    events.broadcast("plan.paused", { planId: "p1", reason: "decision_needed", detail: "要不要改" });
    await waiting;
    const lines: string[] = [];
    assert.equal(await checkWork(connection, (line) => lines.push(line)), 1);
    assert.deepEqual(lines, ["🔔 推播：需要你決定：「確認截斷」 要不要改"]);
    assert.equal(await checkWork(connection, () => undefined), 0);
    events.broadcast("plan.paused", { planId: "p2", reason: "decision_needed", detail: "要不要改" });
    await waitForWork(connection);
    const pending = await notificationsPending(connection);
    assert.deepEqual(pending.map((entry) => entry.text), ["需要你決定：「確認截斷」 要不要改"]);
    await markNotificationDelivered(connection, pending[0]!.id);
    assert.deepEqual(await notificationsPending(connection), []);
    assert.equal((await fetch(`${core.baseUrl}/api/notifications/nope/delivered`, { method: "POST", headers: authHeaders(core.token), body: "{}" })).status, 404);
  } finally {
    await core.close();
    notifications.close();
    notificationStore.close();
    gameStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試等候逾時：超過時限就回報「還在想」，不會卡住。
test("relay client reports a timeout while Alice is still thinking", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-relay-"));
  let release = (): void => undefined;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const core = await startCore(directory, [{ text: "慢慢想", deltas: ["慢慢想"], waitFor: gate }]);
  try {
    const outcome = await relayMessage({ baseUrl: core.baseUrl, token: core.token }, "很難的問題", { timeoutMs: 200 });
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.replyText, undefined);
  } finally {
    release();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試確認請求的文字：列出項目、驗收、風險、預先授權，並提示主人用「核准 <短 id>」。
test("relay formats plan and task confirmations for the owner", () => {
  const plan = formatPlanConfirmation({
    plan: { id: "abcdef12-0000", goal: "改 sandbox", risks: ["可能影響測試"], decisions: ["要不要改文件"], preauthorizeClaudeFallback: true },
    items: [{ key: "a", title: "實作", kind: "modify", project: "sandbox", role: null, risk: "high", dependsOn: [], acceptance: ["npm test 通過"] }],
  });
  assert.match(plan, /計畫 abcdef12：改 sandbox\n  a\. 實作（modify・sandbox・Codex／Claude・高風險）\n     驗收：npm test 通過/u);
  assert.match(plan, /風險：可能影響測試[\s\S]*需要主人決定：要不要改文件[\s\S]*⚠ 預先授權[\s\S]*「核准 abcdef12」或「拒絕 abcdef12」$/u);
  const task = formatTaskConfirmation({ taskId: "12345678-aaaa", goal: "g", repo: "sandbox", acceptance: ["x"], dirtyFiles: ["a.js"] });
  assert.match(task, /任務 12345678：g（repo：sandbox）\n  驗收：x\n  ⚠ repo 有未提交的改動：a\.js\n  → 主人在這個 session 打「核准 12345678」/u);
});

// 測試翻譯 API（§48）：Chrome 插件的來源只能呼叫翻譯，而且一樣要 token；錯誤內容轉成對應的 HTTP 狀態。
test("translate API accepts the Chrome extension origin only for translation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-translate-api-"));
  const fakeSpawn = ((_command: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => undefined;
    let input = "";
    child.stdin.on("data", (chunk: Buffer) => { input += chunk.toString(); });
    child.stdin.on("finish", () => setImmediate(() => { child.stdout.end(JSON.stringify({ is_error: false, result: `譯：${input}` })); child.emit("close", 0); }));
    return child;
  }) as unknown as TranslateSpawn;
  const translate = new TranslateService({ claudePath: "claude", workDir: directory, spawn: fakeSpawn });
  const core = await startCore(directory, [], join(directory, "alice.db"), { translate });
  const extension = "chrome-extension://abcdefghijklmnop";
  try {
    const post = (headers: Record<string, string>, body: unknown) => fetch(`${core.baseUrl}/api/translate`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const ok = await post({ origin: extension, authorization: `Bearer ${core.token}` }, { text: "hello" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json().then((body: { translation: string; target: string }) => [body.translation, body.target]), ["譯：<source>\nhello\n</source>", "zh-TW"]);
    assert.equal((await post({ origin: extension }, { text: "hello" })).status, 401);
    assert.equal((await post({ origin: extension, authorization: `Bearer ${core.token}` }, { text: 3 })).status, 400);
    assert.equal((await post({ origin: extension, authorization: `Bearer ${core.token}` }, { text: " " })).status, 400);
    assert.equal((await post({ origin: "http://evil.example", authorization: `Bearer ${core.token}` }, { text: "hello" })).status, 403);
    const other = await fetch(`${core.baseUrl}/api/messages`, { headers: { origin: extension, authorization: `Bearer ${core.token}` } });
    assert.equal(other.status, 403);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 §64：代理人模式 API 預設關閉，可以開關，狀態存在檔案裡（重開還在），格式不對回 400。
test("proxy mode API toggles and persists", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-proxy-"));
  const path = join(directory, "proxy-mode.json");
  const proxy = new ProxyMode({ path });
  const core = await startCore(directory, [], join(directory, "alice.db"), { proxy });
  try {
    const call = (body?: unknown) => fetch(`${core.baseUrl}/api/proxy`, body === undefined
      ? { headers: authHeaders(core.token) }
      : { method: "POST", headers: authHeaders(core.token), body: JSON.stringify(body) });
    assert.equal((await (await call()).json() as { enabled: boolean }).enabled, false);
    assert.equal((await (await call({ enabled: true })).json() as { enabled: boolean }).enabled, true);
    assert.equal(new ProxyMode({ path }).enabled, true);
    assert.equal((await call({ enabled: "yes" })).status, 400);
    assert.equal((await (await call({ enabled: false })).json() as { enabled: boolean }).enabled, false);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 §64：艾莉絲回覆時用 SendMessage 送出的訊息，Core 逐則記成系統訊息（主人看得到她代你說了什麼）。
test("messages ALICE sent are logged in the conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-sent-log-"));
  const core = await startCore(directory, [
    { text: "已代你轉達給〈Some App - dev〉：開始做 T5", result: { sentMessages: [{ to: "Some App - dev", message: "（ALICE 代主人轉達）Some App\n開始做 T5" }] } },
  ]);
  try {
    await post(core, "sent-1", "幫我叫 prob 開始做 T5");
    let texts: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const body = await (await fetch(`${core.baseUrl}/api/messages`, { headers: authHeaders(core.token) })).json() as { messages: Array<{ role: string; text: string }> };
      texts = body.messages.filter((message) => message.role === "system").map((message) => message.text);
      if (texts.some((text) => text.startsWith("ALICe 傳給"))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(texts.includes("ALICe 傳給〈Some App - dev〉：\n（ALICE 代主人轉達）Some App\n開始做 T5"));
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 §71：委派腳本請 Studio 切到某個 Codex 任務：廣播 codex.focus，回傳連著的 Studio 數量；任務 id 格式不對就不是這個端點。
test("codex focus API broadcasts to Studio", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-codex-focus-"));
  const events = new EventHub();
  const seen: unknown[] = [];
  events.on((type, data) => { if (type === "codex.focus") seen.push(data); });
  const core = await startCore(directory, [], join(directory, "alice.db"), { events });
  try {
    const focus = (id: string) => fetch(`${core.baseUrl}/api/codex/focus/${id}`, { method: "POST", headers: authHeaders(core.token), body: "{}" });
    const ok = await focus("task-abc-1");
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { clients: 0 });
    assert.deepEqual(seen, [{ id: "task-abc-1" }]);
    assert.notEqual((await focus("not-a-task")).status, 200);
    assert.equal((await fetch(`${core.baseUrl}/api/codex/focus/task-abc-1`, { method: "POST", body: "{}" })).status, 401);
  } finally {
    await core.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
