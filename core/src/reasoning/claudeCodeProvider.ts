import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Config } from "../config.js";
import type { BuiltPrompt } from "../prompt/promptBuilder.js";
import { subscriptionOnlyEnv } from "../subscriptionEnv.js";
import { uploadsDir } from "../uploads/uploadStore.js";
import {
  ReasoningError,
  type ReasoningErrorKind,
  type ReasoningProvider,
  type ReasoningRequestOptions,
  type ReasoningResult,
  type ReasoningUsage,
} from "./provider.js";

type ClaudeSpawnOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ["pipe", "pipe", "pipe"];
};

export type ClaudeSpawn = (
  command: string,
  args: string[],
  options: ClaudeSpawnOptions,
) => ChildProcessWithoutNullStreams;

export type ClaudeCodeProviderOptions = {
  spawn?: ClaudeSpawn;
  warn?: (message: string) => void;
};

type StreamResult = {
  type: "result";
  is_error?: boolean;
  result?: unknown;
  duration_ms?: unknown;
  duration_api_ms?: unknown;
  usage?: Record<string, unknown>;
  modelUsage?: Record<string, unknown>;
};

type AttemptResult = Omit<ReasoningResult, "attempts" | "suspect"> & {
  sawThinking: boolean;
  rawText: string;
};

const authErrors = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "model_not_found",
  "invalid_request",
]);
const rateLimitedErrors = new Set(["rate_limit", "overloaded"]);

/** 對話時可用的內建工具（§41）：讀網頁與搜尋；§50 加上 Read，但只准讀 artDirs。 */
export const WEB_TOOLS = ["WebFetch", "WebSearch"];
/** §61：傳訊給同事 session（只限追問卡住的任務、確認進度，規則在提示裡）。 */
export const MESSAGE_TOOLS = ["SendMessage", "ListAgents"];
export const CHAT_TOOLS = [...WEB_TOOLS, "Read", ...MESSAGE_TOOLS];
/** Read 的允許規則：只有這些資料夾（用正斜線的絕對路徑）。 */
export const artReadRules = (dirs: string[]): string[] => dirs.map((dir) => `Read(${dir.replace(/\\/gu, "/")}/**)`);
export const artDirArgs = (dirs: string[]): string[] => dirs.flatMap((dir) => ["--add-dir", dir]);
/** §83：Read 可以讀的資料夾＝美術資料夾＋截圖資料夾。 */
export const readableDirs = (config: Pick<Config, "artDirs" | "dataDir">): string[] => [...config.artDirs, uploadsDir(config.dataDir)];
const chrome = (name: string): string => `mcp__claude-in-chrome__${name}`;
/** Claude in Chrome 只開放開分頁、開網址、讀頁面內容。 */
export const CHROME_READ_TOOLS = ["tabs_context_mcp", "tabs_create_mcp", "tabs_close_mcp", "navigate", "get_page_text", "read_page", "find", "list_connected_browsers"].map(chrome);
/** 會點擊、輸入、上傳、執行程式或讀到登入資訊的工具一律關掉。 */
export const CHROME_BLOCKED_TOOLS = [
  "computer", "browser_batch", "form_input", "file_upload", "upload_image", "javascript_tool", "shortcuts_execute", "shortcuts_list",
  "gif_creator", "read_network_requests", "read_console_messages", "resize_window", "select_browser", "switch_browser",
].map(chrome);

export function claudeSubscriptionEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return subscriptionOnlyEnv(source);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFrom(result: StreamResult): ReasoningUsage {
  const usage = result.usage ?? {};
  return {
    input_tokens: numberValue(usage.input_tokens),
    output_tokens: numberValue(usage.output_tokens),
    cache_creation_input_tokens: numberValue(usage.cache_creation_input_tokens),
    cache_read_input_tokens: numberValue(usage.cache_read_input_tokens),
  };
}

function modelsFrom(result: StreamResult): ReasoningResult["models"] {
  return Object.entries(result.modelUsage ?? {}).map(([model, rawUsage]) => {
    const usage = typeof rawUsage === "object" && rawUsage !== null
      ? rawUsage as Record<string, unknown>
      : {};
    return {
      model,
      inputTokens: numberValue(usage.inputTokens),
      outputTokens: numberValue(usage.outputTokens),
      cacheReadInputTokens: numberValue(usage.cacheReadInputTokens),
      cacheCreationInputTokens: numberValue(usage.cacheCreationInputTokens),
    };
  }).sort((left, right) => right.outputTokens - left.outputTokens);
}

function categoryInMessage(message: string): string | undefined {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("does not support this model")
    || normalized.includes("issue with the selected model")
  ) {
    return "model_not_found";
  }
  return [...authErrors, ...rateLimitedErrors, "server_error", "unknown"]
    .find((category) => normalized.includes(category));
}

function classifyFailure(category: string | undefined, message: string): ReasoningErrorKind {
  const effectiveCategory = categoryInMessage(message) ?? category;
  if (effectiveCategory !== undefined && authErrors.has(effectiveCategory)) {
    return "auth";
  }
  if (effectiveCategory !== undefined && rateLimitedErrors.has(effectiveCategory)) {
    return "rate_limited";
  }
  return "other";
}

export class ClaudeCodeProvider implements ReasoningProvider {
  readonly #config: Config;
  readonly #spawn: ClaudeSpawn;
  readonly #warn: (message: string) => void;
  readonly #warnedModelCombinations = new Set<string>();

  constructor(config: Config, options: ClaudeCodeProviderOptions = {}) {
    this.#config = config;
    this.#spawn = options.spawn ?? (spawn as ClaudeSpawn);
    this.#warn = options.warn ?? console.warn;
  }

  async streamReply(
    prompt: BuiltPrompt,
    onDelta: (text: string) => void,
    options: ReasoningRequestOptions = {},
  ): Promise<ReasoningResult> {
    const signal = options.signal;
    if (signal?.aborted) {
      throw new ReasoningError("network", "Claude Code request was aborted", { cause: signal.reason });
    }

    const workingDirectory = resolve(this.#config.dataDir, "claude-code");
    const systemPromptPath = resolve(workingDirectory, "system-prompt.md");
    mkdirSync(workingDirectory, { recursive: true });
    writeFileSync(systemPromptPath, prompt.systemPrompt, "utf8");

    const maxAttempts = Math.max(1, Math.trunc(this.#config.maxReplyAttempts));
    let lastAttempt: AttemptResult | undefined;
    for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
      const attempt = await this.#attempt(
        prompt,
        onDelta,
        workingDirectory,
        systemPromptPath,
        options.effort ?? this.#config.effort,
        signal,
      );
      const suspect = (this.#config.requireThinking && !attempt.sawThinking)
        || attempt.text.trim() === "";
      // 已經送出訊息的回覆不重試，免得同一則訊息送兩次。
      if (!suspect || (attempt.sentMessages?.length ?? 0) > 0) {
        const { sawThinking: _sawThinking, rawText: _rawText, ...result } = attempt;
        return { ...result, attempts, suspect };
      }
      lastAttempt = attempt;
    }

    if (lastAttempt === undefined) {
      throw new ReasoningError("other", "Claude Code did not make a reply attempt");
    }

    const { sawThinking, rawText, ...result } = lastAttempt;
    const fallbackText = this.#config.requireThinking && !sawThinking ? rawText : result.text;
    if (this.#config.requireThinking && !sawThinking && fallbackText !== "") {
      onDelta(fallbackText);
    }
    this.#warn(`Claude Code reply remained suspect after ${maxAttempts} attempt(s)`);
    return { ...result, text: fallbackText, attempts: maxAttempts, suspect: true };
  }

  async #attempt(
    prompt: BuiltPrompt,
    onDelta: (text: string) => void,
    workingDirectory: string,
    systemPromptPath: string,
    effort: ReasoningRequestOptions["effort"],
    signal?: AbortSignal,
  ): Promise<AttemptResult> {
    if (signal?.aborted) {
      throw new ReasoningError("network", "Claude Code request was aborted", { cause: signal.reason });
    }

    const args = [
      "-p",
      "--safe-mode",
      // §41：可以讀網頁、搜尋，並用主人的 Chrome 開頁閱讀；點擊、輸入、執行程式等會改動網頁的工具都關掉。
      "--chrome",
      "--tools",
      CHAT_TOOLS.join(","),
      // §50：美術資料夾加進可存取範圍，Read 只允許這些資料夾；其他路徑在 -p 模式沒有人核准，會被拒絕。
      ...artDirArgs(readableDirs(this.#config)),
      "--allowedTools",
      ...WEB_TOOLS,
      ...MESSAGE_TOOLS,
      ...artReadRules(readableDirs(this.#config)),
      ...CHROME_READ_TOOLS,
      "--disallowedTools",
      ...CHROME_BLOCKED_TOOLS,
      "--no-session-persistence",
      "--model",
      this.#config.model,
      "--effort",
      effort ?? this.#config.effort,
      "--system-prompt-file",
      systemPromptPath,
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawn(this.#config.claudePath, args, {
        cwd: workingDirectory,
        env: claudeSubscriptionEnv(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new ReasoningError(code === "ENOENT" ? "auth" : "other", "Unable to start Claude Code", {
        cause: error,
      });
    }

    return await new Promise<AttemptResult>((resolvePromise, rejectPromise) => {
      let settled = false;
      let stdoutBuffer = "";
      let stderrTail = Buffer.alloc(0);
      let finalResult: StreamResult | undefined;
      let lastRetryError: string | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let sawThinking = false;
      let initModel: string | undefined;
      let preThinkingText = "";
      let streamedText = "";
      let afterTool = false;
      const sentMessages: Array<{ to: string; message: string }> = [];

      const stopChild = (): void => {
        if (child.exitCode !== null || child.signalCode !== null) {
          return;
        }
        child.kill("SIGINT");
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 5_000);
        forceKillTimer.unref();
      };
      const cleanup = (): void => {
        clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", onAbort);
      };
      const rejectOnce = (error: ReasoningError): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        rejectPromise(error);
      };
      const onAbort = (): void => {
        stopChild();
        rejectOnce(new ReasoningError("network", "Claude Code request was aborted", {
          cause: signal?.reason,
        }));
      };
      const handleLine = (line: string): void => {
        if (line.trim() === "") {
          return;
        }
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.#warn(`Ignoring invalid Claude Code stream line: ${line.slice(0, 200)}`);
          return;
        }

        if (event.type === "stream_event") {
          const streamEvent = event.event as Record<string, unknown> | undefined;
          const contentBlock = streamEvent?.content_block as Record<string, unknown> | undefined;
          // 用過工具（讀網頁）之後的文字跟前面那段分開，不要黏在一起。
          if (streamEvent?.type === "content_block_start" && contentBlock?.type === "tool_use") {
            afterTool = true;
            return;
          }
          if (
            streamEvent?.type === "content_block_start"
            && contentBlock?.type === "thinking"
          ) {
            sawThinking = true;
            preThinkingText = "";
            return;
          }
          const delta = streamEvent?.delta as Record<string, unknown> | undefined;
          if (
            streamEvent?.type === "content_block_delta"
            && delta?.type === "text_delta"
            && typeof delta.text === "string"
          ) {
            if (!this.#config.requireThinking || sawThinking) {
              const text = afterTool && streamedText.trim() !== "" ? `\n\n${delta.text}` : delta.text;
              afterTool = false;
              streamedText += text;
              onDelta(text);
            } else {
              preThinkingText += delta.text;
            }
          }
          return;
        }
        if (
          event.type === "system"
          && event.subtype === "init"
          && typeof event.model === "string"
          && initModel === undefined
        ) {
          initModel = event.model;
          return;
        }
        if (event.type === "system" && event.subtype === "api_retry" && typeof event.error === "string") {
          lastRetryError = event.error;
          return;
        }
        // §64：記下送出的 SendMessage（完整參數在 assistant 事件裡）。
        if (event.type === "assistant") {
          const content = (event.message as { content?: unknown } | undefined)?.content;
          for (const block of Array.isArray(content) ? content as Array<Record<string, unknown>> : []) {
            if (block.type !== "tool_use" || block.name !== "SendMessage") continue;
            const input = (block.input ?? {}) as Record<string, unknown>;
            sentMessages.push({ to: String(input.to ?? ""), message: String(input.message ?? "") });
          }
          return;
        }
        if (event.type === "result") {
          finalResult = event as StreamResult;
        }
      };

      const timeoutTimer = setTimeout(() => {
        stopChild();
        rejectOnce(new ReasoningError("network", `Claude Code timed out after ${this.#config.replyTimeoutMs} ms`));
      }, this.#config.replyTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout.on("data", (chunk: Buffer | string) => {
        const lines = `${stdoutBuffer}${chunk.toString()}`.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-2_048);
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        this.#warn(`Claude Code stdin error: ${error.message}`);
      });
      child.once("error", (error: NodeJS.ErrnoException) => {
        const kind: ReasoningErrorKind = error.code === "ENOENT" ? "auth" : "other";
        rejectOnce(new ReasoningError(kind, `Unable to start Claude Code: ${error.message}`, {
          cause: error,
        }));
      });
      child.once("close", (code) => {
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        if (settled) {
          return;
        }
        if (stdoutBuffer !== "") {
          handleLine(stdoutBuffer);
        }
        settled = true;
        cleanup();

        if (finalResult !== undefined && finalResult.is_error === false) {
          const models = modelsFrom(finalResult);
          const model = models[0]?.model ?? this.#config.model;
          if ((initModel !== undefined && initModel !== this.#config.model) || model !== this.#config.model) {
            const combination = `${initModel ?? ""}\u0000${model}`;
            if (!this.#warnedModelCombinations.has(combination)) {
              this.#warnedModelCombinations.add(combination);
              this.#warn(`[警告] 設定模型 ${this.#config.model}，實際 init=${initModel} 主要=${model}`);
            }
          }
          const rawText = typeof finalResult.result === "string" ? finalResult.result : "";
          resolvePromise({
            text: this.#config.requireThinking ? streamedText : rawText,
            stopReason: "end_turn",
            usage: usageFrom(finalResult),
            durationMs: numberValue(finalResult.duration_ms),
            durationApiMs: numberValue(finalResult.duration_api_ms),
            model,
            ...(initModel === undefined ? {} : { initModel }),
            models,
            ...(sentMessages.length === 0 ? {} : { sentMessages }),
            sawThinking,
            rawText,
          });
          return;
        }

        const resultMessage = typeof finalResult?.result === "string" ? finalResult.result : "";
        const stderrMessage = stderrTail.toString("utf8").trim();
        const message = resultMessage || stderrMessage || `Claude Code exited with code ${code ?? "unknown"}`;
        const kind = finalResult?.is_error === true
          ? classifyFailure(lastRetryError, resultMessage)
          : "other";
        rejectPromise(new ReasoningError(kind, message, { apiError: true }));
      });

      child.stdin.end(prompt.transcript, "utf8");
    });
  }
}
