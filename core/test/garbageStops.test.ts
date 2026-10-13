import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GarbageStops, GarbageStopsError, meters, parseAddress, searchStops, toRecord } from "../src/life/garbageStops.js";

function row(name: string, lat: number, lon: number, time: string, days: { garbage?: string; recycling?: string; foodscraps?: string } = {}, extra: Record<string, string> = {}): Record<string, string> {
  const week = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const flags = (kind: string, value = "0100010") => Object.fromEntries(week.map((day, index) => [`${kind}${day}`, value[index] === "1" ? "Y" : ""]));
  return {
    city: "甲區", village: "乙里", linename: "A 路線", name, latitude: String(lat), longitude: String(lon), time, memo: "",
    ...flags("garbage", days.garbage), ...flags("recycling", days.recycling), ...flags("foodscraps", days.foodscraps), ...extra,
  };
}

const ROWS = [
  row("和平路12巷口", 25.0, 121.5, "19:05"),
  row("和平路12巷口", 25.0, 121.5, "19:07", { garbage: "0010101", recycling: "0010101", foodscraps: "0010101" }, { linename: "A 路線二四六" }),
  row("和平路30巷5號", 25.0006, 121.5, "19:10"),
  row("中山路200巷口", 25.0009, 121.5003, "19:12"),
  row("和平路與中山路口", 25.0015, 121.5, "19:15"),
  row("很遠的點", 25.05, 121.55, "19:30"),
  row("別區和平路12巷", 25.0, 121.5, "18:00", {}, { city: "丙區" }),
  { name: "壞資料", latitude: "x" },
];

// §98：地址拆解、資料轉換、距離。
test("garbage stop records and address parsing", () => {
  assert.deepEqual(parseAddress("新北市甲區和平路12巷3號", ["甲區", "丙區"]), { district: "甲區", street: "和平路", lane: 12 });
  assert.deepEqual(parseAddress("甲和平路１２巷", ["甲區"]), { district: "甲區", street: "和平路", lane: 12 });
  assert.deepEqual(parseAddress("中正路一段", []), { district: null, street: "中正路一段", lane: null });
  const record = toRecord(ROWS[1]!)!;
  assert.equal(record.garbage, "0010101");
  assert.equal(record.time, "19:07");
  assert.equal(toRecord(ROWS[7]!), undefined);
  assert.ok(Math.abs(meters(25, 121.5, 25.001, 121.5) - 111) < 2);
});

// §98：同路同巷最前面；同一個點的各時段合在一起；附近 350 公尺內的點也列；別區不列。
test("searchStops ranks matches and lists nearby stops", () => {
  const records = ROWS.map(toRecord).filter((record) => record !== undefined);
  const result = searchStops(records, "甲區和平路12巷7號");
  assert.equal(result.district, "甲區");
  const names = result.results.map((entry) => entry.name);
  assert.equal(names[0], "和平路12巷口");
  assert.deepEqual(result.results[0]!.schedules.map((entry) => [entry.time, entry.garbage]), [["19:05", [1, 5]], ["19:07", [2, 4, 6]]]);
  assert.equal(result.results[0]!.distance, 0);
  assert.ok(names.includes("中山路200巷口"));
  assert.ok(!names.includes("很遠的點"));
  assert.ok(!names.includes("別區和平路12巷"));
  assert.equal(searchStops(records, "甲區不存在的路").results.length, 0);
});

// §98：第一次查詢才下載（分頁到不足一頁為止），之後用本機快取；查詢太短回 invalid；下載失敗回 unavailable。
test("GarbageStops downloads once and caches locally", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-stops-"));
  const urls: string[] = [];
  let fail = false;
  const fetch = async (url: string) => {
    urls.push(url);
    if (fail) throw new Error("offline");
    return { ok: true, status: 200, json: async () => (url.includes("page=0") ? ROWS : []) };
  };
  try {
    const failing = new GarbageStops({ file: join(directory, "none.json"), fetch: async () => { throw new Error("offline"); } });
    await assert.rejects(failing.search("甲區和平路"), (error: unknown) => error instanceof GarbageStopsError && error.kind === "unavailable");

    const stops = new GarbageStops({ file: join(directory, "stops.json"), fetch });
    await assert.rejects(stops.search("甲"), (error: unknown) => error instanceof GarbageStopsError && error.kind === "invalid");
    const first = await stops.search("甲區和平路12巷");
    assert.equal(first.city, "新北市");
    assert.equal(first.results[0]!.name, "和平路12巷口");
    assert.equal(urls.length, 1);
    assert.ok(existsSync(join(directory, "stops.json")));
    fail = true;
    await stops.search("甲區中山路200巷");
    assert.equal(urls.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
