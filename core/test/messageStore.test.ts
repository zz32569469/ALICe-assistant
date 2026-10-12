import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { MessageStore } from "../src/store/messageStore.js";

// 測試新增訊息會產生識別碼並依寫入順序遞增 seq，確保基本紀錄順序可靠。
test("append assigns ids and increasing sequence numbers", () => {
  const store = new MessageStore(":memory:");
  try {
    const first = store.append({ role: "user", text: "第一則", clientId: "cli" });
    const second = store.append({ role: "alice", text: "第二則", mode: "chat" });

    assert.match(first.id, /^[0-9a-f-]{36}$/);
    assert.equal(second.seq, first.seq + 1);
    assert.equal(first.clientId, "cli");
    assert.equal(second.mode, "chat");
    assert.match(first.createdAt, /(Z|[+-]\d{2}:\d{2})$/);
  } finally {
    store.close();
  }
});

// 測試 clientMsgId 可查回原訊息且資料庫拒絕重複值，避免 Client 重送造成重複紀錄。
test("clientMsgId is queryable and unique", () => {
  const store = new MessageStore(":memory:");
  try {
    const message = store.append({
      role: "user",
      text: "只應寫入一次",
      clientMsgId: "client-message-1",
    });

    assert.deepEqual(store.findByClientMsgId("client-message-1"), message);
    assert.equal(store.findByClientMsgId("missing"), undefined);
    assert.throws(() =>
      store.append({ role: "user", text: "重複", clientMsgId: "client-message-1" }),
    );
  } finally {
    store.close();
  }
});

// 測試列表採新到舊、before 為排他分頁，且過大的 limit 會限制為 200。
test("list paginates newest-first and caps limit at 200", () => {
  const store = new MessageStore(":memory:");
  try {
    for (let index = 1; index <= 205; index += 1) {
      store.append({ role: "user", text: `訊息 ${index}` });
    }

    const capped = store.list({ limit: 999 });
    assert.equal(capped.length, 200);
    assert.equal(capped[0]?.seq, 205);
    assert.equal(capped.at(-1)?.seq, 6);

    const page = store.list({ before: 6, limit: 2 });
    assert.deepEqual(page.map((message) => message.seq), [5, 4]);
  } finally {
    store.close();
  }
});

// 測試 recent 只取最後 n 則並改為舊到新，避免提示中的對話時間順序顛倒。
test("recent returns the newest subset in chronological order", () => {
  const store = new MessageStore(":memory:");
  try {
    for (const text of ["一", "二", "三", "四"]) {
      store.append({ role: "user", text });
    }

    assert.deepEqual(store.recent(3).map((message) => message.text), ["二", "三", "四"]);
    assert.deepEqual(store.recent(0), []);
  } finally {
    store.close();
  }
});

// 測試關閉實體 SQLite 後重新開啟仍可讀取資料，確保正式環境的對話不因重啟遺失。
test("file database persists across close and reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-message-store-"));
  const databasePath = join(directory, "messages.sqlite");
  try {
    const firstStore = new MessageStore(databasePath);
    firstStore.append({ role: "user", text: "保留下來" });
    firstStore.close();

    const reopenedStore = new MessageStore(databasePath);
    try {
      assert.equal(reopenedStore.list()[0]?.text, "保留下來");
    } finally {
      reopenedStore.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 v1 資料庫可連續遷移到 v4，保留既有資料與 seq，並允許寫入 Core 系統通知。
test("migrates a populated v1 database to v4 without changing sequence numbers", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-message-migration-"));
  const databasePath = join(directory, "messages.sqlite");
  try {
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('user', 'alice')),
        text TEXT NOT NULL,
        client_id TEXT,
        mode TEXT CHECK (mode IS NULL OR mode IN ('work', 'chat')),
        client_msg_id TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      INSERT INTO messages (seq, id, role, text, created_at)
      VALUES (7, 'legacy-user', 'user', '舊訊息', '2026-09-29T00:00:00Z');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const store = new MessageStore(databasePath);
    const system = store.append({ role: "system", text: "遷移完成" });
    assert.deepEqual(store.list().map((message) => [message.seq, message.role, message.text]), [
      [8, "system", "遷移完成"],
      [7, "user", "舊訊息"],
    ]);
    store.close();

    const inspected = new Database(databasePath, { readonly: true });
    assert.equal(inspected.pragma("user_version", { simple: true }), 4);
    inspected.close();
    assert.equal(system.seq, 8);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試已存在資料的 v2 資料庫會在交易中新增頻道與用量表並升至 v4，避免升級時遺失主對話。
test("migrates v2 to v4 and preserves existing messages", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-message-v3-migration-"));
  const databasePath = join(directory, "messages.sqlite");
  try {
    const legacy = new Database(databasePath);
    legacy.exec(`
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
      INSERT INTO messages (id, role, text, created_at)
      VALUES ('v2-message', 'alice', '保留內容', '2026-09-30T00:00:00Z');
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const store = new MessageStore(databasePath);
    assert.equal(store.list()[0]?.text, "保留內容");
    store.close();
    const inspected = new Database(databasePath, { readonly: true });
    assert.equal(inspected.pragma("user_version", { simple: true }), 4);
    assert.deepEqual(
      (inspected.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'channel%'").all() as Array<{ name: string }>)
        .map((row) => row.name).sort(),
      ["channel_messages", "channels"],
    );
    inspected.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試已有頻道資料的 v3 資料庫只新增 usage 表並升至 v4，既有訊息與頻道都必須保留。
test("migrates v3 to v4 and preserves existing data", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-message-v4-migration-"));
  const databasePath = join(directory, "messages.sqlite");
  try {
    const legacy = new Database(databasePath);
    legacy.exec(`
      CREATE TABLE messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL, text TEXT NOT NULL, client_id TEXT, mode TEXT,
        client_msg_id TEXT UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE channels (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT NOT NULL, role TEXT NOT NULL,
        worker_session_id TEXT, status TEXT NOT NULL, rounds INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, seq INTEGER NOT NULL,
        author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE (channel_id, seq)
      );
      INSERT INTO messages (id, role, text, created_at) VALUES ('m1', 'user', '保留訊息', '2026-09-30T00:00:00Z');
      INSERT INTO channels VALUES ('c1', '保留頻道', 'p', 'r', NULL, 'closed', 1, '2026-09-30T00:00:00Z', '2026-09-30T00:00:00Z');
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const store = new MessageStore(databasePath);
    assert.equal(store.list()[0]?.text, "保留訊息");
    store.close();
    const inspected = new Database(databasePath, { readonly: true });
    assert.equal(inspected.pragma("user_version", { simple: true }), 4);
    assert.equal((inspected.prepare("SELECT title FROM channels WHERE id = 'c1'").get() as { title: string }).title, "保留頻道");
    assert.equal((inspected.prepare("SELECT COUNT(*) AS count FROM usage").get() as { count: number }).count, 0);
    inspected.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
