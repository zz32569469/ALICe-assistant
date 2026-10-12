import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultConfig, loadConfig } from "../src/config.js";

// 測試預設路徑與 Claude／Codex 設定不依賴 cwd，避免服務從不同目錄啟動時讀錯檔案或工具參數。
test("default paths resolve from the repository root", () => {
  const compiledTestDirectory = dirname(fileURLToPath(import.meta.url));
  const coreDirectory = dirname(dirname(compiledTestDirectory));
  const repoRoot = dirname(coreDirectory);

  assert.equal(defaultConfig.personaPath, resolve(repoRoot, "persona", "alice.md"));
  assert.equal(defaultConfig.factsPath, resolve(repoRoot, "memory", "facts.md"));
  assert.equal(defaultConfig.dataDir, resolve(repoRoot, "data"));
  assert.equal(defaultConfig.claudePath, "claude");
  assert.equal(defaultConfig.replyTimeoutMs, 180_000);
  assert.equal(defaultConfig.model, "claude-opus-5-5");
  assert.equal(defaultConfig.requireThinking, true);
  assert.equal(defaultConfig.maxReplyAttempts, 3);
  assert.equal(defaultConfig.tools.codex.enabled, true);
  assert.equal(defaultConfig.tools.codex.codexPath, "codex");
  assert.equal(defaultConfig.tools.codex.approvalTimeoutMin, 5);
  assert.equal(defaultConfig.tools.codex.taskTimeoutMin, 30);
  // 預設不放可修改的 repo：新電腦上未必有 alice-sandbox；可修改的專案寫在 alice.local.json。
  assert.deepEqual(defaultConfig.tools.codex.repos, {});
});

// 測試 Codex 巢狀設定可局部覆寫而保留其他預設值，避免自訂逾時意外清空白名單或執行檔設定。
test("loadConfig deeply merges Codex settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-tools-config-"));
  const overridePath = join(directory, "config.json");
  try {
    writeFileSync(overridePath, JSON.stringify({ tools: { codex: { approvalTimeoutMin: 1 } } }), "utf8");
    const overridden = loadConfig(overridePath);
    assert.equal(overridden.tools.codex.approvalTimeoutMin, 1);
    assert.equal(overridden.tools.codex.taskTimeoutMin, 30);
    assert.deepEqual(overridden.tools.codex.repos, defaultConfig.tools.codex.repos);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 JSON 只做淺層覆寫且不存在的覆寫檔回退預設，確保可選設定不影響其他預設值。
test("loadConfig shallowly merges an optional JSON override", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-config-"));
  const overridePath = join(directory, "config.json");
  try {
    writeFileSync(overridePath, JSON.stringify({ port: 9000, effort: "high" }), "utf8");
    const overridden = loadConfig(overridePath);
    assert.equal(overridden.port, 9000);
    assert.equal(overridden.effort, "high");
    assert.equal(overridden.host, defaultConfig.host);
    assert.deepEqual(loadConfig(join(directory, "missing.json")), defaultConfig);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
