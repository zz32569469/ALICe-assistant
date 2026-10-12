import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FortuneError, FortuneService, TAROT_DECK, drawCards, fortunePrompt, periodOf } from "../src/fortune/fortuneService.js";

test("§77 牌組 78 張不重複；期別：今日到隔天 0 點、本週到下週一 0 點", () => {
  assert.equal(TAROT_DECK.length, 78);
  assert.equal(new Set(TAROT_DECK).size, 78);
  const wednesday = new Date(2026, 9, 14, 15, 30);
  assert.deepEqual(periodOf("short", wednesday), { period: "2026-10-14", nextAt: new Date(2026, 9, 15) });
  assert.deepEqual(periodOf("long", wednesday), { period: "2026-10-12週", nextAt: new Date(2026, 9, 19) });
  assert.equal(periodOf("long", new Date(2026, 9, 18, 23, 59)).period, "2026-10-12週");
  assert.equal(periodOf("long", new Date(2026, 9, 19, 0, 0)).period, "2026-10-19週");
});

test("§77 抽牌：短期 1 張、長期 3 張不重複，位置與正逆位由亂數決定", () => {
  assert.deepEqual(drawCards("short", () => 0), [{ name: "愚者", reversed: false, position: "今日" }]);
  const long = drawCards("long", (n) => n - 1);
  assert.deepEqual(long.map((card) => card.position), ["過去", "現在", "未來"]);
  assert.equal(new Set(long.map((card) => card.name)).size, 3);
  assert.equal(long.every((card) => card.reversed), true);
  const prompt = fortunePrompt("long", long, new Date(2026, 9, 12));
  assert.match(prompt, /不能換牌/u);
  assert.match(prompt, /### 工作運.*### 財運.*### 感情與人際.*### 健康/u);
  assert.match(prompt, /不要連結主人實際的工作/u);
  assert.match(prompt, /### 總結.*牌名 → 牌名 → 牌名.*濃縮成一句話/u);
  assert.match(fortunePrompt("short", long.slice(0, 1), new Date(2026, 9, 12, 5, 30)), /2026-10-12 05:30[\s\S]*### 總結」：先用一句話說今天/u);
});

test("§77 同一期只占一次，CD 沒到停在上一次；換期後可以再占", async () => {
  const root = mkdtempSync(join(tmpdir(), "alice-fortune-"));
  let clock = new Date(2026, 9, 12, 9, 0);
  const prompts: string[] = [];
  const service = new FortuneService({
    dbPath: join(root, "a.db"), now: () => clock, random: () => 0,
    interpret: async (prompt) => { prompts.push(prompt); return `解讀 ${prompts.length}`; },
  });
  try {
    assert.equal(service.slot("short").latest, null);
    assert.equal(service.slot("short").done, false);
    const first = await service.draw("short");
    assert.equal(first.text, "解讀 1");
    assert.deepEqual(service.slot("short"), { latest: first, done: true, nextAt: new Date(2026, 9, 13).toISOString(), generating: false });
    await assert.rejects(service.draw("short"), (error: unknown) => error instanceof FortuneError && error.code === "conflict");
    assert.equal(service.slot("long").done, false);

    clock = new Date(2026, 9, 13, 8, 0);
    assert.equal(service.slot("short").done, false);
    assert.equal(service.slot("short").latest?.text, "解讀 1");
    assert.equal((await service.draw("short")).text, "解讀 2");
    // §81：同一期重新解讀，牌不變、文字換新。
    const cards = service.slot("short").latest!.cards;
    assert.equal((await service.reinterpret("short")).text, "解讀 3");
    assert.deepEqual(service.slot("short").latest!.cards, cards);
    assert.equal(service.slot("short").latest!.text, "解讀 3");
    await assert.rejects(service.reinterpret("long"), (error: unknown) => error instanceof FortuneError && error.code === "conflict");

    const failing = new FortuneService({ dbPath: join(root, "a.db"), now: () => clock, interpret: async () => { throw new Error("x"); } });
    await assert.rejects(failing.draw("long"), /占卜失敗/u);
    assert.equal(failing.slot("long").latest, null);
    failing.close();
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
