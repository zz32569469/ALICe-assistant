import type { BuiltPrompt } from "../prompt/promptBuilder.js";

export type ReasoningErrorKind =
  | "auth"
  | "network"
  | "rate_limited"
  | "refused"
  | "other";

export type ReasoningUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type ReasoningResult = {
  text: string;
  stopReason: string | null;
  usage: ReasoningUsage;
  durationMs: number;
  durationApiMs: number;
  model: string;
  initModel?: string;
  models: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }>;
  attempts: number;
  suspect: boolean;
  /** §64：這次回覆用 SendMessage 送給同事 session 的訊息（Core 記在對話裡給主人看）。 */
  sentMessages?: Array<{ to: string; message: string }>;
};

export type ReasoningRequestOptions = {
  signal?: AbortSignal;
  effort?: "low" | "medium" | "high" | "max";
};

export class ReasoningError extends Error {
  readonly kind: ReasoningErrorKind;
  readonly apiError: boolean;

  constructor(kind: ReasoningErrorKind, message: string, options: { apiError?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ReasoningError";
    this.kind = kind;
    this.apiError = options.apiError ?? false;
  }
}

export interface ReasoningProvider {
  streamReply(
    prompt: BuiltPrompt,
    onDelta: (text: string) => void,
    options?: ReasoningRequestOptions,
  ): Promise<ReasoningResult>;
}
