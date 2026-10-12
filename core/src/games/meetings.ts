// §73 重要會議：主人在 Web Studio「會議」分頁登記（例：專案名稱 - 10/08 1500 ~ 1530 api 前端會議），
// 存在本機資料庫（含工作資料，不進 git）；艾莉絲從提示知道近期的會議。

import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

export type Meeting = {
  id: string;
  /** 專案名稱（對得上專案卡就用卡片名稱）；空字串表示不屬於某個專案。 */
  game: string;
  /** YYYY-MM-DD。 */
  date: string;
  /** HH:MM。 */
  start: string;
  /** HH:MM；null 表示沒寫結束時間。 */
  end: string | null;
  title: string;
  createdAt: string;
  /** §74 已提醒過的時間點（會議前幾分鐘），例 [30, 10]。 */
  reminded: number[];
};

export type MeetingFields = Omit<Meeting, "id" | "createdAt" | "reminded">;

/** §74：會議前幾分鐘提醒（主人 2026-10-07 定：30 分鐘、10 分鐘前各一次）。 */
export const REMINDER_MINUTES = [30, 10] as const;

type Row = { id: string; game: string; date: string; start_time: string; end_time: string | null; title: string; created_at: string; reminded: string | null };

const toMeeting = (row: Row): Meeting => ({
  id: row.id, game: row.game, date: row.date, start: row.start_time, end: row.end_time, title: row.title, createdAt: row.created_at,
  reminded: row.reminded === null ? [] : JSON.parse(row.reminded) as number[],
});

const pad = (value: number): string => String(value).padStart(2, "0");
const ymd = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export class MeetingParseError extends Error {}

function time(hour: string, minute: string): string {
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) throw new MeetingParseError(`時間 ${hour}:${minute} 不對`);
  return `${pad(h)}:${pad(m)}`;
}

/**
 * 解析一行會議：「專案名稱 - 10/08 1500 ~ 1530 api 前端會議」。專案名稱與結束時間可以省略；
 * 時間可寫 1500 或 15:00；年份用今年，日期比今天早 60 天以上就當明年。
 */
export function parseMeetingText(text: string, now = new Date()): MeetingFields {
  const line = text.trim().replace(/\s+/gu, " ");
  const match = /^(?:(.+?)\s*[-－–—]\s*)?(\d{1,2})[/／.](\d{1,2})\s*(\d{1,2}):?(\d{2})(?:\s*[~～〜\-－–—至到]\s*(\d{1,2}):?(\d{2}))?\s*(.*)$/u.exec(line);
  if (match === null) throw new MeetingParseError("看不懂這行，格式例：專案名稱 - 10/08 1500 ~ 1530 api 前端會議");
  const [, game = "", month, day, startHour, startMinute, endHour, endMinute, title = ""] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  let year = now.getFullYear();
  const candidate = (y: number) => new Date(y, monthNumber - 1, dayNumber);
  if (monthNumber < 1 || monthNumber > 12 || candidate(year).getMonth() !== monthNumber - 1) throw new MeetingParseError(`日期 ${month}/${day} 不對`);
  if (candidate(year).getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - 60 * 86_400_000) year += 1;
  const start = time(startHour!, startMinute!);
  const end = endHour === undefined ? null : time(endHour, endMinute!);
  if (end !== null && end <= start) throw new MeetingParseError("結束時間要比開始晚");
  return { game: game.trim(), date: ymd(candidate(year)), start, end, title: title.trim() || "會議" };
}

/** 一行顯示：10/08（四）15:00～15:30 專案名稱：api 前端會議。 */
export function meetingLine(meeting: Meeting): string {
  const [year, month, day] = meeting.date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(year!, month! - 1, day!).getDay()];
  return `${pad(month!)}/${pad(day!)}（${weekday}）${meeting.start}${meeting.end === null ? "" : `～${meeting.end}`} ${meeting.game === "" ? "" : `${meeting.game}：`}${meeting.title}`;
}

export function meetingStartAt(meeting: Pick<Meeting, "date" | "start">): number {
  const [year, month, day] = meeting.date.split("-").map(Number);
  const [hour, minute] = meeting.start.split(":").map(Number);
  return new Date(year!, month! - 1, day!, hour!, minute!).getTime();
}

/**
 * §74：現在該送哪一個提醒。距離開始 ≤ 30 分鐘、還沒送過 30 分鐘提醒就送 30；≤ 10 分鐘就送 10（同時涵蓋 30）。
 * 已經開始的不再提醒（Core 剛好沒開著的那段就略過）。回傳 null 表示不用送。
 */
export function dueReminder(meeting: Meeting, now: Date): number | null {
  const minutes = (meetingStartAt(meeting) - now.getTime()) / 60_000;
  if (minutes <= 0) return null;
  const due = [...REMINDER_MINUTES].sort((left, right) => left - right).find((mark) => minutes <= mark);
  if (due === undefined || meeting.reminded.some((mark) => mark <= due)) return null;
  return due;
}

/** 會議結束了沒（沒寫結束時間的，開始後一小時算結束）。 */
export function meetingEnded(meeting: Meeting, now = new Date()): boolean {
  const [year, month, day] = meeting.date.split("-").map(Number);
  const [hour, minute] = (meeting.end ?? meeting.start).split(":").map(Number);
  const endAt = new Date(year!, month! - 1, day!, hour!, minute!).getTime() + (meeting.end === null ? 3_600_000 : 0);
  return endAt <= now.getTime();
}

export class MeetingStore {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        game TEXT NOT NULL,
        date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meetings_date ON meetings(date, start_time);
    `);
    // §74：提醒紀錄欄（舊資料庫補欄）。
    const columns = this.#db.prepare("PRAGMA table_info(meetings)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "reminded")) this.#db.exec("ALTER TABLE meetings ADD COLUMN reminded TEXT");
  }

  add(fields: MeetingFields, at = new Date().toISOString()): Meeting {
    const id = randomUUID();
    this.#db.prepare("INSERT INTO meetings (id, game, date, start_time, end_time, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, fields.game, fields.date, fields.start, fields.end, fields.title, at);
    return toMeeting(this.#db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row);
  }

  markReminded(id: string, reminded: number[]): void {
    this.#db.prepare("UPDATE meetings SET reminded = ? WHERE id = ?").run(JSON.stringify(reminded), id);
  }

  remove(id: string): boolean {
    return this.#db.prepare("DELETE FROM meetings WHERE id = ?").run(id).changes > 0;
  }

  /** from 當天以後的會議（YYYY-MM-DD），依時間排序。 */
  since(from: string): Meeting[] {
    return (this.#db.prepare("SELECT * FROM meetings WHERE date >= ? ORDER BY date, start_time").all(from) as Row[]).map(toMeeting);
  }

  close(): void {
    this.#db.close();
  }
}

/** Studio 列表：今天起的會議，加上過去 14 天的（畫面放在「已結束」）。 */
export const LIST_PAST_DAYS = 14;
/** 提示裡列幾天內的會議。 */
export const PROMPT_DAYS = 7;

export function daysFrom(now: Date, days: number): string {
  return ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
}
