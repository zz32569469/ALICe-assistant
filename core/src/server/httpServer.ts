import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";

import { WebSocket, WebSocketServer } from "ws";

import type { Config } from "../config.js";
import type { ChannelService } from "../channels/channelService.js";
import type { ConversationService } from "../conversation/conversationService.js";
import type { ProxyMode } from "../conversation/proxyMode.js";
import type { CodexBoard } from "../codex/codexBoard.js";
import { FortuneError, type FortuneService } from "../fortune/fortuneService.js";
import type { MemoryKeeper } from "../memory/memoryKeeper.js";
import { EventHub } from "../protocol/eventHub.js";
import type { MessageStore } from "../store/messageStore.js";
import type { CharacterState } from "../state/characterState.js";
import { TaskServiceError, type TaskService } from "../tasks/taskService.js";
import { PlanServiceError, type PlanService } from "../plans/planService.js";
import type { QuotaService } from "../usage/quota.js";
import { OutboxError, type OutboxService } from "../relay/outboxService.js";
import type { GameService } from "../games/gameService.js";
import { workflow } from "../games/workflow.js";
import { MeetingParseError } from "../games/meetings.js";
import { MAX_MESSAGE_IMAGES, MAX_UPLOAD_BYTES, UploadError, readUpload, saveUpload, uploadExists, uploadsDir } from "../uploads/uploadStore.js";
import type { NotificationService } from "../notify/notificationService.js";
import { TranslateError, type TranslateService } from "../translate/translateService.js";
import type { UsageStore } from "../usage/usageStore.js";

const MAX_BODY_BYTES = 64 * 1024;
const CORE_VERSION = "0.1.0";

type HttpErrorCode = "bad_request" | "unauthorized" | "internal" | "not_found" | "conflict" | "busy" | "timeout" | "unavailable";

function tokensMatch(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function originAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  return origin === undefined || allowedOrigins.includes(origin);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/** 報告檔類別 → data 底下的資料夾（C3 的報告與回寫候選）。 */
const REPORT_DIRS = { report: "reports", writeback: "writeback" } as const;
type ReportKind = keyof typeof REPORT_DIRS;
const REPORT_NAME = /^[\w.-]+\.md$/u;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: HttpErrorCode,
  message: string,
): void {
  sendJson(response, status, {
    error: { code, message, retryable: code === "internal" },
  });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new Error("body_too_large");
  }

  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new Error("body_too_large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** §83：圖片上傳的原始內容（最大 10 MB）。 */
async function readRawBody(request: IncomingMessage, max: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > max) throw new UploadError(`圖片最大 ${max / 1024 / 1024} MB`);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > max) throw new UploadError(`圖片最大 ${max / 1024 / 1024} MB`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export class AliceHttpServer {
  readonly #config: Config;
  readonly #token: string;
  readonly #store: MessageStore;
  readonly #state: CharacterState;
  readonly #conversation: ConversationService;
  readonly #events: EventHub;
  readonly #tasks: TaskService | undefined;
  readonly #channels: ChannelService | undefined;
  readonly #plans: PlanService | undefined;
  readonly #usage: UsageStore | undefined;
  readonly #quotas: QuotaService | undefined;
  readonly #outbox: OutboxService | undefined;
  readonly #games: GameService | undefined;
  readonly #proxy: ProxyMode | undefined;
  readonly #codexBoard: CodexBoard | undefined;
  readonly #fortune: FortuneService | undefined;
  readonly #memory: MemoryKeeper | undefined;
  readonly #notifications: NotificationService | undefined;
  readonly #translate: TranslateService | undefined;
  readonly #setupWarnings: string[];
  readonly #webSockets = new WebSocketServer({ noServer: true });
  readonly #httpServer;
  readonly #heartbeat;
  readonly #alive = new WeakMap<WebSocket, boolean>();
  /** 實際聽的連接埠（設定為 0 時由系統分配）；用來允許 Web Studio 自己的來源。 */
  #port = 0;

  constructor(options: {
    config: Config;
    token: string;
    store: MessageStore;
    state: CharacterState;
    conversation: ConversationService;
    events: EventHub;
    tasks?: TaskService;
    channels?: ChannelService;
    plans?: PlanService;
    usage?: UsageStore;
    quotas?: QuotaService;
    outbox?: OutboxService;
    games?: GameService;
    notifications?: NotificationService;
    /** §48 選取翻譯（Chrome 插件）。 */
    translate?: TranslateService;
    /** §64 代理人模式。 */
    proxy?: ProxyMode;
    /** §65 Codex 任務看板。 */
    codexBoard?: CodexBoard;
    fortune?: FortuneService;
    memory?: MemoryKeeper;
    /** 啟動時發現的設定問題（本機設定、Codex 等），Web Studio 頂端顯示（§29）。 */
    setupWarnings?: string[];
  }) {
    this.#config = options.config;
    this.#token = options.token;
    this.#store = options.store;
    this.#state = options.state;
    this.#conversation = options.conversation;
    this.#events = options.events;
    this.#tasks = options.tasks;
    this.#channels = options.channels;
    this.#plans = options.plans;
    this.#usage = options.usage;
    this.#quotas = options.quotas;
    this.#outbox = options.outbox;
    this.#games = options.games;
    this.#proxy = options.proxy;
    this.#codexBoard = options.codexBoard;
    this.#fortune = options.fortune;
    this.#memory = options.memory;
    this.#notifications = options.notifications;
    this.#translate = options.translate;
    this.#setupWarnings = options.setupWarnings ?? [];
    this.#httpServer = createServer((request, response) => {
      void this.#handleHttp(request, response).catch((error: unknown) => {
        console.error("HTTP request failed:", error instanceof Error ? error.message : error);
        if (!response.headersSent) {
          sendError(response, 500, "internal", "Core 內部錯誤");
        } else {
          response.end();
        }
      });
    });
    this.#httpServer.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
    this.#webSockets.on("connection", (socket) => this.#handleWebSocket(socket));
    this.#heartbeat = setInterval(() => this.#pingClients(), 30_000);
    this.#heartbeat.unref();
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#httpServer.once("error", onError);
      this.#httpServer.listen(this.#config.port, this.#config.host, () => {
        this.#httpServer.off("error", onError);
        resolve();
      });
    });
    const address = this.#httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("HTTP server did not expose a TCP port");
    }
    this.#port = address.port;
    return address.port;
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeat);
    this.#events.closeAll();
    this.#webSockets.close();
    await new Promise<void>((resolve, reject) => {
      this.#httpServer.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.#config.host}`);
    // §91：放在其他網址的 Studio（例如 GitHub Pages）跨來源呼叫 API；只回應設定裡允許的來源。
    const crossOrigin = request.headers.origin !== undefined && this.#config.allowedOrigins.includes(request.headers.origin);
    if (crossOrigin && url.pathname.startsWith("/api/")) {
      response.setHeader("access-control-allow-origin", request.headers.origin!);
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "access-control-allow-methods": "GET, POST, DELETE",
          "access-control-allow-headers": "authorization, content-type, x-alice-client",
          "access-control-allow-private-network": "true",
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, version: CORE_VERSION });
      return;
    }

    if (request.method === "GET" && !url.pathname.startsWith("/api/") && url.pathname !== "/ws") {
      this.#serveStudio(url.pathname, response);
      return;
    }

    // §48：ALICE 的 Chrome 插件（chrome-extension://）只能用翻譯 API，而且一樣要 token。
    const extensionTranslate = url.pathname === "/api/translate" && request.headers.origin?.startsWith("chrome-extension://") === true;
    if (!extensionTranslate && !this.#originAllowed(request.headers.origin)) {
      sendJson(response, 403, {
        error: { code: "unauthorized", message: "Origin 不允許", retryable: false },
      });
      return;
    }
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!tokensMatch(bearer, this.#token)) {
      sendError(response, 401, "unauthorized", "Token 無效");
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/translate" && this.#translate !== undefined) {
      let text: unknown;
      try {
        text = (await readJsonBody(request) as { text?: unknown } | null)?.text;
      } catch {
        sendError(response, 400, "bad_request", "JSON 內容無效或超過 64 KB");
        return;
      }
      if (typeof text !== "string") {
        sendError(response, 400, "bad_request", "text 必須是字串");
        return;
      }
      try {
        sendJson(response, 200, await this.#translate.translate(text));
      } catch (error) {
        if (error instanceof TranslateError) {
          const status = { bad_request: 400, busy: 429, timeout: 504, unavailable: 503, failed: 502 }[error.code];
          sendError(response, status, error.code === "failed" ? "internal" : error.code, error.message);
        } else {
          sendError(response, 500, "internal", error instanceof Error ? error.message : String(error));
        }
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, this.#state.getState());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/messages") {
      const beforeText = url.searchParams.get("before");
      const limitText = url.searchParams.get("limit");
      const before = beforeText === null ? undefined : Number(beforeText);
      const limit = limitText === null ? undefined : Number(limitText);
      if (
        (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) ||
        (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
      ) {
        sendError(response, 400, "bad_request", "分頁參數無效");
        return;
      }
      sendJson(response, 200, { messages: this.#store.list({ before, limit, ...(url.searchParams.get("thread") === "chat" ? { thread: "chat" as const } : {}) }) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/outbox" && this.#outbox !== undefined) {
      const status = url.searchParams.get("status");
      sendJson(response, 200, { messages: status === "pending" ? this.#outbox.pending() : this.#outbox.list() });
      return;
    }
    const outboxMatch = /^\/api\/outbox\/([^/]+)\/(sent|failed)$/u.exec(url.pathname);
    if (request.method === "POST" && outboxMatch !== null && this.#outbox !== undefined) {
      let body: Record<string, unknown> = {};
      try {
        const contentLength = Number(request.headers["content-length"] ?? 0);
        if (contentLength > 0) {
          const parsed = await readJsonBody(request);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad_json");
          body = parsed as Record<string, unknown>;
        }
      } catch {
        sendError(response, 400, "bad_request", "JSON 內容無效或超過 64 KB");
        return;
      }
      try {
        const id = decodeURIComponent(outboxMatch[1]!);
        const message = outboxMatch[2] === "sent"
          ? this.#outbox.markSent(id)
          : this.#outbox.markFailed(id, typeof body.reason === "string" && body.reason.trim() !== "" ? body.reason.trim() : "轉接 session 回報送出失敗");
        sendJson(response, 200, { message });
      } catch (error) {
        if (error instanceof OutboxError) sendError(response, error.code === "not_found" ? 404 : 409, error.code, error.message);
        else throw error;
      }
      return;
    }
    // §85：馬上整理一次記憶（平常每天 4 點後自動整理）。
    if (request.method === "POST" && url.pathname === "/api/memory/consolidate" && this.#memory !== undefined) {
      const text = await this.#memory.consolidate();
      if (text !== undefined) this.#conversation.postNotice(text);
      sendJson(response, 200, { text: text ?? "上次整理後沒有新的對話或筆記" });
      return;
    }
    // §77 塔羅占卜：短期（今日）、長期（本週）；這一期占過回 409，停在上一次的結果。
    if (request.method === "GET" && url.pathname === "/api/fortune" && this.#fortune !== undefined) {
      sendJson(response, 200, { slots: this.#fortune.slots() });
      return;
    }
    // §81：/reinterpret 用同樣的牌重新解讀。
    const fortuneKind = /^\/api\/fortune\/(short|long)(\/reinterpret)?$/u.exec(url.pathname);
    if (request.method === "POST" && fortuneKind !== null && this.#fortune !== undefined) {
      try {
        const kind = fortuneKind[1] as "short" | "long";
        const fortune = fortuneKind[2] === undefined ? await this.#fortune.draw(kind) : await this.#fortune.reinterpret(kind);
        sendJson(response, 200, { fortune, slots: this.#fortune.slots() });
      } catch (error) {
        if (!(error instanceof FortuneError)) throw error;
        sendError(response, error.code === "conflict" ? 409 : error.code === "busy" ? 409 : 503, error.code === "failed" ? "unavailable" : "conflict", error.message);
      }
      return;
    }
    // §73 重要會議：Studio 會議分頁登記、刪除。
    if (url.pathname === "/api/meetings" && this.#games !== undefined) {
      if (request.method === "GET") {
        sendJson(response, 200, { meetings: this.#games.meetings() });
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request);
        const text = typeof body === "object" && body !== null ? (body as { text?: unknown }).text : undefined;
        if (typeof text !== "string" || text.trim() === "") {
          sendError(response, 400, "bad_request", "text 必須是非空白字串");
          return;
        }
        try {
          sendJson(response, 201, { meeting: this.#games.addMeeting(text) });
        } catch (error) {
          if (error instanceof MeetingParseError) sendError(response, 400, "bad_request", error.message);
          else throw error;
        }
        return;
      }
    }
    const meetingId = /^\/api\/meetings\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (request.method === "DELETE" && meetingId !== null && this.#games !== undefined) {
      if (this.#games.removeMeeting(meetingId[1]!)) sendJson(response, 200, { ok: true });
      else sendError(response, 404, "not_found", "找不到這個會議");
      return;
    }
    // §75：任務完成與換階段等主人確認。
    if (request.method === "GET" && url.pathname === "/api/games/confirmations" && this.#games !== undefined) {
      sendJson(response, 200, { confirmations: this.#games.pendingConfirmations() });
      return;
    }
    const gameConfirm = /^\/api\/games\/confirmations\/([0-9a-f-]{36})\/(approve|reject)$/u.exec(url.pathname);
    if (request.method === "POST" && gameConfirm !== null && this.#games !== undefined) {
      const text = this.#games.resolveConfirmation(gameConfirm[1]!, gameConfirm[2] as "approve" | "reject");
      if (text === undefined) {
        sendError(response, 404, "not_found", "找不到這張確認卡片，或已經處理過");
        return;
      }
      this.#conversation.postNotice(text);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/games" && this.#games !== undefined) {
      sendJson(response, 200, { games: this.#games.cards(), tracks: workflow().tracks.map(({ key, label, stages }) => ({ key, label, stages })), taskSources: workflow().taskSources });
      return;
    }
    // §71：委派腳本或 /board 請 Studio 切到 Codex 分頁並選這個任務；回傳連著的 Studio 數量（0 就由腳本開新分頁）。
    const codexFocus = /^\/api\/codex\/focus\/(task-[a-z0-9-]+)$/u.exec(url.pathname);
    if (request.method === "POST" && codexFocus !== null) {
      this.#events.broadcast("codex.focus", { id: codexFocus[1] });
      sendJson(response, 200, { clients: this.#events.clientCount });
      return;
    }
    const codexOpen = /^\/api\/codex\/jobs\/(task-[a-z0-9-]+)\/open-(watch|log|repo)$/u.exec(url.pathname);
    if (request.method === "POST" && codexOpen !== null && this.#codexBoard?.configured === true) {
      try {
        await this.#codexBoard.open(codexOpen[1]!, codexOpen[2] as "watch" | "log" | "repo");
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendError(response, 503, "unavailable", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/api/codex/")) {
      if (this.#codexBoard === undefined || !this.#codexBoard.configured) {
        sendError(response, 404, "not_found", "這台電腦沒有 Codex 看板（~/.claude/scripts/codex-board.mjs）");
        return;
      }
      const match = /^\/api\/codex\/jobs(?:\/(task-[a-z0-9-]+)(\/diff)?)?$/u.exec(url.pathname);
      if (match === null) {
        sendError(response, 404, "not_found", "找不到端點");
        return;
      }
      try {
        if (match[1] === undefined) sendJson(response, 200, await this.#codexBoard.jobs());
        else if (match[2] === undefined) sendJson(response, 200, await this.#codexBoard.job(match[1]));
        else sendJson(response, 200, await this.#codexBoard.diff(match[1]));
      } catch (error) {
        sendError(response, 503, "unavailable", error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (url.pathname === "/api/proxy" && this.#proxy !== undefined && (request.method === "GET" || request.method === "POST")) {
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await readJsonBody(request);
        } catch {
          sendError(response, 400, "bad_request", "JSON 內容無效或超過 64 KB");
          return;
        }
        const enabled = (body as { enabled?: unknown } | null)?.enabled;
        if (typeof enabled !== "boolean") {
          sendError(response, 400, "bad_request", "enabled 必須是 true 或 false");
          return;
        }
        this.#proxy.set(enabled);
      }
      sendJson(response, 200, this.#proxy.get());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/games/refresh" && this.#games !== undefined) {
      const replyId = this.#conversation.requestProgressRefresh();
      if (replyId !== undefined) sendJson(response, 202, { replyId });
      else sendError(response, 409, "busy", "上一次更新進度還沒做完");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/notifications" && this.#notifications !== undefined) {
      const status = url.searchParams.get("status");
      sendJson(response, 200, { notifications: status === "pending" ? this.#notifications.pending() : this.#notifications.recent() });
      return;
    }
    const notifyMatch = /^\/api\/notifications\/([^/]+)\/delivered$/u.exec(url.pathname);
    if (request.method === "POST" && notifyMatch !== null && this.#notifications !== undefined) {
      const notification = this.#notifications.markDelivered(decodeURIComponent(notifyMatch[1]!));
      if (notification === undefined) sendError(response, 404, "not_found", "找不到這則推播");
      else sendJson(response, 200, { notification });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/setup") {
      sendJson(response, 200, { warnings: this.#setupWarnings });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/reports") {
      sendJson(response, 200, { reports: this.#listReports() });
      return;
    }
    const reportMatch = /^\/api\/reports\/(report|writeback)\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && reportMatch !== null) {
      const kind = reportMatch[1] as ReportKind;
      const name = decodeURIComponent(reportMatch[2]!);
      const path = REPORT_NAME.test(name) ? join(this.#config.dataDir, REPORT_DIRS[kind], name) : undefined;
      if (path === undefined || !existsSync(path)) {
        sendError(response, 404, "not_found", "報告不存在");
        return;
      }
      sendJson(response, 200, { kind, name, text: readFileSync(path, "utf8") });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/usage" && this.#usage !== undefined && this.#quotas !== undefined) {
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 10 : Number(limitText);
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        sendError(response, 400, "bad_request", "limit 必須是正整數");
        return;
      }
      sendJson(response, 200, {
        work: this.#usage.summaries(Math.min(100, limit)),
        quotas: await this.#quotas.read(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/channels" && this.#channels !== undefined) {
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 20 : Number(limitText);
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        sendError(response, 400, "bad_request", "limit 必須是正整數");
        return;
      }
      sendJson(response, 200, { channels: this.#channels.list(Math.min(100, limit)) });
      return;
    }
    const channelMatch = /^\/api\/channels\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && channelMatch !== null && this.#channels !== undefined) {
      const found = this.#channels.get(decodeURIComponent(channelMatch[1]!));
      if (found === undefined) sendError(response, 404, "not_found", "頻道不存在");
      else sendJson(response, 200, found);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/tasks" && this.#tasks !== undefined) {
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 20 : Number(limitText);
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        sendError(response, 400, "bad_request", "limit 必須是正整數");
        return;
      }
      sendJson(response, 200, { tasks: this.#tasks.list(Math.min(100, limit)) });
      return;
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && taskMatch !== null && this.#tasks !== undefined) {
      try {
        sendJson(response, 200, { task: this.#tasks.get(decodeURIComponent(taskMatch[1]!)) });
      } catch (error) {
        this.#sendTaskError(response, error);
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/plans" && this.#plans !== undefined) {
      const limitText = url.searchParams.get("limit");
      const limit = limitText === null ? 20 : Number(limitText);
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        sendError(response, 400, "bad_request", "limit 必須是正整數");
        return;
      }
      sendJson(response, 200, { plans: this.#plans.list(Math.min(100, limit)) });
      return;
    }
    const planMatch = /^\/api\/plans\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && planMatch !== null && this.#plans !== undefined) {
      try {
        sendJson(response, 200, this.#plans.get(decodeURIComponent(planMatch[1]!)));
      } catch (error) {
        this.#sendTaskError(response, error);
      }
      return;
    }
    const planActionMatch = /^\/api\/plans\/([^/]+)\/(approve|reject|resume|cancel)$/.exec(url.pathname);
    if (request.method === "POST" && planActionMatch !== null && this.#plans !== undefined) {
      let body: Record<string, unknown> = {};
      try {
        const contentLength = Number(request.headers["content-length"] ?? 0);
        if (contentLength > 0) {
          const parsed = await readJsonBody(request);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad_json");
          body = parsed as Record<string, unknown>;
        }
      } catch {
        sendError(response, 400, "bad_request", "JSON 內容無效或超過 64 KB");
        return;
      }
      if (body.executor !== undefined && body.executor !== "claude") {
        sendError(response, 400, "bad_request", "executor 只能是 claude");
        return;
      }
      const headerClient = request.headers["x-alice-client"];
      const clientId = typeof headerClient === "string" && headerClient !== ""
        ? headerClient
        : typeof body.clientId === "string" && body.clientId !== "" ? body.clientId : "unknown";
      const id = decodeURIComponent(planActionMatch[1]!);
      try {
        const action = planActionMatch[2]!;
        const plan = action === "approve"
          ? this.#plans.approve(id, clientId)
          : action === "reject"
            ? this.#plans.reject(id, clientId, typeof body.reason === "string" ? body.reason : undefined)
            : action === "resume"
              ? this.#plans.resume(id, clientId, body.executor === "claude" ? { executor: "claude" } : {})
              : await this.#plans.cancel(id, clientId);
        sendJson(response, 200, { plan });
      } catch (error) {
        this.#sendTaskError(response, error);
      }
      return;
    }
    // §83 截圖：上傳（內容是圖片本身）與讀回（Studio 用 token 取圖顯示縮圖）。
    if (request.method === "POST" && url.pathname === "/api/uploads") {
      try {
        const bytes = await readRawBody(request, MAX_UPLOAD_BYTES);
        sendJson(response, 201, { name: saveUpload(uploadsDir(this.#config.dataDir), bytes, String(request.headers["content-type"] ?? "")) });
      } catch (error) {
        if (error instanceof UploadError) sendError(response, 400, "bad_request", error.message);
        else throw error;
      }
      return;
    }
    const uploadName = /^\/api\/uploads\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && uploadName !== null) {
      const found = readUpload(uploadsDir(this.#config.dataDir), uploadName[1]!);
      if (found === undefined) {
        sendError(response, 404, "not_found", "找不到這張圖");
        return;
      }
      response.writeHead(200, { "content-type": found.contentType, "cache-control": "private, max-age=86400", "content-length": found.bytes.length });
      response.end(found.bytes);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/messages") {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendError(response, 400, "bad_request", "JSON 內容無效或超過 64 KB");
        return;
      }
      const candidate = typeof body === "object" && body !== null
        ? body as Record<string, unknown>
        : {};
      if (
        typeof candidate.clientMsgId !== "string" ||
        candidate.clientMsgId === "" ||
        typeof candidate.clientId !== "string" ||
        candidate.clientId === "" ||
        typeof candidate.text !== "string" ||
        (candidate.text.trim() === "" && !(Array.isArray(candidate.images) && candidate.images.length > 0)) ||
        (candidate.images !== undefined && !(Array.isArray(candidate.images) && candidate.images.length <= MAX_MESSAGE_IMAGES && candidate.images.every((name) => typeof name === "string" && uploadExists(uploadsDir(this.#config.dataDir), name)))) ||
        (candidate.deep !== undefined && typeof candidate.deep !== "boolean") ||
        (candidate.thread !== undefined && candidate.thread !== "chat" && candidate.thread !== "work")
      ) {
        sendError(response, 400, "bad_request", `clientMsgId、clientId 為必填；text 不可空白（有附圖時可以空白）；images 最多 ${MAX_MESSAGE_IMAGES} 張、要先上傳`);
        return;
      }
      const input = body as { clientMsgId: string; clientId: string; text: string; deep?: boolean; thread?: "chat" | "work"; images?: string[] };
      sendJson(response, 202, this.#conversation.submit({ ...input, thread: input.thread === "chat" ? "chat" : undefined }));
      return;
    }

    const actionMatch = /^\/api\/tasks\/([^/]+)\/(approve|reject|cancel)$/.exec(url.pathname);
    if (request.method === "POST" && actionMatch !== null && this.#tasks !== undefined) {
      let body: Record<string, unknown> = {};
      try {
        const contentLength = Number(request.headers["content-length"] ?? 0);
        if (contentLength > 0) {
          const parsed = await readJsonBody(request);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("bad_json");
          body = parsed as Record<string, unknown>;
        }
      } catch {
        sendError(response, 400, "bad_request", "JSON 內容無效或超過 64 KB");
        return;
      }
      const headerClient = request.headers["x-alice-client"];
      const clientId = typeof headerClient === "string" && headerClient !== ""
        ? headerClient
        : typeof body.clientId === "string" && body.clientId !== ""
          ? body.clientId
          : "unknown";
      const id = decodeURIComponent(actionMatch[1]!);
      const action = actionMatch[2]!;
      try {
        const task = action === "approve"
          ? this.#tasks.approve(id, clientId)
          : action === "reject"
            ? this.#tasks.reject(id, clientId, typeof body.reason === "string" ? body.reason : undefined)
            : await this.#tasks.cancel(id);
        sendJson(response, 200, { task });
      } catch (error) {
        this.#sendTaskError(response, error);
      }
      return;
    }

    sendError(response, 404, "bad_request", "找不到端點");
  }

  /** 允許設定的來源，以及 Web Studio 自己的來源（同一個 Core 提供的網頁）。 */
  #originAllowed(origin: string | undefined): boolean {
    if (originAllowed(origin, this.#config.allowedOrigins)) return true;
    return this.#port !== 0 && (origin === `http://127.0.0.1:${this.#port}` || origin === `http://localhost:${this.#port}`);
  }

  #listReports(): Array<{ kind: ReportKind; name: string; size: number; modifiedAt: string }> {
    const reports: Array<{ kind: ReportKind; name: string; size: number; modifiedAt: string }> = [];
    for (const kind of Object.keys(REPORT_DIRS) as ReportKind[]) {
      const directory = join(this.#config.dataDir, REPORT_DIRS[kind]);
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        if (!REPORT_NAME.test(name)) continue;
        const stats = statSync(join(directory, name));
        if (stats.isFile()) reports.push({ kind, name, size: stats.size, modifiedAt: stats.mtime.toISOString() });
      }
    }
    return reports.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  /** Web Studio 靜態檔：只讀 studioDir 內的檔案；沒有副檔名的路徑回 index.html（前端路由）。 */
  #serveStudio(pathname: string, response: ServerResponse): void {
    const root = resolve(this.#config.studioDir);
    const index = join(root, "index.html");
    if (!existsSync(index)) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Web Studio 尚未建置：在 repo 根目錄執行 cd studio && npm install && npm run build");
      return;
    }
    let relative: string;
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/u, "");
    } catch {
      sendError(response, 400, "bad_request", "路徑無效");
      return;
    }
    let file = relative === "" ? index : resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) {
      sendError(response, 404, "not_found", "找不到檔案");
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      if (extname(relative) !== "") {
        sendError(response, 404, "not_found", "找不到檔案");
        return;
      }
      file = index;
    }
    const body = readFileSync(file);
    const hashed = file.startsWith(join(root, "assets") + sep);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": [
        "default-src 'self'",
        ["connect-src 'self' ws://127.0.0.1:* ws://localhost:*", ...this.#config.allowedOrigins.filter((origin) => origin.startsWith("https://")).map((origin) => origin.replace(/^https:/u, "wss:"))].join(" "),
        // §83：截圖用 blob 網址顯示（取圖要帶 token）。
        "img-src 'self' data: blob:",
        "style-src 'self' 'unsafe-inline'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    });
    response.end(body);
  }

  #sendTaskError(response: ServerResponse, error: unknown): void {
    if (error instanceof TaskServiceError || error instanceof PlanServiceError) {
      sendError(response, error.code === "not_found" ? 404 : 409, error.code, error.message);
      return;
    }
    console.error("Task request failed:", error instanceof Error ? error.message : error);
    sendError(response, 500, "internal", "Core 內部錯誤");
  }

  #handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): void {
    const url = new URL(request.url ?? "/", `http://${this.#config.host}`);
    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.#originAllowed(request.headers.origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!tokensMatch(url.searchParams.get("token") ?? undefined, this.#token)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      this.#webSockets.emit("connection", webSocket, request);
    });
  }

  #handleWebSocket(socket: WebSocket): void {
    this.#alive.set(socket, true);
    this.#events.add(socket);
    const latest = this.#store.list({ limit: 1 })[0];
    this.#events.send(socket, "hello", {
      coreVersion: CORE_VERSION,
      state: this.#state.getState(),
      lastMessageSeq: latest?.seq ?? 0,
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as { type?: unknown };
        if (message.type === "pong") {
          this.#alive.set(socket, true);
        }
      } catch {
        // 階段 A 僅接受 pong；其他 Client 訊息忽略。
      }
    });
    socket.on("pong", () => this.#alive.set(socket, true));
    socket.on("close", () => this.#events.remove(socket));
    socket.on("error", () => this.#events.remove(socket));
  }

  #pingClients(): void {
    for (const socket of this.#webSockets.clients) {
      if (this.#alive.get(socket) === false) {
        socket.terminate();
        continue;
      }
      this.#alive.set(socket, false);
    }
    this.#events.broadcast("ping", {});
  }
}
