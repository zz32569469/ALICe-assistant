import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GameConfirmationStore, type GameConfirmation } from "../src/games/gameConfirmations.js";
import { GameService } from "../src/games/gameService.js";
import { GameStore } from "../src/games/gameStore.js";
import { DEFAULT_WORKFLOW, useWorkflow } from "../src/games/workflow.js";
import { ALICE_BLOCK_MARKERS } from "../src/tasks/aliceBlockFilter.js";
import { TEST_WORKFLOW } from "./testWorkflow.js";

const block = (value: unknown) => `${ALICE_BLOCK_MARKERS.game.start}\n${JSON.stringify(value)}\n${ALICE_BLOCK_MARKERS.game.end}`;

function setup() {
  useWorkflow(TEST_WORKFLOW);
  const root = mkdtempSync(join(tmpdir(), "alice-confirm-"));
  const store = new GameStore(join(root, "a.db"));
  const confirmations = new GameConfirmationStore(join(root, "a.db"));
  const notified: GameConfirmation[] = [];
  const service = new GameService({ store, projects: () => [], confirmations, onConfirmation: (entry) => notified.push(entry) });
  const game = store.create({ name: "測試專案", trackStages: { build: "實作" } });
  store.addTask(game.id, { title: "匯出功能", track: "build", status: "進行中", version: game.version });
  store.addTask(game.id, { title: "說明文件", track: "docs", status: "待辦", version: game.version });
  const cleanup = () => { confirmations.close(); store.close(); rmSync(root, { recursive: true, force: true }); };
  return { store, service, notified, cleanup };
}

test("任務完成與換階段先保留給主人確認，其他變更直接套用", () => {
  const { store, service, notified, cleanup } = setup();
  try {
    const text = service.applyBlock(block({
      action: "update", name: "測試專案", stages: { build: "整合測試" }, reason: "同事回報實作完成",
      tasks: [{ op: "update", id: "T1", status: "完成", note: "測試通過" }, { op: "update", id: "T2", status: "進行中" }],
    }));
    const game = store.find("測試專案")!;
    assert.equal(game.trackStages.build, "實作");
    assert.deepEqual(store.tasks(game.id).map((task) => task.status), ["進行中", "進行中"]);
    assert.match(text, /T2 說明文件：待辦 → 進行中/u);
    assert.match(text, /等主人確認後才更新\n- 開發：實作 → 整合測試\n- T1 匯出功能〔開發〕：進行中 → 完成（測試通過）/u);
    assert.equal(notified.length, 1);
    assert.equal(notified[0]!.reason, "同事回報實作完成");
    assert.deepEqual(service.pendingConfirmations().map((entry) => entry.id), [notified[0]!.id]);

    const approved = service.resolveConfirmation(notified[0]!.id, "approve")!;
    assert.match(approved, /^主人確認了：開發/u);
    const after = store.find("測試專案")!;
    assert.equal(after.trackStages.build, "整合測試");
    assert.equal(store.tasks(after.id)[0]!.status, "完成");
    assert.equal(service.resolveConfirmation(notified[0]!.id, "approve"), undefined);
    assert.deepEqual(service.pendingConfirmations(), []);
  } finally {
    cleanup();
  }
});

test("主人不確認就維持原狀；沒有要確認的變更不出卡片；開新版本與建卡不保留", () => {
  const { store, service, notified, cleanup } = setup();
  try {
    service.applyBlock(block({ action: "update", name: "測試專案", tasks: [{ op: "update", id: "T1", status: "完成" }] }));
    assert.match(service.resolveConfirmation(notified[0]!.id, "reject")!, /^主人沒有確認，測試專案維持原狀/u);
    assert.equal(store.tasks(store.find("測試專案")!.id)[0]!.status, "進行中");

    service.applyBlock(block({ action: "update", name: "測試專案", stages: { build: "實作" }, tasks: [{ op: "update", id: "T2", note: "補充" }] }));
    assert.equal(notified.length, 1);

    service.applyBlock(block({ action: "create", name: "新專案", stages: { docs: "撰寫" } }));
    assert.deepEqual(store.find("新專案")!.trackStages, { build: "需求確認", docs: "撰寫" });
    assert.equal(notified.length, 1);
  } finally {
    cleanup();
  }
});

test("沒有確認功能時照舊直接套用", () => {
  useWorkflow(DEFAULT_WORKFLOW);
  const root = mkdtempSync(join(tmpdir(), "alice-confirm-"));
  const store = new GameStore(join(root, "a.db"));
  try {
    store.create({ name: "測試專案" });
    new GameService({ store, projects: () => [] }).applyBlock(block({ action: "update", name: "測試專案", stage: "進行中" }));
    assert.equal(store.find("測試專案")!.trackStages.main, "進行中");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
