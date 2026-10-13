// ALICE_GAME 區塊：艾莉絲在對話中建立、修改專案卡。

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { ALICE_BLOCK_MARKERS } from "../tasks/aliceBlockFilter.js";
import { TASK_STATUSES, isFinished, stageSummary, type Game, type GameFields, type GameStore, type GameTaskFields } from "./gameStore.js";
import { resolveStage, stageIn, taskTracks, trackLabel, trackOf, workflow } from "./workflow.js";

/** 任務操作。add 新增；update 用 id（T3 或 3）改狀態、標題、負責、備註。 */
export type TaskOp = { op: "add"; fields: GameTaskFields & { title: string } } | { op: "update"; number: number; fields: GameTaskFields };

/** reason：換階段、任務完成時給主人看的依據（不存進卡片）。 */
export type GameBlock = { action: "create" | "update"; name: string; fields: GameFields; tasks: TaskOp[]; reason?: string };

const MAX_TASK_OPS = 30;

function choice(value: unknown, options: readonly string[], key: string): string {
  if (typeof value !== "string" || !options.includes(value.trim())) throw new Error(`${key} 必須是以下其中之一：${options.join("、")}`);
  return value.trim();
}

function parseTaskOps(value: unknown): TaskOp[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tasks 必須是陣列");
  if (value.length > MAX_TASK_OPS) throw new Error(`一次最多 ${MAX_TASK_OPS} 個任務操作`);
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`tasks[${index}] 必須是物件`);
    const entry = raw as Record<string, unknown>;
    const fields: GameTaskFields = {};
    if (entry.title !== undefined) fields.title = text(entry.title, `tasks[${index}].title`, 120);
    if (entry.track !== undefined) fields.track = choice(entry.track, taskTracks(), `tasks[${index}].track`);
    if (entry.status !== undefined) fields.status = choice(entry.status, TASK_STATUSES, `tasks[${index}].status`) as GameTaskFields["status"];
    if (entry.source !== undefined) fields.source = choice(entry.source, workflow().taskSources, `tasks[${index}].source`);
    if (entry.note !== undefined) fields.note = text(entry.note, `tasks[${index}].note`, 300);
    if (entry.op === "add") {
      if (fields.title === undefined || fields.title === "") throw new Error(`tasks[${index}] 新增任務要有 title`);
      return { op: "add", fields: { ...fields, title: fields.title } };
    }
    if (entry.op === "update") {
      const id = typeof entry.id === "number" ? String(entry.id) : typeof entry.id === "string" ? entry.id.trim() : "";
      const match = /^T?(\d+)$/iu.exec(id);
      if (match === null) throw new Error(`tasks[${index}].id 必須是任務編號，例如 T3`);
      return { op: "update", number: Number(match[1]), fields };
    }
    throw new Error(`tasks[${index}].op 必須是 add 或 update`);
  });
}

function stripMarkers(text: string): string {
  const { start, end } = ALICE_BLOCK_MARKERS.game;
  return text.replace(start, "").replace(end, "").trim();
}

/** stages：{"<線的 key>":"<階段>"}；只有一條線時也可以寫 stage。 */
function parseStages(value: Record<string, unknown>): Record<string, string> | undefined {
  const raw: Record<string, unknown> = {};
  if (value.stage !== undefined) raw[workflow().tracks[0]!.key] = value.stage;
  if (value.stages !== undefined) {
    if (typeof value.stages !== "object" || value.stages === null || Array.isArray(value.stages)) throw new Error("stages 必須是物件，例如 {\"main\":\"進行中\"}");
    Object.assign(raw, value.stages);
  }
  if (Object.keys(raw).length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const [key, stage] of Object.entries(raw)) {
    const track = trackOf(key);
    if (track === undefined) throw new Error(`stages 的 key 必須是：${workflow().tracks.map((entry) => entry.key).join("、")}`);
    const found = typeof stage === "string" ? resolveStage(track, stage) : undefined;
    if (found === undefined) throw new Error(`stages.${key} 必須是以下其中之一：${track.stages.join("、")}`);
    result[key] = found;
  }
  return result;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function stringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    throw new Error(`${key} 必須是非空白字串陣列`);
  }
  return value.map((entry: string) => entry.trim());
}

function text(value: unknown, key: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${key} 必須是字串`);
  if (Array.from(value).length > max) throw new Error(`${key} 最多 ${max} 字`);
  return value.trim();
}

export function parseGameBlock(blockText: string): GameBlock {
  let raw: unknown;
  try {
    raw = JSON.parse(stripMarkers(blockText));
  } catch (error) {
    throw new Error(`專案卡區塊不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("專案卡區塊必須是 JSON 物件");
  const value = raw as Record<string, unknown>;
  if (value.action !== "create" && value.action !== "update") throw new Error("action 必須是 create 或 update");
  const name = text(value.name, "name", 40);
  if (name === "") throw new Error("name 不可空白");
  const fields: GameFields = {};
  if (value.newName !== undefined) fields.name = text(value.newName, "newName", 40);
  if (value.code !== undefined) {
    fields.code = text(value.code, "code", 60);
    if (fields.code !== "" && !/^[A-Za-z0-9_.-]+$/u.test(fields.code)) throw new Error("code 只能有英文、數字、底線、點、連字號");
  }
  if (value.brand !== undefined) fields.brand = text(value.brand, "brand", 40);
  if (value.docsDir !== undefined) fields.docsDir = value.docsDir === null ? null : text(value.docsDir, "docsDir", 400);
  if (value.filePrefix !== undefined) fields.filePrefix = text(value.filePrefix, "filePrefix", 60);
  if (value.spec !== undefined) fields.spec = text(value.spec, "spec", 400);
  if (value.reference !== undefined) fields.reference = text(value.reference, "reference", 200);
  if (value.note !== undefined) fields.note = text(value.note, "note", 500);
  if (value.deadline !== undefined) {
    if (value.deadline === null || value.deadline === "") fields.deadline = null;
    else if (typeof value.deadline === "string" && validDate(value.deadline)) fields.deadline = value.deadline;
    else throw new Error("deadline 必須是 YYYY-MM-DD 或 null");
  }
  const stages = parseStages(value);
  if (stages !== undefined) fields.trackStages = stages;
  if (value.version !== undefined) {
    fields.version = text(value.version, "version", 20);
    if (!/^\d+(\.\d+){1,3}$/u.test(fields.version)) throw new Error("version 必須是用點分開的數字，例如 1.0.1");
  }
  if (value.versionReason !== undefined) fields.versionReason = text(value.versionReason, "versionReason", 300);
  if (value.sections !== undefined) fields.sections = value.sections === null ? null : stringList(value.sections, "sections");
  if (value.repos !== undefined) fields.repos = stringList(value.repos, "repos");
  if (value.sessions !== undefined) fields.sessions = stringList(value.sessions, "sessions");
  // §93：凍結／解凍；frozen 寫 true 時 Core 填上時間。
  if (value.frozen !== undefined) {
    if (typeof value.frozen !== "boolean") throw new Error("frozen 必須是 true 或 false");
    fields.frozenAt = value.frozen ? "" : null;
    fields.frozenReason = value.frozen && value.frozenReason !== undefined ? text(value.frozenReason, "frozenReason", 200) : "";
  }
  const reason = value.reason === undefined ? undefined : text(value.reason, "reason", 300);
  return { action: value.action, name, fields, tasks: parseTaskOps(value.tasks), ...(reason ? { reason } : {}) };
}

function describe(game: Game): string {
  return `${game.name}（${stageSummary(game)}${game.deadline === null ? "" : `，截止 ${game.deadline}`}${game.frozenAt === null ? "" : "，凍結中"}）`;
}

/** 兩個時間相差幾個日曆天（本機時區）。 */
function calendarDays(from: Date, to: Date): number {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/** YYYY-MM-DD 加幾天。 */
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export const compareVersion = (left: string, right: string): number => {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

/** 套用區塊，回傳給主人看的系統訊息。knownRepos 是本機設定的 projects[].name。 */
export function applyGameBlock(store: GameStore, blockText: string, knownRepos: string[], now = new Date()): string {
  let block: GameBlock;
  try {
    block = parseGameBlock(blockText);
  } catch (error) {
    return `專案卡未更新：${error instanceof Error ? error.message : String(error)}`;
  }
  return applyParsedGameBlock(store, block, knownRepos, now);
}

/** 套用已解析的區塊（主人確認後套用保留的部分也走這裡）。 */
export function applyParsedGameBlock(store: GameStore, block: GameBlock, knownRepos: string[], now = new Date()): string {
  const unknown = (block.fields.repos ?? []).filter((repo) => !knownRepos.includes(repo));
  if (unknown.length > 0) {
    return `專案卡未更新：repos 只能用本機設定裡的專案名稱（${knownRepos.join("、") || "目前沒有"}），不認得：${unknown.join("、")}`;
  }
  if (block.fields.docsDir != null) {
    block.fields.docsDir = isAbsolute(block.fields.docsDir) ? resolve(block.fields.docsDir) : block.fields.docsDir;
  }
  const warnings = block.fields.docsDir != null && !existsSync(block.fields.docsDir) ? `（注意：找不到文件資料夾 ${block.fields.docsDir}）` : "";
  const at = now.toISOString();
  if (block.fields.frozenAt === "") block.fields.frozenAt = at;
  if (block.action === "create") {
    if (store.find(block.name) !== undefined) return `專案卡未建立：已經有「${block.name}」，要改請用 update`;
    const game = store.create({ ...block.fields, name: block.fields.name ?? block.name }, at);
    return `已建立專案卡：${describe(game)}${applyTasks(store, game, block.tasks, at)}${warnings}`;
  }
  const current = store.find(block.name);
  if (current === undefined) return `專案卡未更新：找不到「${block.name}」`;
  if (block.fields.name !== undefined && block.fields.name !== current.name && store.find(block.fields.name) !== undefined) {
    return `專案卡未更新：已經有「${block.fields.name}」`;
  }
  // 新版本只能在上一個版本每條線都完成之後開，而且要寫需求來源。
  if (block.fields.version !== undefined && block.fields.version !== current.version) {
    if (compareVersion(block.fields.version, current.version) <= 0) return `專案卡未更新：新版本 ${block.fields.version} 必須大於目前的 ${current.version}`;
    if (!isFinished(current)) return `專案卡未更新：v${current.version} 還沒完成（每條線都到最後一個階段才能開新版本）`;
    if ((block.fields.versionReason ?? "") === "") return "專案卡未更新：開新版本要寫 versionReason（需求來源）";
  }
  // 已經凍結的再凍結一次：保留原本的凍結時間，只換原因。
  if (block.fields.frozenAt != null && current.frozenAt !== null) block.fields.frozenAt = current.frozenAt;
  // 解凍：凍結幾天，截止日就延後幾天（這次同時改截止日的話照主人給的）。
  let frozenDays = 0;
  if (block.fields.frozenAt === null && current.frozenAt !== null) {
    frozenDays = Math.max(0, calendarDays(new Date(current.frozenAt), now));
    if (current.deadline !== null && block.fields.deadline === undefined && frozenDays > 0) block.fields.deadline = addDays(current.deadline, frozenDays);
  }
  const game = store.update(current.id, block.fields, at)!;
  const changes = [
    block.fields.version !== undefined && block.fields.version !== current.version ? `版本 v${current.version} → v${game.version}` : "",
    current.frozenAt === null && game.frozenAt !== null ? `凍結${game.frozenReason === "" ? "" : `（${game.frozenReason}）`}` : "",
    current.frozenAt !== null && game.frozenAt === null
      ? `解除凍結（凍結 ${frozenDays} 天${game.deadline !== current.deadline && current.deadline !== null && game.deadline !== null ? `，截止日 ${current.deadline} → ${game.deadline}` : ""}）`
      : "",
    ...workflow().tracks.map((track) => {
      const before = stageIn(current.trackStages, track);
      const after = stageIn(game.trackStages, track);
      return after === before ? "" : `${track.label} ${before} → ${after}`;
    }),
  ].filter(Boolean);
  const finished = !isFinished(current) && isFinished(game) ? `；v${game.version} 完成` : "";
  const taskText = applyTasks(store, game, block.tasks, at);
  // 只改任務時訊息以任務為主，不重複整張卡的摘要。
  if (Object.keys(block.fields).length === 0 && taskText !== "") return `${game.name}的任務已更新${taskText}`;
  return `已更新專案卡：${describe(game)}${changes.length === 0 ? "" : `，${changes.join("、")}`}${finished}${taskText}${warnings}`;
}

/** 套用任務操作，回傳附在系統訊息後面的說明（沒有操作時是空字串）。找不到的任務編號會列出來，不影響其他操作。 */
function applyTasks(store: GameStore, game: Game, ops: TaskOp[], at: string): string {
  if (ops.length === 0) return "";
  const lines: string[] = [];
  for (const op of ops) {
    if (op.op === "add") {
      const task = store.addTask(game.id, { ...op.fields, version: op.fields.version ?? game.version }, at);
      lines.push(`新增 T${task.number}〔${trackLabel(task.track)}・${task.status}・${task.source}〕${task.title}`);
      continue;
    }
    const before = store.tasks(game.id).find((task) => task.number === op.number);
    if (before === undefined) {
      lines.push(`找不到 T${op.number}`);
      continue;
    }
    const after = store.updateTask(game.id, op.number, op.fields, at)!;
    const parts = [
      after.status !== before.status ? `${before.status} → ${after.status}` : "",
      after.track !== before.track ? `改由${trackLabel(after.track)}` : "",
      after.title !== before.title ? `改名為「${after.title}」` : "",
      op.fields.note !== undefined && op.fields.note !== "" ? `（${op.fields.note}）` : "",
    ].filter(Boolean);
    lines.push(`T${after.number} ${after.title}${parts.length === 0 ? "：沒有變更" : `：${parts.join("，")}`}`);
  }
  return `\n任務：\n- ${lines.join("\n- ")}`;
}

