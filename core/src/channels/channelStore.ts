import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type ChannelStatus = "open" | "closed" | "failed";
export type ChannelAuthor = "alice" | "worker" | "user" | "system";

export type Channel = {
  id: string;
  title: string;
  project: string;
  role: string;
  workerSessionId: string | null;
  status: ChannelStatus;
  rounds: number;
  createdAt: string;
  updatedAt: string;
};

export type ChannelMessage = {
  id: string;
  channelId: string;
  seq: number;
  author: ChannelAuthor;
  text: string;
  createdAt: string;
};

type ChannelRow = {
  id: string; title: string; project: string; role: string; worker_session_id: string | null;
  status: ChannelStatus; rounds: number; created_at: string; updated_at: string;
};
type ChannelMessageRow = {
  id: string; channel_id: string; seq: number; author: ChannelAuthor; text: string; created_at: string;
};

function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    title: row.title,
    project: row.project,
    role: row.role,
    workerSessionId: row.worker_session_id,
    status: row.status,
    rounds: row.rounds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: ChannelMessageRow): ChannelMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    seq: row.seq,
    author: row.author,
    text: row.text,
    createdAt: row.created_at,
  };
}

export class ChannelStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
  }

  create(input: { title: string; project: string; role: string; createdAt?: string }): Channel {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const channel: Channel = {
      id: randomUUID(),
      title: Array.from(input.title).slice(0, 40).join(""),
      project: input.project,
      role: input.role,
      workerSessionId: null,
      status: "open",
      rounds: 0,
      createdAt,
      updatedAt: createdAt,
    };
    this.#db.prepare(`
      INSERT INTO channels (id, title, project, role, worker_session_id, status, rounds, created_at, updated_at)
      VALUES (@id, @title, @project, @role, @workerSessionId, @status, @rounds, @createdAt, @updatedAt)
    `).run(channel);
    return channel;
  }

  get(id: string): Channel | undefined {
    const exact = this.#db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
    if (exact !== undefined) return toChannel(exact);
    const rows = this.#db.prepare("SELECT * FROM channels WHERE id LIKE ? LIMIT 2").all(`${id}%`) as ChannelRow[];
    return rows.length === 1 ? toChannel(rows[0]!) : undefined;
  }

  list(limit = 20): Channel[] {
    const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
    return (this.#db.prepare("SELECT * FROM channels ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(capped) as ChannelRow[]).map(toChannel);
  }

  latestOpenByRole(role: string): Channel | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM channels WHERE role = ? AND status = 'open'
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(role) as ChannelRow | undefined;
    return row === undefined ? undefined : toChannel(row);
  }

  listOpen(): Channel[] {
    return (this.#db.prepare("SELECT * FROM channels WHERE status = 'open' ORDER BY created_at")
      .all() as ChannelRow[]).map(toChannel);
  }

  messages(channelId: string): ChannelMessage[] {
    return (this.#db.prepare(`
      SELECT * FROM channel_messages WHERE channel_id = ? ORDER BY seq
    `).all(channelId) as ChannelMessageRow[]).map(toMessage);
  }

  appendMessage(channelId: string, author: ChannelAuthor, text: string, createdAt = new Date().toISOString()): ChannelMessage {
    return this.#db.transaction(() => {
      const channel = this.get(channelId);
      if (channel === undefined) throw new Error(`Channel not found: ${channelId}`);
      const row = this.#db.prepare(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM channel_messages WHERE channel_id = ?",
      ).get(channelId) as { seq: number };
      const message: ChannelMessage = {
        id: randomUUID(), channelId, seq: row.seq, author, text, createdAt,
      };
      this.#db.prepare(`
        INSERT INTO channel_messages (id, channel_id, seq, author, text, created_at)
        VALUES (@id, @channelId, @seq, @author, @text, @createdAt)
      `).run(message);
      this.#db.prepare("UPDATE channels SET updated_at = ? WHERE id = ?").run(createdAt, channelId);
      return message;
    })();
  }

  beginRound(id: string, updatedAt = new Date().toISOString()): Channel {
    const result = this.#db.prepare(`
      UPDATE channels SET rounds = rounds + 1, updated_at = ?
      WHERE id = ? AND status = 'open' AND rounds < 5
    `).run(updatedAt, id);
    if (result.changes === 0) throw new Error("頻道已結束或已達 5 輪上限");
    return this.get(id)!;
  }

  update(id: string, patch: { workerSessionId?: string | null; status?: ChannelStatus; updatedAt?: string }): Channel {
    const assignments: string[] = [];
    const values: Record<string, unknown> = { id };
    if ("workerSessionId" in patch) {
      assignments.push("worker_session_id = @workerSessionId");
      values.workerSessionId = patch.workerSessionId ?? null;
    }
    if (patch.status !== undefined) {
      assignments.push("status = @status");
      values.status = patch.status;
    }
    assignments.push("updated_at = @updatedAt");
    values.updatedAt = patch.updatedAt ?? new Date().toISOString();
    const result = this.#db.prepare(`UPDATE channels SET ${assignments.join(", ")} WHERE id = @id`).run(values);
    if (result.changes === 0) throw new Error(`Channel not found: ${id}`);
    return this.get(id)!;
  }

  close(): void {
    this.#db.close();
  }
}
