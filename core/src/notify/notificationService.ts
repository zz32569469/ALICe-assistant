// 手機推播（§30 M-4）：Core 排入推播，轉接 session（ALICE）的背景監看取出後用 PushNotification 推到手機。
// 立刻推：計畫暫停（等主人決定、同事回報卡住）。每天早上一則彙整：截止日、太久沒進度、等決定的事累積。

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { isFinished, type Game } from "../games/gameStore.js";
import { daysBetween, localDate } from "../games/progress.js";
import type { EventHub } from "../protocol/eventHub.js";

export type Notification = { id: string; kind: "immediate" | "digest"; text: string; createdAt: string; deliveredAt: string | null };

type Row = { id: string; kind: Notification["kind"]; text: string; created_at: string; delivered_at: string | null };

const toNotification = (row: Row): Notification => ({ id: row.id, kind: row.kind, text: row.text, createdAt: row.created_at, deliveredAt: row.delivered_at });

export const DIGEST_HOUR = 9;
export const DEADLINE_WARN_DAYS = 3;
export const STALE_DAYS = 5;
export const DECISIONS_WARN = 3;
const MAX_CHARS = 200;

export class NotificationStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS notifications_pending ON notifications(delivered_at, created_at);
      CREATE TABLE IF NOT EXISTS alice_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  create(kind: Notification["kind"], text: string, at = new Date().toISOString()): Notification {
    const id = randomUUID();
    this.#db.prepare("INSERT INTO notifications (id, kind, text, created_at) VALUES (?, ?, ?, ?)").run(id, kind, text, at);
    return this.get(id)!;
  }

  get(id: string): Notification | undefined {
    const row = this.#db.prepare("SELECT * FROM notifications WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toNotification(row);
  }

  findByPrefix(prefix: string): Notification | undefined {
    const rows = this.#db.prepare("SELECT * FROM notifications WHERE id LIKE ? LIMIT 2").all(`${prefix}%`) as Row[];
    return rows.length === 1 ? toNotification(rows[0]!) : undefined;
  }

  pending(): Notification[] {
    return (this.#db.prepare("SELECT * FROM notifications WHERE delivered_at IS NULL ORDER BY created_at LIMIT 50").all() as Row[]).map(toNotification);
  }

  recent(limit = 30): Notification[] {
    return (this.#db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map(toNotification);
  }

  markDelivered(id: string, at = new Date().toISOString()): Notification | undefined {
    this.#db.prepare("UPDATE notifications SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL").run(at, id);
    return this.get(id);
  }

  getMeta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM alice_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO alice_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  close(): void {
    this.#db.close();
  }
}

function clip(text: string, max = MAX_CHARS): string {
  const chars = Array.from(text.replace(/\s*\r?\n\s*/gu, " ").trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
}

function dateKey(date: Date): string {
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 每日彙整的內容；沒事回傳 undefined（不推）。 */
export function digestText(input: {
  games: Array<{ game: Game; lastActivityAt: string | null }>;
  waitingDecisions: number;
  now: Date;
}): string | undefined {
  const parts: string[] = [];
  for (const { game, lastActivityAt } of input.games) {
    if (isFinished(game)) continue;
    if (game.deadline !== null) {
      const days = daysBetween(input.now, localDate(game.deadline));
      if (days < 0) parts.push(`${game.name} 已過截止日 ${-days} 天`);
      else if (days === 0) parts.push(`${game.name} 今天截止`);
      else if (days <= DEADLINE_WARN_DAYS) parts.push(`${game.name} ${days} 天後截止`);
    }
    if (lastActivityAt !== null) {
      const idle = daysBetween(new Date(lastActivityAt), input.now);
      if (idle > STALE_DAYS) parts.push(`${game.name} ${idle} 天沒有進度`);
    }
  }
  if (input.waitingDecisions >= DECISIONS_WARN) parts.push(`${input.waitingDecisions} 件事等你決定`);
  return parts.length === 0 ? undefined : clip(`ALICe 早報：${parts.join("；")}`);
}

const PAUSE_PREFIX: Record<string, string> = {
  decision_needed: "需要你決定",
  session_blocked: "同事回報卡住",
};

export class NotificationService {
  readonly #store: NotificationStore;
  readonly #events: EventHub;
  readonly #now: () => Date;
  readonly #planGoal: (planId: string) => string | undefined;
  readonly #digestInput: () => { games: Array<{ game: Game; lastActivityAt: string | null }>; waitingDecisions: number };
  readonly #unsubscribe: () => void;

  constructor(options: {
    store: NotificationStore;
    events: EventHub;
    planGoal: (planId: string) => string | undefined;
    digestInput: () => { games: Array<{ game: Game; lastActivityAt: string | null }>; waitingDecisions: number };
    now?: () => Date;
  }) {
    this.#store = options.store;
    this.#events = options.events;
    this.#now = options.now ?? (() => new Date());
    this.#planGoal = options.planGoal;
    this.#digestInput = options.digestInput;
    this.#unsubscribe = this.#events.on((type, data) => {
      if (type !== "plan.paused") return;
      const event = data as { planId?: unknown; reason?: unknown; detail?: unknown };
      const planId = String(event.planId ?? "");
      const goal = this.#planGoal(planId);
      const label = PAUSE_PREFIX[String(event.reason)] ?? "計畫暫停";
      this.push("immediate", `${label}：${goal === undefined ? `計畫 ${planId.slice(0, 8)}` : `「${goal}」`}${event.detail === undefined ? "" : ` ${String(event.detail)}`}`);
    });
  }

  push(kind: Notification["kind"], text: string): Notification {
    const notification = this.#store.create(kind, clip(text), this.#now().toISOString());
    this.#events.broadcast("notify.created", notification);
    return notification;
  }

  pending(): Notification[] {
    return this.#store.pending();
  }

  recent(): Notification[] {
    return this.#store.recent();
  }

  markDelivered(id: string): Notification | undefined {
    const found = this.#store.get(id) ?? this.#store.findByPrefix(id);
    return found === undefined ? undefined : this.#store.markDelivered(found.id, this.#now().toISOString());
  }

  /** 每分鐘呼叫一次；過了早上 9 點且今天還沒彙整就彙整一次（Core 晚開機也會補一次）。 */
  tick(): Notification | undefined {
    const now = this.#now();
    if (now.getHours() < DIGEST_HOUR) return undefined;
    const today = dateKey(now);
    if (this.#store.getMeta("digest.date") === today) return undefined;
    this.#store.setMeta("digest.date", today);
    let text: string | undefined;
    try {
      text = digestText({ ...this.#digestInput(), now });
    } catch (error) {
      console.warn("每日彙整失敗：", error instanceof Error ? error.message : error);
      return undefined;
    }
    return text === undefined ? undefined : this.push("digest", text);
  }

  close(): void {
    this.#unsubscribe();
  }
}
