import assert from "node:assert/strict";
import test from "node:test";

import { CharacterState } from "../src/state/characterState.js";

function clock(initial: Date): {
  now: () => Date;
  advanceMinutes: (amount: number) => void;
} {
  let current = initial.getTime();
  return {
    now: () => new Date(current),
    advanceMinutes: (amount) => {
      current += amount * 60_000;
    },
  };
}

// 測試 E1、E2 會在收到訊息與回覆結束時切換 talking／idle，建立基本對話生命週期。
test("E1 and E2 transition between idle and talking", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  machine.onUserMessage();
  assert.equal(machine.getState().activity, "talking");
  machine.onReplyEnd({ ok: true });
  assert.equal(machine.getState().activity, "idle");
});

// 測試 E3、E4 支援多個任務計數，只有最後一個任務結束才回到 idle。
test("E3 and E4 count concurrent tasks", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  machine.onTaskStart();
  machine.onTaskStart();
  assert.equal(machine.getState().activity, "busy");
  machine.onTaskEnd();
  assert.equal(machine.getState().activity, "busy");
  machine.onTaskEnd();
  assert.equal(machine.getState().activity, "idle");
});

// 測試任務中收到訊息時 talking 優先，回覆結束後恢復 busy，確保狀態優先序正確。
test("talking takes priority over busy", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  machine.onTaskStart();
  machine.onUserMessage();
  assert.equal(machine.getState().activity, "talking");
  machine.onReplyEnd({ ok: true });
  assert.equal(machine.getState().activity, "busy");
});

// 測試 E5 以最近活動起算 30 分鐘後進入 idle_timeout 睡眠，避免過早休眠。
test("E5 sleeps after the idle timeout", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  time.advanceMinutes(29);
  machine.tick();
  assert.equal(machine.getState().activity, "idle");
  time.advanceMinutes(1);
  machine.tick();
  assert.equal(machine.getState().sleepReason, "idle_timeout");
});

// 測試 E6 在深夜時段閒置五分鐘即以 night 入睡，覆蓋跨午夜時段判斷。
test("E6 sleeps after five idle minutes at night", () => {
  const time = clock(new Date(2026, 8, 29, 0, 56));
  const machine = new CharacterState({ now: time.now });

  time.advanceMinutes(5);
  machine.tick();
  assert.deepEqual(
    { activity: machine.getState().activity, reason: machine.getState().sleepReason },
    { activity: "sleeping", reason: "night" },
  );
});

// 測試任務進行時 tick 不會觸發 E5／E6，確保忙碌工作不被休眠狀態蓋掉。
test("active tasks prevent idle and night sleep", () => {
  const time = clock(new Date(2026, 8, 29, 0, 0));
  const machine = new CharacterState({ now: time.now });

  machine.onTaskStart();
  time.advanceMinutes(90);
  machine.tick();
  assert.equal(machine.getState().activity, "busy");
});

// 測試 E7 喚醒時只在該次回覆期間標示 justWoken，避免提示長期誤報剛醒。
test("E7 marks justWoken until the reply ends", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });
  time.advanceMinutes(30);
  machine.tick();

  machine.onUserMessage();
  assert.equal(machine.getState().activity, "talking");
  assert.equal(machine.isJustWoken(), true);
  machine.onReplyEnd({ ok: true });
  assert.equal(machine.isJustWoken(), false);
});

// 測試 E8 的 auth 錯誤立即進入 reasoning_unavailable，避免無效驗證持續重試。
test("E8 auth failure sleeps immediately", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  machine.onUserMessage();
  machine.onReplyEnd({ ok: false, kind: "auth" });
  assert.equal(machine.getState().sleepReason, "reasoning_unavailable");
});

// 測試 E8 只在第三次連續 network 錯誤後休眠，符合可調式失敗門檻。
test("E8 sleeps after three consecutive network failures", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    machine.onUserMessage();
    machine.onReplyEnd({ ok: false, kind: "network" });
    assert.equal(machine.getState().activity, attempt === 3 ? "sleeping" : "idle");
  }
});

// 測試 rate_limited 不納入 E8 且成功會清除既有失敗計數，避免限流誤判為引擎離線。
test("rate limiting is excluded from E8 and success resets failures", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  machine.onUserMessage();
  machine.onReplyEnd({ ok: false, kind: "network" });
  machine.onUserMessage();
  machine.onReplyEnd({ ok: false, kind: "rate_limited" });
  assert.equal(machine.getState().activity, "idle");
  machine.onUserMessage();
  machine.onReplyEnd({ ok: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    machine.onUserMessage();
    machine.onReplyEnd({ ok: false, kind: "other" });
  }
  assert.equal(machine.getState().activity, "idle");
});

// 測試 E9 在 reasoning_unavailable 後成功回覆會恢復 idle，確認引擎恢復路徑。
test("E9 successful retry leaves reasoning_unavailable sleep", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });
  machine.onUserMessage();
  machine.onReplyEnd({ ok: false, kind: "auth" });

  machine.onUserMessage();
  machine.onReplyEnd({ ok: true });
  assert.equal(machine.getState().activity, "idle");
  assert.equal(machine.getState().sleepReason, undefined);
});

// 測試 reasoning_unavailable 後再試仍失敗會立即回睡，不必重新累計三次。
test("failed retry returns to reasoning_unavailable sleep", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });
  machine.onUserMessage();
  machine.onReplyEnd({ ok: false, kind: "auth" });

  machine.onUserMessage();
  machine.onReplyEnd({ ok: false, kind: "rate_limited" });
  assert.equal(machine.getState().sleepReason, "reasoning_unavailable");
});

// 測試精神涵蓋 normal、醒後 high、夜間 low，且 low 與 high 同時符合時以 low 為準。
test("energy supports all levels and low overrides high", () => {
  const normalTime = clock(new Date(2026, 8, 29, 12, 0));
  const normalMachine = new CharacterState({ now: normalTime.now });
  assert.equal(normalMachine.getState().energy, "normal");
  normalTime.advanceMinutes(30);
  normalMachine.tick();
  normalMachine.onUserMessage();
  assert.equal(normalMachine.getState().energy, "high");

  const nightTime = clock(new Date(2026, 8, 29, 21, 30));
  const nightMachine = new CharacterState({ now: nightTime.now });
  nightTime.advanceMinutes(30);
  nightMachine.tick();
  nightMachine.onUserMessage();
  assert.equal(nightMachine.getState().energy, "low");
});

// 測試相鄰訊息皆未超過閒置門檻且持續逾兩小時會變為 low，落實連續對話定義。
test("long continuous conversation lowers energy", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });

  for (let index = 0; index < 6; index += 1) {
    machine.onUserMessage();
    if (index < 5) {
      machine.onReplyEnd({ ok: true });
      time.advanceMinutes(25);
    }
  }
  assert.equal(machine.getState().energy, "low");
});

// 測試訂閱只在公開狀態欄位實際改變時通知，且取消後不再收到事件。
test("subscribe emits only for state changes and supports unsubscribe", () => {
  const time = clock(new Date(2026, 8, 29, 12, 0));
  const machine = new CharacterState({ now: time.now });
  const activities: string[] = [];
  const unsubscribe = machine.subscribe((state) => activities.push(state.activity));

  machine.tick();
  machine.onUserMessage();
  machine.onUserMessage();
  machine.onReplyEnd({ ok: true });
  machine.tick();
  unsubscribe();
  machine.onTaskStart();

  assert.deepEqual(activities, ["talking", "idle"]);
});
