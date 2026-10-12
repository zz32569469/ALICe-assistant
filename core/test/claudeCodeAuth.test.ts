import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import {
  checkClaudeCodeAuth,
  type ClaudeAuthExec,
} from "../src/reasoning/claudeCodeAuth.js";

// 測試非 claude.ai 的登入方式會在伺服器啟動前遭拒，確保不會誤用 API 或雲端供應商計費。
test("startup auth check rejects non-subscription authentication", async () => {
  const fakeExec: ClaudeAuthExec = async () => ({
    stdout: JSON.stringify({ loggedIn: true, authMethod: "apiKey", subscriptionType: "none" }),
    stderr: "",
  });

  await assert.rejects(
    checkClaudeCodeAuth(defaultConfig, fakeExec),
    /只允許 Claude Code 的 claude\.ai 訂閱登入/,
  );
});

// 測試有效的 claude.ai 訂閱登入可通過，且檢查命令同樣移除 API 憑證環境變數。
test("startup auth check accepts claude.ai subscription authentication", async () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  let captured: Parameters<ClaudeAuthExec> | undefined;
  const fakeExec: ClaudeAuthExec = async (...args) => {
    captured = args;
    return {
      stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }),
      stderr: "",
    };
  };

  try {
    const status = await checkClaudeCodeAuth(defaultConfig, fakeExec);
    assert.equal(status.subscriptionType, "pro");
    assert.equal(captured?.[0], "claude");
    assert.deepEqual(captured?.[1], ["auth", "status"]);
    assert.equal(captured?.[2].shell, false);
    assert.equal(captured?.[2].env.ANTHROPIC_API_KEY, undefined);
  } finally {
    if (previousKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
  }
});
