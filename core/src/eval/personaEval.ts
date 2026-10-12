import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, type Config } from "../config.js";
import { buildPrompt, loadFacts, loadPersona } from "../prompt/promptBuilder.js";
import { ClaudeCodeProvider } from "../reasoning/claudeCodeProvider.js";
import {
  ReasoningError,
  type ReasoningProvider,
  type ReasoningUsage,
} from "../reasoning/provider.js";
import { personaCases } from "./personaCases.js";

export type PersonaEvalOptions = {
  config?: Config;
  provider?: ReasoningProvider;
  outputPath?: string;
  startedAt?: Date;
  log?: (line: string) => void;
};

const emptyUsage: ReasoningUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

function fenced(text: string): string {
  const longestRun = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

function stateLineFrom(prompt: ReturnType<typeof buildPrompt>): string {
  const stateLine = prompt.systemPrompt.split(/\r?\n/).find((line) => line.startsWith("[目前狀態]"));
  if (stateLine === undefined) {
    throw new Error("Built prompt is missing the state line");
  }
  return stateLine;
}

function formatCaseSection(input: {
  id: string;
  userText: string;
  stateLine: string;
  expected: string;
  reply: string;
  usage: ReasoningUsage;
  errorKind?: string;
  errorMessage?: string;
}): string {
  const errorLines = input.errorKind === undefined
    ? []
    : [
        `- 錯誤種類：${input.errorKind}`,
        `- 錯誤訊息：${input.errorMessage ?? "（無）"}`,
      ];
  return [
    `## ${input.id}`,
    "",
    "### 輸入",
    "",
    fenced(input.userText),
    "",
    `- 送出的狀態行：${input.stateLine}`,
    `- 期望：${input.expected}`,
    ...errorLines,
    "",
    "### 回覆全文",
    "",
    fenced(input.reply),
    "",
    "### usage",
    "",
    `- input_tokens：${input.usage.input_tokens}`,
    `- output_tokens：${input.usage.output_tokens}`,
    `- cache_creation_input_tokens：${input.usage.cache_creation_input_tokens}`,
    `- cache_read_input_tokens：${input.usage.cache_read_input_tokens}`,
    "",
    "評分：",
  ].join("\n");
}

export async function runPersonaEval(options: PersonaEvalOptions = {}): Promise<void> {
  const config = options.config ?? loadConfig(process.env.ALICE_CONFIG);
  const provider = options.provider ?? new ClaudeCodeProvider(config);
  const outputPath = options.outputPath ?? resolve(config.dataDir, "persona-eval.md");
  const log = options.log ?? console.log;
  const personaText = loadPersona(config.personaPath);
  const factsText = loadFacts(config.factsPath);
  const sections: string[] = [];

  for (const testCase of personaCases) {
    const prompt = buildPrompt({
      personaText,
      factsText,
      history: [],
      userText: testCase.input,
      state: testCase.state,
      justWoken: testCase.justWoken,
      now: testCase.now,
    });
    const stateLine = stateLineFrom(prompt);
    let reply = "";
    let usage = emptyUsage;
    let errorKind: string | undefined;
    let errorMessage: string | undefined;

    try {
      const result = await provider.streamReply(prompt, () => {});
      reply = result.text;
      usage = result.usage;
    } catch (error) {
      errorKind = error instanceof ReasoningError ? error.kind : "unknown";
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    sections.push(formatCaseSection({
      id: testCase.id,
      userText: testCase.input,
      stateLine,
      expected: testCase.expected,
      reply,
      usage,
      ...(errorKind === undefined ? {} : { errorKind, errorMessage }),
    }));
    const status = errorKind === undefined ? "完成" : `失敗(${errorKind})`;
    log(
      `${testCase.id} ${status}：${reply.length} 字，input ${usage.input_tokens} / cache_read ${usage.cache_read_input_tokens} tokens`,
    );
  }

  const report = [
    "# 人格一致性測試結果",
    "",
    "- 推理引擎：Claude Code（訂閱）",
    `- 執行時間：${(options.startedAt ?? new Date()).toISOString()}`,
    `- 模型：${config.model}`,
    `- effort：${config.effort}`,
    "",
    sections.join("\n\n"),
    "",
  ].join("\n");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, report, "utf8");
}

const isDirectRun = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  try {
    await runPersonaEval();
  } catch (error) {
    console.error("Persona evaluation failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
