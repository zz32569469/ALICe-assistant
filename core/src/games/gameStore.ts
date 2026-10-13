// 專案卡：每個專案一張，存在本機資料庫（不進 git），由對話建立與修改。
// 進度線與階段由流程設定決定（workflow.ts）；卡片記每條線目前在哪個階段。

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import { allFinished, firstStages, stageIn, workflow } from "./workflow.js";

export type Game = {
  id: string;
  name: string;
  /** 英文代號（分支名用）。 */
  code: string;
  /** 品牌或分類（選填）。 */
  brand: string;
  /** 專案文件所在資料夾（更改紀錄、待確認檔）。 */
  docsDir: string | null;
  /** 文件檔名前綴；空字串表示資料夾內的 .md 都算。 */
  filePrefix: string;
  spec: string;
  reference: string;
  /** YYYY-MM-DD。 */
  deadline: string | null;
  /** 每條進度線目前的階段（key 是流程設定的 track key）。 */
  trackStages: Record<string, string>;
  /** 目前在做（或已完成）的版本。 */
  version: string;
  /** 這個版本的需求來源（第一版之後的版本才有）。 */
  versionReason: string;
  /** 更改紀錄要讀的段落標題關鍵字；null 用預設（現況、標題含「待」）。 */
  sections: string[] | null;
  /** 本機設定 projects[].name。 */
  repos: string[];
  sessions: string[];
  note: string;
  /** §93：凍結的時間（null＝沒凍結）。凍結的專案不核對進度、不催進度，卡片與任務保留。 */
  frozenAt: string | null;
  frozenReason: string;
  createdAt: string;
  updatedAt: string;
};

export type GameStageEntry = { track: string; stage: string; at: string };

/** 任務清單：誰做（進度線的 key，或 owner＝主人）、狀態、需求來源。 */
export const TASK_STATUSES = ["待辦", "進行中", "卡住", "完成", "取消"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export type GameTask = {
  /** 每個專案自己的流水號，顯示成 T1、T2…。 */
  number: number;
  title: string;
  track: string;
  status: TaskStatus;
  source: string;
  /** 哪個版本的工作。 */
  version: string;
  /** 最近一次更新的依據（同事回報、更改紀錄、主人說的）。 */
  note: string;
  createdAt: string;
  updatedAt: string;
};

export type GameTaskFields = Partial<Pick<GameTask, "title" | "track" | "status" | "source" | "version" | "note">>;

export const isOpenTask = (task: Pick<GameTask, "status">): boolean => task.status !== "完成" && task.status !== "取消";

export type GameFields = Partial<Omit<Game, "id" | "createdAt" | "updatedAt">>;

/** 每條線都完成＝目前版本結束。 */
export function isFinished(game: Pick<Game, "trackStages">): boolean {
  return allFinished(game.trackStages);
}

/** §93：進行中＝目前版本還沒完成、也沒凍結（每日核對、更新進度只看這些）。 */
export function isActive(game: Pick<Game, "trackStages" | "frozenAt">): boolean {
  return game.frozenAt === null && !isFinished(game);
}

/** 一行摘要：版本與每條線的階段。 */
export function stageSummary(game: Pick<Game, "trackStages" | "version">): string {
  if (isFinished(game)) return `v${game.version} 完成`;
  return `v${game.version}，${workflow().tracks.map((track) => `${track.label}：${stageIn(game.trackStages, track)}`).join("，")}`;
}

type Row = {
  id: string; name: string; code: string; brand: string; docs_dir: string | null; file_prefix: string; spec: string; reference: string;
  deadline: string | null; track_stages: string | null; version: string; version_reason: string;
  sections: string | null; repos: string; sessions: string; note: string; frozen_at: string | null; frozen_reason: string; created_at: string; updated_at: string;
};

function toGame(row: Row): Game {
  return {
    id: row.id, name: row.name, code: row.code, brand: row.brand, docsDir: row.docs_dir, filePrefix: row.file_prefix, spec: row.spec,
    reference: row.reference, deadline: row.deadline, trackStages: row.track_stages === null ? {} : JSON.parse(row.track_stages) as Record<string, string>,
    version: row.version, versionReason: row.version_reason,
    sections: row.sections === null ? null : JSON.parse(row.sections) as string[],
    repos: JSON.parse(row.repos) as string[], sessions: JSON.parse(row.sessions) as string[], note: row.note,
    frozenAt: row.frozen_at, frozenReason: row.frozen_reason,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export class GameStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        code TEXT NOT NULL,
        docs_dir TEXT,
        file_prefix TEXT NOT NULL,
        spec TEXT NOT NULL,
        reference TEXT NOT NULL,
        deadline TEXT,
        stage TEXT NOT NULL DEFAULT '',
        sections TEXT,
        repos TEXT NOT NULL,
        sessions TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_stages (
        game_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS game_stages_game ON game_stages(game_id, at);
      CREATE TABLE IF NOT EXISTS game_tasks (
        game_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        track TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        version TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (game_id, number)
      );
      CREATE TABLE IF NOT EXISTS alice_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.#migrate();
  }

  /** 補欄位；舊版固定兩條線（stage、adapter_stage 欄，歷史的 track 是 prob、adapter）換成每條線一個階段的對照。 */
  #migrate(): void {
    const columns = (table: string) => (this.#db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
    const games = columns("games");
    if (!games.includes("version")) this.#db.exec("ALTER TABLE games ADD COLUMN version TEXT NOT NULL DEFAULT '1.0.0'");
    if (!games.includes("version_reason")) this.#db.exec("ALTER TABLE games ADD COLUMN version_reason TEXT NOT NULL DEFAULT ''");
    if (!games.includes("brand")) this.#db.exec("ALTER TABLE games ADD COLUMN brand TEXT NOT NULL DEFAULT ''");
    if (!games.includes("frozen_at")) this.#db.exec("ALTER TABLE games ADD COLUMN frozen_at TEXT");
    if (!games.includes("frozen_reason")) this.#db.exec("ALTER TABLE games ADD COLUMN frozen_reason TEXT NOT NULL DEFAULT ''");
    if (!columns("game_stages").includes("track")) this.#db.exec(`ALTER TABLE game_stages ADD COLUMN track TEXT NOT NULL DEFAULT '${workflow().tracks[0]!.key}'`);
    if (!games.includes("track_stages")) {
      this.#db.exec("ALTER TABLE games ADD COLUMN track_stages TEXT");
      const hasSecond = games.includes("adapter_stage");
      const rows = this.#db.prepare(`SELECT id, stage${hasSecond ? ", adapter_stage" : ""} FROM games`).all() as Array<{ id: string; stage: string; adapter_stage?: string }>;
      const update = this.#db.prepare("UPDATE games SET track_stages = ? WHERE id = ?");
      this.#db.transaction(() => {
        for (const row of rows) {
          const legacy: Record<string, string> = row.stage === "" ? {} : { prob: row.stage };
          if (row.adapter_stage) legacy.adapter = row.adapter_stage;
          update.run(JSON.stringify(legacy), row.id);
        }
      })();
    }
  }

  create(fields: GameFields & { name: string }, at = new Date().toISOString()): Game {
    const id = randomUUID();
    const trackStages = { ...firstStages(), ...fields.trackStages };
    this.#db.prepare(`
      INSERT INTO games (id, name, code, brand, docs_dir, file_prefix, spec, reference, deadline, stage, track_stages, version, version_reason,
        sections, repos, sessions, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, fields.name, fields.code ?? "", fields.brand ?? "", fields.docsDir ?? null, fields.filePrefix ?? "", fields.spec ?? "", fields.reference ?? "",
      fields.deadline ?? null, JSON.stringify(trackStages), fields.version ?? workflow().firstVersion, fields.versionReason ?? "",
      fields.sections == null ? null : JSON.stringify(fields.sections),
      JSON.stringify(fields.repos ?? []), JSON.stringify(fields.sessions ?? []), fields.note ?? "", at, at,
    );
    for (const track of workflow().tracks) this.#record(id, track.key, stageIn(trackStages, track), at);
    return this.get(id)!;
  }

  update(id: string, fields: GameFields, at = new Date().toISOString()): Game | undefined {
    const current = this.get(id);
    if (current === undefined) return undefined;
    const next = { ...current, ...fields, trackStages: { ...current.trackStages, ...fields.trackStages } };
    this.#db.prepare(`
      UPDATE games SET name = ?, code = ?, brand = ?, docs_dir = ?, file_prefix = ?, spec = ?, reference = ?, deadline = ?, track_stages = ?,
        version = ?, version_reason = ?, sections = ?, repos = ?, sessions = ?, note = ?, frozen_at = ?, frozen_reason = ?, updated_at = ? WHERE id = ?
    `).run(
      next.name, next.code, next.brand, next.docsDir, next.filePrefix, next.spec, next.reference, next.deadline, JSON.stringify(next.trackStages),
      next.version, next.versionReason,
      next.sections === null ? null : JSON.stringify(next.sections), JSON.stringify(next.repos), JSON.stringify(next.sessions),
      next.note, next.frozenAt, next.frozenAt === null ? "" : next.frozenReason, at, id,
    );
    for (const track of workflow().tracks) {
      const before = stageIn(current.trackStages, track);
      const after = stageIn(next.trackStages, track);
      if (after !== before) this.#record(id, track.key, after, at);
    }
    return this.get(id);
  }

  #record(id: string, track: string, stage: string, at: string): void {
    this.#db.prepare("INSERT INTO game_stages (game_id, stage, at, track) VALUES (?, ?, ?, ?)").run(id, stage, at, track);
  }

  get(id: string): Game | undefined {
    const row = this.#db.prepare("SELECT * FROM games WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toGame(row);
  }

  /** 用名稱或代號找（不分大小寫）。 */
  find(nameOrCode: string): Game | undefined {
    const key = nameOrCode.trim().toLowerCase();
    if (key === "") return undefined;
    return this.list().find((game) => game.name.toLowerCase() === key || (game.code !== "" && game.code.toLowerCase() === key));
  }

  list(): Game[] {
    return (this.#db.prepare("SELECT * FROM games ORDER BY created_at").all() as Row[]).map(toGame);
  }

  stages(id: string): GameStageEntry[] {
    return this.#db.prepare("SELECT track, stage, at FROM game_stages WHERE game_id = ? ORDER BY at, rowid").all(id) as GameStageEntry[];
  }

  tasks(gameId: string): GameTask[] {
    const rows = this.#db.prepare("SELECT * FROM game_tasks WHERE game_id = ? ORDER BY number").all(gameId) as Array<{
      number: number; title: string; track: string; status: TaskStatus; source: string; version: string; note: string; created_at: string; updated_at: string;
    }>;
    return rows.map((row) => ({
      number: row.number, title: row.title, track: row.track, status: row.status, source: row.source, version: row.version, note: row.note,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }));
  }

  addTask(gameId: string, fields: GameTaskFields & { title: string; version: string }, at = new Date().toISOString()): GameTask {
    const next = (this.#db.prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM game_tasks WHERE game_id = ?").get(gameId) as { next: number }).next;
    this.#db.prepare(`
      INSERT INTO game_tasks (game_id, number, title, track, status, source, version, note, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(gameId, next, fields.title, fields.track ?? workflow().tracks[0]!.key, fields.status ?? "待辦", fields.source ?? workflow().taskSources[0]!, fields.version, fields.note ?? "", at, at);
    return this.tasks(gameId).find((task) => task.number === next)!;
  }

  updateTask(gameId: string, number: number, fields: GameTaskFields, at = new Date().toISOString()): GameTask | undefined {
    const current = this.tasks(gameId).find((task) => task.number === number);
    if (current === undefined) return undefined;
    const next = { ...current, ...fields };
    this.#db.prepare(`
      UPDATE game_tasks SET title = ?, track = ?, status = ?, source = ?, version = ?, note = ?, updated_at = ? WHERE game_id = ? AND number = ?
    `).run(next.title, next.track, next.status, next.source, next.version, next.note, at, gameId, number);
    return this.tasks(gameId).find((task) => task.number === number);
  }

  getMeta(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM alice_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO alice_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  close(): void {
    this.#db.close();
  }
}

