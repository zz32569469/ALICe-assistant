// 進度確認：同事回報做完時，任務「完成」與換階段不直接改，先給主人一張確認卡片（並跳桌面通知），主人確認後才更新。
// 其他變更（新增任務、進行中、卡住、備註…）照舊直接套用。保留的部分存在本機資料庫，Core 重啟後卡片還在。

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { GameBlock, TaskOp } from "./gameBlock.js";
import type { Game, GameTask } from "./gameStore.js";
import { stageIn, trackLabel, workflow } from "./workflow.js";

export type GameConfirmation = {
  id: string;
  gameName: string;
  /** 給主人看的變更，一項一行。 */
  lines: string[];
  reason: string;
  createdAt: string;
};

type Row = { id: string; game_name: string; block: string; lines: string; reason: string; created_at: string };

const toConfirmation = (row: Row): GameConfirmation => ({
  id: row.id, gameName: row.game_name, lines: JSON.parse(row.lines) as string[], reason: row.reason, createdAt: row.created_at,
});

/**
 * 把區塊拆成「直接套用」與「等主人確認」兩份。等確認：update 的任一條線換階段、任務改成「完成」。
 * create 不拆（建卡時的階段是起點）。held 是 null 表示沒有要確認的。
 */
export function splitForConfirmation(block: GameBlock, game: Game | undefined, tasks: GameTask[]): { direct: GameBlock | null; held: GameBlock | null; lines: string[] } {
  if (block.action !== "update" || game === undefined) return { direct: block, held: null, lines: [] };
  const heldFields: GameBlock["fields"] = {};
  const directFields: GameBlock["fields"] = { ...block.fields };
  const lines: string[] = [];
  // 開新版本時各條線一起移回對應階段，是主人說了才做的，不另外確認。
  if (block.fields.version !== undefined && block.fields.version !== game.version) return { direct: block, held: null, lines: [] };
  const changed: Record<string, string> = {};
  for (const track of workflow().tracks) {
    const next = block.fields.trackStages?.[track.key];
    const before = stageIn(game.trackStages, track);
    if (next !== undefined && next !== before) {
      changed[track.key] = next;
      lines.push(`${track.label}：${before} → ${next}`);
    }
  }
  delete directFields.trackStages;
  if (Object.keys(changed).length > 0) heldFields.trackStages = changed;
  const heldTasks: TaskOp[] = [];
  const directTasks: TaskOp[] = [];
  for (const op of block.tasks) {
    const before = op.op === "update" ? tasks.find((task) => task.number === op.number) : undefined;
    if (op.op === "update" && op.fields.status === "完成" && before !== undefined && before.status !== "完成") {
      heldTasks.push(op);
      lines.push(`T${before.number} ${before.title}〔${trackLabel(before.track)}〕：${before.status} → 完成${op.fields.note ? `（${op.fields.note}）` : ""}`);
    } else directTasks.push(op);
  }
  const held = lines.length === 0 ? null : { action: "update" as const, name: game.name, fields: heldFields, tasks: heldTasks, ...(block.reason ? { reason: block.reason } : {}) };
  const direct = Object.keys(directFields).length === 0 && directTasks.length === 0 ? null : { ...block, fields: directFields, tasks: directTasks };
  return { direct, held, lines };
}

export class GameConfirmationStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS game_confirmations (
        id TEXT PRIMARY KEY,
        game_name TEXT NOT NULL,
        block TEXT NOT NULL,
        lines TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        decision TEXT
      );
    `);
  }

  add(block: GameBlock, lines: string[], at = new Date().toISOString()): GameConfirmation {
    const id = randomUUID();
    this.#db.prepare("INSERT INTO game_confirmations (id, game_name, block, lines, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, block.name, JSON.stringify(block), JSON.stringify(lines), block.reason ?? "", at);
    return this.get(id)!;
  }

  get(id: string): GameConfirmation | undefined {
    const row = this.#db.prepare("SELECT * FROM game_confirmations WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toConfirmation(row);
  }

  /** 還沒處理的保留區塊；已處理或不存在回傳 undefined。 */
  pendingBlock(id: string): { confirmation: GameConfirmation; block: GameBlock } | undefined {
    const row = this.#db.prepare("SELECT * FROM game_confirmations WHERE id = ? AND resolved_at IS NULL").get(id) as Row | undefined;
    return row === undefined ? undefined : { confirmation: toConfirmation(row), block: JSON.parse(row.block) as GameBlock };
  }

  pending(): GameConfirmation[] {
    return (this.#db.prepare("SELECT * FROM game_confirmations WHERE resolved_at IS NULL ORDER BY created_at").all() as Row[]).map(toConfirmation);
  }

  resolve(id: string, decision: "approve" | "reject", at = new Date().toISOString()): void {
    this.#db.prepare("UPDATE game_confirmations SET resolved_at = ?, decision = ? WHERE id = ?").run(at, decision, id);
  }

  close(): void {
    this.#db.close();
  }
}
