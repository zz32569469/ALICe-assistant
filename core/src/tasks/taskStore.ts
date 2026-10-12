import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type TaskStatus =
  | "pending_approval"
  | "approved"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "rejected"
  | "expired";

export type Task = {
  id: string;
  planId: string | null;
  sourceMessageId: string;
  tool: string;
  repo: string;
  repoPath: string;
  goal: string;
  instructions: string;
  acceptance: string[];
  estimateMin: number | null;
  status: TaskStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  startedAt: string | null;
  endedAt: string | null;
  codexThreadId: string | null;
  pid: number | null;
  report: unknown | null;
  reportError: string | null;
  diff: unknown | null;
  mismatch: unknown | null;
  error: string | null;
};

export type CreateTaskInput = Pick<Task,
  "planId" | "sourceMessageId" | "tool" | "repo" | "repoPath" | "goal" |
  "instructions" | "acceptance" | "estimateMin"
> & { createdAt?: string };

type TaskRow = {
  id: string; plan_id: string | null; source_message_id: string; tool: string; repo: string;
  repo_path: string; goal: string; instructions: string; acceptance: string;
  estimate_min: number | null; status: TaskStatus; created_at: string; decided_at: string | null;
  decided_by: string | null; started_at: string | null; ended_at: string | null;
  codex_thread_id: string | null; pid: number | null; report: string | null; report_error: string | null; diff: string | null;
  mismatch: string | null; error: string | null;
};

function parseJson(value: string | null): unknown | null {
  return value === null ? null : JSON.parse(value);
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id, planId: row.plan_id, sourceMessageId: row.source_message_id,
    tool: row.tool, repo: row.repo, repoPath: row.repo_path, goal: row.goal,
    instructions: row.instructions, acceptance: JSON.parse(row.acceptance) as string[],
    estimateMin: row.estimate_min, status: row.status, createdAt: row.created_at,
    decidedAt: row.decided_at, decidedBy: row.decided_by, startedAt: row.started_at,
    endedAt: row.ended_at, codexThreadId: row.codex_thread_id, pid: row.pid,
    report: parseJson(row.report), reportError: row.report_error, diff: parseJson(row.diff), mismatch: parseJson(row.mismatch),
    error: row.error,
  };
}

export class TaskStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        plan_id TEXT,
        source_message_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        repo TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        goal TEXT NOT NULL,
        instructions TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        estimate_min REAL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        started_at TEXT,
        ended_at TEXT,
        codex_thread_id TEXT,
        pid INTEGER,
        report TEXT,
        report_error TEXT,
        diff TEXT,
        mismatch TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
    `);
    const columns = this.#db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "report_error")) {
      this.#db.exec("ALTER TABLE tasks ADD COLUMN report_error TEXT");
    }
  }

  create(input: CreateTaskInput): Task {
    const task: Task = {
      ...input,
      id: randomUUID(),
      status: "pending_approval",
      createdAt: input.createdAt ?? new Date().toISOString(),
      decidedAt: null, decidedBy: null, startedAt: null, endedAt: null,
      codexThreadId: null, pid: null, report: null, reportError: null, diff: null, mismatch: null, error: null,
    };
    this.#db.prepare(`
      INSERT INTO tasks (
        id, plan_id, source_message_id, tool, repo, repo_path, goal, instructions,
        acceptance, estimate_min, status, created_at, decided_at, decided_by,
        started_at, ended_at, codex_thread_id, pid, report, report_error, diff, mismatch, error
      ) VALUES (
        @id, @planId, @sourceMessageId, @tool, @repo, @repoPath, @goal, @instructions,
        @acceptance, @estimateMin, @status, @createdAt, @decidedAt, @decidedBy,
        @startedAt, @endedAt, @codexThreadId, @pid, @report, @reportError, @diff, @mismatch, @error
      )
    `).run({
      ...task,
      acceptance: JSON.stringify(task.acceptance),
      report: null, reportError: null, diff: null, mismatch: null,
    });
    return task;
  }

  get(id: string): Task | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  list(limit = 20): Task[] {
    const capped = Math.min(100, Math.max(1, Math.trunc(limit)));
    return (this.#db.prepare("SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(capped) as TaskRow[]).map(toTask);
  }

  active(): Task | undefined {
    const row = this.#db.prepare(`
      SELECT * FROM tasks WHERE status IN ('pending_approval', 'approved', 'running')
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get() as TaskRow | undefined;
    return row === undefined ? undefined : toTask(row);
  }

  listByStatuses(statuses: TaskStatus[]): Task[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    return (this.#db.prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...statuses) as TaskRow[]).map(toTask);
  }

  update(id: string, patch: Partial<Omit<Task, "id">>): Task {
    const entries = Object.entries(patch);
    if (entries.length === 0) {
      const unchanged = this.get(id);
      if (unchanged === undefined) throw new Error(`Task not found: ${id}`);
      return unchanged;
    }
    const column: Record<string, string> = {
      planId: "plan_id", sourceMessageId: "source_message_id", repoPath: "repo_path",
      estimateMin: "estimate_min", createdAt: "created_at", decidedAt: "decided_at",
      decidedBy: "decided_by", startedAt: "started_at", endedAt: "ended_at",
      codexThreadId: "codex_thread_id",
      reportError: "report_error",
    };
    const values: Record<string, unknown> = { id };
    const assignments = entries.map(([key, value], index) => {
      const parameter = `value${index}`;
      values[parameter] = ["acceptance", "report", "diff", "mismatch"].includes(key) && value !== null
        ? JSON.stringify(value)
        : value;
      return `${column[key] ?? key} = @${parameter}`;
    });
    const result = this.#db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = @id`).run(values);
    if (result.changes === 0) throw new Error(`Task not found: ${id}`);
    return this.get(id)!;
  }

  close(): void {
    this.#db.close();
  }
}
