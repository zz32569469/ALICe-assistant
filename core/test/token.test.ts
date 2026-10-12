import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadOrCreateToken } from "../src/auth/token.js";

// 測試首次啟動會建立 32-byte 隨機 token，後續啟動則沿用檔案內容以維持 Client 認證有效。
test("loadOrCreateToken creates and reuses a persistent token", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-token-"));
  const path = join(directory, "nested", "token");
  try {
    const first = loadOrCreateToken(path);
    const second = loadOrCreateToken(path);
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(second, first);
    assert.equal(readFileSync(path, "utf8").trim(), first);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
