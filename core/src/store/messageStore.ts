import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type Message = {
  id: string;
  seq: number;
  role: "user" | "alice" | "system";
  text: string;
  clientId?: string;
  mode?: "work" | "chat";
  /** §78 對話分頁：沒有＝工作，"chat"＝聊天。 */
  thread?: "chat";
  /** §83 附的截圖（data/uploads 裡的檔名）。 */
  images?: string[];
  createdAt: string;
};

export type Thread = "work" | "chat";

export type AppendMessageInput = {
  role: Message["role"];
  text: string;
  clientId?: string;
  mode?: Message["mode"];
  thread?: Thread;
  images?: string[];
  clientMsgId?: string | null;
  createdAt?: string;
};

type MessageRow = {
  id: string;
  seq: number;
  role: Message["role"];
  text: string;
  client_id: string | null;
  mode: Message["mode"] | null;
  thread?: string | null;
  images?: string | null;
  created_at: string;
};

function localIsoString(date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetRemainder = Math.abs(offsetMinutes) % 60;
  const localTime = new Date(date.getTime() + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, -1);
  return `${localTime}${sign}${String(offsetHours).padStart(2, "0")}:${String(offsetRemainder).padStart(2, "0")}`;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    text: row.text,
    ...(row.client_id === null ? {} : { clientId: row.client_id }),
    ...(row.mode === null ? {} : { mode: row.mode }),
    ...(row.thread === "chat" ? { thread: "chat" as const } : {}),
    ...(row.images ? { images: JSON.parse(row.images) as string[] } : {}),
    createdAt: row.created_at,
  };
}

export class MessageStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#migrate();
  }

  #migrate(): void {
    const version = this.#db.pragma("user_version", { simple: true }) as number;
    if (version === 0) {
      this.#db.transaction(() => {
        this.#db.exec(`
          CREATE TABLE messages (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL CHECK (role IN ('user', 'alice', 'system')),
            text TEXT NOT NULL,
            client_id TEXT,
            mode TEXT CHECK (mode IS NULL OR mode IN ('work', 'chat')),
            client_msg_id TEXT UNIQUE,
            created_at TEXT NOT NULL
          );
        `);
        this.#createChannelTables();
        this.#createUsageTable();
        this.#db.pragma("user_version = 4");
      })();
      this.#ensureThreadColumn();
      return;
    }

    let currentVersion = version;
    if (version === 1) {
      this.#db.transaction(() => {
        this.#db.exec(`
          CREATE TABLE messages_v2 (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            role TEXT NOT NULL CHECK (role IN ('user', 'alice', 'system')),
            text TEXT NOT NULL,
            client_id TEXT,
            mode TEXT CHECK (mode IS NULL OR mode IN ('work', 'chat')),
            client_msg_id TEXT UNIQUE,
            created_at TEXT NOT NULL
          );
          INSERT INTO messages_v2 (seq, id, role, text, client_id, mode, client_msg_id, created_at)
          SELECT seq, id, role, text, client_id, mode, client_msg_id, created_at FROM messages;
          DROP TABLE messages;
          ALTER TABLE messages_v2 RENAME TO messages;
        `);
        this.#db.pragma("user_version = 2");
      })();
      currentVersion = 2;
    }

    if (currentVersion === 2) {
      this.#db.transaction(() => {
        this.#createChannelTables();
        this.#db.pragma("user_version = 3");
      })();
      currentVersion = 3;
    }

    if (currentVersion === 3) {
      this.#db.transaction(() => {
        this.#createUsageTable();
        this.#db.pragma("user_version = 4");
      })();
      currentVersion = 4;
    }

    if (currentVersion !== 4) {
      throw new Error(`Unsupported message database version: ${currentVersion}`);
    }
    this.#ensureThreadColumn();
  }

  /** §78：對話分頁欄（舊資料都是工作）。 */
  #ensureThreadColumn(): void {
    const columns = this.#db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "thread")) this.#db.exec("ALTER TABLE messages ADD COLUMN thread TEXT");
    // §83：截圖欄。
    if (!columns.some((column) => column.name === "images")) this.#db.exec("ALTER TABLE messages ADD COLUMN images TEXT");
  }

  #createChannelTables(): void {
    this.#db.exec(`
      CREATE TABLE channels (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project TEXT NOT NULL,
        role TEXT NOT NULL,
        worker_session_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'failed')),
        rounds INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        author TEXT NOT NULL CHECK (author IN ('alice', 'worker', 'user', 'system')),
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (channel_id, seq)
      );
      CREATE INDEX channels_updated_at ON channels(updated_at DESC);
      CREATE INDEX channel_messages_channel_seq ON channel_messages(channel_id, seq);
    `);
  }

  #createUsageTable(): void {
    this.#db.exec(`
      CREATE TABLE usage (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('alice', 'worker', 'codex')),
        ref_type TEXT NOT NULL CHECK (ref_type IN ('message', 'channel', 'task')),
        ref_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_input_tokens INTEGER NOT NULL,
        cache_creation_input_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      );
      CREATE INDEX usage_ts ON usage(ts DESC);
      CREATE INDEX usage_ref ON usage(kind, ref_type, ref_id);
    `);
  }

  append(input: AppendMessageInput): Message {
    const id = randomUUID();
    const createdAt = input.createdAt ?? localIsoString();
    const result = this.#db
      .prepare(`
        INSERT INTO messages (id, role, text, client_id, mode, thread, images, client_msg_id, created_at)
        VALUES (@id, @role, @text, @clientId, @mode, @thread, @images, @clientMsgId, @createdAt)
      `)
      .run({
        id,
        role: input.role,
        text: input.text,
        clientId: input.clientId ?? null,
        mode: input.mode ?? null,
        thread: input.thread === "chat" ? "chat" : null,
        images: input.images === undefined || input.images.length === 0 ? null : JSON.stringify(input.images),
        clientMsgId: input.clientMsgId ?? null,
        createdAt,
      });

    return {
      id,
      seq: Number(result.lastInsertRowid),
      role: input.role,
      text: input.text,
      ...(input.clientId === undefined ? {} : { clientId: input.clientId }),
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.thread === "chat" ? { thread: "chat" as const } : {}),
      ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }),
      createdAt,
    };
  }

  findByClientMsgId(id: string): Message | undefined {
    const row = this.#db
      .prepare(`
        SELECT id, seq, role, text, client_id, mode, thread, images, created_at
        FROM messages
        WHERE client_msg_id = ?
      `)
      .get(id) as MessageRow | undefined;
    return row === undefined ? undefined : toMessage(row);
  }

  /** §78：thread 預設是工作（舊訊息與系統訊息都算工作）。 */
  list(options: { before?: number; limit?: number; thread?: Thread } = {}): Message[] {
    const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 50)));
    const threadWhere = options.thread === "chat" ? "thread = 'chat'" : "(thread IS NULL OR thread <> 'chat')";
    const rows = options.before === undefined
      ? this.#db
          .prepare(`
            SELECT id, seq, role, text, client_id, mode, thread, images, created_at
            FROM messages
            WHERE ${threadWhere}
            ORDER BY seq DESC
            LIMIT ?
          `)
          .all(limit)
      : this.#db
          .prepare(`
            SELECT id, seq, role, text, client_id, mode, thread, images, created_at
            FROM messages
            WHERE seq < ? AND ${threadWhere}
            ORDER BY seq DESC
            LIMIT ?
          `)
          .all(options.before, limit);
    return (rows as MessageRow[]).map(toMessage);
  }


  recent(n: number): Message[] {
    const limit = Math.max(0, Math.trunc(n));
    if (limit === 0) {
      return [];
    }

    const rows = this.#db
      .prepare(`
        SELECT id, seq, role, text, client_id, mode, thread, images, created_at
        FROM messages
        ORDER BY seq DESC
        LIMIT ?
      `)
      .all(limit) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  /** §85：seq 之後主人與 ALICe 的對話（兩個分頁），最多 limit 則（取最新的），舊到新。 */
  conversationSince(seq: number, limit: number): Message[] {
    const rows = this.#db.prepare(`
      SELECT id, seq, role, text, client_id, mode, thread, images, created_at
      FROM messages
      WHERE seq > ? AND role IN ('user', 'alice')
      ORDER BY seq DESC
      LIMIT ?
    `).all(seq, Math.max(1, Math.trunc(limit))) as MessageRow[];
    return rows.reverse().map(toMessage);
  }

  unansweredUserMessages(): Message[] {
    const rows = this.#db.prepare(`
      SELECT id, seq, role, text, client_id, mode, thread, images, created_at
      FROM messages AS m
      WHERE role = 'user'
        AND seq > COALESCE((
          SELECT MAX(seq) FROM messages AS a
          WHERE a.role = 'alice' AND COALESCE(a.thread, 'work') = COALESCE(m.thread, 'work')
        ), 0)
      ORDER BY seq
    `).all() as MessageRow[];
    return rows.map(toMessage);
  }

  close(): void {
    this.#db.close();
  }
}
