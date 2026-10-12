import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { LocalConfig, WorkerProjectConfig } from "../localConfig.js";
import { EventHub } from "../protocol/eventHub.js";
import { ErrorLogger } from "../reliability/errorLog.js";
import { MessageStore, type Message } from "../store/messageStore.js";
import { ALICE_BLOCK_MARKERS } from "../tasks/aliceBlockFilter.js";
import type { UsageStore } from "../usage/usageStore.js";
import { ChannelStore, type Channel, type ChannelAuthor } from "./channelStore.js";
import { WorkerRunner } from "./workerRunner.js";

export type AskRequest = {
  role: string;
  project: string;
  question: string;
  channelId: string | null;
};

export type ChannelFollowup = {
  channel: Channel;
  transcript: string;
  failed: boolean;
};

type FollowupHandler = (followup: ChannelFollowup) => void;
export type WorkerExecutor = Pick<WorkerRunner, "canStart" | "run">;

export function parseAskRequest(blockText: string): AskRequest {
  const markers = ALICE_BLOCK_MARKERS.ask;
  if (!blockText.startsWith(markers.start) || !blockText.endsWith(markers.end)) {
    throw new Error("部下區塊標記不完整");
  }
  const jsonText = blockText.slice(markers.start.length, -markers.end.length).trim();
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error("部下區塊 JSON 格式錯誤");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("部下內容必須是 JSON 物件");
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(["role", "project", "question", "channelId"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) throw new Error("部下區塊包含不支援的欄位");
  for (const key of ["role", "project", "question"] as const) {
    if (typeof item[key] !== "string" || item[key].trim() === "") {
      throw new Error(`${key} 必須是非空白字串`);
    }
  }
  if (item.channelId !== undefined && item.channelId !== null &&
      (typeof item.channelId !== "string" || item.channelId.trim() === "")) {
    throw new Error("channelId 必須是非空白字串或 null");
  }
  return {
    role: item.role as string,
    project: item.project as string,
    question: item.question as string,
    channelId: item.channelId == null ? null : item.channelId as string,
  };
}

export class ChannelService {
  readonly #local: LocalConfig;
  readonly #channels: ChannelStore;
  readonly #messages: MessageStore;
  readonly #runner: WorkerExecutor | undefined;
  readonly #events: EventHub;
  readonly #usage: UsageStore | undefined;
  readonly #errors: ErrorLogger | undefined;
  readonly #now: () => Date;
  #followupHandler: FollowupHandler | undefined;

  constructor(options: {
    local: LocalConfig;
    channels: ChannelStore;
    messages: MessageStore;
    runner?: WorkerExecutor;
    events: EventHub;
    usage?: UsageStore;
    errors?: ErrorLogger;
    now?: () => Date;
  }) {
    this.#local = options.local;
    this.#channels = options.channels;
    this.#messages = options.messages;
    this.#runner = options.runner;
    this.#events = options.events;
    this.#usage = options.usage;
    this.#errors = options.errors;
    this.#now = options.now ?? (() => new Date());
  }

  setFollowupHandler(handler: FollowupHandler): void {
    this.#followupHandler = handler;
  }

  createFromBlock(blockText: string, expectedChannelId?: string): Channel | undefined {
    try {
      const request = this.#normalizeChannelId(parseAskRequest(blockText), expectedChannelId);
      if (expectedChannelId !== undefined && request.channelId !== expectedChannelId) {
        throw new Error(`追問必須使用原頻道 channelId：${expectedChannelId}`);
      }
      return this.#start(request, "alice", request.question);
    } catch (error) {
      this.#appendMainSystem(`部下未派出：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  handleUserMention(message: Message): boolean {
    const roles = [...new Set(this.#local.projects.map((project) => project.role))]
      .sort((left, right) => right.length - left.length);
    const role = roles.find((candidate) => {
      const prefix = `@${candidate}`;
      // 角色名稱後面可接空白、結尾或中英文標點（例：「@工程師，能收到嗎？」）。
      return message.text.startsWith(prefix)
        && /^[\s，,：:、。！？!?]|^$/u.test(message.text.slice(prefix.length, prefix.length + 1));
    });
    if (role === undefined) return false;
    try {
      const existing = this.#channels.latestOpenByRole(role);
      const project = existing === undefined
        ? this.#local.projects.find((candidate) => candidate.role === role)
        : this.#local.projects.find((candidate) => candidate.name === existing.project && candidate.role === role);
      if (project === undefined) throw new Error(`角色「${role}」沒有可用專案`);
      this.#start({
        role,
        project: project.name,
        question: message.text,
        channelId: existing?.id ?? null,
      }, "user", message.text);
    } catch (error) {
      this.#appendMainSystem(`部下未派出：${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  list(limit?: number): Channel[] {
    return this.#channels.list(limit);
  }

  get(id: string): { channel: Channel; messages: ReturnType<ChannelStore["messages"]> } | undefined {
    const channel = this.#channels.get(id);
    return channel === undefined ? undefined : { channel, messages: this.#channels.messages(channel.id) };
  }

  closeWithConclusion(id: string): void {
    const channel = this.#channels.get(id);
    if (channel?.status !== "open") return;
    const closed = this.#channels.update(id, { status: "closed" });
    this.#events.broadcast("channel.closed", closed);
  }

  recover(): number {
    const open = this.#channels.listOpen();
    for (const channel of open) {
      const text = "Core 重啟，頻道中斷";
      const system = this.#channels.appendMessage(channel.id, "system", text, this.#now().toISOString());
      this.#events.broadcast("channel.message", { ...system, role: channel.role });
      const failed = this.#channels.update(channel.id, { status: "failed", updatedAt: this.#now().toISOString() });
      this.#events.broadcast("channel.closed", failed);
    }
    return open.length;
  }

  #start(request: AskRequest, author: Extract<ChannelAuthor, "alice" | "user">, text: string): Channel {
    if (!this.#local.workersEnabled || this.#local.knowledgeBase === null || this.#runner === undefined) {
      throw new Error("部下功能未啟用");
    }
    const project = this.#validateProject(request);
    if (!this.#runner.canStart()) throw new Error("同時進行中的 worker 已達 2 個");
    const channel = request.channelId === null
      ? this.#createChannel(request)
      : this.#validateChannel(request);
    if (channel.rounds >= 5) throw new Error("同一個問題已達 5 輪上限");

    const message = this.#channels.appendMessage(channel.id, author, text);
    this.#events.broadcast("channel.message", { ...message, role: channel.role });
    const running = this.#channels.beginRound(channel.id);
    void this.#runWorker(running, project, request.question);
    return running;
  }

  #validateProject(request: AskRequest): WorkerProjectConfig {
    const roles = new Set(this.#local.projects.map((project) => project.role));
    if (!roles.has(request.role)) throw new Error(`角色不存在：${request.role}`);
    const project = this.#local.projects.find((item) => item.name === request.project);
    if (project === undefined) throw new Error(`專案不存在：${request.project}`);
    if (project.role !== request.role) throw new Error("專案與角色不相符");
    if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
      throw new Error(`專案路徑不存在：${project.path}`);
    }
    const rolePath = resolve(this.#local.knowledgeBase!.path, this.#local.knowledgeBase!.rolesDir, `${request.role}.md`);
    if (!existsSync(rolePath)) throw new Error(`角色頁不存在：${rolePath}`);
    return project;
  }

  /** 追問時接受頻道 id 的前 8 碼以上（艾莉絲的建議）：對到原頻道或最近頻道中唯一符合的那一個。 */
  #normalizeChannelId(request: AskRequest, expectedChannelId: string | undefined): AskRequest {
    const given = request.channelId;
    if (given === undefined || given === null || given.length < 8) return request;
    if (expectedChannelId?.startsWith(given) === true) return { ...request, channelId: expectedChannelId };
    const found = this.#channels.get(given);
    if (found !== undefined) return { ...request, channelId: found.id };
    const matches = this.#channels.list(100).filter((channel) => channel.id.startsWith(given));
    return matches.length === 1 ? { ...request, channelId: matches[0]!.id } : request;
  }

  #createChannel(request: AskRequest): Channel {
    const channel = this.#channels.create({
      title: request.question,
      project: request.project,
      role: request.role,
    });
    this.#events.broadcast("channel.created", channel);
    return channel;
  }

  #validateChannel(request: AskRequest): Channel {
    const channel = this.#channels.get(request.channelId!);
    if (channel === undefined) throw new Error(`頻道不存在：${request.channelId}`);
    if (channel.status !== "open") throw new Error(`頻道已結束：${request.channelId}；要繼續問請開新頻道（channelId 填 null），並在問題裡附上前一輪的結論`);
    if (channel.project !== request.project || channel.role !== request.role) {
      throw new Error("頻道的專案或角色不相符");
    }
    return channel;
  }

  async #runWorker(channel: Channel, project: WorkerProjectConfig, question: string): Promise<void> {
    const startedAt = this.#now().getTime();
    try {
      const result = await this.#runner!.run({
        channelId: channel.id,
        role: channel.role,
        project,
        question,
        workerSessionId: channel.workerSessionId,
      }, (text) => this.#events.broadcast("channel.delta", { channelId: channel.id, text }));
      let updated = channel;
      if (result.sessionId !== channel.workerSessionId) {
        updated = this.#channels.update(channel.id, { workerSessionId: result.sessionId });
      }
      const reply = this.#channels.appendMessage(channel.id, "worker", result.text);
      this.#events.broadcast("channel.message", { ...reply, role: channel.role });
      if (result.permissionDeniedPaths.length > 0) {
        const audit = this.#channels.appendMessage(
          channel.id,
          "system",
          `權限拒絕：${result.permissionDeniedPaths.join("、")}`,
        );
        this.#events.broadcast("channel.message", { ...audit, role: channel.role });
      }
      this.#followupHandler?.({ channel: updated, transcript: this.#transcript(updated), failed: false });
      this.#usage?.append({
        kind: "worker",
        refType: "channel",
        refId: channel.id,
        model: result.usage?.model ?? "claude-worker",
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        cacheReadInputTokens: result.usage?.cacheReadInputTokens ?? 0,
        cacheCreationInputTokens: result.usage?.cacheCreationInputTokens ?? 0,
        reasoningTokens: 0,
        durationMs: result.usage?.durationMs ?? Math.max(0, this.#now().getTime() - startedAt),
        attempts: result.usage?.attempts ?? 1,
        ts: this.#now().toISOString(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const system = this.#channels.appendMessage(channel.id, "system", `worker 失敗：${reason}`);
      this.#events.broadcast("channel.message", { ...system, role: channel.role });
      const failed = this.#channels.update(channel.id, { status: "failed" });
      this.#events.broadcast("channel.closed", failed);
      const mainMessage = this.#appendMainSystem(`工作頻道 ${channel.id.slice(0, 8)} 失敗：${reason}`);
      void mainMessage;
      this.#usage?.append({
        kind: "worker", refType: "channel", refId: channel.id, model: "claude-worker",
        inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        reasoningTokens: 0, durationMs: Math.max(0, this.#now().getTime() - startedAt), attempts: 1,
        ts: this.#now().toISOString(),
      });
      this.#errors?.write({ replyId: channel.id, kind: "worker", message: reason, attempts: 1, source: "worker" });
      this.#followupHandler?.({ channel: failed, transcript: this.#transcript(failed, true), failed: true });
    }
  }

  #transcript(channel: Channel, failed = false): string {
    // 顯示完整 id：追問必須用原頻道的 channelId，只給前 8 碼時艾莉絲沒辦法照規則追問（2026-10-01 實測三次被擋）。
    const heading = `（工作頻道 ${channel.id}・${channel.role}）`;
    const tail = failed
      ? "（系統通知）部下執行失敗，請告知主人；要重問就開新頻道（channelId 填 null）。"
      : `（系統通知）請追問（ALICE_ASK 的 channelId 填 ${channel.id}）或向主人給結論。`;
    const selected: string[] = [];
    let bytes = Buffer.byteLength(`${heading}\n${tail}`, "utf8");
    for (const message of this.#channels.messages(channel.id).reverse()) {
      const line = `${message.author}：${message.text}`;
      const lineBytes = Buffer.byteLength(`\n${line}`, "utf8");
      if (bytes + lineBytes > 12 * 1024) break;
      selected.unshift(line);
      bytes += lineBytes;
    }
    return [heading, ...selected, tail].join("\n");
  }

  #appendMainSystem(text: string): Message {
    const message = this.#messages.append({ role: "system", text });
    this.#events.broadcast("message.created", message);
    return message;
  }
}
