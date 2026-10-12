import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GameStore } from "../src/games/gameStore.js";
import { GameService } from "../src/games/gameService.js";
import { StageGuide, cellText, parseStageTable, responsibleSession } from "../src/games/stageGuide.js";
import { useWorkflow } from "../src/games/workflow.js";
import { TEST_WORKFLOW } from "./testWorkflow.js";

const BUILD_PAGE = [
  "# 開發工程師",
  "",
  "## 大階段",
  "",
  "| # | 階段 | 工作項 | 判定 | 使用者決定 |",
  "| --- | --- | --- | --- | --- |",
  "| 1 | 需求確認 | W01 | — | 範圍與時程 |",
  "| 1a | 設計文件 | [[17-文件\\|17]] | — | — |",
  "| 2 | 實作 | W20 | 單元測試、`/code-review` | — |",
  "| 3 | 整合測試 | W10 | **通過率** 達標，見 [[頁面#段落\\|套組]] | 測試範圍 |",
  "| 4 | 上線準備 | W25 | [[分支管理#上線\\|上線]] | 說「上線」 |",
  "",
  "### 接手 session",
  "| 項目 | 內容 |",
].join("\n");

const DOCS_PAGE = [
  "## 大階段",
  "",
  "| # | 階段 | 見 |",
  "| --- | --- | --- |",
  "| 1 | 撰寫 | 04 |",
  "| 3 | 審閱 | 03 |",
].join("\n");

test("解析角色頁大階段表：用表頭找欄、去掉連結與粗體、「—」當沒有", () => {
  const rows = parseStageTable(BUILD_PAGE);
  assert.deepEqual(rows.get("1"), { criteria: null, decisions: "範圍與時程" });
  assert.deepEqual(rows.get("2"), { criteria: "單元測試、`/code-review`", decisions: null });
  assert.deepEqual(rows.get("3"), { criteria: "通過率 達標，見 套組", decisions: "測試範圍" });
  assert.equal(rows.get("4")?.criteria, "上線");
  assert.equal(rows.has("項目"), false);
  // 沒有判定欄的表：只有 # 也能讀，判定是 null。
  assert.deepEqual(parseStageTable(DOCS_PAGE).get("1"), { criteria: null, decisions: null });
  // 表格標題可以換。
  assert.equal(parseStageTable(BUILD_PAGE.replace("## 大階段", "## 專案階段"), "專案階段").get("2")?.criteria, "單元測試、`/code-review`");
  assert.equal(parseStageTable(BUILD_PAGE, "專案階段").size, 0);
  assert.equal(cellText("[[a/b/c]]"), "c");
  assert.equal(cellText(" – "), null);
});

test("StageGuide：依流程設定的對照找列；1a 與沒有內容的列不回傳；角色頁改了會重讀", () => {
  useWorkflow(TEST_WORKFLOW);
  const root = mkdtempSync(join(tmpdir(), "alice-guide-"));
  try {
    mkdirSync(join(root, "roles"));
    writeFileSync(join(root, "roles", "開發工程師.md"), BUILD_PAGE);
    writeFileSync(join(root, "roles", "文件工程師.md"), DOCS_PAGE);
    const guide = new StageGuide({ path: root, summaryPage: "s.md", rolesDir: "roles" });
    assert.deepEqual(guide.lookup("build", "整合測試"), { criteria: "通過率 達標，見 套組", decisions: "測試範圍" });
    assert.equal(guide.lookup("build", "上線準備")?.decisions, "說「上線」");
    assert.equal(guide.lookup("build", "完成"), null);
    assert.equal(guide.lookup("docs", "等待實作"), null);
    assert.equal(guide.lookup("docs", "撰寫"), null);
    assert.equal(guide.lookup("other", "撰寫"), null);
    writeFileSync(join(root, "roles", "文件工程師.md"), DOCS_PAGE.replace("| # | 階段 | 見 |\n| --- | --- | --- |", "| # | 階段 | 見 | 判定 |\n| --- | --- | --- | --- |").replace("| 3 | 審閱 | 03 |", "| 3 | 審閱 | 03 | 兩人審過 |"));
    assert.equal(guide.lookup("docs", "審閱")?.criteria, "兩人審過");
    assert.equal(new StageGuide(null).lookup("build", "整合測試"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("負責的 session：依流程設定由上往下找，fromStage 以後才換接手的 session", () => {
  useWorkflow(TEST_WORKFLOW);
  const sessions = ["App - dev", "App - writer", "App - dev 2"];
  assert.equal(responsibleSession(sessions, "build", "整合測試"), "App - dev");
  assert.equal(responsibleSession(sessions, "build", "上線準備"), "App - dev 2");
  assert.equal(responsibleSession(sessions.slice(0, 2), "build", "上線準備"), "App - dev");
  assert.equal(responsibleSession(sessions, "docs", "撰寫"), "App - writer");
  assert.equal(responsibleSession([], "docs", "撰寫"), null);
  assert.equal(responsibleSession(sessions, "other", "撰寫"), null);
});

test("進度資料與專案卡帶負責 session、完成條件、要主人決定的事", () => {
  useWorkflow(TEST_WORKFLOW);
  const root = mkdtempSync(join(tmpdir(), "alice-guide-"));
  const store = new GameStore(join(root, "games.db"));
  try {
    const game = store.create({ name: "測試專案", trackStages: { build: "整合測試" }, sessions: ["App - dev", "App - writer"] });
    const service = new GameService({
      store, projects: () => [],
      guide: (track, stage) => track === "build" && stage === "整合測試" ? { criteria: "通過率達標", decisions: "測試範圍" } : null,
    });
    const text = service.progress(["測試專案"]).text;
    assert.match(text, /- 開發「整合測試」：負責 App - dev；完成條件：通過率達標；要主人決定：測試範圍/u);
    assert.match(text, /- 文件「等待實作」：負責 App - writer\n/u);
    const card = service.cards().find((entry) => entry.id === game.id)!;
    assert.deepEqual(card.tracks.build, { owner: "App - dev", guide: { criteria: "通過率達標", decisions: "測試範圍" } });
    assert.deepEqual(card.tracks.docs, { owner: "App - writer", guide: null });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
