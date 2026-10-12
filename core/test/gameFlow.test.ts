import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { defaultConfig } from "../src/config.js";
import { ConversationService } from "../src/conversation/conversationService.js";
import { applyGameBlock, parseGameBlock } from "../src/games/gameBlock.js";
import { GameService } from "../src/games/gameService.js";
import { GameStore } from "../src/games/gameStore.js";
import { collectProgress, extractSections, formatProgress } from "../src/games/progress.js";
import { DEFAULT_WORKFLOW, loadWorkflow, parseWorkflow, useWorkflow } from "../src/games/workflow.js";
import type { WorkerProjectConfig } from "../src/localConfig.js";
import { digestText, NotificationService, NotificationStore } from "../src/notify/notificationService.js";
import { formatGames, formatMeetings, formatSessions } from "../src/prompt/promptBuilder.js";
import { EventHub } from "../src/protocol/eventHub.js";
import { CharacterState } from "../src/state/characterState.js";
import { MessageStore } from "../src/store/messageStore.js";
import { AliceBlockFilter } from "../src/tasks/aliceBlockFilter.js";
import { FakeProvider } from "./fakeProvider.js";
import { TEST_WORKFLOW } from "./testWorkflow.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "alice-games-"));
}

function gameBlock(value: unknown): string {
  return `<<<ALICE_GAME\n${JSON.stringify(value)}\nALICE_GAME>>>`;
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 建一個有專案分支、一個未提交檔的 repo，以及專案文件資料夾。 */
function fixture(directory: string): { repo: WorkerProjectConfig; docsDir: string } {
  const repoPath = join(directory, "tool");
  mkdirSync(repoPath);
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "t@example.com"]);
  git(repoPath, ["config", "user.name", "t"]);
  writeFileSync(join(repoPath, "a.txt"), "a");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "init"]);
  git(repoPath, ["checkout", "-q", "-b", "feature/testProject"]);
  writeFileSync(join(repoPath, "b.txt"), "b");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-q", "-m", "加入功能 A"]);
  writeFileSync(join(repoPath, "c.txt"), "dirty");
  const docsDir = join(directory, "docs");
  mkdirSync(docsDir);
  writeFileSync(join(docsDir, "測試專案 更改紀錄.md"), [
    "# 測試專案 更改紀錄",
    "## 規格決定",
    "不該出現",
    "## 現況（2026-10-01）",
    "功能 A 做完，測試通過率 96%",
    "### 待客戶確認",
    "Q3 上限",
    "## 待回寫",
    "不該出現的回寫",
    "## 待修改",
    "```",
    "## 程式碼區塊裡的標題不算",
    "```",
    "修上限截斷",
  ].join("\n"));
  writeFileSync(join(docsDir, "其他專案 更改紀錄.md"), "## 現況\n別的專案");
  return {
    repo: { name: "工具專案", path: repoPath, role: "工程師", readDirs: [] },
    docsDir,
  };
}

// 測試流程設定：檢查格式、讀檔失敗時退回內建流程。
test("workflow settings are validated and fall back to the built-in flow", () => {
  assert.throws(() => parseWorkflow({ tracks: [] }), /至少要有一條/u);
  assert.throws(() => parseWorkflow({ tracks: [{ key: "Main", label: "x", stages: ["a", "b"] }] }), /key/u);
  assert.throws(() => parseWorkflow({ tracks: [{ key: "owner", label: "x", stages: ["a", "b"] }] }), /owner/u);
  assert.throws(() => parseWorkflow({ tracks: [{ key: "a", label: "x", stages: ["a", "b"], aliases: { z: "c" } }] }), /aliases/u);
  assert.equal(parseWorkflow({ tracks: [{ key: "a", label: "x", stages: ["a", "b"] }] }).taskSources.length, 3);
  assert.equal(loadWorkflow(null).workflow, DEFAULT_WORKFLOW);
  assert.match(loadWorkflow(join(tmpdir(), "no-such-workflow.json")).warning ?? "", /找不到流程設定/u);
  const directory = tempDir();
  try {
    writeFileSync(join(directory, "bad.json"), "{");
    assert.match(loadWorkflow(join(directory, "bad.json")).warning ?? "", /有錯/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試專案卡區塊的檢查：階段要在各條線的清單內（忽略空白、頓號、斜線，別名也認得）、日期要合法、代號只能英數、版本是數字。
test("parseGameBlock validates stages, deadline, code and version", () => {
  useWorkflow(TEST_WORKFLOW);
  const parsed = parseGameBlock(gameBlock({ action: "update", name: "測試專案", stages: { build: "整合 測試", docs: "撰寫" }, deadline: "2026-10-20" }));
  assert.deepEqual(parsed.fields.trackStages, { build: "整合測試", docs: "撰寫" });
  assert.deepEqual(parseGameBlock(gameBlock({ action: "update", name: "x", stage: "寫程式" })).fields.trackStages, { build: "實作" });
  assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", stages: { docs: "實作" } })), /stages\.docs 必須是/u);
  assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", stages: { other: "實作" } })), /stages 的 key/u);
  assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", version: "1" })), /version/u);
  assert.equal(parseGameBlock(gameBlock({ action: "update", name: "x", version: "1.0.1" })).fields.version, "1.0.1");
  assert.equal(parsed.fields.deadline, "2026-10-20");
  assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", deadline: "2026-02-30" })), /deadline/u);
  assert.throws(() => parseGameBlock(gameBlock({ action: "create", name: "x", code: "有空 格" })), /code/u);
  assert.throws(() => parseGameBlock(gameBlock({ action: "delete", name: "x" })), /action/u);
  assert.equal(parseGameBlock(gameBlock({ action: "update", name: "x", deadline: null })).fields.deadline, null);
});

// 測試建立與修改專案卡：重複建立會被擋、repos 只能用本機設定的專案、換階段留下歷史、開新版本的規則。
test("applyGameBlock creates and updates cards with stage history", () => {
  useWorkflow(TEST_WORKFLOW);
  const directory = tempDir();
  const store = new GameStore(join(directory, "alice.db"));
  try {
    const created = applyGameBlock(store, gameBlock({ action: "create", name: "測試專案", code: "testProject", deadline: "2026-10-20", repos: ["工具專案"] }), ["工具專案"], new Date("2026-10-01T01:00:00Z"));
    assert.match(created, /已建立專案卡：測試專案（v1.0.0，開發：需求確認，文件：等待實作，截止 2026-10-20）/u);
    assert.match(applyGameBlock(store, gameBlock({ action: "create", name: "測試專案" }), []), /已經有/u);
    assert.match(applyGameBlock(store, gameBlock({ action: "create", name: "B", repos: ["不存在"] }), ["工具專案"]), /不認得：不存在/u);
    const updated = applyGameBlock(store, gameBlock({ action: "update", name: "testproject", stages: { build: "整合測試", docs: "撰寫" } }), [], new Date("2026-10-03T01:00:00Z"));
    assert.match(updated, /開發 需求確認 → 整合測試、文件 等待實作 → 撰寫/u);
    assert.match(applyGameBlock(store, gameBlock({ action: "update", name: "沒有這個", stage: "實作" }), []), /找不到/u);
    let game = store.find("測試專案")!;
    assert.deepEqual(store.stages(game.id).map((entry) => [entry.track, entry.stage]), [
      ["build", "需求確認"], ["docs", "等待實作"], ["build", "整合測試"], ["docs", "撰寫"],
    ]);
    assert.equal(game.deadline, "2026-10-20");
    // 還沒完成不能開新版本；每條線都完成後，開新版本要寫需求來源而且版號要變大。
    assert.match(applyGameBlock(store, gameBlock({ action: "update", name: "測試專案", version: "1.0.1", versionReason: "客戶回饋" }), []), /還沒完成/u);
    assert.match(applyGameBlock(store, gameBlock({ action: "update", name: "測試專案", stages: { build: "完成", docs: "完成" } }), []), /v1.0.0 完成/u);
    assert.match(applyGameBlock(store, gameBlock({ action: "update", name: "測試專案", version: "1.0.1" }), []), /versionReason/u);
    assert.match(applyGameBlock(store, gameBlock({ action: "update", name: "測試專案", version: "0.9.0", versionReason: "x" }), []), /必須大於/u);
    const next = applyGameBlock(store, gameBlock({ action: "update", name: "測試專案", version: "1.0.1", versionReason: "客戶要加匯出功能", stages: { build: "實作" } }), []);
    assert.match(next, /版本 v1.0.0 → v1\.0\.1、開發 完成 → 實作/u);
    game = store.find("測試專案")!;
    assert.equal(game.versionReason, "客戶要加匯出功能");
    assert.equal(game.trackStages.docs, "完成");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試舊資料庫遷移：固定兩欄（stage、adapter_stage）換成每條線一個階段的對照；重開不會重複遷移。
test("GameStore migrates the fixed two-column stages", () => {
  useWorkflow(parseWorkflow({ tracks: [{ key: "prob", label: "甲線", stages: ["一", "二", "完成"] }, { key: "adapter", label: "乙線", stages: ["等", "做", "完成"] }] }));
  const directory = tempDir();
  const path = join(directory, "alice.db");
  try {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE games (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, code TEXT NOT NULL, docs_dir TEXT, file_prefix TEXT NOT NULL,
        spec TEXT NOT NULL, reference TEXT NOT NULL, deadline TEXT, stage TEXT NOT NULL, sections TEXT, repos TEXT NOT NULL,
        sessions TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        adapter_stage TEXT NOT NULL DEFAULT '等', version TEXT NOT NULL DEFAULT '1.0.0', version_reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE game_stages (game_id TEXT NOT NULL, stage TEXT NOT NULL, at TEXT NOT NULL, track TEXT NOT NULL DEFAULT 'prob');
      INSERT INTO games (id, name, code, docs_dir, file_prefix, spec, reference, deadline, stage, sections, repos, sessions, note, created_at, updated_at, adapter_stage)
        VALUES ('g1', '舊專案', 'old', NULL, '', '', '', NULL, '二', NULL, '[]', '[]', '', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '做');
    `);
    legacy.close();
    const store = new GameStore(path);
    const old = store.find("舊專案")!;
    assert.deepEqual(old.trackStages, { prob: "二", adapter: "做" });
    assert.equal(old.brand, "");
    store.update(old.id, { trackStages: { prob: "完成" } });
    store.close();
    // 重開不會再用舊欄位覆蓋。
    const reopened = new GameStore(path);
    assert.deepEqual(reopened.find("舊專案")!.trackStages, { prob: "完成", adapter: "做" });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試段落擷取：現況與標題含「待」的段落（不含待回寫），子段落不重複，程式碼區塊裡的 # 不算標題。
test("extractSections picks status and todo sections", () => {
  const source = "# 標題\n## 規格決定\nx\n## 現況\n現在\n### 待客戶確認\nQ3\n## 待回寫\n回寫\n## 待修改\n```\n## 假標題\n```\n修\n";
  const sections = extractSections(source, (heading) => /現況|待(?!回寫)/u.test(heading));
  assert.deepEqual(sections.map((section) => section.heading), ["現況", "待修改"]);
  assert.match(sections[0]!.text, /Q3/u);
  assert.match(sections[1]!.text, /假標題[\s\S]*修/u);
});

// 測試進度收集：只讀本專案前綴的文件、找到含代號的分支、算出未提交與最後動靜。
test("collectProgress reads docs sections and git branches", () => {
  useWorkflow(TEST_WORKFLOW);
  const directory = tempDir();
  const store = new GameStore(join(directory, "alice.db"));
  try {
    const { repo, docsDir } = fixture(directory);
    const game = store.create({ name: "測試專案", code: "testProject", docsDir, filePrefix: "測試專案 ", repos: ["工具專案", "文件專案"], deadline: "2026-10-03" });
    const progress = collectProgress(game, [repo]);
    assert.deepEqual(progress.docs.map((doc) => doc.name), ["測試專案 更改紀錄.md"]);
    assert.deepEqual(progress.sections.map((section) => section.heading), ["現況（2026-10-01）", "待修改"]);
    assert.equal(progress.repos.length, 1);
    assert.equal(progress.repos[0]!.currentBranch, "feature/testProject");
    assert.equal(progress.repos[0]!.uncommitted, 1);
    assert.deepEqual(progress.repos[0]!.branches.map((branch) => [branch.branch, branch.subject, branch.unpushed, branch.current]), [["feature/testProject", "加入功能 A", null, true]]);
    assert.ok(progress.warnings.some((warning) => /沒有專案「文件專案」/u.test(warning)));
    assert.notEqual(progress.lastActivityAt, null);
    const text = formatProgress(progress, new Date(2026, 9, 1, 10));
    assert.match(text, /截止 2026-10-03（剩 2 天）/u);
    assert.match(text, /未提交 1 個檔/u);
    assert.match(text, /功能 A 做完/u);
    assert.doesNotMatch(text, /不該出現|別的專案/u);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試每日彙整：截止日 3 天內、超過 5 天沒進度、等決定 3 件以上才推；結束的專案不提；沒事不推。
test("digestText reports deadlines, stale projects and waiting decisions", () => {
  useWorkflow(TEST_WORKFLOW);
  const directory = tempDir();
  const store = new GameStore(join(directory, "alice.db"));
  try {
    const now = new Date(2026, 9, 10, 9, 0);
    const soon = store.create({ name: "A", deadline: "2026-10-12" });
    const late = store.create({ name: "B", deadline: "2026-10-09" });
    const idle = store.create({ name: "C" });
    const done = store.create({ name: "D", deadline: "2026-10-01", trackStages: { build: "完成", docs: "完成" } });
    const far = store.create({ name: "E", deadline: "2026-12-01" });
    const text = digestText({
      games: [
        { game: soon, lastActivityAt: new Date(2026, 9, 9).toISOString() },
        { game: late, lastActivityAt: null },
        { game: idle, lastActivityAt: new Date(2026, 9, 3).toISOString() },
        { game: done, lastActivityAt: null },
        { game: far, lastActivityAt: new Date(2026, 9, 9).toISOString() },
      ],
      waitingDecisions: 3,
      now,
    });
    assert.equal(text, "ALICe 早報：A 2 天後截止；B 已過截止日 1 天；C 7 天沒有進度；3 件事等你決定");
    assert.equal(digestText({ games: [{ game: far, lastActivityAt: now.toISOString() }], waitingDecisions: 2, now }), undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試推播：計畫暫停立刻排入（等決定、卡住分開標示）；早上 9 點前不彙整，9 點後一天只彙整一次。
test("notification service pushes pauses immediately and digests once a day", () => {
  const directory = tempDir();
  const store = new NotificationStore(join(directory, "alice.db"));
  const events = new EventHub();
  const broadcasts: string[] = [];
  events.on((type) => broadcasts.push(type));
  let now = new Date(2026, 9, 10, 8, 59);
  let waiting = 5;
  const service = new NotificationService({
    store, events, now: () => now,
    planGoal: (id) => id === "plan-1" ? "確認上限截斷" : undefined,
    digestInput: () => ({ games: [], waitingDecisions: waiting }),
  });
  try {
    events.broadcast("plan.paused", { planId: "plan-1", reason: "decision_needed", detail: "要不要改上限" });
    events.broadcast("plan.paused", { planId: "plan-2xxxxxxx", reason: "session_blocked", detail: "缺規格" });
    const pending = service.pending();
    assert.deepEqual(pending.map((entry) => entry.text), [
      "需要你決定：「確認上限截斷」 要不要改上限",
      "同事回報卡住：計畫 plan-2xx 缺規格",
    ]);
    assert.ok(broadcasts.includes("notify.created"));
    assert.equal(service.tick(), undefined);
    now = new Date(2026, 9, 10, 9, 0);
    assert.equal(service.tick()?.text, "ALICe 早報：5 件事等你決定");
    assert.equal(service.tick(), undefined);
    assert.ok(service.markDelivered(pending[0]!.id.slice(0, 8))?.deliveredAt);
    assert.equal(service.pending().length, 2);
    now = new Date(2026, 9, 11, 10, 0);
    waiting = 0;
    assert.equal(service.tick(), undefined);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試對話：艾莉絲的專案卡區塊建立卡片；進度區塊讓 Core 收集資料、再請艾莉絲整理一次（不會再收集第二次）。
test("conversation applies game blocks and runs one progress round", async () => {
  useWorkflow(TEST_WORKFLOW);
  const directory = tempDir();
  const messages = new MessageStore(join(directory, "alice.db"));
  const gameStore = new GameStore(join(directory, "alice.db"));
  const { repo, docsDir } = fixture(directory);
  const config = { ...defaultConfig, dataDir: join(directory, "data") };
  const state = new CharacterState({ now: () => new Date(), config });
  const events = new EventHub();
  const games = new GameService({ store: gameStore, projects: () => [repo], events });
  const first = `好的，建好了。${gameBlock({ action: "create", name: "測試專案", code: "testProject", docsDir, filePrefix: "測試專案 ", repos: ["工具專案"] })}`;
  const second = "我整理一下。<<<ALICE_PROGRESS\n{\"games\":[\"測試專案\",\"不存在\"]}\nALICE_PROGRESS>>>";
  const third = "測試專案：開發階段。<<<ALICE_PROGRESS\n{\"games\":[]}\nALICE_PROGRESS>>>";
  const provider = new FakeProvider([{ text: first }, { text: second }, { text: third }]);
  const conversation = new ConversationService({ config, store: messages, state, provider, events, games });
  try {
    conversation.submit({ clientMsgId: "c1", clientId: "test", text: "開新專案測試專案" });
    await waitFor(() => gameStore.find("測試專案") !== undefined, "建卡");
    assert.ok(messages.list({ limit: 10 }).some((message) => message.role === "system" && /已建立專案卡：測試專案/u.test(message.text)));
    await waitFor(() => provider.calls === 1 && messages.list({ limit: 10 }).some((message) => message.role === "alice"), "第一則回覆");
    conversation.submit({ clientMsgId: "c2", clientId: "test", text: "測試專案進度如何" });
    await waitFor(() => provider.calls === 3, "進度整理");
    await waitFor(() => messages.list({ limit: 20 }).filter((message) => message.role === "alice").length === 3, "整理回覆");
    assert.match(provider.prompts[1]!.systemPrompt, /# 專案管理（參謀模式）[\s\S]*- 測試專案（testProject）：v1.0.0，開發：需求確認，文件：等待實作；沒有截止日；最後動靜 0 天前/u);
    const progressPrompt = provider.prompts[2]!.transcript;
    assert.match(progressPrompt, /Core 剛收集的進度資料/u);
    assert.match(progressPrompt, /功能 A 做完/u);
    assert.match(progressPrompt, /找不到這些專案卡：不存在/u);
    assert.match(progressPrompt, /## Core 裡等主人決定的事\n- （沒有）/u);
    assert.ok(messages.list({ limit: 20 }).some((message) => message.role === "system" && /Core 已收集 測試專案 的進度資料/u.test(message.text)));
    // 整理的那一輪又放了進度區塊：不再收集。
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(provider.calls, 3);
  } finally {
    gameStore.close();
    messages.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試提示：專案管理段落依流程設定列出各條線與階段、團隊規則、開新專案的欄位；會議段落帶團隊的會議規則。
test("prompt sections follow the workflow settings", () => {
  useWorkflow(TEST_WORKFLOW);
  const section = formatGames(["- 範例（sample）：v1.0.0，開發：實作，文件：等待實作；沒有截止日；最後動靜 1 天前"])!;
  assert.match(section, /範例（sample）/u);
  assert.match(section, /每個專案有 2 條並行的進度線/u);
  assert.match(section, /開發（stages 的 key：build）：需求確認 → 實作 → 整合測試 → 上線準備 → 完成/u);
  assert.match(section, /文件（stages 的 key：docs）：等待實作 → 撰寫 → 審閱 → 完成/u);
  assert.match(section, /- 測試規則：兩條線都到「上線準備」才一起上線。/u);
  assert.match(section, /缺的欄位一次問完：測試欄位甲、測試欄位乙/u);
  assert.match(section, /5\. 固定加一個任務「設計文件」。/u);
  assert.match(section, /source：需求、回饋、客戶、其他/u);
  assert.match(section, /"stages":\{"build":"需求確認","docs":"等待實作"\}/u);
  assert.match(section, /ALICE_PROGRESS/u);
  assert.match(formatMeetings([])!, /- 測試會議規則。/u);
  useWorkflow(DEFAULT_WORKFLOW);
  const plain = formatGames([])!;
  assert.match(plain, /還沒有專案卡/u);
  assert.match(plain, /專案的進度線：\n- 進度（stages 的 key：main）：規劃 → 進行中 → 驗證 → 完成/u);
  assert.doesNotMatch(plain, /測試規則/u);
  assert.equal(formatGames(undefined), null);
  assert.match(formatSessions([{ session: "Library", role: "知識庫管理員", project: "知識庫" }])!, /只在主人說「直接送」/u);
});

// 測試區塊過濾：專案卡區塊可以有多個，進度區塊不出現在回覆裡。
test("block filter collects multiple game blocks and a progress block", () => {
  const filter = new AliceBlockFilter(() => undefined);
  filter.push(`好。${gameBlock({ action: "update", name: "A", stage: "實作" })}`);
  filter.push(`${gameBlock({ action: "update", name: "B", stage: "實作" })}<<<ALICE_PRO`);
  filter.push("GRESS\n{}\nALICE_PROGRESS>>>");
  const result = filter.finish();
  assert.equal(result.visibleText, "好。");
  assert.equal(result.gameBlockTexts?.length, 2);
  assert.ok(result.progressBlockText?.startsWith("<<<ALICE_PROGRESS"));
});

// 測試 Core 內部監聽：監聽器出錯不影響廣播。
test("event hub listeners are isolated", () => {
  const events = new EventHub();
  const seen: string[] = [];
  events.on(() => { throw new Error("boom"); });
  events.on((type) => seen.push(type));
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    events.broadcast("x", {});
  } finally {
    console.warn = warn;
  }
  events.broadcast("y", {});
  assert.deepEqual(seen, ["x", "y"]);
});

// 測試任務清單：新增、改狀態、找不到的編號；只改任務時訊息以任務為主；新任務版本跟著卡片；track 與 source 照流程設定。
test("game blocks add and update tasks", () => {
  useWorkflow(TEST_WORKFLOW);
  const directory = tempDir();
  const store = new GameStore(join(directory, "alice.db"));
  try {
    applyGameBlock(store, gameBlock({ action: "create", name: "測試專案", code: "testProject", tasks: [{ op: "add", title: "需求討論：畫面大小", track: "owner" }] }), []);
    const added = applyGameBlock(store, gameBlock({
      action: "update", name: "testProject",
      tasks: [
        { op: "add", title: "匯出功能", track: "build", status: "進行中" },
        { op: "update", id: "T1", status: "完成", note: "主人說 1920x1080" },
        { op: "update", id: 9, status: "完成" },
      ],
    }), [], new Date("2026-10-03T01:00:00Z"));
    assert.match(added, /^測試專案的任務已更新\n任務：/u);
    assert.match(added, /新增 T2〔開發・進行中・需求〕匯出功能/u);
    assert.match(added, /T1 需求討論：畫面大小：待辦 → 完成，（主人說 1920x1080）/u);
    assert.match(added, /找不到 T9/u);
    const game = store.find("測試專案")!;
    assert.deepEqual(store.tasks(game.id).map((task) => [task.number, task.status, task.track, task.version]), [[1, "完成", "owner", "1.0.0"], [2, "進行中", "build", "1.0.0"]]);
    assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", tasks: [{ op: "add", title: "x", status: "做完了" }] })), /status 必須是/u);
    assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", tasks: [{ op: "add", title: "x", track: "main" }] })), /track 必須是.*build、docs、owner/u);
    assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", tasks: [{ op: "add", title: "x", source: "規格" }] })), /source 必須是/u);
    assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", tasks: [{ op: "update", id: "第三個" }] })), /任務編號/u);
    assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", tasks: [{ op: "add" }] })), /要有 title/u);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試任務出現在提示、進度資料與 API 卡片；每日核對一天只觸發一次，而且只有進行中的專案才觸發。
test("tasks appear in prompt lines, progress text and cards; daily review fires once a day", () => {
  useWorkflow(TEST_WORKFLOW);
  const directory = tempDir();
  const store = new GameStore(join(directory, "alice.db"));
  try {
    const game = store.create({ name: "測試專案", code: "testProject" });
    store.addTask(game.id, { title: "匯出功能", track: "build", status: "卡住", version: "1.0.0", note: "等客戶回覆" });
    store.addTask(game.id, { title: "說明文件", version: "1.0.0", status: "完成" });
    let now = new Date(2026, 9, 3, 8, 30);
    const service = new GameService({ store, projects: () => [], now: () => now });
    const lines = service.promptLines().join("\n");
    assert.match(lines, /  - T1〔開發・卡住・需求〕匯出功能— 等客戶回覆/u);
    assert.match(lines, /已完成或取消 1 個任務/u);
    assert.doesNotMatch(lines, /T2/u);
    assert.match(service.progress(["測試專案"]).text, /任務清單：\n  - T1〔開發・卡住・需求・v1.0.0〕匯出功能— 等客戶回覆[\s\S]*T2〔開發・完成/u);
    assert.equal(service.cards()[0]!.tasks.length, 2);
    assert.equal(service.reviewDue(now), false);
    now = new Date(2026, 9, 3, 9, 1);
    assert.equal(service.reviewDue(now), true);
    assert.equal(service.reviewDue(now), false);
    // 核對資料沒變就不必再請艾莉絲核對；任務清單變了不算，卡片或紀錄變了才算。
    assert.equal(service.reviewInputChanged(), true);
    assert.equal(service.reviewInputChanged(), false);
    store.addTask(game.id, { title: "新任務", version: "1.0.0" });
    now = new Date(2026, 9, 9, 9, 1);
    assert.equal(service.reviewInputChanged(), false);
    store.update(game.id, { deadline: "2026-11-01" });
    assert.equal(service.reviewInputChanged(), true);
    store.update(game.id, { trackStages: { build: "完成", docs: "完成" } });
    assert.equal(service.reviewDue(new Date(2026, 9, 4, 9, 5)), false);
    const section = formatGames([], "ALICE tra")!;
    assert.match(section, /【進度】/u);
    assert.match(section, /請用 SendMessage 傳給 ALICE tra 回覆/u);
    assert.doesNotMatch(section, /開工卡片（程式碼區塊/u);
    assert.match(section, /確認卡片並跳桌面通知/u);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試品牌：建卡與修改時可以寫，出現在提示與進度資料；舊卡預設空白。
test("game cards keep a brand", () => {
  useWorkflow(TEST_WORKFLOW);
  const directory = tempDir();
  const store = new GameStore(join(directory, "alice.db"));
  try {
    assert.match(applyGameBlock(store, gameBlock({ action: "create", name: "測試專案", code: "testProject", brand: "BrandA" }), []), /已建立專案卡/u);
    const service = new GameService({ store, projects: () => [] });
    assert.match(service.promptLines()[0]!, /品牌 BrandA/u);
    assert.match(service.progress(["測試專案"]).text, /## 測試專案（testProject）・BrandA/u);
    applyGameBlock(store, gameBlock({ action: "update", name: "測試專案", brand: "BrandB" }), []);
    assert.equal(store.find("測試專案")!.brand, "BrandB");
    assert.equal(store.create({ name: "沒寫品牌" }).brand, "");
    assert.throws(() => parseGameBlock(gameBlock({ action: "update", name: "x", brand: 3 })), /brand 必須是字串/u);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
