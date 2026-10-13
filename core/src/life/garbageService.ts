// §97 垃圾車、回收車提醒：主人在聊天側「垃圾車」分頁設定每週哪幾天、幾點、提前幾分鐘提醒；
// Core 每分鐘檢查，到點跳桌面通知並在聊天分頁留一則訊息。同一時間的多種（一般垃圾＋回收）合成一則。
// 設定存在 data/garbage.json（不進 git）；「今天略過」只影響當天。

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const GARBAGE_KINDS = ["garbage", "recycle", "other"] as const;
export type GarbageKind = typeof GARBAGE_KINDS[number];

export type GarbageEntry = {
  id: string;
  label: string;
  kind: GarbageKind;
  /** 0＝週日 … 6＝週六。 */
  weekdays: number[];
  /** HH:MM（24 小時制）。 */
  time: string;
  /** 提前幾分鐘提醒，例如 [15, 5]。 */
  before: number[];
  place: string;
  enabled: boolean;
};

type GarbageFile = {
  entries: GarbageEntry[];
  /** 今天略過：entry id → YYYY-MM-DD。 */
  skip: Record<string, string>;
  /** 已提醒：「YYYY-MM-DD HH:MM」→ 已提醒過的分鐘數。 */
  reminded: Record<string, number[]>;
};

export type GarbageReminder = { time: string; minutes: number; entries: GarbageEntry[]; title: string; body: string; text: string };
export type GarbageToday = { entry: GarbageEntry; skipped: boolean; passed: boolean };

export class GarbageError extends Error {}

const pad = (value: number): string => String(value).padStart(2, "0");
export const dateKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const WEEKDAY = "日一二三四五六";

function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour! * 60 + minute!;
}

/** 週幾的寫法：週一、二、四（連續的不合併，一般一週最多五六天）。 */
export function weekdayText(weekdays: number[]): string {
  if (weekdays.length === 7) return "每天";
  return `週${[...weekdays].sort((left, right) => ((left + 6) % 7) - ((right + 6) % 7)).map((day) => WEEKDAY[day]).join("、")}`;
}

/** 檢查並整理主人送來的設定；不對丟 GarbageError。 */
export function parseEntries(value: unknown): GarbageEntry[] {
  if (!Array.isArray(value)) throw new GarbageError("entries 必須是陣列");
  if (value.length > 20) throw new GarbageError("最多 20 筆");
  return value.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) throw new GarbageError(`第 ${index + 1} 筆格式不對`);
    const entry = raw as Record<string, unknown>;
    const kind = GARBAGE_KINDS.includes(entry.kind as GarbageKind) ? entry.kind as GarbageKind : "other";
    const label = typeof entry.label === "string" && entry.label.trim() !== "" ? entry.label.trim().slice(0, 30) : kind === "garbage" ? "一般垃圾" : kind === "recycle" ? "資源回收" : "其他";
    const weekdays = Array.isArray(entry.weekdays) ? [...new Set(entry.weekdays.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))].sort() : [];
    if (weekdays.length === 0) throw new GarbageError(`「${label}」至少要選一天`);
    const time = typeof entry.time === "string" ? entry.time.trim() : "";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new GarbageError(`「${label}」的時間要寫成 HH:MM，例如 19:30`);
    const before = Array.isArray(entry.before)
      ? [...new Set(entry.before.filter((mark): mark is number => Number.isInteger(mark) && mark >= 1 && mark <= 120))].sort((left, right) => right - left).slice(0, 3)
      : [];
    return {
      id: typeof entry.id === "string" && /^[\w-]{1,64}$/u.test(entry.id) ? entry.id : randomUUID(),
      label, kind, weekdays, time,
      before: before.length === 0 ? [10] : before,
      place: typeof entry.place === "string" ? entry.place.trim().slice(0, 40) : "",
      enabled: entry.enabled !== false,
    };
  });
}

/** 同一時間的提醒合成一則。 */
function reminderFor(time: string, minutes: number, entries: GarbageEntry[]): GarbageReminder {
  const labels = entries.map((entry) => entry.label).join("、");
  const places = [...new Set(entries.map((entry) => entry.place).filter(Boolean))].join("、");
  const truck = entries.every((entry) => entry.kind === "recycle") ? "回收車" : "垃圾車";
  const body = `${time} ${labels}${places === "" ? "" : `（${places}）`}`;
  return { time, minutes, entries, title: `🚛 ${truck} ${minutes} 分鐘後到`, body, text: `🚛 ${minutes} 分鐘後${truck}：${body}` };
}

export class GarbageService {
  readonly #file: string;
  readonly #now: () => Date;

  constructor(options: { file: string; now?: () => Date }) {
    this.#file = options.file;
    this.#now = options.now ?? (() => new Date());
  }

  #read(): GarbageFile {
    if (!existsSync(this.#file)) return { entries: [], skip: {}, reminded: {} };
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<GarbageFile>;
      let entries: GarbageEntry[] = [];
      try {
        entries = parseEntries(raw.entries ?? []);
      } catch {
        entries = [];
      }
      return { entries, skip: raw.skip ?? {}, reminded: raw.reminded ?? {} };
    } catch {
      return { entries: [], skip: {}, reminded: {} };
    }
  }

  #write(data: GarbageFile): void {
    // 只留今天的略過與提醒紀錄，檔案不會越長越大。
    const today = dateKey(this.#now());
    const skip = Object.fromEntries(Object.entries(data.skip).filter(([, date]) => date === today));
    const reminded = Object.fromEntries(Object.entries(data.reminded).filter(([key]) => key.startsWith(today)));
    writeFileSync(this.#file, `${JSON.stringify({ entries: data.entries, skip, reminded }, null, 2)}\n`);
  }

  entries(): GarbageEntry[] {
    return this.#read().entries;
  }

  save(value: unknown): GarbageEntry[] {
    const entries = parseEntries(value);
    const data = this.#read();
    this.#write({ ...data, entries });
    return entries;
  }

  /** 今天略過（或取消略過）某一筆。 */
  setSkip(id: string, skip: boolean): boolean {
    const data = this.#read();
    if (!data.entries.some((entry) => entry.id === id)) return false;
    if (skip) data.skip[id] = dateKey(this.#now());
    else delete data.skip[id];
    this.#write(data);
    return true;
  }

  /** 某一天要收的（依時間排序）。 */
  on(date: Date): GarbageToday[] {
    const data = this.#read();
    const key = dateKey(date);
    const nowMinutes = date.getHours() * 60 + date.getMinutes();
    const isToday = key === dateKey(this.#now());
    return data.entries
      .filter((entry) => entry.enabled && entry.weekdays.includes(date.getDay()))
      .sort((left, right) => left.time.localeCompare(right.time))
      .map((entry) => ({ entry, skipped: data.skip[entry.id] === key, passed: isToday && minutesOf(entry.time) < nowMinutes }));
  }

  today(): GarbageToday[] {
    return this.on(this.#now());
  }

  /** 每分鐘呼叫：到了提醒時間的（同一時間合成一則），回傳後記為已提醒。 */
  dueReminders(): GarbageReminder[] {
    const now = this.#now();
    const data = this.#read();
    const today = dateKey(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const byTime = new Map<string, GarbageEntry[]>();
    for (const entry of data.entries) {
      if (!entry.enabled || !entry.weekdays.includes(now.getDay()) || data.skip[entry.id] === today) continue;
      byTime.set(entry.time, [...(byTime.get(entry.time) ?? []), entry]);
    }
    const reminders: GarbageReminder[] = [];
    for (const [time, entries] of byTime) {
      const left = minutesOf(time) - nowMinutes;
      if (left <= 0) continue;
      const marks = [...new Set(entries.flatMap((entry) => entry.before))].sort((a, b) => a - b);
      const due = marks.find((mark) => left <= mark);
      const key = `${today} ${time}`;
      const done = data.reminded[key] ?? [];
      if (due === undefined || done.some((mark) => mark <= due)) continue;
      data.reminded[key] = [...done, due];
      reminders.push(reminderFor(time, Math.ceil(left), entries));
    }
    if (reminders.length > 0) this.#write(data);
    return reminders;
  }

  /** §97：聊天提示裡的一行（今天與明天要收的）；沒設定回傳 undefined。 */
  promptLine(): string | undefined {
    const data = this.#read();
    if (data.entries.length === 0) return undefined;
    const now = this.#now();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const describe = (items: GarbageToday[]) => (items.length === 0 ? "沒有" : items.map(({ entry, skipped }) => `${entry.time} ${entry.label}${skipped ? "（主人說今天略過）" : ""}`).join("、"));
    const schedule = data.entries.filter((entry) => entry.enabled).map((entry) => `${entry.label} ${weekdayText(entry.weekdays)} ${entry.time}`).join("；");
    return `今天：${describe(this.today())}；明天：${describe(this.on(tomorrow))}。固定時間：${schedule}`;
  }
}
