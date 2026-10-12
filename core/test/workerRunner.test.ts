import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { WorkerRunner, type WorkerSpawn } from "../src/channels/workerRunner.js";
import { defaultConfig } from "../src/config.js";

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: () => boolean;
  close: (code?: number) => void;
};

function fakeChild(pid = 321): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  child.close = (code = 0) => {
    child.exitCode = code;
    child.emit("close", code, null);
  };
  return child;
}

// 測試 worker 的參數、cwd、訂閱環境、stdin 與角色提示完全符合唯讀契約，並收集 session 與權限稽核。
test("WorkerRunner launches an exact read-only Claude request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-worker-"));
  const vault = join(directory, "vault");
  const projectPath = join(directory, "project");
  mkdirSync(join(vault, "roles"), { recursive: true });
  mkdirSync(projectPath);
  writeFileSync(join(vault, "roles", "工程師.md"), "---\nid: role\n---\n# 工程師\n角色內文", "utf8");
  const child = fakeChild();
  let command = "";
  let args: string[] = [];
  let options: Parameters<WorkerSpawn>[2] | undefined;
  let stdin = "";
  child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });
  const spawn: WorkerSpawn = (nextCommand, nextArgs, nextOptions) => {
    command = nextCommand;
    args = nextArgs;
    options = nextOptions;
    child.stdin.once("finish", () => {
      child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "sid-1" })}\n`);
      child.stdout.write(`${JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "查到結果" } },
      })}\n`);
      child.stdout.write(`${JSON.stringify({
        type: "result", is_error: false, result: "查到結果", session_id: "sid-1",
        permission_denials: [{ tool_name: "Read", tool_input: { file_path: "C:/secret.txt" } }],
      })}\n`);
      child.close();
    });
    return child as never;
  };
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  try {
    const config = { ...defaultConfig, dataDir: join(directory, "data") };
    const runner = new WorkerRunner(config, { path: vault, summaryPage: "summary.md", rolesDir: "roles" }, 5, { spawn });
    const deltas: string[] = [];
    const result = await runner.run({
      channelId: "channel-1",
      role: "工程師",
      project: { name: "專案", path: projectPath, role: "工程師", readDirs: ["C:/extra/logs"] },
      question: "請查資料",
      workerSessionId: null,
    }, (text) => deltas.push(text));
    const promptPath = resolve(directory, "data", "workers", "channel-1", "system-prompt.md");
    assert.equal(command, "claude");
    assert.deepEqual(args, [
      "-p", "--safe-mode", "--tools", "Read,Grep,Glob", "--disallowedTools", "mcp__*",
      "--permission-mode", "dontAsk", "--permission-prompts", "none", "--add-dir", vault, "--add-dir", "C:/extra/logs",
      "--model", defaultConfig.model, "--effort", "high", "--system-prompt-file", promptPath,
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    ]);
    assert.equal(options?.shell, false);
    assert.equal(options?.cwd, projectPath);
    assert.equal(options?.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(stdin, "請查資料");
    assert.deepEqual(deltas, ["查到結果"]);
    assert.deepEqual(result, { text: "查到結果", sessionId: "sid-1", permissionDeniedPaths: ["C:/secret.txt"] });
    const systemPrompt = readFileSync(promptPath, "utf8");
    assert.match(systemPrompt, /角色內文/);
    assert.doesNotMatch(systemPrompt, /人格本文/);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試後續輪次加入 --resume 並沿用 session，確保同一頻道能保留 worker 的查詢脈絡。
test("WorkerRunner resumes an existing worker session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-worker-resume-"));
  const vault = join(directory, "vault");
  const projectPath = join(directory, "project");
  mkdirSync(join(vault, "roles"), { recursive: true });
  mkdirSync(projectPath);
  writeFileSync(join(vault, "roles", "工程師.md"), "# 工程師", "utf8");
  let args: string[] = [];
  const spawn: WorkerSpawn = (_command, nextArgs) => {
    args = nextArgs;
    const child = fakeChild();
    child.stdin.once("finish", () => {
      child.stdout.write(`${JSON.stringify({ type: "result", is_error: false, result: "續答", session_id: "sid-1" })}\n`);
      child.close();
    });
    return child as never;
  };
  try {
    const runner = new WorkerRunner(
      { ...defaultConfig, dataDir: join(directory, "data") },
      { path: vault, summaryPage: "summary.md", rolesDir: "roles" },
      5,
      { spawn },
    );
    await runner.run({
      channelId: "channel-1", role: "工程師",
      project: { name: "專案", path: projectPath, role: "工程師", readDirs: [] },
      question: "追問", workerSessionId: "sid-1",
    }, () => {});
    assert.deepEqual(args.slice(0, 4), ["-p", "--resume", "sid-1", "--safe-mode"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試 worker 逾時會呼叫可注入的行程樹終止器並回報失敗，避免卡住頻道與並行名額。
test("WorkerRunner kills the process tree on timeout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-worker-timeout-"));
  const vault = join(directory, "vault");
  const projectPath = join(directory, "project");
  mkdirSync(join(vault, "roles"), { recursive: true });
  mkdirSync(projectPath);
  writeFileSync(join(vault, "roles", "工程師.md"), "# 工程師", "utf8");
  const killed: number[] = [];
  try {
    const runner = new WorkerRunner(
      { ...defaultConfig, dataDir: join(directory, "data") },
      { path: vault, summaryPage: "summary.md", rolesDir: "roles" },
      0.0001,
      { spawn: () => fakeChild(987) as never, killTree: (pid) => { killed.push(pid); } },
    );
    await assert.rejects(runner.run({
      channelId: "channel-timeout", role: "工程師",
      project: { name: "專案", path: projectPath, role: "工程師", readDirs: [] },
      question: "查詢", workerSessionId: null,
    }, () => {}), /逾時/);
    assert.deepEqual(killed, [987]);
    assert.equal(runner.activeCount(), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

