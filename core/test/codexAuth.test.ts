import assert from "node:assert/strict";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { checkCodexAuth, type CodexAuthExec } from "../src/tasks/codexAuth.js";

// 測試 Codex 登入檢查只接受 ChatGPT 訂閱，並確保檢查程序不會繼承任何 API 計費憑證。
test("checkCodexAuth verifies ChatGPT subscription with a sanitized environment", async () => {
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousCodex = process.env.codex_api_key;
  process.env.OPENAI_API_KEY = "must-not-leak";
  process.env.codex_api_key = "also-must-not-leak";
  let call: Parameters<CodexAuthExec> | undefined;
  const exec: CodexAuthExec = async (...args) => {
    call = args;
    return { stdout: "Logged in using ChatGPT", stderr: "" };
  };
  try {
    await checkCodexAuth(defaultConfig, exec);
    assert.equal(call?.[0], "codex");
    assert.deepEqual(call?.[1], ["login", "status"]);
    assert.equal(call?.[2].shell, false);
    assert.equal(call?.[2].env.OPENAI_API_KEY, undefined);
    assert.equal(call?.[2].env.codex_api_key, undefined);
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousCodex === undefined) delete process.env.codex_api_key;
    else process.env.codex_api_key = previousCodex;
  }
});

// 測試登入狀態未包含 ChatGPT 時明確失敗，避免誤用非訂閱認證。
test("checkCodexAuth rejects a non-ChatGPT login", async () => {
  await assert.rejects(
    checkCodexAuth(defaultConfig, async () => ({ stdout: "Not logged in", stderr: "" })),
    /未顯示 ChatGPT/,
  );
});
