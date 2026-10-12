import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { subscriptionOnlyEnv } from "../subscriptionEnv.js";

export type QuotaWindow = { usedPercent: number; resets: string };
export type QuotaResult =
  | { status: "ok"; currentSession?: QuotaWindow; currentWeek?: QuotaWindow; primary?: QuotaWindow; secondary?: QuotaWindow }
  | { status: "error"; message: "無法解析" | "無法讀取"; reason: string; sample?: string };

export type Quotas = { max: QuotaResult; codex: QuotaResult };
type Clock = () => number;

class CachedReader {
  readonly #load: () => Promise<QuotaResult>;
  readonly #now: Clock;
  readonly #ttlMs: number;
  #cached: { at: number; value: QuotaResult } | undefined;

  constructor(load: () => Promise<QuotaResult>, now: Clock, ttlMs: number) {
    this.#load = load;
    this.#now = now;
    this.#ttlMs = ttlMs;
  }

  async read(): Promise<QuotaResult> {
    const now = this.#now();
    if (this.#cached !== undefined && now - this.#cached.at < this.#ttlMs) return this.#cached.value;
    let value: QuotaResult;
    try {
      value = await this.#load();
    } catch (error) {
      value = { status: "error", message: "無法讀取", reason: error instanceof Error ? error.message : String(error) };
    }
    this.#cached = { at: now, value };
    return value;
  }
}

export function parseMaxUsage(text: string): QuotaResult {
  const parseLine = (label: string): QuotaWindow | undefined => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`^${escaped}:\\s*(\\d+(?:\\.\\d+)?)% used\\s*[·•]\\s*resets\\s+(.+)$`, "mi").exec(text);
    return match === null ? undefined : { usedPercent: Number(match[1]), resets: match[2]!.trim() };
  };
  const currentSession = parseLine("Current session");
  const currentWeek = parseLine("Current week (all models)");
  if (currentSession === undefined || currentWeek === undefined) {
    return { status: "error", message: "無法解析", reason: "找不到 Current session 或 Current week (all models)", sample: text.slice(0, 200) };
  }
  return { status: "ok", currentSession, currentWeek };
}

function runClaudeUsage(claudePath = "claude"): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(claudePath, [
      "-p", "--safe-mode", "--tools", "", "--no-session-persistence", "/usage",
    ], { env: subscriptionOnlyEnv(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(stderr.trim() || `claude /usage 結束碼 ${code ?? "unknown"}`));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findRateLimits(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.rate_limits)) return value.rate_limits;
  for (const nested of Object.values(value)) {
    const found = findRateLimits(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}

function numberField(value: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function resetText(value: Record<string, unknown>, nowMs: number): string | undefined {
  const at = numberField(value, ["resets_at", "reset_at", "resetsAt", "resetAt"]);
  if (at !== undefined) return new Date(at < 10_000_000_000 ? at * 1_000 : at).toISOString();
  const seconds = numberField(value, ["resets_in_seconds", "reset_in_seconds", "resetsInSeconds", "resetInSeconds"]);
  return seconds === undefined ? undefined : new Date(nowMs + seconds * 1_000).toISOString();
}

function parseCodexWindow(value: unknown, nowMs: number): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;
  const usedPercent = numberField(value, ["used_percent", "usedPercent", "percent_used", "percentUsed"]);
  const resets = resetText(value, nowMs);
  return usedPercent === undefined || resets === undefined ? undefined : { usedPercent, resets };
}

export function parseCodexUsageJsonl(text: string, nowMs = Date.now()): QuotaResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "").reverse();
  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    const payload = isRecord(event.payload) ? event.payload : undefined;
    if (event.type !== "token_count" && payload?.type !== "token_count") continue;
    const limits = findRateLimits(event);
    if (limits === undefined) continue;
    const primary = parseCodexWindow(limits.primary, nowMs);
    const secondary = parseCodexWindow(limits.secondary, nowMs);
    if (primary !== undefined || secondary !== undefined) return {
      status: "ok",
      ...(primary === undefined ? {} : { primary }),
      ...(secondary === undefined ? {} : { secondary }),
    };
  }
  return { status: "error", message: "無法讀取", reason: "最新 session 中找不到可解析的 token_count rate_limits" };
}

export async function loadLatestCodexSession(sessionsDir = resolve(homedir(), ".codex", "sessions")): Promise<string> {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/u.test(entry.name)) files.push({ path, mtimeMs: (await stat(path)).mtimeMs });
    }
  };
  await walk(sessionsDir);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (files[0] === undefined) throw new Error("找不到 Codex session 檔案");
  // 最新的 session 可能沒有可用的額度（剛開始、或額度用完時 rate_limits 的 primary／secondary 為 null），
  // 往前找最多 20 個檔案，回傳第一個解析得出數值的。
  for (const file of files.slice(0, 20)) {
    const text = await readFile(file.path, "utf8");
    if (text.includes("\"rate_limits\"") && parseCodexUsageJsonl(text).status === "ok") return text;
  }
  return await readFile(files[0].path, "utf8");
}

export class QuotaService {
  readonly #max: CachedReader;
  readonly #codex: CachedReader;

  constructor(options: {
    loadMax?: () => Promise<string>;
    loadCodex?: () => Promise<string>;
    now?: Clock;
    ttlMs?: number;
    claudePath?: string;
  } = {}) {
    const now = options.now ?? Date.now;
    const ttlMs = options.ttlMs ?? 60_000;
    const loadMax = options.loadMax ?? (() => runClaudeUsage(options.claudePath));
    this.#max = new CachedReader(async () => parseMaxUsage(await loadMax()), now, ttlMs);
    this.#codex = new CachedReader(async () => parseCodexUsageJsonl(await (options.loadCodex ?? loadLatestCodexSession)(), now()), now, ttlMs);
  }

  async read(): Promise<Quotas> {
    const [max, codex] = await Promise.all([this.#max.read(), this.#codex.read()]);
    return { max, codex };
  }
}
