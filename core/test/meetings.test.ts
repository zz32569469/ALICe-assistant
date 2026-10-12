import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GameService } from "../src/games/gameService.js";
import { GameStore } from "../src/games/gameStore.js";
import { MeetingParseError, MeetingStore, dueReminder, meetingEnded, meetingLine, parseMeetingText } from "../src/games/meetings.js";
import { ALICE_BLOCK_MARKERS, AliceBlockFilter } from "../src/tasks/aliceBlockFilter.js";
import { formatMeetings } from "../src/prompt/promptBuilder.js";

const now = new Date(2026, 9, 7, 10, 0);

test("§73 解析一行會議：專案名稱、日期、起訖時間、主題", () => {
  assert.deepEqual(parseMeetingText("測試專案 - 10/08 1500 ~ 1530 API 對接會議", now), { game: "測試專案", date: "2026-10-08", start: "15:00", end: "15:30", title: "API 對接會議" });
  assert.deepEqual(parseMeetingText("10/8 9:05 對齊", now), { game: "", date: "2026-10-08", start: "09:05", end: null, title: "對齊" });
  assert.deepEqual(parseMeetingText("Game A － 1/5 14:00～15:00", now), { game: "Game A", date: "2027-01-05", start: "14:00", end: "15:00", title: "會議" });
  assert.equal(parseMeetingText("x - 10/01 1000 會", now).date, "2026-10-01");
  assert.throws(() => parseMeetingText("明天下午開會", now), MeetingParseError);
  assert.throws(() => parseMeetingText("x - 2/30 1000 會", now), /日期/u);
  assert.throws(() => parseMeetingText("x - 10/08 1530 ~ 1500 會", now), /結束時間/u);
  assert.throws(() => parseMeetingText("x - 10/08 2500 會", now), /時間/u);
});

test("§73 會議顯示與是否結束", () => {
  const meeting = { id: "m", game: "測試專案", date: "2026-10-08", start: "15:00", end: "15:30", title: "API 對接會議", createdAt: "", reminded: [] };
  assert.equal(meetingLine(meeting), "10/08（四）15:00～15:30 測試專案：API 對接會議");
  assert.equal(meetingEnded(meeting, new Date(2026, 9, 8, 15, 29)), false);
  assert.equal(meetingEnded(meeting, new Date(2026, 9, 8, 15, 30)), true);
  assert.equal(meetingEnded({ ...meeting, end: null }, new Date(2026, 9, 8, 15, 59)), false);
});

test("§73 GameService：登記時對上專案卡名稱或英文代號、提示只列 7 天內還沒結束的", () => {
  const root = mkdtempSync(join(tmpdir(), "alice-meet-"));
  const store = new GameStore(join(root, "a.db"));
  const meetings = new MeetingStore(join(root, "a.db"));
  try {
    store.create({ name: "測試專案", code: "testProject" });
    const service = new GameService({ store, projects: () => [], now: () => now, meetings });
    assert.equal(service.addMeeting("testproject - 10/08 1500 ~ 1530 API 對接會議").game, "測試專案");
    service.addMeeting("10/07 0900 ~ 0930 早會");
    service.addMeeting("其他 - 10/20 1000 晚一點的會");
    const old = service.addMeeting("10/01 1000 上週的會");
    assert.deepEqual(service.meetingLines()?.map((line) => line.replace(/（id [0-9a-f]{8}）$/u, "")), ["- 10/08（四）15:00～15:30 測試專案：API 對接會議"]);
    assert.deepEqual(service.meetings().map((meeting) => meeting.title), ["上週的會", "早會", "API 對接會議", "晚一點的會"]);
    assert.equal(service.removeMeeting(old.id), true);
    assert.equal(service.removeMeeting(old.id), false);
    assert.equal(new GameService({ store, projects: () => [] }).meetingLines(), undefined);
  } finally {
    meetings.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("§73 提示的會議段落：沒有會議功能就不放；沒有會議也放（ALICE 要知道怎麼新增）", () => {
  assert.equal(formatMeetings(undefined), null);
  assert.match(formatMeetings([])!, /- （沒有）[\s\S]*<<<ALICE_MEETING/u);
  assert.match(formatMeetings(["- 10/08（四）15:00～15:30 測試專案：API 對接會議"])!, /# 重要會議[\s\S]*測試專案：API 對接會議[\s\S]*不要預期主人回覆/u);
});

test("§74 提醒時間點：30 分鐘、10 分鐘前各一次；已開始的不提醒；晚開機直接送最近的", () => {
  const meeting = { id: "m", game: "", date: "2026-10-08", start: "15:00", end: null, title: "會", createdAt: "", reminded: [] as number[] };
  const at = (hour: number, minute: number) => new Date(2026, 9, 8, hour, minute);
  assert.equal(dueReminder(meeting, at(14, 29)), null);
  assert.equal(dueReminder(meeting, at(14, 30)), 30);
  assert.equal(dueReminder({ ...meeting, reminded: [30] }, at(14, 40)), null);
  assert.equal(dueReminder({ ...meeting, reminded: [30] }, at(14, 50)), 10);
  assert.equal(dueReminder({ ...meeting, reminded: [30, 10] }, at(14, 55)), null);
  assert.equal(dueReminder(meeting, at(14, 55)), 10);
  assert.equal(dueReminder({ ...meeting, reminded: [10] }, at(14, 56)), null);
  assert.equal(dueReminder(meeting, at(15, 0)), null);
});

test("§74 GameService 提醒只送一次、ALICE_MEETING 區塊新增與刪除", () => {
  const root = mkdtempSync(join(tmpdir(), "alice-meet-"));
  const store = new GameStore(join(root, "a.db"));
  const meetings = new MeetingStore(join(root, "a.db"));
  let clock = new Date(2026, 9, 8, 14, 31);
  try {
    store.create({ name: "測試專案", code: "testProject" });
    const service = new GameService({ store, projects: () => [], now: () => clock, meetings });
    const block = (body: string) => `${ALICE_BLOCK_MARKERS.meeting.start}\n${body}\n${ALICE_BLOCK_MARKERS.meeting.end}`;
    assert.equal(service.applyMeetingBlock(block('{"add":"測試專案 - 10/08 1500 ~ 1530 API 對接會議"}'), ALICE_BLOCK_MARKERS.meeting), "已新增會議：10/08（四）15:00～15:30 測試專案：API 對接會議");
    assert.match(service.applyMeetingBlock(block('{"add":"明天下午"}'), ALICE_BLOCK_MARKERS.meeting), /^會議沒有登記：看不懂/u);
    assert.deepEqual(service.meetingReminders().map((entry) => entry.text), ["29 分鐘後開會：10/08（四）15:00～15:30 測試專案：API 對接會議"]);
    assert.deepEqual(service.meetingReminders(), []);
    clock = new Date(2026, 9, 8, 14, 50);
    assert.deepEqual(service.meetingReminders().map((entry) => entry.minutes), [10]);
    assert.deepEqual(service.meetingReminders(), []);
    const id = service.meetings()[0]!.id.slice(0, 8);
    assert.match(service.applyMeetingBlock(block(`{"remove":"${id}"}`), ALICE_BLOCK_MARKERS.meeting), /^已刪除會議：/u);
    assert.match(service.applyMeetingBlock(block(`{"remove":"${id}"}`), ALICE_BLOCK_MARKERS.meeting), /找不到/u);
    assert.match(service.applyMeetingBlock(block("不是 JSON"), ALICE_BLOCK_MARKERS.meeting), /不是 JSON/u);
  } finally {
    meetings.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("§74 回覆裡的 ALICE_MEETING 區塊不顯示給主人、可以有多個", () => {
  const filter = new AliceBlockFilter(() => {});
  filter.push("已登記。\n<<<ALICE_MEETING\n{\"add\":\"10/08 1500 會\"}\nALICE_MEE");
  filter.push("TING>>>\n<<<ALICE_MEETING\n{\"remove\":\"abcd1234\"}\nALICE_MEETING>>>");
  const result = filter.finish();
  assert.equal(result.visibleText.trim(), "已登記。");
  assert.equal(result.meetingBlockTexts?.length, 2);
});
