// 待送信件的服務（§27）：排入、轉接 session 回報送出結果、留紀錄讓主人看得到。

import type { EventHub } from "../protocol/eventHub.js";
import type { Message, MessageStore } from "../store/messageStore.js";
import type { OutboxMessage, OutboxStore } from "./outboxStore.js";
import { parseSendBlock, resolveRecipient, type SessionTarget } from "./sendBlock.js";

export class OutboxError extends Error {
  readonly code: "not_found" | "conflict";

  constructor(code: "not_found" | "conflict", message: string) {
    super(message);
    this.code = code;
  }
}

type FailedHandler = (message: OutboxMessage) => void;

function firstLine(text: string, max = 80): string {
  const line = text.split(/\r?\n/u).find((entry) => entry.trim() !== "") ?? "";
  return Array.from(line).length > max ? `${Array.from(line).slice(0, max).join("")}…` : line;
}

export class OutboxService {
  readonly #store: OutboxStore;
  readonly #messages: MessageStore;
  readonly #events: EventHub;
  readonly #targets: () => SessionTarget[];
  readonly #relaySession: string;
  readonly #now: () => Date;
  #onFailed: FailedHandler | undefined;

  constructor(options: {
    store: OutboxStore;
    messages: MessageStore;
    events: EventHub;
    targets: () => SessionTarget[];
    relaySession: string;
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#messages = options.messages;
    this.#events = options.events;
    this.#targets = options.targets;
    this.#relaySession = options.relaySession;
    this.#now = options.now ?? (() => new Date());
  }

  get relaySession(): string {
    return this.#relaySession;
  }

  targets(): SessionTarget[] {
    return this.#targets();
  }

  resolve(to: string): SessionTarget | undefined {
    return resolveRecipient(to, this.#targets());
  }

  setFailedHandler(handler: FailedHandler): void {
    this.#onFailed = handler;
  }

  enqueue(input: { recipient: string; text: string; kind: OutboxMessage["kind"]; planId?: string; itemId?: string }): OutboxMessage {
    const message = this.#store.create({ ...input, createdAt: this.#now().toISOString() });
    this.#appendSystem(`📤 待送給〈${message.recipient}〉（${message.id.slice(0, 8)}）：${firstLine(message.text.replace(/^【[^】]*】\s*/u, ""))}`);
    this.#events.broadcast("outbox.created", { id: message.id, recipient: message.recipient, kind: message.kind });
    return message;
  }

  /** 艾莉絲回覆中的 ALICE_SEND 區塊。對象不在設定裡或格式錯誤時寫 system 訊息，不送出。 */
  sendFromBlock(blockText: string): OutboxMessage | undefined {
    try {
      const request = parseSendBlock(blockText);
      const target = this.resolve(request.to);
      if (target === undefined) {
        const known = this.#targets().map((entry) => `${entry.session}（${entry.role}）`).join("、") || "（無）";
        throw new Error(`找不到傳訊對象「${request.to}」；可傳的對象：${known}`);
      }
      return this.enqueue({ recipient: target.session, kind: "message", text: this.directMessageText(request.message) });
    } catch (error) {
      this.#appendSystem(`訊息未送出：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  directMessageText(body: string): string {
    return [
      "【ALICe 訊息】",
      body,
      "",
      `（這是 Alice Core 透過轉接 session 送來的訊息。要回覆時用 SendMessage 傳給「${this.#relaySession}」；ALICe 不能替主人做決定或核准。）`,
    ].join("\n");
  }

  pending(): OutboxMessage[] {
    return this.#store.list({ status: "pending", limit: 50 });
  }

  list(limit = 50): OutboxMessage[] {
    return this.#store.list({ limit });
  }

  get(idOrPrefix: string): OutboxMessage {
    const found = this.#store.get(idOrPrefix) ?? this.#store.findByPrefix(idOrPrefix);
    if (found === undefined) throw new OutboxError("not_found", "信件不存在");
    return found;
  }

  markSent(idOrPrefix: string): OutboxMessage {
    const message = this.get(idOrPrefix);
    if (message.status !== "pending") throw new OutboxError("conflict", `信件已是 ${message.status}`);
    const updated = this.#store.mark(message.id, "sent", undefined, this.#now().toISOString())!;
    this.#appendSystem(`📨 已送給〈${updated.recipient}〉（${updated.id.slice(0, 8)}）`);
    this.#events.broadcast("outbox.updated", updated);
    return updated;
  }

  markFailed(idOrPrefix: string, reason: string): OutboxMessage {
    const message = this.get(idOrPrefix);
    if (message.status !== "pending") throw new OutboxError("conflict", `信件已是 ${message.status}`);
    const updated = this.#store.mark(message.id, "failed", reason, this.#now().toISOString())!;
    this.#appendSystem(`⚠ 送給〈${updated.recipient}〉失敗（${updated.id.slice(0, 8)}）：${reason}`);
    this.#events.broadcast("outbox.updated", updated);
    this.#onFailed?.(updated);
    return updated;
  }

  #appendSystem(text: string): Message {
    const message = this.#messages.append({ role: "system", text });
    this.#events.broadcast("message.created", message);
    return message;
  }
}
