import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadLatestCodexSession, parseCodexUsageJsonl, parseMaxUsage, QuotaService } from "../src/usage/quota.js";

// 測試 Max 純文字的 session 與全模型週額度百分比、重置文字可被精確拆出。
test("parses Max usage output", () => {
  const result = parseMaxUsage([
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 30% used · resets Sep 30, 3:30pm (Asia/Taipei)",
    "Current week (all models): 4% used · resets Oct 7, 10am (Asia/Taipei)",
    "Current week (Fable): 0% used · resets Oct 7, 10am (Asia/Taipei)",
  ].join("\n"));
  assert.deepEqual(result, {
    status: "ok",
    currentSession: { usedPercent: 30, resets: "Sep 30, 3:30pm (Asia/Taipei)" },
    currentWeek: { usedPercent: 4, resets: "Oct 7, 10am (Asia/Taipei)" },
  });
});

// 測試 Max 格式不符時不拋錯，並以最多 200 字樣本協助後續診斷。
test("reports unparseable Max output with a bounded sample", () => {
  const text = "unexpected ".repeat(30);
  const result = parseMaxUsage(text);
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.message, "無法解析");
    assert.equal(result.sample?.length, 200);
  }
});

// 測試 Codex JSONL 從最後一筆 token_count 寬鬆接受 snake_case 與 camelCase rate_limits 欄位。
test("parses the latest Codex token_count rate limits", () => {
  const now = Date.parse("2026-09-30T00:00:00.000Z");
  const text = [
    JSON.stringify({ type: "token_count", rate_limits: { primary: { used_percent: 1, resets_in_seconds: 10 } } }),
    "not-json",
    JSON.stringify({ type: "event_msg", payload: {
      type: "token_count",
      rate_limits: {
        primary: { usedPercent: 12.5, resetsInSeconds: 60 },
        secondary: { percent_used: 34, resets_at: 1_800_000_000 },
      },
    } }),
  ].join("\n");
  const result = parseCodexUsageJsonl(text, now);
  assert.deepEqual(result, {
    status: "ok",
    primary: { usedPercent: 12.5, resets: "2026-09-30T00:01:00.000Z" },
    secondary: { usedPercent: 34, resets: "2027-01-15T08:00:00.000Z" },
  });
});

// 測試兩個額度來源拋錯時服務仍回傳具原因的錯誤，而且 60 秒內不會再次呼叫來源。
test("quota failures are returned and cached for 60 seconds", async () => {
  let now = 1_000;
  let maxCalls = 0;
  let codexCalls = 0;
  const service = new QuotaService({
    now: () => now,
    loadMax: async () => { maxCalls += 1; throw new Error("max boom"); },
    loadCodex: async () => { codexCalls += 1; throw new Error("codex boom"); },
  });
  const first = await service.read();
  now += 59_999;
  const cached = await service.read();
  assert.deepEqual(cached, first);
  assert.deepEqual([maxCalls, codexCalls], [1, 1]);
  assert.match(first.max.status === "error" ? first.max.reason : "", /max boom/);
  assert.match(first.codex.status === "error" ? first.codex.reason : "", /codex boom/);

  now += 1;
  await service.read();
  assert.deepEqual([maxCalls, codexCalls], [2, 2]);
});

// 測試最新的 Codex session 還沒有 rate_limits（例如因額度用完中斷）時，會往前找到最近一個有額度資料的 session。
test("latest Codex session without rate_limits falls back to an older session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-codex-sessions-"));
  try {
    const day = join(directory, "2026", "09", "30");
    mkdirSync(day, { recursive: true });
    const older = join(day, "rollout-older.jsonl");
    const newer = join(day, "rollout-newer.jsonl");
    writeFileSync(older, JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12, resets_in_seconds: 60 } } } }) + "\n");
    // 實際案例：額度用完時最新 session 仍寫出 rate_limits，但 primary／secondary 為 null。
    writeFileSync(newer, JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: null, secondary: null } } }) + "\n");
    utimesSync(older, new Date("2026-09-30T01:00:00Z"), new Date("2026-09-30T01:00:00Z"));
    utimesSync(newer, new Date("2026-09-30T02:00:00Z"), new Date("2026-09-30T02:00:00Z"));
    const text = await loadLatestCodexSession(directory);
    assert.equal(parseCodexUsageJsonl(text).status, "ok");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
