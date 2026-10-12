import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type UsageKind = "alice" | "worker" | "codex";
export type UsageRefType = "message" | "channel" | "task";

export type UsageRecord = {
  id: string;
  ts: string;
  kind: UsageKind;
  refType: UsageRefType;
  refId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  durationMs: number;
  attempts: number;
};

export type AppendUsageInput = Omit<UsageRecord, "id" | "ts"> & { ts?: string };

export type UsageSummary = {
  kind: UsageKind;
  refType: UsageRefType | "date";
  refId: string;
  title: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number;
  attempts: number;
  time: string;
};

type UsageRow = {
  id: string; ts: string; kind: UsageKind; ref_type: UsageRefType; ref_id: string; model: string;
  input_tokens: number; output_tokens: number; cache_read_input_tokens: number;
  cache_creation_input_tokens: number; reasoning_tokens: number; duration_ms: number; attempts: number;
};

function toRecord(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    refType: row.ref_type,
    refId: row.ref_id,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadInputTokens: row.cache_read_input_tokens,
    cacheCreationInputTokens: row.cache_creation_input_tokens,
    reasoningTokens: row.reasoning_tokens,
    durationMs: row.duration_ms,
    attempts: row.attempts,
  };
}

function nonnegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export class UsageStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
  }

  append(input: AppendUsageInput): UsageRecord {
    const record: UsageRecord = {
      ...input,
      id: randomUUID(),
      ts: input.ts ?? new Date().toISOString(),
      inputTokens: nonnegativeInteger(input.inputTokens),
      outputTokens: nonnegativeInteger(input.outputTokens),
      cacheReadInputTokens: nonnegativeInteger(input.cacheReadInputTokens),
      cacheCreationInputTokens: nonnegativeInteger(input.cacheCreationInputTokens),
      reasoningTokens: nonnegativeInteger(input.reasoningTokens),
      durationMs: nonnegativeInteger(input.durationMs),
      attempts: nonnegativeInteger(input.attempts),
    };
    this.#db.prepare(`
      INSERT INTO usage (
        id, ts, kind, ref_type, ref_id, model, input_tokens, output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens, reasoning_tokens, duration_ms, attempts
      ) VALUES (
        @id, @ts, @kind, @refType, @refId, @model, @inputTokens, @outputTokens,
        @cacheReadInputTokens, @cacheCreationInputTokens, @reasoningTokens, @durationMs, @attempts
      )
    `).run(record);
    return record;
  }

  /** 指定工作（頻道、任務）的全部用量紀錄（計畫報告用）。 */
  listByRefIds(refIds: readonly string[]): UsageRecord[] {
    if (refIds.length === 0) return [];
    const placeholders = refIds.map(() => "?").join(", ");
    return (this.#db.prepare(`SELECT * FROM usage WHERE ref_id IN (${placeholders}) ORDER BY ts, rowid`)
      .all(...refIds) as UsageRow[]).map(toRecord);
  }

  list(limit = 100): UsageRecord[] {
    const capped = Math.min(1_000, Math.max(1, Math.trunc(limit)));
    return (this.#db.prepare("SELECT * FROM usage ORDER BY ts DESC, rowid DESC LIMIT ?")
      .all(capped) as UsageRow[]).map(toRecord);
  }

  summaries(limit = 10): UsageSummary[] {
    const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
    // channels／tasks 表由其他模組建立；未啟用時不存在，改用空表以免彙總失敗。
    const channelsTable = this.#hasTable("channels") ? "channels" : "(SELECT NULL AS id, NULL AS title WHERE 0)";
    const tasksTable = this.#hasTable("tasks") ? "tasks" : "(SELECT NULL AS id, NULL AS goal WHERE 0)";
    const rows = this.#db.prepare(`
      WITH per_ref AS (
        SELECT
          kind, ref_type, ref_id, MAX(ts) AS time,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_input_tokens) AS cache_read_input_tokens,
          SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
          SUM(reasoning_tokens) AS reasoning_tokens,
          MAX(duration_ms) AS duration_ms,
          MAX(attempts) AS attempts
        FROM usage
        GROUP BY kind, ref_type, ref_id
      ), work AS (
        SELECT
          p.kind AS kind,
          CASE WHEN p.kind = 'alice' THEN 'date' ELSE p.ref_type END AS ref_type,
          CASE WHEN p.kind = 'alice' THEN substr(p.time, 1, 10) ELSE p.ref_id END AS ref_id,
          CASE
            WHEN p.kind = 'alice' THEN '一般回覆（' || substr(p.time, 1, 10) || '）'
            WHEN p.kind = 'worker' THEN COALESCE(c.title, '工作頻道 ' || substr(p.ref_id, 1, 8))
            ELSE COALESCE(t.goal, 'Codex 任務 ' || substr(p.ref_id, 1, 8))
          END AS title,
          SUM(p.input_tokens) AS input_tokens,
          SUM(p.output_tokens) AS output_tokens,
          SUM(p.cache_read_input_tokens) AS cache_read_input_tokens,
          SUM(p.cache_creation_input_tokens) AS cache_creation_input_tokens,
          SUM(p.reasoning_tokens) AS reasoning_tokens,
          SUM(p.duration_ms) AS duration_ms,
          SUM(p.attempts) AS attempts,
          MAX(p.time) AS time
        FROM per_ref p
        LEFT JOIN ${channelsTable} c ON p.kind = 'worker' AND c.id = p.ref_id
        LEFT JOIN ${tasksTable} t ON p.kind = 'codex' AND t.id = p.ref_id
        GROUP BY
          p.kind,
          CASE WHEN p.kind = 'alice' THEN substr(p.time, 1, 10) ELSE p.ref_id END
      )
      SELECT * FROM work ORDER BY time DESC LIMIT ?
    `).all(capped) as Array<{
      kind: UsageKind; ref_type: UsageRefType | "date"; ref_id: string; title: string;
      input_tokens: number; output_tokens: number; cache_read_input_tokens: number;
      cache_creation_input_tokens: number; reasoning_tokens: number; duration_ms: number;
      attempts: number; time: string;
    }>;
    return rows.map((row) => ({
      kind: row.kind,
      refType: row.ref_type,
      refId: row.ref_id,
      title: row.title,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadInputTokens: row.cache_read_input_tokens,
      cacheCreationInputTokens: row.cache_creation_input_tokens,
      reasoningTokens: row.reasoning_tokens,
      totalTokens: row.input_tokens + row.output_tokens,
      durationMs: row.duration_ms,
      attempts: row.attempts,
      time: row.time,
    }));
  }

  #hasTable(name: string): boolean {
    return this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  close(): void {
    this.#db.close();
  }
}
