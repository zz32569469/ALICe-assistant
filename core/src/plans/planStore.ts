import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type PlanStatus =
  | "pending_approval"
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "cancelled"
  | "rejected"
  | "expired"
  | "failed";

export type PlanItemKind = "read" | "modify" | "review" | "session";
export type PlanItemStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type PlanExecutor = "worker" | "codex" | "claude" | "session";

export type Plan = {
  id: string;
  goal: string;
  status: PlanStatus;
  risks: string[];
  decisions: string[];
  preauthorizeClaudeFallback: boolean;
  sourceMessageId: string;
  pauseReason: string | null;
  pauseDetail: string | null;
  /** 要等這些計畫完成才開始（完整 id，§27 #3）。 */
  afterPlans: string[];
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  endedAt: string | null;
};

export type PlanItem = {
  id: string;
  planId: string;
  seq: number;
  key: string;
  title: string;
  kind: PlanItemKind;
  project: string;
  role: string | null;
  instructions: string;
  acceptance: string[];
  dependsOn: string[];
  risk: "normal" | "high";
  estimateMin: number | null;
  status: PlanItemStatus;
  attempts: number;
  executor: PlanExecutor | null;
  refType: "channel" | "task" | "outbox" | null;
  refId: string | null;
  result: unknown | null;
  error: string | null;
  reviewOf: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type CreatePlanItemInput = Pick<PlanItem,
  "key" | "title" | "kind" | "project" | "role" | "instructions" | "acceptance" | "dependsOn" | "risk" | "estimateMin"
> & { reviewOf?: string | null };

type PlanRow = {
  id: string; goal: string; status: PlanStatus; risks: string; decisions: string;
  preauthorize_claude_fallback: number; source_message_id: string; pause_reason: string | null;
  pause_detail: string | null; created_at: string; decided_at: string | null; decided_by: string | null;
  ended_at: string | null; after_plans: string | null;
};

type ItemRow = {
  id: string; plan_id: string; seq: number; key: string; title: string; kind: PlanItemKind; project: string;
  role: string | null; instructions: string; acceptance: string; depends_on: string; risk: "normal" | "high";
  estimate_min: number | null; status: PlanItemStatus; attempts: number; executor: PlanExecutor | null;
  ref_type: "channel" | "task" | "outbox" | null; ref_id: string | null; result: string | null; error: string | null;
  review_of: string | null; started_at: string | null; ended_at: string | null;
};

function toPlan(row: PlanRow): Plan {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    risks: JSON.parse(row.risks) as string[],
    decisions: JSON.parse(row.decisions) as string[],
    preauthorizeClaudeFallback: row.preauthorize_claude_fallback === 1,
    sourceMessageId: row.source_message_id,
    pauseReason: row.pause_reason,
    pauseDetail: row.pause_detail,
    afterPlans: row.after_plans === null ? [] : JSON.parse(row.after_plans) as string[],
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    endedAt: row.ended_at,
  };
}

function toItem(row: ItemRow): PlanItem {
  return {
    id: row.id,
    planId: row.plan_id,
    seq: row.seq,
    key: row.key,
    title: row.title,
    kind: row.kind,
    project: row.project,
    role: row.role,
    instructions: row.instructions,
    acceptance: JSON.parse(row.acceptance) as string[],
    dependsOn: JSON.parse(row.depends_on) as string[],
    risk: row.risk,
    estimateMin: row.estimate_min,
    status: row.status,
    attempts: row.attempts,
    executor: row.executor,
    refType: row.ref_type,
    refId: row.ref_id,
    result: row.result === null ? null : JSON.parse(row.result),
    error: row.error,
    reviewOf: row.review_of,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

const PLAN_COLUMNS: Record<string, string> = {
  status: "status", pauseReason: "pause_reason", pauseDetail: "pause_detail", decidedAt: "decided_at",
  decidedBy: "decided_by", endedAt: "ended_at", preauthorizeClaudeFallback: "preauthorize_claude_fallback",
};

const ITEM_COLUMNS: Record<string, string> = {
  status: "status", attempts: "attempts", executor: "executor", refType: "ref_type", refId: "ref_id",
  result: "result", error: "error", instructions: "instructions", startedAt: "started_at", endedAt: "ended_at",
};

export class PlanStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        risks TEXT NOT NULL,
        decisions TEXT NOT NULL,
        preauthorize_claude_fallback INTEGER NOT NULL,
        source_message_id TEXT NOT NULL,
        pause_reason TEXT,
        pause_detail TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        ended_at TEXT
      );
      CREATE INDEX IF NOT EXISTS plans_created_at ON plans(created_at DESC);
      CREATE TABLE IF NOT EXISTS plan_items (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id),
        seq INTEGER NOT NULL,
        key TEXT NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        project TEXT NOT NULL,
        role TEXT,
        instructions TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        risk TEXT NOT NULL,
        estimate_min REAL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        executor TEXT,
        ref_type TEXT,
        ref_id TEXT,
        result TEXT,
        error TEXT,
        review_of TEXT,
        started_at TEXT,
        ended_at TEXT,
        UNIQUE (plan_id, key)
      );
      CREATE INDEX IF NOT EXISTS plan_items_plan ON plan_items(plan_id, seq);
    `);
    // §27：跨計畫依賴。舊資料庫補欄位。
    const columns = this.#db.prepare("PRAGMA table_info(plans)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "after_plans")) this.#db.exec("ALTER TABLE plans ADD COLUMN after_plans TEXT");
  }

  create(input: {
    goal: string;
    risks: string[];
    decisions: string[];
    preauthorizeClaudeFallback: boolean;
    sourceMessageId: string;
    items: CreatePlanItemInput[];
    afterPlans?: string[];
    createdAt?: string;
  }): { plan: Plan; items: PlanItem[] } {
    const id = randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.#db.transaction(() => {
      this.#db.prepare(`
        INSERT INTO plans (id, goal, status, risks, decisions, preauthorize_claude_fallback, source_message_id, created_at, after_plans)
        VALUES (?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?)
      `).run(id, input.goal, JSON.stringify(input.risks), JSON.stringify(input.decisions),
        input.preauthorizeClaudeFallback ? 1 : 0, input.sourceMessageId, createdAt, JSON.stringify(input.afterPlans ?? []));
      input.items.forEach((item, index) => this.#insertItem(id, index + 1, item));
    })();
    return { plan: this.get(id)!, items: this.items(id) };
  }

  /** 在指定項目之後插入項目（自動審查用），後面的項目 seq 往後移。 */
  insertAfter(planId: string, afterSeq: number, item: CreatePlanItemInput): PlanItem {
    return this.#db.transaction(() => {
      this.#db.prepare("UPDATE plan_items SET seq = seq + 1 WHERE plan_id = ? AND seq > ?").run(planId, afterSeq);
      const id = this.#insertItem(planId, afterSeq + 1, item);
      return this.item(id)!;
    })();
  }

  get(id: string): Plan | undefined {
    const row = this.#db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
    return row === undefined ? undefined : toPlan(row);
  }

  findByPrefix(prefix: string): Plan | undefined {
    const rows = this.#db.prepare("SELECT * FROM plans WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2")
      .all(`${prefix}%`) as PlanRow[];
    return rows.length === 1 ? toPlan(rows[0]!) : undefined;
  }

  list(limit = 20): Plan[] {
    const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
    return (this.#db.prepare("SELECT * FROM plans ORDER BY created_at DESC LIMIT ?").all(capped) as PlanRow[]).map(toPlan);
  }

  listByStatuses(statuses: PlanStatus[]): Plan[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return (this.#db.prepare(`SELECT * FROM plans WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...statuses) as PlanRow[]).map(toPlan);
  }

  /** 未結束的計畫中最早的一個。 */
  active(): Plan | undefined {
    return this.activeAll()[0];
  }

  /** 所有未結束的計畫（C3 起可同時有多份）。 */
  activeAll(): Plan[] {
    return this.listByStatuses(["pending_approval", "queued", "running", "paused"]);
  }

  items(planId: string): PlanItem[] {
    return (this.#db.prepare("SELECT * FROM plan_items WHERE plan_id = ? ORDER BY seq").all(planId) as ItemRow[])
      .map(toItem);
  }

  item(id: string): PlanItem | undefined {
    const row = this.#db.prepare("SELECT * FROM plan_items WHERE id = ?").get(id) as ItemRow | undefined;
    return row === undefined ? undefined : toItem(row);
  }

  update(id: string, patch: Partial<Pick<Plan, "status" | "pauseReason" | "pauseDetail" | "decidedAt" | "decidedBy" | "endedAt" | "preauthorizeClaudeFallback">>): Plan {
    const entries = Object.entries(patch).filter(([key]) => key in PLAN_COLUMNS);
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${PLAN_COLUMNS[key]} = @${key}`).join(", ");
      const values = Object.fromEntries(entries.map(([key, value]) =>
        [key, typeof value === "boolean" ? (value ? 1 : 0) : value ?? null]));
      this.#db.prepare(`UPDATE plans SET ${sets} WHERE id = @id`).run({ ...values, id });
    }
    const plan = this.get(id);
    if (plan === undefined) throw new Error(`計畫不存在：${id}`);
    return plan;
  }

  updateItem(id: string, patch: Partial<Pick<PlanItem, "status" | "attempts" | "executor" | "refType" | "refId" | "result" | "error" | "instructions" | "startedAt" | "endedAt">>): PlanItem {
    const entries = Object.entries(patch).filter(([key]) => key in ITEM_COLUMNS);
    if (entries.length > 0) {
      const sets = entries.map(([key]) => `${ITEM_COLUMNS[key]} = @${key}`).join(", ");
      const values = Object.fromEntries(entries.map(([key, value]) =>
        [key, key === "result" ? (value === null || value === undefined ? null : JSON.stringify(value)) : value ?? null]));
      this.#db.prepare(`UPDATE plan_items SET ${sets} WHERE id = @id`).run({ ...values, id });
    }
    const item = this.item(id);
    if (item === undefined) throw new Error(`計畫項目不存在：${id}`);
    return item;
  }

  close(): void {
    this.#db.close();
  }

  #insertItem(planId: string, seq: number, item: CreatePlanItemInput): string {
    const id = randomUUID();
    this.#db.prepare(`
      INSERT INTO plan_items (id, plan_id, seq, key, title, kind, project, role, instructions, acceptance, depends_on,
        risk, estimate_min, status, attempts, review_of)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)
    `).run(id, planId, seq, item.key, item.title, item.kind, item.project, item.role, item.instructions,
      JSON.stringify(item.acceptance), JSON.stringify(item.dependsOn), item.risk, item.estimateMin,
      item.reviewOf ?? null);
    return id;
  }
}
