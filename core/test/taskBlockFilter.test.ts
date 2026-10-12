import assert from "node:assert/strict";
import test from "node:test";

import { TaskBlockFilter } from "../src/tasks/taskBlockFilter.js";
import { AliceBlockFilter } from "../src/tasks/aliceBlockFilter.js";

function run(deltas: string[]): { emitted: string; visibleText: string; blockText?: string } {
  let emitted = "";
  const filter = new TaskBlockFilter((text) => { emitted += text; });
  for (const delta of deltas) filter.push(delta);
  return { emitted, ...filter.finish() };
}

const block = '<<<ALICE_TASK\n{"tool":"codex"}\nALICE_TASK>>>';

// 測試完整標記出現在單一 delta 時，主人只會看見標記前的正文。
test("filters a task block contained in one delta", () => {
  assert.deepEqual(run([`可見內容\n${block}`]), {
    emitted: "可見內容\n",
    visibleText: "可見內容\n",
    blockText: block,
  });
});

// 測試開始標記跨兩個 delta 時仍能攔截，避免任務 JSON 洩漏到串流事件。
test("filters a task marker split across deltas", () => {
  const result = run(["可見<<<ALI", `CE_TASK\n{}\nALICE_TASK>>>`]);
  assert.equal(result.emitted, "可見");
  assert.equal(result.blockText, "<<<ALICE_TASK\n{}\nALICE_TASK>>>");
});

// 測試僅像標記的普通文字會在確認不匹配後立即釋放，不吞掉使用者可見內容。
test("preserves text that only resembles the marker prefix", () => {
  const result = run(["前文<<<ALI", "X 後文"]);
  assert.equal(result.emitted, "前文<<<ALIX 後文");
  assert.equal(result.blockText, undefined);
});

// 測試一則回覆含兩個區塊時只回傳第一個，確保 Core 不會建立多個任務。
test("returns only the first of multiple task blocks", () => {
  const second = '<<<ALICE_TASK\n{"tool":"codex","goal":"second"}\nALICE_TASK>>>';
  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const result = run([`說明${block}\n${second}`]);
    assert.equal(result.blockText, block);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

function runAlice(deltas: string[]) {
  let emitted = "";
  const filter = new AliceBlockFilter((text) => { emitted += text; });
  for (const delta of deltas) filter.push(delta);
  return { emitted, ...filter.finish() };
}

// 測試單獨的 ALICE_ASK 區塊不會顯示或存入主回覆，避免派工協定洩漏給主人。
test("filters an ALICE_ASK block", () => {
  const ask = '<<<ALICE_ASK\n{"role":"工程師"}\nALICE_ASK>>>';
  assert.deepEqual(runAlice([`先查一下\n${ask}`]), {
    emitted: "先查一下\n",
    visibleText: "先查一下\n",
    askBlockText: ask,
  });
});

// 測試同一則回覆的任務與部下區塊都會被擷取，確保兩條工作流程可同時啟動。
test("filters ALICE_TASK and ALICE_ASK blocks in one reply", () => {
  const ask = '<<<ALICE_ASK\n{"role":"工程師"}\nALICE_ASK>>>';
  const result = runAlice([`正文${block}\n${ask}`]);
  assert.equal(result.visibleText, "正文\n");
  assert.equal(result.taskBlockText, block);
  assert.equal(result.askBlockText, ask);
});

// 測試 ALICE_ASK 的開始與結束標記跨 delta 仍能完整攔截，避免串流切片造成 JSON 外洩。
test("filters split ALICE_ASK markers across deltas", () => {
  const result = runAlice(["正文<<<ALICE_", 'ASK\n{"question":"查"}\nALICE_', "ASK>>>"]);
  assert.equal(result.emitted, "正文");
  assert.equal(result.askBlockText, '<<<ALICE_ASK\n{"question":"查"}\nALICE_ASK>>>');
});
