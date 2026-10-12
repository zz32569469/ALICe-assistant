// §77 塔羅占卜：短期（今日，1 張）、長期（本週，3 張：過去／現在／未來），看工作運、財運、感情與人際、健康。
// 抽牌由 Core 用亂數決定（ALICe 不能自己挑牌），ALICe 只解讀。§79：不參考主人的工作，只簡單描寫未來的可能性。同一期（今天、本週）只占一次，CD 沒到就停在上一次的結果。
// 解讀用 Claude Code（Max 訂閱，不用 API），和翻譯一樣一次性呼叫、不用工具。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

import Database from "better-sqlite3";

import type { EventHub } from "../protocol/eventHub.js";
import { subscriptionOnlyEnv } from "../subscriptionEnv.js";

export type FortuneKind = "short" | "long";
export type TarotCard = { name: string; reversed: boolean; position: string };
export type Fortune = { id: string; kind: FortuneKind; period: string; cards: TarotCard[]; text: string; createdAt: string };
export type FortuneSlot = { latest: Fortune | null; /** 這一期已經占過。 */ done: boolean; /** 下次可以占的時間（ISO）。 */ nextAt: string; generating: boolean };

const MAJOR = [
  "愚者", "魔術師", "女祭司", "皇后", "皇帝", "教皇", "戀人", "戰車", "力量", "隱者", "命運之輪",
  "正義", "吊人", "死神", "節制", "惡魔", "高塔", "星星", "月亮", "太陽", "審判", "世界",
];
const SUITS = ["權杖", "聖杯", "寶劍", "錢幣"];
const RANKS = ["王牌", "二", "三", "四", "五", "六", "七", "八", "九", "十", "侍者", "騎士", "皇后", "國王"];
/** 78 張：22 張大阿爾克那＋56 張小阿爾克那。 */
export const TAROT_DECK: readonly string[] = [...MAJOR, ...SUITS.flatMap((suit) => RANKS.map((rank) => `${suit}${rank}`))];

export const ASPECTS = ["工作運", "財運", "感情與人際", "健康"] as const;
const POSITIONS: Record<FortuneKind, string[]> = { short: ["今日"], long: ["過去", "現在", "未來"] };
export const KIND_LABEL: Record<FortuneKind, string> = { short: "今日運勢", long: "本週運勢" };

const pad = (value: number): string => String(value).padStart(2, "0");
const ymd = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 這一期的代號與下一期開始的時間：短期是今天（隔天 0 點換期），長期是本週（週一 0 點換期）。 */
export function periodOf(kind: FortuneKind, now: Date): { period: string; nextAt: Date } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (kind === "short") return { period: ymd(today), nextAt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1) };
  const sinceMonday = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - sinceMonday);
  return { period: `${ymd(monday)}週`, nextAt: new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7) };
}

/** 不重複抽 count 張，每張各一半機率逆位。random(n) 回傳 0～n-1。 */
export function drawCards(kind: FortuneKind, random: (n: number) => number = randomInt): TarotCard[] {
  const deck = [...TAROT_DECK];
  return POSITIONS[kind].map((position) => {
    const [name] = deck.splice(random(deck.length), 1);
    return { name: name!, reversed: random(2) === 1, position };
  });
}

export const cardText = (card: TarotCard): string => `${card.position}：${card.name}（${card.reversed ? "逆位" : "正位"}）`;

export function fortunePrompt(kind: FortuneKind, cards: TarotCard[], now: Date): string {
  return [
    `請為主人做${KIND_LABEL[kind]}的塔羅解讀（現在是 ${ymd(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}）。牌已經由程式隨機抽好，不能換牌、不能加牌：`,
    ...cards.map((card) => `- ${cardText(card)}`),
    "",
    `面向：${ASPECTS.join("、")}。`,
    "不要連結主人實際的工作、專案或行程；用牌義簡單描寫接下來可能出現的情況與機會，像一般的運勢文字。",
    "",
    "格式（Markdown，繁體中文，總長 400～700 字）：",
    "1. 第一行一句總結（不加標題）。",
    `2. 「### 牌面」：每張牌一行，寫牌名、正逆位與這張牌在${kind === "short" ? "今天" : "這個位置"}的意思。`,
    `3. ${ASPECTS.map((aspect) => `「### ${aspect}」`).join("、")}各兩三句，寫可能的走向，輕鬆好讀。`,
    "4. 「### 小建議」：一句提醒，加一個幸運色或幸運物。",
    // §82 主人要的總結（參考主人給的範例：把牌串成脈絡、點出要小心的牌、最後濃縮成一句話）。
    `5. 「### 總結」：${kind === "short"
      ? "先用一句話說今天這張牌的整體氣氛；再寫今天最要留意的一點（逆位或比較不舒服的牌義直接說，不粉飾）"
      : "先把三張牌串成一條脈絡，寫成「牌名 → 牌名 → 牌名」，下一行用白話寫成「先…→ 再…→ 然後…」；再點出這次最要留意的一張牌或一個傾向（不舒服的牌義直接說，不粉飾）"}；最後一行寫「如果要 ALICe 把這次占卜濃縮成一句話：」加上用「」括起來的一句話。只有在深夜或清晨（23:00～06:00）才在最後加一句關心作息，其他時間不要提時間。`,
    "用 ALICe 的口吻（親切、像身邊的助理），不要說「作為 AI」，也不要在內文提到這些寫作要求（例如「照實說」「不美化」）。這是娛樂性質的占卜：健康只給作息與生活提醒，不做醫療判斷；財運不給投資建議。",
  ].filter((line) => line !== "").join("\n");
}

export type FortuneSpawn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessWithoutNullStreams;
export type FortuneInterpreter = (prompt: string, system: string) => Promise<string>;

export class FortuneError extends Error {
  readonly code: "conflict" | "busy" | "failed";

  constructor(code: FortuneError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

type Row = { id: string; kind: FortuneKind; period: string; cards: string; text: string; created_at: string };
const toFortune = (row: Row): Fortune => ({ id: row.id, kind: row.kind, period: row.period, cards: JSON.parse(row.cards) as TarotCard[], text: row.text, createdAt: row.created_at });

export class FortuneService {
  readonly #db: Database.Database;
  readonly #events: EventHub | undefined;
  readonly #now: () => Date;
  readonly #interpret: FortuneInterpreter;
  readonly #personaPath: string | undefined;
  readonly #random: (n: number) => number;
  readonly #generating = new Set<FortuneKind>();

  constructor(options: {
    dbPath: string; events?: EventHub; now?: () => Date; personaPath?: string;
    /** 測試可換掉解讀；預設用 Claude Code 一次性呼叫。 */
    interpret?: FortuneInterpreter; claudePath?: string; workDir?: string; random?: (n: number) => number;
  }) {
    this.#db = new Database(options.dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS fortunes (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        period TEXT NOT NULL,
        cards TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (kind, period)
      );
    `);
    this.#events = options.events;
    this.#now = options.now ?? (() => new Date());
    this.#personaPath = options.personaPath;
    this.#random = options.random ?? randomInt;
    this.#interpret = options.interpret ?? claudeInterpreter(options.claudePath ?? "claude", options.workDir ?? process.cwd());
  }

  slot(kind: FortuneKind): FortuneSlot {
    const now = this.#now();
    const { period, nextAt } = periodOf(kind, now);
    const row = this.#db.prepare("SELECT * FROM fortunes WHERE kind = ? ORDER BY created_at DESC LIMIT 1").get(kind) as Row | undefined;
    const latest = row === undefined ? null : toFortune(row);
    const done = latest?.period === period;
    return { latest, done, nextAt: done ? nextAt.toISOString() : now.toISOString(), generating: this.#generating.has(kind) };
  }

  slots(): Record<FortuneKind, FortuneSlot> {
    return { short: this.slot("short"), long: this.slot("long") };
  }

  /** 占卜：這一期已經占過回傳 conflict（畫面停在上一次）；同一種正在占回傳 busy。 */
  async draw(kind: FortuneKind): Promise<Fortune> {
    const now = this.#now();
    const { period } = periodOf(kind, now);
    if (this.slot(kind).done) throw new FortuneError("conflict", `${KIND_LABEL[kind]}這一期已經占過了`);
    if (this.#generating.has(kind)) throw new FortuneError("busy", `${KIND_LABEL[kind]}正在占卜中`);
    this.#generating.add(kind);
    this.#broadcast();
    try {
      const cards = drawCards(kind, this.#random);
      const text = await this.#reading(kind, cards, now);
      const fortune: Fortune = { id: randomUUID(), kind, period, cards, text, createdAt: now.toISOString() };
      this.#db.prepare("INSERT INTO fortunes (id, kind, period, cards, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(fortune.id, kind, period, JSON.stringify(cards), text, fortune.createdAt);
      return fortune;
    } finally {
      this.#generating.delete(kind);
      this.#broadcast();
    }
  }

  /** §81：這一期的牌不變，照目前的寫法重新解讀（解讀方式改版後用）。這一期還沒占過回傳 conflict。 */
  async reinterpret(kind: FortuneKind): Promise<Fortune> {
    const slot = this.slot(kind);
    if (!slot.done || slot.latest === null) throw new FortuneError("conflict", `${KIND_LABEL[kind]}這一期還沒占過`);
    if (this.#generating.has(kind)) throw new FortuneError("busy", `${KIND_LABEL[kind]}正在占卜中`);
    this.#generating.add(kind);
    this.#broadcast();
    try {
      const text = await this.#reading(kind, slot.latest.cards, new Date(slot.latest.createdAt));
      this.#db.prepare("UPDATE fortunes SET text = ? WHERE id = ?").run(text, slot.latest.id);
      return { ...slot.latest, text };
    } finally {
      this.#generating.delete(kind);
      this.#broadcast();
    }
  }

  close(): void {
    this.#db.close();
  }

  async #reading(kind: FortuneKind, cards: TarotCard[], at: Date): Promise<string> {
    const persona = this.#personaPath !== undefined && existsSync(this.#personaPath) ? readFileSync(this.#personaPath, "utf8") : "";
    const system = `${persona}\n\n你現在在 Web Studio 的占卜分頁替主人解讀塔羅牌。只輸出解讀內容。`.trim();
    let text: string;
    try {
      text = (await this.#interpret(fortunePrompt(kind, cards, at), system)).trim();
    } catch (error) {
      throw new FortuneError("failed", `占卜失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    if (text === "") throw new FortuneError("failed", "占卜失敗：ALICe 沒有回應內容");
    return text;
  }

  #broadcast(): void {
    this.#events?.broadcast("fortune.updated", { slots: this.slots() });
  }
}

/** 一次性呼叫 Claude Code：不用工具、不存對話、關掉思考（和翻譯一樣），模型用 Sonnet。 */
export function claudeInterpreter(claudePath: string, workDir: string, spawnProcess: FortuneSpawn = spawn as FortuneSpawn): FortuneInterpreter {
  return (prompt, system) => new Promise<string>((resolve, reject) => {
    mkdirSync(workDir, { recursive: true });
    const args = ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--model", "sonnet", "--output-format", "json", "--system-prompt", system];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(claudePath, args, { cwd: workDir, env: { ...subscriptionOnlyEnv(process.env), MAX_THINKING_TOKENS: "0" }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("超過 120 秒沒有回應")); }, 120_000);
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr = (stderr + chunk.toString()).slice(-2_000); });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout) as { is_error?: boolean; result?: unknown };
        if (result.is_error === true || typeof result.result !== "string") throw new Error(typeof result.result === "string" ? result.result : "空白回應");
        resolve(result.result);
      } catch (error) {
        reject(new Error(`結束碼 ${code ?? "?"}：${error instanceof Error ? error.message : String(error)}${stderr === "" ? "" : `；${stderr.trim().slice(0, 200)}`}`));
      }
    });
    child.stdin.end(prompt, "utf8");
  });
}
