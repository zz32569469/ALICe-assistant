// Core 自己的驗收（R2-2）：修改項目前後各跑一次 testCommands，比對失敗清單，不採信執行者自述。
// 另外監看 git 看不到的路徑（R2-1，例如被 .gitignore 排除的 symlink），以檔案雜湊比對前後。

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { subscriptionOnlyEnv } from "../subscriptionEnv.js";

export const VERIFY_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type CommandRun = {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
};

export type VerifyCommandResult = {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** 失敗項目的識別字串（TAP 的 not ok 名稱、TypeScript 錯誤、或整條指令失敗）。 */
  failures: string[];
};

export type VerifyResult = { commands: VerifyCommandResult[] };

export type CommandExecutor = (repoPath: string, command: string, timeoutMs: number) => Promise<CommandRun>;

/** 以 shell 執行（npm、npx 在 Windows 是 .cmd），輸出上限 2 MB，逾時結束整個行程樹由呼叫端負責。 */
export const executeCommand: CommandExecutor = (repoPath, command, timeoutMs) => new Promise((resolvePromise) => {
  const started = Date.now();
  const child = spawn(command, { cwd: repoPath, shell: true, env: subscriptionOnlyEnv(), windowsHide: true });
  const chunks: Buffer[] = [];
  let size = 0;
  const collect = (chunk: Buffer): void => {
    if (size >= MAX_OUTPUT_BYTES) return;
    chunks.push(chunk);
    size += chunk.length;
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid !== undefined && process.platform === "win32") {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  const finish = (exitCode: number | null): void => {
    clearTimeout(timer);
    resolvePromise({ command, exitCode, timedOut, durationMs: Date.now() - started, output: Buffer.concat(chunks).toString("utf8") });
  };
  child.on("error", (error) => {
    chunks.push(Buffer.from(`\n無法執行：${error.message}`));
    finish(null);
  });
  child.on("close", (code) => finish(code));
});

/** 從輸出取出失敗項目。TAP 取「not ok」名稱；TypeScript 取錯誤行（去掉行列號，避免改檔後行號位移造成誤判）。 */
export function failureKeys(run: CommandRun): string[] {
  const keys = new Set<string>();
  for (const line of run.output.split(/\r?\n/u)) {
    const tap = /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/u.exec(line);
    if (tap !== null) {
      keys.add(`${run.command}：${tap[1]}`);
      continue;
    }
    const ts = /^(.+?)\(\d+,\d+\): error (TS\d+): (.+)$/u.exec(line.trim());
    if (ts !== null) keys.add(`${run.command}：${ts[1]}：${ts[2]}：${ts[3]}`);
  }
  if (run.timedOut) keys.add(`${run.command}：逾時`);
  else if (keys.size === 0 && run.exitCode !== 0) keys.add(`${run.command}：結束碼 ${String(run.exitCode)}`);
  return [...keys].sort();
}

export async function runVerification(
  repoPath: string,
  commands: readonly string[],
  execute: CommandExecutor = executeCommand,
  timeoutMs = VERIFY_TIMEOUT_MS,
): Promise<VerifyResult> {
  const results: VerifyCommandResult[] = [];
  for (const command of commands) {
    const run = await execute(repoPath, command, timeoutMs);
    results.push({ command, exitCode: run.exitCode, timedOut: run.timedOut, durationMs: run.durationMs, failures: failureKeys(run) });
  }
  return { commands: results };
}

export type VerifyComparison = {
  newFailures: string[];
  fixed: string[];
  baselineFailures: number;
  afterFailures: number;
};

export function compareVerification(before: VerifyResult, after: VerifyResult): VerifyComparison {
  const beforeKeys = new Set(before.commands.flatMap((entry) => entry.failures));
  const afterKeys = new Set(after.commands.flatMap((entry) => entry.failures));
  return {
    newFailures: [...afterKeys].filter((key) => !beforeKeys.has(key)).sort(),
    fixed: [...beforeKeys].filter((key) => !afterKeys.has(key)).sort(),
    baselineFailures: beforeKeys.size,
    afterFailures: afterKeys.size,
  };
}

/** git 監看的識別字串後綴：監看路徑本身是 git repo 時，以它的 HEAD 與 git status 代表整個資料夾。 */
export const GIT_WATCH_SUFFIX = "（git 狀態與 HEAD）";

/** 監看路徑本身是 git repo（R3-1，例：大型資料夾有約 8,000 檔，雜湊要近兩分鐘）：用 HEAD＋git status 當指紋，不到 1 秒。 */
function gitFingerprint(absolute: string): string | undefined {
  if (!existsSync(join(absolute, ".git"))) return undefined;
  try {
    const head = execFileSync("git", ["-C", absolute, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
    const status = execFileSync("git", ["-C", absolute, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", windowsHide: true });
    return createHash("sha256").update(`${head}\n${status}`).digest("hex");
  } catch {
    return undefined;
  }
}

/**
 * 監看路徑的指紋。一般資料夾：每個檔案的 sha256（跟隨 symlink；略過 node_modules、.git）。
 * git repo：整個資料夾一筆 HEAD＋git status 指紋。回傳「repo 相對路徑 → 指紋」。
 */
export function hashWatchedPaths(repoPath: string, watchPaths: readonly string[]): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (absolute: string): void => {
    if (!existsSync(absolute)) return;
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        if (entry === "node_modules" || entry === ".git") continue;
        walk(join(absolute, entry));
      }
      return;
    }
    if (!stats.isFile()) return;
    const key = relative(repoPath, absolute).split("\\").join("/");
    hashes.set(key, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
  };
  for (const watchPath of watchPaths) {
    const absolute = resolve(repoPath, watchPath);
    const git = gitFingerprint(absolute);
    if (git !== undefined) {
      hashes.set(`${relative(repoPath, absolute).split("\\").join("/")}${GIT_WATCH_SUFFIX}`, git);
      continue;
    }
    walk(absolute);
  }
  return hashes;
}

export function changedWatchedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [path, hash] of before) if (after.get(path) !== hash) changed.add(path);
  for (const path of after.keys()) if (!before.has(path)) changed.add(path);
  return [...changed].sort();
}
