// 待送信件（§27）：Core 不能用 SendMessage，由轉接 session 監看這裡、代為送出給同事 session。

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type OutboxStatus = "pending" | "sent" | "failed";

export type OutboxMessage = {
  id: string;
  /** 收件的 session 名稱（ListAgents／SendMessage 用的名稱）。 */
  recipient: string;
  text: string;
  /** message：艾莉絲直接傳訊；task：計畫的 session 項目派工。 */
  kind: "message" | "task";
  planId: string | null;
  itemId: string | null;
  status: OutboxStatus;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
};

type Row = {
  id: string; recipient: string; text: string; kind: "message" | "task"; plan_id: string | null; item_id: string | null;
  status: OutboxStatus; error: string | null; created_at: string; sent_at: string | null;
};

function toMessage(row: Row): OutboxMessage {
  return {
    id: row.id, recipient: row.recipient, text: row.text, kind: row.kind, planId: row.plan_id, itemId: row.item_id,
    status: row.status, error: row.error, createdAt: row.created_at, sentAt: row.sent_at,
  };
}

export class OutboxStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL,
        plan_id TEXT,
        item_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status, created_at);
    `);
  }

  create(input: { recipient: string; text: string; kind: OutboxMessage["kind"]; planId?: string; itemId?: string; createdAt?: string }): OutboxMessage {
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO outbox (id, recipient, text, kind, plan_id, item_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, input.recipient, input.text, input.kind, input.planId ?? null, input.itemId ?? null, input.createdAt ?? new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): OutboxMessage | undefined {
    const row = this.#db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toMessage(row);
  }

  findByPrefix(prefix: string): OutboxMessage | undefined {
    const rows = this.#db.prepare("SELECT * FROM outbox WHERE id LIKE ? LIMIT 2").all(`${prefix}%`) as Row[];
    return rows.length === 1 ? toMessage(rows[0]!) : undefined;
  }

  list(options: { status?: OutboxStatus; limit?: number } = {}): OutboxMessage[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
    const rows = options.status === undefined
      ? this.#db.prepare("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?").all(limit)
      : this.#db.prepare("SELECT * FROM outbox WHERE status = ? ORDER BY created_at LIMIT ?").all(options.status, limit);
    return (rows as Row[]).map(toMessage);
  }

  mark(id: string, status: Exclude<OutboxStatus, "pending">, error?: string, at = new Date().toISOString()): OutboxMessage | undefined {
    this.#db.prepare("UPDATE outbox SET status = ?, error = ?, sent_at = ? WHERE id = ?").run(status, error ?? null, at, id);
    return this.get(id);
  }

  close(): void {
    this.#db.close();
  }
}
