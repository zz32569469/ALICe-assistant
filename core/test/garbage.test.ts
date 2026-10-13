import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GarbageError, GarbageService, parseEntries, weekdayText } from "../src/life/garbageService.js";
import { buildChatPrompt } from "../src/prompt/promptBuilder.js";

// §97：設定檢查（時間格式、至少一天、提醒分鐘數整理）與週幾的寫法。
test("garbage entries are validated", () => {
  const [entry] = parseEntries([{ kind: "recycle", weekdays: [5, 1, 1, 9], time: "19:30", before: [5, 15, 999, 15] }]);
  assert.equal(entry!.label, "資源回收");
  assert.deepEqual(entry!.weekdays, [1, 5]);
  assert.deepEqual(entry!.before, [15, 5]);
  assert.equal(entry!.enabled, true);
  assert.deepEqual(parseEntries([{ kind: "garbage", weekdays: [1], time: "07:00" }])[0]!.before, [10]);
  assert.throws(() => parseEntries([{ kind: "garbage", weekdays: [], time: "19:30" }]), GarbageError);
  assert.throws(() => parseEntries([{ kind: "garbage", weekdays: [1], time: "7:30" }]), /HH:MM/u);
  assert.throws(() => parseEntries("x"), GarbageError);
  assert.equal(weekdayText([0, 1, 2, 4, 5, 6]), "週一、二、四、五、六、日");
  assert.equal(weekdayText([0, 1, 2, 3, 4, 5, 6]), "每天");
});

// §97：到點提醒（同一時間合成一則、每個提前時間只提醒一次、略過今天不提醒）。
test("garbage reminders fire once per mark and respect skip", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-garbage-"));
  // 2026-10-13 是週二。
  let now = new Date(2026, 9, 13, 19, 0);
  const garbage = new GarbageService({ file: join(directory, "garbage.json"), now: () => now });
  try {
    assert.equal(garbage.promptLine(), undefined);
    const entries = garbage.save([
      { id: "g", kind: "garbage", weekdays: [1, 2, 4, 5, 6], time: "19:30", before: [15, 5], place: "巷口" },
      { id: "r", kind: "recycle", weekdays: [2, 5], time: "19:30", before: [15] },
      { id: "k", kind: "other", label: "廚餘", weekdays: [3], time: "19:30" },
    ]);
    assert.equal(entries.length, 3);
    assert.deepEqual(garbage.today().map(({ entry }) => entry.id), ["g", "r"]);

    assert.deepEqual(garbage.dueReminders(), []);
    now = new Date(2026, 9, 13, 19, 16);
    const [first, ...rest] = garbage.dueReminders();
    assert.equal(rest.length, 0);
    assert.equal(first!.title, "🚛 垃圾車 14 分鐘後到");
    assert.equal(first!.body, "19:30 一般垃圾、資源回收（巷口）");
    assert.deepEqual(garbage.dueReminders(), []);
    now = new Date(2026, 9, 13, 19, 26);
    assert.equal(garbage.dueReminders()[0]!.minutes, 4);
    assert.deepEqual(garbage.dueReminders(), []);
    now = new Date(2026, 9, 13, 19, 31);
    assert.deepEqual(garbage.dueReminders(), []);

    // 週五：略過一般垃圾，只剩回收，而且叫回收車。
    now = new Date(2026, 9, 16, 19, 20);
    assert.equal(garbage.setSkip("g", true), true);
    assert.equal(garbage.setSkip("nope", true), false);
    const [friday] = garbage.dueReminders();
    assert.equal(friday!.title, "🚛 回收車 10 分鐘後到");
    assert.equal(friday!.body, "19:30 資源回收");
    assert.match(garbage.promptLine()!, /^今天：19:30 一般垃圾（主人說今天略過）、19:30 資源回收；明天：19:30 一般垃圾。固定時間：/u);

    const prompt = buildChatPrompt({ personaText: "P", factsText: null, history: [], userText: "今天有收垃圾嗎", state: { mood: "neutral", activity: "idle", updatedAt: "" } as never, justWoken: false, now, uploadsDir: directory, garbageLine: garbage.promptLine() });
    assert.match(prompt.systemPrompt, /# 垃圾車、回收車（主人在垃圾車分頁設定）\n\n今天：/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
