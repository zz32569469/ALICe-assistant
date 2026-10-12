import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type ErrorSource = "alice" | "worker" | "codex";

export type ErrorLogEntry = {
  ts: string;
  replyId: string;
  kind: string;
  message: string;
  attempts: number;
  source: ErrorSource;
};

export class ErrorLogger {
  readonly #dataDir: string;
  readonly #now: () => Date;

  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.#dataDir = dataDir;
    this.#now = now;
  }

  write(input: Omit<ErrorLogEntry, "ts">): void {
    try {
      mkdirSync(this.#dataDir, { recursive: true });
      appendFileSync(resolve(this.#dataDir, "errors.log"), `${JSON.stringify({
        ts: this.#now().toISOString(),
        ...input,
      })}\n`, "utf8");
    } catch (error) {
      console.warn("Unable to write errors.log:", error instanceof Error ? error.message : error);
    }
  }
}
