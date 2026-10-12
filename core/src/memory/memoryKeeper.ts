// §85 長期記憶：ALICe 自己整理關於主人的重點，寫進事實檔裡的「ALICe 整理區」（主人手寫的部分不動）。
// 平常聽到值得記的事用 ALICE_MEMORY 區塊先記成筆記；每天整理一次：把新筆記和上次整理後的對話整併進整理區，
// 刪掉過時、重複、沒用的條目，條目數有上限。每次整理前先備份事實檔。整理用 Claude Code 一次性呼叫（訂閱額度）。

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { FortuneInterpreter } from "../fortune/fortuneService.js";
import type { MessageStore } from "../store/messageStore.js";

export const SECTION_START = "<!-- ALICe 整理區：以下由 ALICe 每天整理，主人可以直接改或刪；請不要刪掉這兩行標記 -->";
export const SECTION_END = "<!-- ALICe 整理區結束 -->";
/** 整理區最多幾條。 */
export const MAX_ITEMS = 40;
/** 每天幾點後整理（Core 晚開機也會補）。 */
export const CONSOLIDATE_HOUR = 4;
/** 一次整理最多看幾則對話、每則最多幾字。 */
const MAX_MESSAGES = 150;
const MAX_MESSAGE_CHARS = 400;
const NOTE_MAX_CHARS = 200;

export type MemoryNote = { id: string; text: string; createdAt: string };

/** 事實檔裡整理區的內容；沒有整理區回傳空字串。 */
export function readSection(facts: string): string {
  const start = facts.indexOf(SECTION_START);
  const end = facts.indexOf(SECTION_END);
  if (start < 0 || end < start) return "";
  return facts.slice(start + SECTION_START.length, end).trim();
}

/** 換掉整理區；還沒有整理區就加在檔尾。主人手寫的部分原封不動。 */
export function replaceSection(facts: string, body: string): string {
  const block = `${SECTION_START}\n\n${body.trim()}\n\n${SECTION_END}`;
  const start = facts.indexOf(SECTION_START);
  const end = facts.indexOf(SECTION_END);
  if (start >= 0 && end > start) return `${facts.slice(0, start)}${block}${facts.slice(end + SECTION_END.length)}`;
  return `${facts.replace(/\s*$/u, "")}\n\n## ALICe 記住的事\n\n${block}\n`;
}

const countItems = (body: string): number => body.split(/\r?\n/u).filter((line) => /^\s*[-*]\s+\S/u.test(line)).length;

export function consolidatePrompt(input: { handWritten: string; section: string; notes: MemoryNote[]; transcript: string[]; today: string }): string {
  return [
    `今天是 ${input.today}。請整理「ALICe 記住的事」：這是你對主人的長期記憶，每次對話都會帶給你。`,
    "",
    "主人手寫的事實檔（只供參考，不要重複寫進整理區）：",
    input.handWritten.trim() === "" ? "（空）" : input.handWritten.trim(),
    "",
    "目前的整理區：",
    input.section === "" ? "（空）" : input.section,
    "",
    "這段期間你記下的筆記（主人要你記住的、你覺得重要的）：",
    input.notes.length === 0 ? "（沒有）" : input.notes.map((note) => `- ${localDate(new Date(note.createdAt))}：${note.text}`).join("\n"),
    "",
    "上次整理後的對話（舊到新，已截短）：",
    input.transcript.length === 0 ? "（沒有）" : input.transcript.join("\n"),
    "",
    "規則：",
    "- 只記對以後有幫助、長期成立的事：主人的偏好、習慣、喜好與討厭的事、做事方式、重要的個人背景、主人明確要你記住的事。",
    "- 不記：專案進度、任務、截止日、會議（這些有專案卡）、一次性的閒聊內容、你的推測、密碼與帳號等敏感資料。",
    "- 筆記裡主人明確要你記住的事一定要保留（除非後來的對話推翻它）。",
    "- 合併重複的、更新改變了的、刪掉過時或沒用的；和主人手寫內容重複的不寫。",
    `- 最多 ${MAX_ITEMS} 條，每條一行、簡短具體，用「- 」開頭；可以用「### 分類」分組（例：偏好、習慣、生活、工作方式）。必要時在句尾用括號標日期，例如（2026-10）。`,
    "",
    '只輸出一個 JSON（不要程式碼區塊）：{"section":"整理區的新內容（Markdown）","added":["新增的條目"],"removed":["刪掉的條目與一句原因"]}',
  ].join("\n");
}

export function parseConsolidation(text: string): { section: string; added: string[]; removed: string[] } {
  const json = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
  const value = JSON.parse(json) as { section?: unknown; added?: unknown; removed?: unknown };
  if (typeof value.section !== "string") throw new Error("缺少 section");
  const list = (entry: unknown): string[] => (Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : []);
  if (countItems(value.section) > MAX_ITEMS) throw new Error(`整理區超過 ${MAX_ITEMS} 條`);
  return { section: value.section.trim(), added: list(value.added), removed: list(value.removed) };
}

export class MemoryKeeper {
  readonly #db: Database.Database;
  readonly #factsPath: string;
  readonly #backupDir: string;
  readonly #messages: MessageStore;
  readonly #interpret: FortuneInterpreter;
  readonly #now: () => Date;
  #running = false;

  constructor(options: { dbPath: string; factsPath: string; backupDir: string; messages: MessageStore; interpret: FortuneInterpreter; now?: () => Date }) {
    this.#db = new Database(options.dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS memory_notes (id TEXT PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.#factsPath = options.factsPath;
    this.#backupDir = options.backupDir;
    this.#messages = options.messages;
    this.#interpret = options.interpret;
    this.#now = options.now ?? (() => new Date());
  }

  /** ALICE_MEMORY 區塊：{"note":"要記住的事"}。回傳給對話的系統訊息。 */
  applyBlock(blockText: string, markers: { start: string; end: string }): string {
    let body: unknown;
    try {
      body = JSON.parse(blockText.replace(markers.start, "").replace(markers.end, "").trim());
    } catch {
      return "記憶區塊不是 JSON，沒有記下。";
    }
    const note = typeof body === "object" && body !== null ? (body as { note?: unknown }).note : undefined;
    if (typeof note !== "string" || note.trim() === "") return "記憶區塊要寫 note，沒有記下。";
    const text = Array.from(note.trim()).slice(0, NOTE_MAX_CHARS).join("");
    this.#db.prepare("INSERT INTO memory_notes (id, text, created_at) VALUES (?, ?, ?)").run(randomUUID(), text, this.#now().toISOString());
    return `ALICe 記下了：${text}（每天整理時寫進事實檔）`;
  }

  pendingNotes(): MemoryNote[] {
    return (this.#db.prepare("SELECT id, text, created_at FROM memory_notes WHERE consumed_at IS NULL ORDER BY created_at").all() as Array<{ id: string; text: string; created_at: string }>)
      .map((row) => ({ id: row.id, text: row.text, createdAt: row.created_at }));
  }

  /** 今天該整理了：過了 4 點、今天還沒整理過、而且上次整理後有新對話或筆記。 */
  due(now = this.#now()): boolean {
    if (now.getHours() < CONSOLIDATE_HOUR) return false;
    if (this.#meta("date") === localDate(now)) return false;
    return this.pendingNotes().length > 0 || this.#messages.conversationSince(this.#lastSeq(), 1).length > 0;
  }

  /** 每分鐘檢查一次，該整理就整理（同時只跑一個）。 */
  async tick(): Promise<string | undefined> {
    if (this.#running || !this.due()) return undefined;
    return this.consolidate();
  }

  /** 整理一次，回傳給對話的系統訊息；沒有新東西時回傳 undefined。失敗時事實檔不變。 */
  async consolidate(): Promise<string | undefined> {
    if (this.#running) return undefined;
    this.#running = true;
    try {
      const now = this.#now();
      const notes = this.pendingNotes();
      const recent = this.#messages.conversationSince(this.#lastSeq(), MAX_MESSAGES);
      this.#setMeta("date", localDate(now));
      if (notes.length === 0 && recent.length === 0) return undefined;
      const facts = existsSync(this.#factsPath) ? readFileSync(this.#factsPath, "utf8") : "";
      const section = readSection(facts);
      const handWritten = section === "" ? facts : facts.slice(0, facts.indexOf(SECTION_START));
      const transcript = recent.filter((message) => !/^［來自 session〈/u.test(message.text)).map((message) => `${message.role === "alice" ? "ALICe" : "主人"}${message.thread === "chat" ? "（聊天）" : ""}：${Array.from(message.text.replace(/\s+/gu, " ")).slice(0, MAX_MESSAGE_CHARS).join("")}`);
      let result: ReturnType<typeof parseConsolidation>;
      try {
        result = parseConsolidation(await this.#interpret(
          consolidatePrompt({ handWritten, section, notes, transcript, today: localDate(now) }),
          "你是 ALICe，正在整理自己對主人的長期記憶。只輸出要求的 JSON。",
        ));
      } catch (error) {
        return `記憶整理失敗，事實檔沒有改：${error instanceof Error ? error.message : String(error)}`;
      }
      mkdirSync(this.#backupDir, { recursive: true });
      if (existsSync(this.#factsPath)) copyFileSync(this.#factsPath, resolve(this.#backupDir, `facts-${localDate(now)}-${now.getTime()}.md`));
      mkdirSync(dirname(this.#factsPath), { recursive: true });
      writeFileSync(this.#factsPath, replaceSection(facts, result.section));
      const consumedAt = now.toISOString();
      for (const note of notes) this.#db.prepare("UPDATE memory_notes SET consumed_at = ? WHERE id = ?").run(consumedAt, note.id);
      const lastSeq = recent.reduce((max, message) => Math.max(max, message.seq), this.#lastSeq());
      this.#setMeta("lastSeq", String(lastSeq));
      const lines = [
        `ALICe 整理了記憶（事實檔的「ALICe 記住的事」，共 ${countItems(result.section)} 條）`,
        ...result.added.slice(0, 10).map((item) => `＋ ${item}`),
        ...result.removed.slice(0, 10).map((item) => `－ ${item}`),
      ];
      if (result.added.length === 0 && result.removed.length === 0) lines.push("沒有新增或刪除。");
      return lines.join("\n");
    } finally {
      this.#running = false;
    }
  }

  close(): void {
    this.#db.close();
  }

  #lastSeq(): number {
    return Number(this.#meta("lastSeq") ?? 0);
  }

  #meta(key: string): string | undefined {
    return (this.#db.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  #setMeta(key: string, value: string): void {
    this.#db.prepare("INSERT INTO memory_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}

function localDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
