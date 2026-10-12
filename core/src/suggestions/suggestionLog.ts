// 艾莉絲的自我改進建議（Q23、C3-2）：她不能改自己，只能提出建議；Core 只附加寫入建議檔，主人決定做不做。

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SUGGEST_BLOCK_MARKERS = { start: "<<<ALICE_SUGGEST", end: "ALICE_SUGGEST>>>" } as const;

export type Suggestion = {
  title: string;
  reason: string;
  impact: string;
  proposal: string;
};

const HEADER = [
  "# 艾莉絲的建議",
  "",
  "> 艾莉絲對自己（人格、流程、工具）的改進建議，由 Alice Core 自動附加；艾莉絲不會自己動手改。",
  "> 主人看過後，在每則建議的「主人決定」一行填寫：採用／不採用／之後再議，並可附理由。",
  "",
].join("\n");

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function parseSuggestBlock(blockText: string): Suggestion {
  if (!blockText.startsWith(SUGGEST_BLOCK_MARKERS.start) || !blockText.endsWith(SUGGEST_BLOCK_MARKERS.end)) {
    throw new Error("建議區塊標記不完整");
  }
  let value: unknown;
  try {
    value = JSON.parse(blockText.slice(SUGGEST_BLOCK_MARKERS.start.length, -SUGGEST_BLOCK_MARKERS.end.length).trim());
  } catch {
    throw new Error("建議區塊 JSON 格式錯誤");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("建議內容必須是 JSON 物件");
  const record = value as Record<string, unknown>;
  const allowed = new Set(["title", "reason", "impact", "proposal"]);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra !== undefined) throw new Error(`建議包含不支援的欄位：${extra}`);
  for (const key of ["title", "reason", "impact", "proposal"] as const) {
    if (!nonBlank(record[key])) throw new Error(`${key} 必須是非空白字串`);
  }
  if (Array.from(record.title as string).length > 80) throw new Error("title 最多 80 字");
  return {
    title: (record.title as string).trim(),
    reason: (record.reason as string).trim(),
    impact: (record.impact as string).trim(),
    proposal: (record.proposal as string).trim(),
  };
}

function localStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 只附加，不改寫既有內容。檔案不存在時先寫標頭。 */
export function appendSuggestion(path: string, suggestion: Suggestion, now: Date): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, HEADER, "utf8");
  }
  const indent = (text: string): string => text.split(/\r?\n/u).join("\n  ");
  appendFileSync(path, [
    "",
    `## ${localStamp(now)}　${suggestion.title}`,
    "",
    `- 理由：${indent(suggestion.reason)}`,
    `- 影響：${indent(suggestion.impact)}`,
    `- 建議做法：${indent(suggestion.proposal)}`,
    "- 主人決定：（未決定）",
    "",
  ].join("\n"), "utf8");
}
