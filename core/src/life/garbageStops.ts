// §98 垃圾車清運點查詢（目前接新北市開放資料）：主人輸入地址，Core 在本機比對路名、巷弄，列出附近的清運點與時間。
// 地址不送到任何外部服務：只下載整份公開的清運路線（新北市每天更新），存在 data/garbage-ntpc.json，7 天重抓一次。
// 資料來源：新北市政府環境保護局「新北市垃圾車路線」（data.ntpc.gov.tw，政府資料開放授權條款）。

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const NTPC_URL = "https://data.ntpc.gov.tw/api/datasets/edc3ad26-8ae7-4916-a00b-bc6048d19bf8/json";
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;
const MAX_AGE_MS = 7 * 86_400_000;
const NEARBY_METERS = 350;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

/** 一筆清運紀錄（同一個點可能有好幾條路線、時段）。days 是 7 碼字串，第 0 碼是週日，1 表示有收。 */
export type StopRecord = {
  district: string; village: string; line: string; name: string; lat: number; lon: number; time: string; memo: string;
  garbage: string; recycle: string; food: string;
};

export type StopSchedule = { time: string; line: string; memo: string; garbage: number[]; recycle: number[]; food: number[] };
export type StopResult = { name: string; district: string; village: string; lat: number; lon: number; distance: number | null; matched: boolean; schedules: StopSchedule[] };
export type StopSearch = { city: string; updatedAt: string; district: string | null; street: string | null; lane: number | null; results: StopResult[] };

/** invalid：查詢太短；unavailable：資料下載失敗。 */
export class GarbageStopsError extends Error {
  readonly kind: "invalid" | "unavailable";

  constructor(message: string, kind: "invalid" | "unavailable") {
    super(message);
    this.kind = kind;
  }
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const daysOf = (flags: string): number[] => [...flags].flatMap((flag, day) => (flag === "1" ? [day] : []));

export function toRecord(raw: Record<string, unknown>): StopRecord | undefined {
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "");
  const lat = Number(raw.latitude);
  const lon = Number(raw.longitude);
  const time = text("time");
  if (text("name") === "" || !Number.isFinite(lat) || !Number.isFinite(lon) || !/^\d{1,2}:\d{2}$/u.test(time)) return undefined;
  const flags = (kind: string) => DAYS.map((day) => (text(`${kind}${day}`).toUpperCase() === "Y" ? "1" : "0")).join("");
  return {
    district: text("city"), village: text("village"), line: text("linename"), name: text("name"), lat, lon, time: time.padStart(5, "0"), memo: text("memo"),
    garbage: flags("garbage"), recycle: flags("recycling"), food: flags("foodscraps"),
  };
}

/** 兩點距離（公尺）。 */
export function meters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(a));
}

const FULL_DIGITS = /[０-９]/gu;
const CHINESE_DIGITS: Record<string, string> = { 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

/** 地址拆成區、路名、巷：全形數字轉半形，臺→台，去掉縣市。 */
export function parseAddress(query: string, districts: string[]): { district: string | null; street: string | null; lane: number | null } {
  let text = query.replace(FULL_DIGITS, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0)).replace(/臺/gu, "台").replace(/\s+/gu, "");
  text = text.replace(/^(新北市|新北勢|新北)/u, "");
  const district = districts.find((name) => text.includes(name)) ?? districts.find((name) => text.includes(name.replace(/區$/u, ""))) ?? null;
  if (district !== null) text = text.replace(district, "").replace(district.replace(/區$/u, ""), "");
  const street = /([一-鿿]{1,6}?(?:大道|路|街)(?:[一二三四五六七八九]段)?)/u.exec(text)?.[1] ?? null;
  const lane = /(\d+)巷/u.exec(text)?.[1];
  return { district, street, lane: lane === undefined ? null : Number(lane) };
}

const laneOf = (name: string): number | null => {
  const match = /(\d+)巷/u.exec(name);
  return match === null ? null : Number(match[1]);
};
const streetSegment = (street: string): string => street.replace(/([一二三四五六七八九])段$/u, (_, digit: string) => `${CHINESE_DIGITS[digit]}段`);

/** 名稱的比對分數：同路名、同巷號最高；別條路但同巷號也列（地址可能寫錯路名）。 */
function score(record: StopRecord, street: string | null, lane: number | null): number {
  let value = 0;
  const sameStreet = street !== null && (record.name.includes(street) || record.name.includes(streetSegment(street)));
  if (sameStreet) value += 10;
  const stopLane = laneOf(record.name);
  if (lane !== null && stopLane !== null) {
    if (stopLane === lane) value += sameStreet ? 8 : 6;
    else if (sameStreet) value += Math.max(0, 4 - Math.abs(stopLane - lane) / 10);
  }
  return value;
}

export function searchStops(records: StopRecord[], query: string): Omit<StopSearch, "city" | "updatedAt"> {
  const districts = [...new Set(records.map((record) => record.district))];
  const parsed = parseAddress(query, districts);
  const pool = parsed.district === null ? records : records.filter((record) => record.district === parsed.district);
  // 同一個點（名稱＋座標）合成一筆，底下列各時段。
  const groups = new Map<string, { records: StopRecord[]; score: number }>();
  for (const record of pool) {
    const key = `${record.name}|${record.lat.toFixed(5)}|${record.lon.toFixed(5)}`;
    const group = groups.get(key) ?? { records: [], score: score(record, parsed.street, parsed.lane) };
    group.records.push(record);
    groups.set(key, group);
  }
  const ranked = [...groups.values()].filter((group) => group.score > 0).sort((left, right) => right.score - left.score);
  // 用分數最高的點當中心，再列它附近的點（主人家門口不一定有站名，附近的點可能更近）。
  const anchor = ranked[0]?.records[0];
  const results = new Map<string, StopResult>();
  const toResult = (group: { records: StopRecord[]; score: number }, distance: number | null): StopResult => {
    const first = group.records[0]!;
    const schedules = group.records
      .map((record) => ({ time: record.time, line: record.line, memo: record.memo, garbage: daysOf(record.garbage), recycle: daysOf(record.recycle), food: daysOf(record.food) }))
      .sort((left, right) => left.time.localeCompare(right.time) || left.line.localeCompare(right.line));
    return { name: first.name, district: first.district, village: first.village, lat: first.lat, lon: first.lon, distance, matched: group.score > 0, schedules };
  };
  for (const group of ranked.slice(0, 8)) {
    const first = group.records[0]!;
    results.set(`${first.name}|${first.lat}|${first.lon}`, toResult(group, anchor === undefined ? null : Math.round(meters(anchor.lat, anchor.lon, first.lat, first.lon))));
  }
  if (anchor !== undefined) {
    const nearby = [...groups.values()]
      .map((group) => ({ group, distance: meters(anchor.lat, anchor.lon, group.records[0]!.lat, group.records[0]!.lon) }))
      .filter((entry) => entry.distance <= NEARBY_METERS)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 12);
    for (const { group, distance } of nearby) {
      const first = group.records[0]!;
      const key = `${first.name}|${first.lat}|${first.lon}`;
      if (!results.has(key)) results.set(key, toResult(group, Math.round(distance)));
    }
  }
  const sorted = [...results.values()].sort((left, right) => Number(right.matched) - Number(left.matched) || (left.distance ?? 0) - (right.distance ?? 0));
  return { ...parsed, results: sorted.slice(0, 16) };
}

export class GarbageStops {
  readonly #file: string;
  readonly #fetch: FetchLike;
  #records: StopRecord[] | undefined;
  #loading: Promise<StopRecord[]> | undefined;

  constructor(options: { file: string; fetch?: FetchLike }) {
    this.#file = options.file;
    this.#fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  }

  updatedAt(): string | null {
    return existsSync(this.#file) ? statSync(this.#file).mtime.toISOString() : null;
  }

  async search(query: string): Promise<StopSearch> {
    if (query.trim().length < 2) throw new GarbageStopsError("請輸入地址，例如「板橋區文化路一段」", "invalid");
    const records = await this.#load();
    return { city: "新北市", updatedAt: this.updatedAt() ?? "", ...searchStops(records, query.slice(0, 80)) };
  }

  /** 讀本機快取；沒有或超過 7 天就重新下載（同時只下載一次）。下載失敗但有舊資料時用舊的。 */
  async #load(): Promise<StopRecord[]> {
    const fresh = existsSync(this.#file) && Date.now() - statSync(this.#file).mtimeMs < MAX_AGE_MS;
    if (this.#records !== undefined && fresh) return this.#records;
    if (fresh) {
      this.#records = JSON.parse(readFileSync(this.#file, "utf8")) as StopRecord[];
      return this.#records;
    }
    this.#loading ??= this.#download().finally(() => { this.#loading = undefined; });
    try {
      this.#records = await this.#loading;
    } catch (error) {
      if (existsSync(this.#file)) this.#records = JSON.parse(readFileSync(this.#file, "utf8")) as StopRecord[];
      else throw error;
    }
    return this.#records;
  }

  async #download(): Promise<StopRecord[]> {
    const records: StopRecord[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let rows: unknown;
      try {
        const response = await this.#fetch(`${NTPC_URL}?page=${page}&size=${PAGE_SIZE}`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        rows = await response.json();
      } catch (error) {
        throw new GarbageStopsError(`下載新北市垃圾車資料失敗：${error instanceof Error ? error.message : String(error)}`, "unavailable");
      }
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const record = typeof row === "object" && row !== null ? toRecord(row as Record<string, unknown>) : undefined;
        if (record !== undefined) records.push(record);
      }
      if (rows.length < PAGE_SIZE) break;
    }
    if (records.length === 0) throw new GarbageStopsError("新北市垃圾車資料是空的", "unavailable");
    writeFileSync(this.#file, JSON.stringify(records));
    return records;
  }
}
