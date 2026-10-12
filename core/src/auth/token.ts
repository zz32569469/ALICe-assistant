import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadOrCreateToken(path: string): string {
  if (existsSync(path)) {
    return readToken(path);
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return token;
}

export function readToken(path: string): string {
  const token = readFileSync(path, "utf8").trim();
  if (token === "") {
    throw new Error(`Token file is empty: ${path}`);
  }
  return token;
}
