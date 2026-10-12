// 階段的完成條件：從知識庫角色頁的「大階段」表讀「判定」與「主人決定」欄，只維護在知識庫一處。
// 哪條線讀哪一頁、表格標題、階段對到表格哪一列（#），都寫在流程設定的 track.guide。
// 欄位用表頭名稱找，找不到的欄就當沒有。

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { KnowledgeBaseConfig } from "../localConfig.js";
import { extractSections } from "./progress.js";
import { trackOf } from "./workflow.js";

export type StageGuideEntry = { criteria: string | null; decisions: string | null };
export type StageGuideLookup = (track: string, stage: string) => StageGuideEntry | null;

/** 角色頁裡大階段表的預設標題（track.guide.heading 可以換）。 */
export const DEFAULT_TABLE_HEADING = "大階段";

/** 表格一格轉成純文字：[[頁|顯示]] → 顯示、[[頁]] → 頁、粗體記號拿掉；「—」或空白當沒有。 */
export function cellText(cell: string): string | null {
  const text = cell
    .replace(/\[\[([^\]|]+?)(?:\\?\|([^\]]+))?\]\]/gu, (_match, page: string, label?: string) => (label ?? page.split("#")[0]!.split("/").pop()!))
    .replace(/\*\*/gu, "")
    .trim();
  return text === "" || /^[—–-]+$/u.test(text) ? null : text;
}

/** 把一列 markdown 表格切成格（`\|` 是格內的直線，不是分隔）。 */
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === "\\" && body[index + 1] === "|") {
      current += "\\|";
      index += 1;
    } else if (char === "|") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/** 讀角色頁大階段表：# → 判定、主人決定。 */
export function parseStageTable(source: string, heading = DEFAULT_TABLE_HEADING): Map<string, StageGuideEntry> {
  const rows = new Map<string, StageGuideEntry>();
  const section = extractSections(source, (title) => title.trim() === heading)[0];
  if (section === undefined) return rows;
  const lines = section.text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim().startsWith("|"));
  if (start < 0) return rows;
  const header = splitRow(lines[start]!);
  const numberAt = header.indexOf("#");
  const criteriaAt = header.indexOf("判定");
  // 知識庫內文用「使用者」，欄名可能是「使用者決定」或「主人決定」。
  const decisionsAt = header.findIndex((name) => name === "使用者決定" || name === "主人決定");
  if (numberAt < 0) return rows;
  for (const line of lines.slice(start + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = splitRow(line);
    const number = cells[numberAt]?.trim();
    if (number === undefined || number === "") continue;
    rows.set(number, {
      criteria: criteriaAt < 0 ? null : cellText(cells[criteriaAt] ?? ""),
      decisions: decisionsAt < 0 ? null : cellText(cells[decisionsAt] ?? ""),
    });
  }
  return rows;
}

/** 角色頁有改才重讀（看修改時間與大小）。 */
export class StageGuide {
  readonly #knowledgeBase: KnowledgeBaseConfig | null;
  readonly #cache = new Map<string, { key: string; rows: Map<string, StageGuideEntry> }>();

  constructor(knowledgeBase: KnowledgeBaseConfig | null) {
    this.#knowledgeBase = knowledgeBase;
  }

  lookup: StageGuideLookup = (trackKey, stage) => {
    const guide = trackOf(trackKey)?.guide;
    const number = guide?.rows[stage];
    if (guide === undefined || number === undefined) return null;
    const entry = this.#rows(guide.page, guide.heading ?? DEFAULT_TABLE_HEADING).get(number);
    if (entry === undefined || (entry.criteria === null && entry.decisions === null)) return null;
    return entry;
  };

  #rows(page: string, heading: string): Map<string, StageGuideEntry> {
    if (this.#knowledgeBase === null) return new Map();
    const path = resolve(this.#knowledgeBase.path, this.#knowledgeBase.rolesDir, page);
    if (!existsSync(path)) return new Map();
    const stat = statSync(path);
    const key = `${stat.mtimeMs}:${stat.size}:${heading}`;
    const cached = this.#cache.get(path);
    if (cached?.key === key) return cached.rows;
    let rows: Map<string, StageGuideEntry>;
    try {
      rows = parseStageTable(readFileSync(path, "utf8"), heading);
    } catch {
      rows = new Map();
    }
    this.#cache.set(path, { key, rows });
    return rows;
  }
}

/** 負責這條線的同事 session：照流程設定 track.sessions 由上往下找第一個符合的（fromStage 表示到這個階段以後才換它）。 */
export function responsibleSession(sessions: string[], trackKey: string, stage: string): string | null {
  const track = trackOf(trackKey);
  if (track === undefined) return null;
  const index = track.stages.indexOf(stage);
  for (const rule of track.sessions ?? []) {
    if (rule.fromStage !== undefined && index < track.stages.indexOf(rule.fromStage)) continue;
    const pattern = new RegExp(rule.pattern, "iu");
    const found = sessions.find((name) => pattern.test(name.trim()));
    if (found !== undefined) return found;
  }
  return null;
}
