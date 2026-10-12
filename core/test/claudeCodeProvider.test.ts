import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import type { BuiltPrompt } from "../src/prompt/promptBuilder.js";
import {
  CHROME_BLOCKED_TOOLS,
  CHROME_READ_TOOLS,
  ClaudeCodeProvider,
  WEB_TOOLS,
  MESSAGE_TOOLS,
  artDirArgs,
  artReadRules,
  readableDirs,
  type ClaudeSpawn,
} from "../src/reasoning/claudeCodeProvider.js";
import { ReasoningError } from "../src/reasoning/provider.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killSignals: NodeJS.Signals[];
  kill: (signal?: NodeJS.Signals | number) => boolean;
  close: (code?: number) => void;
};

const prompt: BuiltPrompt = {
  systemPrompt: "人格本文\n\n事實\n\n# 目前狀態\n\n[目前狀態] 測試",
  transcript: "主人的新訊息：\n你好",
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killSignals.push(signal as NodeJS.Signals);
    return true;
  };
  child.close = (code = 0) => {
    child.exitCode = code;
    child.emit("close", code, null);
  };
  return child;
}

function configFor(directory: string, replyTimeoutMs = 1_000) {
  return { ...defaultConfig, dataDir: directory, replyTimeoutMs };
}

async function expectKind(promise: Promise<unknown>, kind: ReasoningError["kind"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ReasoningError);
    assert.equal(error.kind, kind);
    return true;
  });
}

function thinkingStart() {
  return {
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
  };
}

function textDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

function successResult(text: string) {
  return {
    type: "result",
    is_error: false,
    result: text,
    duration_ms: 10,
    duration_api_ms: 8,
    usage: {},
    modelUsage: { "claude-opus-5-5": {} },
  };
}

function scriptedSpawn(
  attempts: Array<{ events: unknown[]; code?: number }>,
  beforeClose?: (attempt: number) => void,
) {
  let calls = 0;
  const spawn: ClaudeSpawn = () => {
    const child = createFakeChild();
    const attempt = attempts[calls];
    calls += 1;
    if (attempt === undefined) {
      throw new Error("Unexpected Claude Code attempt");
    }
    child.stdin.once("finish", () => {
      for (const event of attempt.events) {
        child.stdout.write(`${JSON.stringify(event)}\n`);
      }
      beforeClose?.(calls);
      child.close(attempt.code ?? 0);
    });
    return child as never;
  };
  return { spawn, calls: () => calls };
}

// 測試 CLI 參數、隔離環境、stdin 與 system prompt 檔案完全符合訂閱推理契約，避免意外走 API 路徑。
test("ClaudeCodeProvider launches Claude Code with the exact subscription-safe request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-code-"));
  const child = createFakeChild();
  let command = "";
  let args: string[] = [];
  let options: Parameters<ClaudeSpawn>[2] | undefined;
  let stdin = "";
  const deltas: string[] = [];
  let deltasBeforeClose: string[] = [];
  child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
  const fakeSpawn: ClaudeSpawn = (nextCommand, nextArgs, nextOptions) => {
    command = nextCommand;
    args = nextArgs;
    options = nextOptions;
    child.stdin.once("finish", () => {
      const first = JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "thinking", thinking: "" } },
      });
      const init = JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" });
      const second = JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "早安" } },
      });
      const third = JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "主人" } },
      });
      const result = JSON.stringify({
        type: "result",
        is_error: false,
        result: "早安主人",
        duration_ms: 123,
        duration_api_ms: 100,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
        modelUsage: {
          "claude-haiku-4-5": {
            inputTokens: 4, outputTokens: 2,
            cacheReadInputTokens: 1, cacheCreationInputTokens: 3,
          },
          "claude-opus-5-5": {
            inputTokens: 9, outputTokens: 7,
            cacheReadInputTokens: 5, cacheCreationInputTokens: 6,
          },
        },
      });
      child.stdout.write(first.slice(0, 25));
      child.stdout.write(`${first.slice(25)}\n${init}\nnot-json\n${second}\n${third}\n${result.slice(0, 30)}`);
      child.stdout.write(result.slice(30));
      deltasBeforeClose = [...deltas];
      child.close();
    });
    return child as never;
  };
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";

  try {
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: fakeSpawn, warn: () => {} });
    const result = await provider.streamReply(prompt, (delta) => deltas.push(delta));
    const systemPromptPath = resolve(directory, "claude-code", "system-prompt.md");

    assert.equal(command, "claude");
    assert.deepEqual(args, [
      "-p",
      "--safe-mode",
      "--chrome",
      "--tools",
      "WebFetch,WebSearch,Read,SendMessage,ListAgents",
      ...artDirArgs(readableDirs(configFor(directory))),
      "--allowedTools",
      ...WEB_TOOLS,
      ...MESSAGE_TOOLS,
      ...artReadRules(readableDirs(configFor(directory))),
      ...CHROME_READ_TOOLS,
      "--disallowedTools",
      ...CHROME_BLOCKED_TOOLS,
      "--no-session-persistence",
      "--model",
      "claude-opus-5-5",
      "--effort",
      "medium",
      "--system-prompt-file",
      systemPromptPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
    assert.equal(options?.shell, false);
    assert.equal(options?.cwd, resolve(directory, "claude-code"));
    assert.equal(options?.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(stdin, prompt.transcript);
    assert.equal(readFileSync(systemPromptPath, "utf8"), prompt.systemPrompt);
    assert.deepEqual(deltas, ["早安", "主人"]);
    assert.deepEqual(deltasBeforeClose, ["早安", "主人"]);
    assert.deepEqual(result, {
      text: "早安主人",
      stopReason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
      durationMs: 123,
      durationApiMs: 100,
      model: "claude-opus-5-5",
      initModel: "claude-opus-5-5",
      models: [
        {
          model: "claude-opus-5-5", inputTokens: 9, outputTokens: 7,
          cacheReadInputTokens: 5, cacheCreationInputTokens: 6,
        },
        {
          model: "claude-haiku-4-5", inputTokens: 4, outputTokens: 2,
          cacheReadInputTokens: 1, cacheCreationInputTokens: 3,
        },
      ],
      attempts: 1,
      suspect: false,
    });
  } finally {
    if (previousKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = previousKey;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試單次請求可覆寫 effort 而不改動全域設定，確保部下回報後的艾莉絲推理固定使用 high。
test("ClaudeCodeProvider accepts a per-request effort override", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-effort-"));
  let args: string[] = [];
  const spawn: ClaudeSpawn = (_command, nextArgs) => {
    args = nextArgs;
    const child = createFakeChild();
    child.stdin.once("finish", () => {
      child.stdout.write(`${JSON.stringify(thinkingStart())}\n`);
      child.stdout.write(`${JSON.stringify(textDelta("完成"))}\n`);
      child.stdout.write(`${JSON.stringify(successResult("完成"))}\n`);
      child.close();
    });
    return child as never;
  };
  try {
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn });
    await provider.streamReply(prompt, () => {}, { effort: "high" });
    assert.equal(args[args.indexOf("--effort") + 1], "high");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試啟動模型與設定不符時會警告，且相同的 init／主要模型組合只警告一次，避免洗版。
test("ClaudeCodeProvider warns once for each actual model combination", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-model-warning-"));
  const events = [
    { type: "system", subtype: "init", model: "claude-haiku-4-5" },
    thinkingStart(),
    textDelta("完成"),
    successResult("完成"),
  ];
  const scripted = scriptedSpawn([{ events }, { events }]);
  const warnings: string[] = [];
  try {
    const provider = new ClaudeCodeProvider(configFor(directory), {
      spawn: scripted.spawn,
      warn: (message) => warnings.push(message),
    });
    await provider.streamReply(prompt, () => {});
    await provider.streamReply(prompt, () => {});
    assert.deepEqual(warnings, [
      "[警告] 設定模型 claude-opus-5-5，實際 init=claude-haiku-4-5 主要=claude-opus-5-5",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 thinking 前的文字會被隔離，避免 CLI 前置雜訊進入串流事件或最終回覆。
test("ClaudeCodeProvider discards text before the first thinking block", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-thinking-noise-"));
  const scripted = scriptedSpawn([{
    events: [textDelta("<br>"), thinkingStart(), textDelta("正常回覆"), successResult("<br>正常回覆")],
  }]);
  try {
    const deltas: string[] = [];
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: scripted.spawn });
    const result = await provider.streamReply(prompt, (delta) => deltas.push(delta));

    assert.deepEqual(deltas, ["正常回覆"]);
    assert.equal(result.text, "正常回覆");
    assert.equal(result.attempts, 1);
    assert.equal(result.suspect, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試讀網頁（工具呼叫）前後的兩段文字之間會空一行，不會黏在一起。
test("ClaudeCodeProvider separates text before and after a tool call", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-tool-gap-"));
  const toolStart = { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "WebFetch" } } };
  const scripted = scriptedSpawn([{
    events: [thinkingStart(), textDelta("我看一下規格書。"), toolStart, thinkingStart(), textDelta("看完了"), textDelta("：共 5 軸。"), successResult("看完了：共 5 軸。")],
  }]);
  try {
    const deltas: string[] = [];
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: scripted.spawn });
    const result = await provider.streamReply(prompt, (delta) => deltas.push(delta));
    assert.equal(result.text, "我看一下規格書。\n\n看完了：共 5 軸。");
    assert.deepEqual(deltas, ["我看一下規格書。", "\n\n看完了", "：共 5 軸。"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 §64：SendMessage 的收件人與內容會帶回給 Core；已送出訊息的回覆就算可疑也不重試（免得同一則送兩次）。
test("ClaudeCodeProvider reports sent messages and does not retry after sending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-sent-"));
  const assistant = { type: "assistant", message: { content: [
    { type: "tool_use", name: "SendMessage", input: { to: "Some App - dev", message: "（ALICE 追問）T3 卡在哪？" } },
    { type: "tool_use", name: "WebFetch", input: { url: "https://example.com" } },
  ] } };
  const scripted = scriptedSpawn([
    { events: [assistant, textDelta("已傳給〈Some App - dev〉"), successResult("已傳給〈Some App - dev〉")] },
    { events: [thinkingStart(), textDelta("不應該有第二次"), successResult("不應該有第二次")] },
  ]);
  try {
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: scripted.spawn, warn: () => {} });
    const result = await provider.streamReply(prompt, () => undefined);
    assert.equal(scripted.calls(), 1);
    assert.equal(result.suspect, true);
    assert.deepEqual(result.sentMessages, [{ to: "Some App - dev", message: "（ALICE 追問）T3 卡在哪？" }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試缺少 thinking 的首次結果不會外洩，且下一次正常結果會完整取代可疑回覆。
test("ClaudeCodeProvider retries a reply without thinking", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-retry-thinking-"));
  const scripted = scriptedSpawn([
    { events: [textDelta("內部分析"), successResult("內部分析")] },
    { events: [thinkingStart(), textDelta("安全回覆"), successResult("安全回覆")] },
  ]);
  try {
    const deltas: string[] = [];
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: scripted.spawn });
    const result = await provider.streamReply(prompt, (delta) => deltas.push(delta));

    assert.equal(scripted.calls(), 2);
    assert.deepEqual(deltas, ["安全回覆"]);
    assert.equal(result.text, "安全回覆");
    assert.equal(result.attempts, 2);
    assert.equal(result.suspect, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試有 thinking 但正文空白時仍會重試，避免把空回覆保存到對話紀錄。
test("ClaudeCodeProvider retries a blank reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-retry-blank-"));
  const scripted = scriptedSpawn([
    { events: [thinkingStart(), successResult("   ")] },
    { events: [thinkingStart(), textDelta("第二次成功"), successResult("第二次成功")] },
  ]);
  try {
    const deltas: string[] = [];
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: scripted.spawn });
    const result = await provider.streamReply(prompt, (delta) => deltas.push(delta));

    assert.equal(scripted.calls(), 2);
    assert.deepEqual(deltas, ["第二次成功"]);
    assert.equal(result.text, "第二次成功");
    assert.equal(result.attempts, 2);
    assert.equal(result.suspect, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試所有嘗試都缺少 thinking 時只降級送出最後結果，並留下可疑標記與告警。
test("ClaudeCodeProvider returns the final suspect reply after exhausting attempts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-exhausted-"));
  const scripted = scriptedSpawn([
    { events: [textDelta("第一次"), successResult("第一次")] },
    { events: [textDelta("第二次"), successResult("第二次")] },
    { events: [textDelta("第三次 delta"), successResult("第三次 result")] },
  ]);
  const warnings: string[] = [];
  try {
    const deltas: string[] = [];
    const provider = new ClaudeCodeProvider(configFor(directory), {
      spawn: scripted.spawn,
      warn: (message) => warnings.push(message),
    });
    const result = await provider.streamReply(prompt, (delta) => deltas.push(delta));

    assert.equal(scripted.calls(), 3);
    assert.deepEqual(deltas, ["第三次 result"]);
    assert.equal(result.text, "第三次 result");
    assert.equal(result.attempts, 3);
    assert.equal(result.suspect, true);
    assert.deepEqual(warnings, ["Claude Code reply remained suspect after 3 attempt(s)"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試可關閉 thinking 防護，確保不產生 thinking 的相容模型仍維持單次即時串流。
test("ClaudeCodeProvider accepts a reply without thinking when the guard is disabled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-no-guard-"));
  const deltas: string[] = [];
  let deltasBeforeClose: string[] = [];
  const scripted = scriptedSpawn([{
    events: [textDelta("相容"), textDelta("模型"), successResult("相容模型")],
  }], () => {
    deltasBeforeClose = [...deltas];
  });
  try {
    const config = { ...configFor(directory), requireThinking: false };
    const provider = new ClaudeCodeProvider(config, { spawn: scripted.spawn });
    const result = await provider.streamReply(prompt, (delta) => deltas.push(delta));

    assert.equal(scripted.calls(), 1);
    assert.deepEqual(deltas, ["相容", "模型"]);
    assert.deepEqual(deltasBeforeClose, ["相容", "模型"]);
    assert.equal(result.text, "相容模型");
    assert.equal(result.attempts, 1);
    assert.equal(result.suspect, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試推理錯誤不會套用可疑回覆重試，避免 rate limit 等錯誤被額外放大。
test("ClaudeCodeProvider does not retry a ReasoningError", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-no-error-retry-"));
  const scripted = scriptedSpawn([
    {
      events: [
        { type: "system", subtype: "api_retry", error: "rate_limit" },
        { type: "result", is_error: true, result: "稍後再試" },
      ],
      code: 1,
    },
    { events: [thinkingStart(), textDelta("不應執行"), successResult("不應執行")] },
  ]);
  try {
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: scripted.spawn });
    await expectKind(provider.streamReply(prompt, () => {}), "rate_limited");
    assert.equal(scripted.calls(), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試模型設定錯誤即使沒有 api_retry 事件仍視為 auth，且不進行可疑回覆重試。
test("ClaudeCodeProvider maps selected model issues to auth without retrying", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-model-issue-"));
  const scripted = scriptedSpawn([{
    events: [{
      type: "result",
      is_error: true,
      subtype: "success",
      result: "There's an issue with the selected model (claude-no-such-model). It may not exist or you may not have access to it. Run --model to pick a different model.",
    }],
  }]);
  try {
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: scripted.spawn });
    await expectKind(provider.streamReply(prompt, () => {}), "auth");
    assert.equal(scripted.calls(), 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 Claude Code 的重試類別與 result 錯誤文字會映射成既有狀態機需要的錯誤種類。
test("ClaudeCodeProvider maps subscription and service errors", async () => {
  const cases = [
    { retry: "authentication_failed", result: "登入失敗", expected: "auth" },
    { retry: "rate_limit", result: "稍後再試", expected: "rate_limited" },
    { retry: undefined, result: "API Error: model does not support this model", expected: "auth" },
  ] as const;

  for (const item of cases) {
    const directory = mkdtempSync(join(tmpdir(), "alice-claude-error-"));
    const child = createFakeChild();
    const fakeSpawn: ClaudeSpawn = () => {
      child.stdin.once("finish", () => {
        if (item.retry !== undefined) {
          child.stdout.write(`${JSON.stringify({ type: "system", subtype: "api_retry", error: item.retry })}\n`);
        }
        child.stdout.write(`${JSON.stringify({ type: "result", is_error: true, result: item.result })}\n`);
        child.close(1);
      });
      return child as never;
    };
    try {
      const provider = new ClaudeCodeProvider(configFor(directory), { spawn: fakeSpawn });
      await expectKind(provider.streamReply(prompt, () => {}), item.expected);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

// 測試找不到 claude 執行檔時視為設定／登入問題，讓角色立即進入安全睡眠狀態。
test("ClaudeCodeProvider maps ENOENT to auth", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-enoent-"));
  const child = createFakeChild();
  const fakeSpawn: ClaudeSpawn = () => {
    child.stdin.once("finish", () => {
      const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
      child.emit("error", error);
    });
    return child as never;
  };
  try {
    const provider = new ClaudeCodeProvider(configFor(directory), { spawn: fakeSpawn });
    await expectKind(provider.streamReply(prompt, () => {}), "auth");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試子程序提早關閉 stdin 時 EPIPE 只會告警，最終仍依非零結束碼回報一般推理錯誤。
test("ClaudeCodeProvider tolerates stdin EPIPE until the child closes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-epipe-"));
  const child = createFakeChild();
  const warnings: string[] = [];
  const fakeSpawn: ClaudeSpawn = () => {
    child.stdin.once("data", () => {
      const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      child.stdin.emit("error", error);
      child.close(1);
    });
    return child as never;
  };
  try {
    const provider = new ClaudeCodeProvider(configFor(directory), {
      spawn: fakeSpawn,
      warn: (message) => warnings.push(message),
    });

    await expectKind(provider.streamReply(prompt, () => {}), "other");
    assert.deepEqual(warnings, ["Claude Code stdin error: write EPIPE"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試超時會回報 network 並先送 SIGINT 終止子程序，避免卡住對話佇列。
test("ClaudeCodeProvider terminates a timed out process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-claude-timeout-"));
  const child = createFakeChild();
  const fakeSpawn: ClaudeSpawn = () => child as never;
  try {
    const provider = new ClaudeCodeProvider(configFor(directory, 10), { spawn: fakeSpawn });
    await expectKind(provider.streamReply(prompt, () => {}), "network");
    assert.deepEqual(child.killSignals, ["SIGINT"]);
    child.exitCode = 1;
    child.emit("close", 1, "SIGINT");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
