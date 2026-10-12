import type { BuiltPrompt } from "../src/prompt/promptBuilder.js";
import {
  ReasoningError,
  type ReasoningErrorKind,
  type ReasoningProvider,
  type ReasoningRequestOptions,
  type ReasoningResult,
} from "../src/reasoning/provider.js";

export type FakeReply =
  | { text: string; deltas?: string[]; waitFor?: Promise<void>; result?: Partial<ReasoningResult> }
  | { error: ReasoningErrorKind; apiError?: boolean; waitFor?: Promise<void> };

export class FakeProvider implements ReasoningProvider {
  readonly prompts: BuiltPrompt[] = [];
  readonly options: ReasoningRequestOptions[] = [];
  readonly replies: FakeReply[];
  calls = 0;

  constructor(replies: FakeReply[]) {
    this.replies = [...replies];
  }

  async streamReply(
    prompt: BuiltPrompt,
    onDelta: (text: string) => void,
    options: ReasoningRequestOptions = {},
  ): Promise<ReasoningResult> {
    this.calls += 1;
    this.prompts.push(prompt);
    this.options.push(options);
    const reply = this.replies.shift();
    if (reply === undefined) {
      throw new Error("FakeProvider has no queued reply");
    }
    await reply.waitFor;
    if ("error" in reply) {
      throw new ReasoningError(reply.error, `fake ${reply.error}`, {
        apiError: reply.apiError ?? true,
      });
    }
    const deltas = reply.deltas ?? [reply.text];
    for (const delta of deltas) {
      onDelta(delta);
    }
    const base: ReasoningResult = {
      text: reply.text,
      stopReason: "end_turn",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
      },
      durationMs: 100,
      durationApiMs: 80,
      model: "fake-model",
      initModel: "fake-model",
      models: [{
        model: "fake-model",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
      }],
      attempts: 1,
      suspect: false,
    };
    return { ...base, ...reply.result };
  }
}
