import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { LocalConfig } from "../localConfig.js";

export function stripYamlFrontmatter(source: string): string {
  return source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

export class KnowledgeSummaryLoader {
  readonly #local: LocalConfig;
  #cachedMtimeMs: number | undefined;
  #cachedText: string | null = null;

  constructor(local: LocalConfig) {
    this.#local = local;
  }

  load(): string | null {
    if (!this.#local.summaryEnabled || this.#local.knowledgeBase === null) return null;
    const path = resolve(this.#local.knowledgeBase.path, this.#local.knowledgeBase.summaryPage);
    if (!existsSync(path)) return null;
    const mtimeMs = statSync(path).mtimeMs;
    if (mtimeMs !== this.#cachedMtimeMs) {
      this.#cachedText = stripYamlFrontmatter(readFileSync(path, "utf8"));
      this.#cachedMtimeMs = mtimeMs;
    }
    return this.#cachedText;
  }
}

