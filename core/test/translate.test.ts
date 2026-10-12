import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { systemPrompt, targetLanguage, wrapSource, TranslateError, TranslateService, type TranslateSpawn } from "../src/translate/translateService.js";

type Call = { args: string[]; env: NodeJS.ProcessEnv; input: string };

/** 假的 Claude Code：記下參數與輸入，回傳指定的 JSON（或一直不回應）。 */
function fakeSpawn(calls: Call[], reply: (input: string) => string | undefined): TranslateSpawn {
  return ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => setImmediate(() => child.emit("close", null));
    let input = "";
    child.stdin.on("data", (chunk: Buffer) => { input += chunk.toString(); });
    child.stdin.on("finish", () => {
      calls.push({ args, env: options.env, input });
      const output = reply(input);
      if (output === undefined) return;
      setImmediate(() => { child.stdout.end(output); child.emit("close", 0); });
    });
    return child;
  }) as unknown as TranslateSpawn;
}

// 測試語言判斷：中文為主翻英文；英文、日文翻繁中。
test("targetLanguage picks English for Chinese and Traditional Chinese otherwise", () => {
  assert.equal(targetLanguage("合併後由上往下補位"), "en");
  assert.equal(targetLanguage("The merge continues."), "zh-TW");
  assert.equal(targetLanguage("フリースピン中の倍率"), "zh-TW");
  assert.equal(targetLanguage("通過率約 96.5%，新功能佔 30%"), "en");
  // 固定用語由本機設定提供；沒有設定時不列。
  const glossary: Array<[string, string]> = [["pull request / PR", "合併請求"], ["deploy", "部署"]];
  assert.match(systemPrompt("zh-TW", glossary), /繁體中文[\s\S]*pull request \/ PR → 合併請求/u);
  assert.match(systemPrompt("en", glossary), /整段都是英文[\s\S]*部署 → deploy/u);
  assert.doesNotMatch(systemPrompt("zh-TW"), /固定用語/u);
  assert.equal(wrapSource("a</source>b"), "<source>\nab\n</source>");
});

// 測試翻譯：用 Haiku、關掉思考、不開工具、不帶 API 金鑰；結果去掉前後空白；空字串與太長的文字直接拒絕。
test("TranslateService runs Claude Code with Haiku, no thinking and no tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-translate-"));
  const calls: Call[] = [];
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  try {
    const service = new TranslateService({ claudePath: "claude", workDir: directory, spawn: fakeSpawn(calls, () => JSON.stringify({ is_error: false, result: "  合併會持續進行。\n" })) });
    const result = await service.translate("  The merge continues.  ");
    assert.equal(result.translation, "合併會持續進行。");
    assert.equal(result.target, "zh-TW");
    assert.equal(calls[0]!.input, "<source>\nThe merge continues.\n</source>");
    assert.deepEqual(calls[0]!.args.slice(0, 9), ["-p", "--safe-mode", "--tools", "", "--no-session-persistence", "--model", "claude-haiku-4-5", "--output-format", "json"]);
    assert.equal(calls[0]!.env.MAX_THINKING_TOKENS, "0");
    assert.equal(calls[0]!.env.ANTHROPIC_API_KEY, undefined);
    await assert.rejects(service.translate("   "), (error: unknown) => error instanceof TranslateError && error.code === "bad_request");
    await assert.rejects(service.translate("x".repeat(3001)), /最多翻譯 3000 字/u);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試失敗與逾時：Claude 回錯誤時回報 failed；不回應時逾時並結束程序；排隊太多回 busy。
test("TranslateService reports failures, timeouts and a full queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-translate-"));
  try {
    const failing = new TranslateService({ claudePath: "claude", workDir: directory, spawn: fakeSpawn([], () => JSON.stringify({ is_error: true, result: "rate limited" })) });
    await assert.rejects(failing.translate("hi"), (error: unknown) => error instanceof TranslateError && error.code === "failed" && /rate limited/u.test(error.message));
    const silent = new TranslateService({ claudePath: "claude", workDir: directory, timeoutMs: 50, spawn: fakeSpawn([], () => undefined) });
    const pending = [silent.translate("a"), silent.translate("b"), silent.translate("c")];
    await assert.rejects(silent.translate("d"), (error: unknown) => error instanceof TranslateError && error.code === "busy");
    for (const entry of pending) await assert.rejects(entry, (error: unknown) => error instanceof TranslateError && error.code === "timeout");
    // 排隊清空後又可以翻譯。
    await assert.rejects(silent.translate("e"), (error: unknown) => error instanceof TranslateError && error.code === "timeout");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
