import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadLocalConfig } from "../src/localConfig.js";

// 測試本機設定不存在時只停用摘要與部下，確保一般聊天仍可用預設 Core 設定啟動。
test("missing alice.local.json disables optional local features", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-local-missing-"));
  try {
    const warnings: string[] = [];
    const local = loadLocalConfig(join(directory, "missing.json"), (message) => warnings.push(message));
    assert.equal(local.summaryEnabled, false);
    assert.equal(local.workersEnabled, false);
    assert.equal(local.workerTimeoutMin, 5);
    assert.equal(warnings.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試完整設定會正規化相對專案路徑並保留 worker 逾時，避免從不同 cwd 啟動時派到錯誤目錄。
test("valid local config enables summaries and workers", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-local-valid-"));
  const path = join(directory, "alice.local.json");
  try {
    mkdirSync(join(directory, "project"));
    writeFileSync(path, JSON.stringify({
      knowledgeBase: { path: join(directory, "vault"), summaryPage: "summary.md", rolesDir: "roles" },
      codex: { available: true },
      projects: [{ name: "工具", path: "project", role: "工程師" }],
      workerTimeoutMin: 7,
    }), "utf8");
    const local = loadLocalConfig(path, () => {});
    assert.equal(local.summaryEnabled, true);
    assert.equal(local.workersEnabled, true);
    assert.equal(local.projects[0]?.path, resolve(directory, "project"));
    assert.equal(local.workerTimeoutMin, 7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試缺少知識庫欄位時會獨立停用相關功能並留下原因，避免半套設定在執行期才無聲失敗。
test("invalid local config reports why dependent features are disabled", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-local-invalid-"));
  const path = join(directory, "alice.local.json");
  try {
    writeFileSync(path, JSON.stringify({ codex: { available: false }, projects: [] }), "utf8");
    const warnings: string[] = [];
    const local = loadLocalConfig(path, (message) => warnings.push(message));
    assert.equal(local.summaryEnabled, false);
    assert.equal(local.workersEnabled, false);
    assert.match(local.reasons.join("\n"), /knowledgeBase/);
    assert.ok(warnings.length >= 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


// 測試專案的 readDirs 會轉成絕對路徑供 worker 額外唯讀；格式錯誤時停用部下並留下原因。
test("project readDirs are normalized and validated", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-local-readdirs-"));
  const path = join(directory, "alice.local.json");
  const base = { knowledgeBase: { path: "vault", summaryPage: "s.md", rolesDir: "roles" } };
  try {
    writeFileSync(path, JSON.stringify({ ...base, projects: [{ name: "專案", path: "project", role: "工程師", readDirs: ["logs"] }] }));
    const valid = loadLocalConfig(path, () => undefined);
    assert.deepEqual(valid.projects[0]?.readDirs, [resolve(directory, "logs")]);
    writeFileSync(path, JSON.stringify({ ...base, projects: [{ name: "專案", path: "project", role: "工程師", readDirs: [""] }] }));
    const warnings: string[] = [];
    const invalid = loadLocalConfig(path, (message) => warnings.push(message));
    assert.equal(invalid.workersEnabled, false);
    assert.match(warnings.join("\n"), /readDirs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
