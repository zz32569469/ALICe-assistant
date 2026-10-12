import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryKeeper, SECTION_END, SECTION_START, parseConsolidation, readSection, replaceSection } from "../src/memory/memoryKeeper.js";
import { MessageStore } from "../src/store/messageStore.js";
import { ALICE_BLOCK_MARKERS } from "../src/tasks/aliceBlockFilter.js";

const block = (body: string) => `${ALICE_BLOCK_MARKERS.memory.start}\n${body}\n${ALICE_BLOCK_MARKERS.memory.end}`;

test("§85 整理區：只換標記之間，主人手寫的部分不動；沒有就加在檔尾", () => {
  const hand = "# 事實檔\n\n- 主人叫 Joe\n";
  const first = replaceSection(hand, "- 喜歡黑咖啡");
  assert.ok(first.startsWith(hand.trimEnd()));
  assert.equal(readSection(first), "- 喜歡黑咖啡");
  const second = replaceSection(`${first}\n主人後來手寫的一行\n`, "- 喜歡拿鐵");
  assert.equal(readSection(second), "- 喜歡拿鐵");
  assert.match(second, /主人叫 Joe[\s\S]*喜歡拿鐵[\s\S]*主人後來手寫的一行/u);
  assert.equal(second.split(SECTION_START).length, 2);
  assert.equal(readSection(hand), "");
});

test("§85 整理結果：JSON 解析、條目上限", () => {
  assert.deepEqual(parseConsolidation('```json\n{"section":"- a","added":["a"],"removed":[]}\n```'), { section: "- a", added: ["a"], removed: [] });
  assert.throws(() => parseConsolidation('{"added":[]}'), /section/u);
  assert.throws(() => parseConsolidation(JSON.stringify({ section: Array.from({ length: 41 }, (_, index) => `- ${index}`).join("\n") })), /40/u);
});

test("§85 記筆記、每天整理一次：寫進整理區、先備份、筆記用掉、失敗不改檔", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alice-memory-"));
  const messages = new MessageStore(join(dir, "alice.db"));
  const factsPath = join(dir, "facts.md");
  writeFileSync(factsPath, "# 事實檔\n\n- 主人叫 Joe\n");
  let clock = new Date(2026, 9, 12, 3, 0);
  const prompts: string[] = [];
  let reply = JSON.stringify({ section: "### 偏好\n- 喝咖啡不加糖", added: ["喝咖啡不加糖"], removed: [] });
  const keeper = new MemoryKeeper({
    dbPath: join(dir, "alice.db"), factsPath, backupDir: join(dir, "backups"), messages, now: () => clock,
    interpret: async (prompt) => { prompts.push(prompt); return reply; },
  });
  try {
    assert.equal(keeper.due(), false);
    assert.match(keeper.applyBlock(block('{"note":"主人喝咖啡不加糖"}'), ALICE_BLOCK_MARKERS.memory), /ALICe 記下了：主人喝咖啡不加糖/u);
    assert.match(keeper.applyBlock(block("x"), ALICE_BLOCK_MARKERS.memory), /不是 JSON/u);
    messages.append({ role: "user", text: "我喝咖啡都不加糖", thread: "chat" });
    messages.append({ role: "user", text: "［來自 session〈X - dev〉］\n【進度】不該進記憶" });
    messages.append({ role: "alice", text: "好的，記下了" });
    assert.equal(keeper.due(), false);
    clock = new Date(2026, 9, 12, 4, 30);
    assert.equal(keeper.due(), true);

    const text = (await keeper.tick())!;
    assert.match(text, /ALICe 整理了記憶（事實檔的「ALICe 記住的事」，共 1 條）\n＋ 喝咖啡不加糖/u);
    const facts = readFileSync(factsPath, "utf8");
    assert.match(facts, /主人叫 Joe[\s\S]*## ALICe 記住的事[\s\S]*喝咖啡不加糖[\s\S]*/u);
    assert.ok(facts.includes(SECTION_END));
    assert.equal(readdirSync(join(dir, "backups")).length, 1);
    assert.match(prompts[0]!, /2026-10-12：主人喝咖啡不加糖/u);
    assert.match(prompts[0]!, /主人（聊天）：我喝咖啡都不加糖/u);
    assert.doesNotMatch(prompts[0]!, /不該進記憶/u);
    assert.deepEqual(keeper.pendingNotes(), []);
    assert.equal(keeper.due(), false);

    // 隔天沒有新東西就不整理；有新對話才整理，只看上次之後的。
    clock = new Date(2026, 9, 13, 9, 0);
    assert.equal(keeper.due(), false);
    messages.append({ role: "user", text: "最近開始跑步" });
    assert.equal(keeper.due(), true);
    reply = "不是 JSON";
    assert.match((await keeper.consolidate())!, /記憶整理失敗，事實檔沒有改/u);
    assert.equal(readFileSync(factsPath, "utf8"), facts);
    assert.doesNotMatch(prompts[1]!, /我喝咖啡都不加糖/u);
    assert.match(prompts[1]!, /最近開始跑步/u);
  } finally {
    keeper.close();
    messages.close();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(existsSync(dir), false);
});
