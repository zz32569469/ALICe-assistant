import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MEMORY_SECTION,
  buildPrompt,
  formatArt,
  formatWorkers,
  loadFacts,
  loadPersona,
  PEER_SECTION,
  SUGGESTION_SECTION,
  WEB_SECTION,
  type BuildPromptInput,
} from "../src/prompt/promptBuilder.js";
import { KnowledgeSummaryLoader } from "../src/prompt/knowledgeSummary.js";
import type { LocalConfig } from "../src/localConfig.js";
import type { Message } from "../src/store/messageStore.js";

function message(seq: number, role: Message["role"], text: string): Message {
  return {
    id: `message-${seq}`,
    seq,
    role,
    text,
    createdAt: "2026-09-29T08:00:00+08:00",
  };
}

function promptInput(overrides: Partial<BuildPromptInput> = {}): BuildPromptInput {
  return {
    personaText: "人格本文",
    factsText: null,
    history: [],
    userText: "早安",
    state: {
      activity: "talking",
      energy: "high",
      changedAt: "2026-09-29T08:12:00+08:00",
    },
    justWoken: true,
    now: new Date(2026, 8, 29, 8, 12),
    ...overrides,
  };
}

// 測試人格載入會移除檔首 YAML frontmatter，只把穩定的 Markdown 本文交給模型。
test("loadPersona strips YAML frontmatter", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-persona-"));
  const path = join(directory, "alice.md");
  try {
    writeFileSync(path, "---\nid: alice\n---\n\n# Identity\n\n本文\n", "utf8");
    assert.equal(loadPersona(path), "# Identity\n\n本文");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試外觀段落會完整略過且前後內容逐位元組保留，避免美術資料污染每次人格提示。
test("loadPersona removes the appearance section and preserves surrounding content", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-persona-"));
  const path = join(directory, "alice.md");
  try {
    const source = [
      "# Identity\r\n",
      "前段\r\n",
      "## 外觀（僅供美術參考）\r\n",
      "銀色長髮\r\n",
      "\r\n",
      "# Personality\r\n",
      "後段",
    ].join("");
    writeFileSync(path, source, "utf8");

    assert.equal(loadPersona(path), "# Identity\r\n前段\r\n# Personality\r\n後段");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試沒有外觀標題時不改動人格本文，避免誤刪名稱相近或一般 Markdown 內容。
test("loadPersona leaves content unchanged when no appearance section exists", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-persona-"));
  const path = join(directory, "alice.md");
  try {
    const body = "# Identity\r\n\r\n外觀設定另存\t \r\n# Personality";
    writeFileSync(path, `---\r\nid: alice\r\n---\r\n${body}`, "utf8");

    assert.equal(loadPersona(path), body);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試事實檔不存在時回傳 null，讓呼叫端能省略對應 system block。
test("loadFacts returns null for a missing file", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-facts-"));
  try {
    assert.equal(loadFacts(join(directory, "missing.md")), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試狀態只置於 system prompt 末尾，避免 stdin 中的狀態誘發模型輸出內部分析。
test("buildPrompt appends state to the system prompt instead of the transcript", () => {
  const built = buildPrompt(promptInput({ factsText: "喜歡咖啡", userText: "第一行\n第二行" }));

  assert.equal(
    built.systemPrompt,
    [
      "人格本文",
      "# 關於主人（事實檔）\n\n喜歡咖啡",
      WEB_SECTION,
      SUGGESTION_SECTION,
      MEMORY_SECTION,
      PEER_SECTION,
      "# 目前狀態\n\n[目前狀態] 活動：對話中；精神：好；剛被叫醒：是；現在時間：2026-09-29 08:12（週二）",
    ].join("\n\n"),
  );
  assert.equal(built.transcript, "主人的新訊息：\n第一行\n第二行");
  assert.doesNotMatch(built.transcript, /\[目前狀態\]/);
});

// 測試歷史依序逐筆列出，保留開頭 Alice、相鄰同角色與多行文字，避免純文字紀錄遺失內容。
test("history is listed chronologically without role merging", () => {
  const built = buildPrompt(
    promptInput({
      history: [
        message(3, "user", "問題二\n續行"),
        message(1, "alice", "無前置使用者"),
        message(2, "user", "問題一"),
        message(4, "alice", "回答"),
      ],
      userText: "追問",
    }),
  );

  assert.equal(
    built.transcript,
    [
      "以下是最近的對話紀錄（舊到新）：",
      "ALICe：無前置使用者",
      "主人：問題一",
      "主人：問題二\n續行",
      "ALICe：回答",
      "",
      "主人的新訊息：",
      "追問",
    ].join("\n"),
  );
});

// 測試固定本機時間能在 system prompt 末尾產生規格逐字相符的狀態行，避免格式或位置漂移。
test("state line exactly matches the specified format", () => {
  const built = buildPrompt(promptInput());

  assert.ok(
    built.systemPrompt.endsWith(
      "# 目前狀態\n\n[目前狀態] 活動：對話中；精神：好；剛被叫醒：是；現在時間：2026-09-29 08:12（週二）",
    ),
  );
});

// 測試相同狀態與時間會產生相同 system prompt，且狀態變化不影響前方的人格與事實內容。
test("system prompt is stable for identical state and isolates dynamic state in its final section", () => {
  const input = promptInput({ factsText: "主人偏好：安靜" });
  const first = buildPrompt(input);
  const sameStateAndTime = buildPrompt({
    ...input,
    state: { ...input.state },
    now: new Date(input.now),
  });
  const changedState = buildPrompt({
    ...input,
    state: { ...input.state, energy: "low" },
  });
  const stateSectionMarker = "\n\n# 目前狀態\n\n";
  const beforeState = (systemPrompt: string) => systemPrompt.split(stateSectionMarker)[0];

  assert.equal(first.systemPrompt, sameStateAndTime.systemPrompt);
  assert.equal(beforeState(first.systemPrompt), beforeState(changedState.systemPrompt));
  assert.notEqual(first.systemPrompt, changedState.systemPrompt);
});

// 測試工具段落位於事實與狀態之間、repo 依名稱排序，確保設定相同時提示逐位元組穩定。
test("tool instructions are stable, sorted, and placed before current state", () => {
  const built = buildPrompt(promptInput({
    factsText: "主人事實",
    tools: {
      codex: {
        enabled: true,
        repos: {
          zebra: { path: "ignored-z", description: "最後" },
          alpha: { path: "ignored-a", description: "最先" },
        },
      },
    },
    activeTask: { id: "task-1", goal: "處理事情", status: "running" },
  }));
  const factsAt = built.systemPrompt.indexOf("# 關於主人");
  const toolsAt = built.systemPrompt.indexOf("# 工具");
  const stateAt = built.systemPrompt.indexOf("# 目前狀態");
  assert.ok(factsAt < toolsAt && toolsAt < stateAt);
  assert.ok(built.systemPrompt.indexOf("- alpha：最先") < built.systemPrompt.indexOf("- zebra：最後"));
  assert.doesNotMatch(built.systemPrompt, /ignored-a|ignored-z/);
  assert.match(built.systemPrompt, /\[進行中任務\] id：task-1；目標：處理事情；狀態：running/);
  assert.match(built.systemPrompt, /收到任務完成通知前，不得聲稱工作已完成/);
});

// 測試工具停用時完全省略工具段落，避免模型誤以為仍可建立任務。
test("disabled tools omit the tool section", () => {
  const built = buildPrompt(promptInput({
    tools: { codex: { enabled: false, repos: {} } },
  }));
  assert.doesNotMatch(built.systemPrompt, /# 工具/);
});

// 測試 system 歷史與完成通知使用固定標籤，並把任務結果放入狀態段落供 Alice 回報。
test("system notifications and task result are represented in completion prompts", () => {
  const built = buildPrompt(promptInput({
    history: [message(1, "system", "先前通知")],
    currentRole: "system",
    userText: "任務完成，請向主人回報。",
    taskResult: {
      id: "task-2",
      goal: "完成測試",
      status: "succeeded",
      report: { summary: "全部完成" },
      diff: { modified: ["a.ts"] },
      mismatch: [],
      error: null,
    },
  }));
  assert.match(built.transcript, /（系統通知）先前通知/);
  assert.ok(built.transcript.endsWith("（系統通知）任務完成，請向主人回報。"));
  assert.match(built.systemPrompt, /\[任務結果\].*全部完成/);
});

// 測試摘要會去除 YAML frontmatter 並依 mtime 更新快取，避免把維護欄位送進提示或長期讀到舊內容。
test("knowledge summary strips frontmatter and refreshes by mtime", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-summary-"));
  const path = join(directory, "summary.md");
  const local: LocalConfig = {
    path: join(directory, "alice.local.json"),
    knowledgeBase: { path: directory, summaryPage: "summary.md", rolesDir: "roles" },
    docRoots: [],
    codexAvailable: false,
    projects: [],
    workerTimeoutMin: 5,
    summaryEnabled: true,
    workersEnabled: false, dispatch: true, remoteOrigins: [], workflowFile: null, translateGlossary: [],
    reasons: [],
  };
  try {
    writeFileSync(path, "---\nid: summary\n---\n# 第一版\n", "utf8");
    const loader = new KnowledgeSummaryLoader(local);
    assert.equal(loader.load(), "# 第一版");
    writeFileSync(path, "---\nid: changed\n---\n# 第二版\n", "utf8");
    const future = new Date(Date.now() + 2_000);
    utimesSync(path, future, future);
    assert.equal(loader.load(), "# 第二版");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試知識庫摘要與部下段落依規格插在事實及工具之間，且相同專案設定產生逐位元組穩定內容。
test("summary and stable worker sections follow the required prompt order", () => {
  const projects = [
    { name: "Z 專案", path: "ignored", role: "乙角色", readDirs: [] },
    { name: "A 專案", path: "ignored", role: "甲角色", readDirs: [] },
  ];
  const firstWorkers = formatWorkers(projects);
  const secondWorkers = formatWorkers([...projects].reverse());
  const built = buildPrompt(promptInput({
    factsText: "主人事實",
    knowledgeSummaryText: "摘要本文",
    workerProjects: projects,
    tools: { codex: { enabled: true, repos: {} } },
  }));
  assert.equal(firstWorkers, secondWorkers);
  const factsAt = built.systemPrompt.indexOf("# 關於主人");
  const summaryAt = built.systemPrompt.indexOf("# 知識庫摘要");
  const workersAt = built.systemPrompt.indexOf("# 部下");
  const toolsAt = built.systemPrompt.indexOf("# 工具");
  const stateAt = built.systemPrompt.indexOf("# 目前狀態");
  assert.ok(factsAt < summaryAt && summaryAt < workersAt && workersAt < toolsAt && toolsAt < stateAt);
});

// 測試同事 session 的訊息（S-1）：紀錄與目前訊息都標成「同事 session〈名稱〉」，不會被當成主人。
test("peer session messages are labelled as colleagues, not the owner", () => {
  const peer = "［來自 session〈知識庫管理員〉］\n摘要頁要更新嗎？";
  const history = buildPrompt(promptInput({ history: [message(1, "user", peer), message(2, "alice", "要，我整理給你。")], userText: "謝謝" }));
  assert.match(history.transcript, /同事 session〈知識庫管理員〉：摘要頁要更新嗎？\nALICe：要，我整理給你。\n\n主人的新訊息：\n謝謝$/u);
  assert.doesNotMatch(history.transcript, /主人：［來自/u);
  const current = buildPrompt(promptInput({ userText: peer }));
  assert.match(current.transcript, /^同事 session〈知識庫管理員〉的新訊息：\n摘要頁要更新嗎？$/u);
  assert.match(current.systemPrompt, /# 同事 session[\s\S]*不能替主人做決定、核准或授權/u);
});

// 測試看美術圖段落（§50）：有資料夾才輸出，路徑一律用正斜線，並寫明什麼時候看、看不清楚不要猜。
test("formatArt lists readable art folders", () => {
  assert.equal(formatArt([]), null);
  assert.equal(formatArt(undefined), null);
  const section = formatArt(["C:\\repo\\art", "C:\\repo\\docs\\art"])!;
  assert.match(section, /# 看美術圖/u);
  assert.match(section, /- C:\/repo\/art\n- C:\/repo\/docs\/art/u);
  assert.match(section, /alice_design_sheet\.png/u);
  assert.match(section, /看不清楚就說看不清楚/u);
});

// 測試 §64：代理人模式開啟才放「# 代理人模式」，而且寫明只轉達主人說過的話、需要本人確認的事不放行。
test("proxy mode section appears only when enabled", () => {
  const input = {
    personaText: "人格", factsText: null, history: [], userText: "嗨",
    state: { activity: "idle" as const, energy: "normal" as const, changedAt: new Date(0).toISOString() },
    justWoken: false, now: new Date(0),
  };
  assert.doesNotMatch(buildPrompt(input).systemPrompt, /# 代理人模式/u);
  const on = buildPrompt({ ...input, proxyMode: true }).systemPrompt;
  assert.match(on, /# 代理人模式（開啟中）[\s\S]*只轉達主人說過的話[\s\S]*（ALICe 代主人轉達）[\s\S]*上傳或 push、刪除、寫知識庫/u);
});
