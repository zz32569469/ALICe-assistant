// ALICE_DOC 區塊（§45）：艾莉絲把整理好的文件直接寫成 Obsidian 可開的 .md 檔。
// 只能寫進 alice.local.json 的 docRoots（不可是知識庫），不經 Codex、不需要 git repo。
// 新檔直接寫；已存在的檔案要 overwrite: true 才覆蓋，覆蓋前把舊版備份到 Core 資料夾。

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ALICE_BLOCK_MARKERS } from "../tasks/aliceBlockFilter.js";

export type DocRoot = { name: string; path: string };

export type DocBlock = { root?: string; path: string; overwrite: boolean; content: string };

const MAX_CONTENT = 200_000;

function stripMarkers(text: string): string {
  const { start, end } = ALICE_BLOCK_MARKERS.doc;
  return text.replace(start, "").replace(end, "").replace(/^\r?\n/u, "").replace(/\r?\n?$/u, "");
}

/** 第一行是 JSON 標頭（{"path":"…"}），之後全部是文件內容。 */
export function parseDocBlock(blockText: string): DocBlock {
  const body = stripMarkers(blockText);
  const newline = body.indexOf("\n");
  const headerText = (newline < 0 ? body : body.slice(0, newline)).trim();
  let header: unknown;
  try {
    header = JSON.parse(headerText);
  } catch {
    throw new Error("第一行必須是 JSON 標頭，例如 {\"path\":\"專案名/文件名.md\"}");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) throw new Error("標頭必須是 JSON 物件");
  const value = header as Record<string, unknown>;
  if (typeof value.path !== "string" || value.path.trim() === "") throw new Error("path 必須是非空白字串");
  if (value.root !== undefined && typeof value.root !== "string") throw new Error("root 必須是字串");
  if (value.overwrite !== undefined && typeof value.overwrite !== "boolean") throw new Error("overwrite 必須是布林值");
  const content = newline < 0 ? "" : body.slice(newline + 1);
  if (content.trim() === "") throw new Error("文件內容是空的");
  if (content.length > MAX_CONTENT) throw new Error(`文件太長（最多 ${MAX_CONTENT} 字）`);
  return {
    ...(value.root === undefined ? {} : { root: value.root.trim() }),
    path: value.path.trim().replace(/\\/gu, "/"),
    overwrite: value.overwrite === true,
    content,
  };
}

/** 檢查相對路徑：只能是 .md、不能跳出資料夾、不能寫進隱藏資料夾（.obsidian 等）、檔名不能有 Windows 不允許的字元。 */
function checkPath(path: string): string | undefined {
  if (isAbsolute(path) || /^[A-Za-z]:/u.test(path)) return "path 要寫資料夾裡的相對路徑";
  if (!path.toLowerCase().endsWith(".md")) return "只能寫 .md 檔";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return "path 不能有空白段、. 或 ..";
  if (segments.some((segment) => segment.startsWith("."))) return "不能寫進隱藏資料夾或隱藏檔（例如 .obsidian）";
  if (segments.some((segment) => /[<>:"|?*\u0000-\u001f]/u.test(segment) || /[. ]$/u.test(segment))) return "檔名或資料夾名有 Windows 不允許的字元";
  return undefined;
}

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Obsidian 用 YAML frontmatter 當屬性；艾莉絲沒寫的話補上建立日期與來源。 */
export function withFrontmatter(content: string, now: Date): string {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (/^---\n[\s\S]*?\n---(\n|$)/u.test(normalized)) return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  return `---\ncreated: ${localDate(now)}\nsource: ALICe\n---\n\n${normalized}${normalized.endsWith("\n") ? "" : "\n"}`;
}

/** 套用區塊，回傳給主人看的系統訊息。backupDir 是覆蓋前存舊版的地方（Core 的 data 資料夾）。 */
export function writeDocBlock(roots: DocRoot[], blockText: string, backupDir: string, now = new Date()): string {
  if (roots.length === 0) return "文件未寫入：本機設定沒有 docRoots（可寫入的文件資料夾）";
  let block: DocBlock;
  try {
    block = parseDocBlock(blockText);
  } catch (error) {
    return `文件未寫入：${error instanceof Error ? error.message : String(error)}`;
  }
  const root = block.root === undefined ? roots[0]! : roots.find((candidate) => candidate.name === block.root);
  if (root === undefined) return `文件未寫入：沒有叫「${block.root}」的文件資料夾（可用：${roots.map((candidate) => candidate.name).join("、")}）`;
  const problem = checkPath(block.path);
  if (problem !== undefined) return `文件未寫入：${problem}`;
  const target = resolve(root.path, ...block.path.split("/"));
  const inside = relative(resolve(root.path), target);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return "文件未寫入：路徑不在文件資料夾裡";
  let backup = "";
  if (existsSync(target)) {
    if (!block.overwrite) return `文件未寫入：已經有 ${target}。要覆蓋請主人明確說，再加上 "overwrite": true`;
    const stamp = now.toISOString().replace(/[:.]/gu, "-");
    const backupPath = join(backupDir, "doc-backups", `${stamp}-${basename(target)}`);
    mkdirSync(dirname(backupPath), { recursive: true });
    copyFileSync(target, backupPath);
    backup = `，舊版備份在 ${backupPath}`;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, withFrontmatter(block.content, now), "utf8");
  return `已${backup === "" ? "寫入" : "覆蓋"}文件：${target.split(sep).join("/")}${backup}`;
}
