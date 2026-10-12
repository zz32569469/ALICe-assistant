import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { defaultConfig, type Config } from "../src/config.js";
import {
  CODEX_REPORT_SCHEMA,
  CodexRunner,
  killProcessTree,
  type CodexReport,
  type CodexSpawn,
} from "../src/tasks/codexRunner.js";
import type { RepoSnapshot } from "../src/tasks/snapshot.js";
import type { TaskRunnerHooks } from "../src/tasks/taskRunner.js";
import type { Task } from "../src/tasks/taskStore.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  close: (code?: number) => void;
};

function createFakeChild(pid = 4321): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.close = (code = 0) => {
    child.exitCode = code;
    child.emit("close", code, null);
  };
  return child;
}

function configFor(directory: string, taskTimeoutMin = 1): Config {
  return {
    ...defaultConfig,
    dataDir: directory,
    tools: {
      codex: {
        ...defaultConfig.tools.codex,
        taskTimeoutMin,
        repos: { sandbox: { path: directory, description: "測試 repo" } },
      },
    },
  };
}

function taskFor(repoPath: string): Task {
  return {
    id: "task-123", planId: null, sourceMessageId: "source", tool: "codex", repo: "sandbox",
    repoPath, goal: "完成目標", instructions: "修改指定程式", acceptance: ["第一條通過", "第二條有證據"],
    estimateMin: 3, status: "running", createdAt: "2026-09-29T00:00:00.000Z", decidedAt: null,
    decidedBy: null, startedAt: null, endedAt: null, codexThreadId: null, pid: null,
    report: null, reportError: null, diff: null, mismatch: null, error: null,
  };
}

const report: CodexReport = {
  summary: "完成修改",
  filesChanged: [{ path: "src/new.ts", change: "added" }],
  tests: [{ command: "npm test", result: "pass", detail: "全部通過" }],
  acceptance: [
    { criterion: "第一條通過", met: true, evidence: "測試通過" },
    { criterion: "第二條有證據", met: true, evidence: "檔案已新增" },
  ],
  unfinished: [],
  notes: "無",
};

function snapshots(...values: RepoSnapshot[]): { take: () => Promise<RepoSnapshot> } {
  let index = 0;
  return {
    take: async () => {
      const value = values[Math.min(index, values.length - 1)];
      index += 1;
      if (value === undefined) throw new Error("missing fake snapshot");
      return value;
    },
  };
}

function collectHooks(): {
  hooks: TaskRunnerHooks;
  starts: Array<{ codexThreadId?: string; pid?: number }>;
  progress: string[];
  result: Promise<Parameters<TaskRunnerHooks["onFinished"]>[0]>;
} {
  const starts: Array<{ codexThreadId?: string; pid?: number }> = [];
  const progress: string[] = [];
  let finish!: (value: Parameters<TaskRunnerHooks["onFinished"]>[0]) => void;
  const result = new Promise<Parameters<TaskRunnerHooks["onFinished"]>[0]>((resolvePromise) => {
    finish = resolvePromise;
  });
  return {
    starts,
    progress,
    result,
    hooks: {
      onStarted: (details) => starts.push(details),
      onProgress: (text) => progress.push(text),
      onFinished: finish,
    },
  };
}

const authExec = async (): Promise<{ stdout: string; stderr: string }> => ({
  stdout: "Logged in using ChatGPT", stderr: "",
});

// 測試成功執行會使用精確 CLI 契約、隔離環境、完整提示與工作檔，並解析 thread、三種進度及結構化回報。
test("CodexRunner executes a successful structured task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-codex-success-"));
  const child = createFakeChild();
  let command = "";
  let args: string[] = [];
  let options: Parameters<CodexSpawn>[2] | undefined;
  let stdin = "";
  child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
  const spawn: CodexSpawn = (nextCommand, nextArgs, nextOptions) => {
    command = nextCommand;
    args = nextArgs;
    options = nextOptions;
    child.stdin.once("finish", () => {
      writeFileSync(nextArgs.at(-1)!, JSON.stringify(report), "utf8");
      const events = [
        { type: "thread.started", thread_id: "thread-123" },
        { type: "item.completed", item: { type: "command_execution", command: "npm test", exit_code: 0 } },
        { type: "item.completed", item: { type: "file_change", changes: [{ path: "src/new.ts" }] } },
        { type: "item.completed", item: {
          type: "agent_message",
          text: JSON.stringify({ summary: "完成 JSON 摘要", filesChanged: [] }),
        } },
        { type: "item.completed", item: { type: "agent_message", text: "完成所有工作" } },
        { type: "turn.completed", usage: {
          input_tokens: 10, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 3,
        } },
      ];
      child.stdout.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      child.close(0);
    });
    return child as never;
  };
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousCodex = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  process.env.CODEX_API_KEY = "must-not-leak";
  try {
    const runner = new CodexRunner(configFor(directory), {
      spawn,
      authExec,
      snapshotter: snapshots(
        { head: "same", files: {} },
        { head: "same", files: { "src/new.ts": "hash" } },
      ),
      platform: "win32",
    });
    const collected = collectHooks();
    await runner.start(taskFor(directory), collected.hooks);
    const result = await collected.result;
    const taskDirectory = resolve(directory, "tasks", "task-123");

    assert.equal(command, "codex");
    assert.deepEqual(args, [
      "exec", "--json", "-C", directory, "-s", "workspace-write",
      "--output-schema", resolve(taskDirectory, "schema.json"),
      "-o", resolve(taskDirectory, "report.json"),
    ]);
    assert.equal(options?.shell, false);
    assert.equal(options?.env.OPENAI_API_KEY, undefined);
    assert.equal(options?.env.CODEX_API_KEY, undefined);
    assert.match(stdin, /# 目標\n完成目標/);
    assert.match(stdin, /1\. 第一條通過/);
    assert.match(stdin, /2\. 第二條有證據/);
    assert.match(stdin, /不 commit/);
    assert.match(stdin, /這是 Alice Core 派的任務：不需要讀取全域指引/);
    assert.match(stdin, /不切分支/);
    assert.match(stdin, /git stash、git reset 或 git checkout/);
    assert.match(stdin, /不還原或改寫工作區中既有的未提交改動/);
    assert.match(stdin, /只修改 repo 內的檔案/);
    assert.match(stdin, /做不到時立即停下/);
    assert.match(stdin, /acceptance 必須逐條對應/);
    assert.match(stdin, /tests 必須附上實際執行的指令與結果/);
    assert.equal(readFileSync(resolve(taskDirectory, "prompt.md"), "utf8"), stdin);
    assert.deepEqual(JSON.parse(readFileSync(resolve(taskDirectory, "schema.json"), "utf8")), CODEX_REPORT_SCHEMA);
    assert.match(readFileSync(resolve(taskDirectory, "events.jsonl"), "utf8"), /thread\.started/);
    assert.deepEqual(collected.starts, [{ pid: 4321 }, { codexThreadId: "thread-123" }]);
    assert.deepEqual(collected.progress, [
      "$ npm test（結束碼 0）", "✎ src/new.ts", "完成 JSON 摘要", "完成所有工作",
    ]);
    assert.deepEqual(result.report, report);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.usage, {
      model: "codex", inputTokens: 10, cacheReadInputTokens: 4, outputTokens: 8,
      cacheCreationInputTokens: 0, reasoningTokens: 3, attempts: 1,
    });
    assert.deepEqual(result.diff, { added: ["src/new.ts"], modified: [], deleted: [], headChanged: false });
    assert.deepEqual(result.mismatch, {
      reportedButUnchanged: [], changedButUnreported: [], kindDiffers: [],
    });
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousCodex === undefined) delete process.env.CODEX_API_KEY;
    else process.env.CODEX_API_KEY = previousCodex;
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 turn.failed 優先採用事件錯誤，而一般非零結束碼則保留 stderr 尾端，讓失敗原因可供完成通知使用。
test("CodexRunner reports turn failures and nonzero stderr", async (context) => {
  const cases = [
    {
      name: "turn failed",
      events: [{ type: "turn.failed", error: { message: "額度用完" } }],
      stderr: "次要錯誤",
      expected: "額度用完",
    },
    { name: "exit failure", events: [], stderr: "編譯失敗", expected: "編譯失敗" },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      const directory = mkdtempSync(join(tmpdir(), "alice-codex-fail-"));
      const child = createFakeChild();
      const spawn: CodexSpawn = () => {
        child.stdin.once("finish", () => {
          if (item.events.length > 0) child.stdout.write(`${JSON.stringify(item.events[0])}\n`);
          child.stderr.write(item.stderr);
          child.close(2);
        });
        return child as never;
      };
      try {
        const runner = new CodexRunner(configFor(directory), {
          spawn, authExec, snapshotter: snapshots({ head: null, files: {} }, { head: null, files: {} }),
        });
        const collected = collectHooks();
        await runner.start(taskFor(directory), collected.hooks);
        assert.equal((await collected.result).status, "failed");
        assert.equal((await collected.result).error, item.expected);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

// 測試缺少或不合格的 report.json 不會推翻成功結束碼，但會清空回報並留下可診斷的 reportError。
test("CodexRunner succeeds with reportError for missing or invalid reports", async (context) => {
  for (const item of [
    { name: "missing", content: undefined, expected: "找不到 report.json" },
    { name: "invalid", content: JSON.stringify({ summary: "欄位不足" }), expected: "不符合 schema" },
  ]) {
    await context.test(item.name, async () => {
      const directory = mkdtempSync(join(tmpdir(), "alice-codex-report-"));
      const child = createFakeChild();
      const spawn: CodexSpawn = (_command, args) => {
        child.stdin.once("finish", () => {
          if (item.content !== undefined) writeFileSync(args.at(-1)!, item.content, "utf8");
          child.close(0);
        });
        return child as never;
      };
      try {
        const runner = new CodexRunner(configFor(directory), {
          spawn, authExec, snapshotter: snapshots({ head: null, files: {} }, { head: null, files: {} }),
        });
        const collected = collectHooks();
        await runner.start(taskFor(directory), collected.hooks);
        const result = await collected.result;
        assert.equal(result.status, "succeeded");
        assert.equal(result.report, null);
        assert.match(result.reportError ?? "", new RegExp(item.expected));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

// 測試登入與 Git repo 前置檢查失敗都不會啟動 Codex，避免未授權或無法驗收的工作進入執行階段。
test("CodexRunner stops before spawn when auth or repository checks fail", async (context) => {
  await context.test("auth failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alice-codex-auth-fail-"));
    let spawned = false;
    try {
      const runner = new CodexRunner(configFor(directory), {
        spawn: (() => { spawned = true; throw new Error("must not spawn"); }) as CodexSpawn,
        authExec: async () => ({ stdout: "Not logged in", stderr: "" }),
        snapshotter: snapshots({ head: null, files: {} }),
      });
      const collected = collectHooks();
      await runner.start(taskFor(directory), collected.hooks);
      assert.equal(spawned, false);
      assert.match((await collected.result).error ?? "", /^Codex 未以 ChatGPT 訂閱登入：/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await context.test("non-git repository", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alice-codex-not-git-"));
    let spawned = false;
    try {
      const runner = new CodexRunner(configFor(directory), {
        spawn: (() => { spawned = true; throw new Error("must not spawn"); }) as CodexSpawn,
        authExec,
        snapshotter: { take: async () => { throw new Error("repo 不是 git repo"); } },
      });
      const collected = collectHooks();
      await runner.start(taskFor(directory), collected.hooks);
      assert.equal(spawned, false);
      assert.equal((await collected.result).error, "repo 不是 git repo");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// 測試逾時會終止整個行程樹並等 close 後回報 failed，避免 Codex 子行程在背景殘留。
test("CodexRunner kills the process tree on timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-codex-timeout-"));
  const child = createFakeChild(9001);
  const killed: number[] = [];
  try {
    const runner = new CodexRunner(configFor(directory, 0.0001), {
      spawn: (() => child as never) as CodexSpawn,
      authExec,
      snapshotter: snapshots({ head: null, files: {} }, { head: null, files: {} }),
      killTree: (pid) => { killed.push(pid); child.close(1); },
    });
    const collected = collectHooks();
    await runner.start(taskFor(directory), collected.hooks);
    const result = await collected.result;
    assert.deepEqual(killed, [9001]);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "逾時（上限 0.0001 分鐘）");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試取消會終止整個行程樹、等待 close，再只回報 cancelled 終態。
test("CodexRunner waits for close when cancelling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-codex-cancel-"));
  const child = createFakeChild(9002);
  const killed: number[] = [];
  let spawned!: () => void;
  const spawnReady = new Promise<void>((resolvePromise) => { spawned = resolvePromise; });
  try {
    const runner = new CodexRunner(configFor(directory), {
      spawn: (() => { spawned(); return child as never; }) as CodexSpawn,
      authExec,
      snapshotter: snapshots({ head: null, files: {} }, { head: null, files: {} }),
      killTree: (pid) => { killed.push(pid); child.close(1); },
    });
    const collected = collectHooks();
    const running = runner.start(taskFor(directory), collected.hooks);
    await spawnReady;
    await runner.cancel("task-123");
    await running;
    assert.deepEqual(killed, [9002]);
    assert.equal((await collected.result).status, "cancelled");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 Windows 行程樹清理使用固定 taskkill 參數，且殘留 PID 已不存在時不把重啟清理視為錯誤。
test("killProcessTree invokes Windows taskkill and ignores a missing process", async () => {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const fakeExec = ((
    command: string,
    args: readonly string[],
    options: unknown,
    callback: (error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ command, args, options });
    callback(Object.assign(new Error("not found"), { code: 128 }), "", "找不到處理程序");
    return {};
  }) as never;
  await killProcessTree(7788, "win32", fakeExec);
  assert.equal(calls[0]?.command, "taskkill");
  assert.deepEqual(calls[0]?.args, ["/T", "/F", "/PID", "7788"]);
  assert.deepEqual(calls[0]?.options, { shell: false, windowsHide: true });
});
