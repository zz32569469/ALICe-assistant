// 進度資料收集（§30 M-3）：不用推理，直接讀文件段落與 git 狀態；艾莉絲再用一次推理整理成總覽。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRunningJob, type CodexJob } from "../codex/codexBoard.js";

import type { WorkerProjectConfig } from "../localConfig.js";
import { stageSummary, type Game, type GameTask } from "./gameStore.js";
import { trackLabel } from "./workflow.js";

const SECTION_MAX_CHARS = 2500;
const GAME_MAX_CHARS = 12_000;
const GIT_TIMEOUT_MS = 10_000;
/** 預設要讀的段落：標題含「現況」，或含「待」但不是「待回寫」（§30 M-3）。 */
const DEFAULT_SECTION = /現況|待(?!回寫)/u;

export type DocFile = { name: string; path: string; modifiedAt: string };
export type DocSection = { file: string; heading: string; text: string };
export type BranchInfo = {
  repo: string;
  branch: string;
  lastCommitAt: string;
  subject: string;
  /** null：沒有遠端追蹤分支。 */
  unpushed: number | null;
  /** 在主目錄切出來的分支。 */
  current: boolean;
};

/** §76：專案分支切在主目錄以外的 git worktree（例：兩個專案同時開發），那裡的未提交狀態。 */
export type WorktreeInfo = { path: string; branch: string; uncommitted: number; error?: string };
export type RepoInfo = {
  repo: string;
  currentBranch: string;
  uncommitted: number;
  branches: BranchInfo[];
  /** §76：本專案分支所在的其他 worktree。 */
  worktrees?: WorktreeInfo[];
  error?: string;
};
export type GameActivity = { lastActivityAt: string | null; docs: DocFile[]; repos: RepoInfo[] };
export type GameProgress = GameActivity & { game: Game; sections: DocSection[]; warnings: string[] };

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}\n…（以下省略）` : text;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
}

export function listDocs(game: Game): DocFile[] {
  if (game.docsDir === null || !existsSync(game.docsDir)) return [];
  return readdirSync(game.docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name.startsWith(game.filePrefix))
    .map((entry) => {
      const path = join(game.docsDir!, entry.name);
      return { name: entry.name, path, modifiedAt: statSync(path).mtime.toISOString() };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
}

/** 取出 markdown 的段落：從符合的標題到下一個同級或更高級的標題。 */
export function extractSections(source: string, wanted: (heading: string) => boolean): Array<{ heading: string; text: string }> {
  const lines = source.split(/\r?\n/u);
  const sections: Array<{ heading: string; text: string }> = [];
  let inFence = false;
  const headings: Array<{ index: number; level: number; title: string }> = [];
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/u.test(line)) inFence = !inFence;
    const match = inFence ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match !== null) headings.push({ index, level: match[1]!.length, title: match[2]! });
  });
  headings.forEach((heading, position) => {
    if (!wanted(heading.title)) return;
    // 父段落已經整段收進來時，不重複收子段落。
    const parent = sections.length > 0 ? headings.slice(0, position).reverse().find((entry) => entry.level < heading.level) : undefined;
    if (parent !== undefined && wanted(parent.title)) return;
    const end = headings.slice(position + 1).find((entry) => entry.level <= heading.level)?.index ?? lines.length;
    sections.push({ heading: heading.title, text: lines.slice(heading.index, end).join("\n").trim() });
  });
  return sections;
}

function sectionMatcher(game: Game): (heading: string) => boolean {
  if (game.sections === null || game.sections.length === 0) return (heading) => DEFAULT_SECTION.test(heading);
  return (heading) => game.sections!.some((keyword) => heading.includes(keyword));
}

/** §76：解析 `git worktree list --porcelain`：每個 worktree 的路徑與切出的分支（detached 或 bare 的略過）。 */
export function parseWorktreeList(text: string): Array<{ path: string; branch: string }> {
  return text.split(/\r?\n\r?\n/u).flatMap((block) => {
    const path = /^worktree (.+)$/mu.exec(block)?.[1]?.trim();
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1]?.trim();
    return path === undefined || branch === undefined ? [] : [{ path, branch }];
  });
}

const samePath = (left: string, right: string): boolean => resolve(left).toLowerCase() === resolve(right).toLowerCase();

function statusCount(cwd: string): number {
  const status = git(cwd, ["status", "--porcelain"]);
  return status === "" ? 0 : status.split(/\r?\n/u).length;
}

export function repoInfo(project: WorkerProjectConfig, code: string): RepoInfo {
  try {
    const currentBranch = git(project.path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = git(project.path, ["status", "--porcelain"]);
    const refs = git(project.path, ["for-each-ref", "refs/heads", "--sort=-committerdate", "--format=%(refname:short)%09%(committerdate:iso-strict)%09%(upstream:short)%09%(subject)"]);
    const key = code.toLowerCase();
    const branches: BranchInfo[] = refs.split(/\r?\n/u).filter(Boolean).map((line) => {
      const [branch = "", lastCommitAt = "", upstream = "", ...subject] = line.split("\t");
      return { branch, lastCommitAt, upstream, subject: subject.join("\t") };
    })
      .filter((entry) => key === "" ? entry.branch === currentBranch : entry.branch.toLowerCase().includes(key))
      .slice(0, 5)
      .map((entry) => {
        let unpushed: number | null = null;
        if (entry.upstream !== "") {
          try {
            unpushed = Number(git(project.path, ["rev-list", "--count", `${entry.upstream}..${entry.branch}`]));
          } catch {
            unpushed = null;
          }
        }
        return {
          repo: project.name, branch: entry.branch, lastCommitAt: new Date(entry.lastCommitAt).toISOString(), subject: entry.subject,
          unpushed, current: entry.branch === currentBranch,
        };
      });
    // §76：本專案分支若切在其他 worktree，讀那裡的未提交狀態。
    let worktrees: WorktreeInfo[] = [];
    try {
      worktrees = parseWorktreeList(git(project.path, ["worktree", "list", "--porcelain"]))
        .filter((entry) => !samePath(entry.path, project.path) && branches.some((branch) => branch.branch === entry.branch))
        .map((entry) => {
          try {
            return { path: entry.path, branch: entry.branch, uncommitted: statusCount(entry.path) };
          } catch (error) {
            return { path: entry.path, branch: entry.branch, uncommitted: 0, error: error instanceof Error ? error.message.split(/\r?\n/u)[0]! : String(error) };
          }
        });
    } catch {
      worktrees = [];
    }
    return { repo: project.name, currentBranch, uncommitted: status === "" ? 0 : status.split(/\r?\n/u).length, branches, ...(worktrees.length === 0 ? {} : { worktrees }) };
  } catch (error) {
    return { repo: project.name, currentBranch: "", uncommitted: 0, branches: [], error: error instanceof Error ? error.message.split(/\r?\n/u)[0]! : String(error) };
  }
}

function latest(values: string[]): string | null {
  const sorted = values.filter((value) => !Number.isNaN(new Date(value).getTime())).sort();
  return sorted.length === 0 ? null : sorted[sorted.length - 1]!;
}

/** 只看最後動靜（給提示與每日彙整用，不讀檔案內容）。 */
export function gameActivity(game: Game, projects: WorkerProjectConfig[]): GameActivity {
  const docs = listDocs(game);
  const repos = game.repos
    .map((name) => projects.find((project) => project.name === name))
    .filter((project): project is WorkerProjectConfig => project !== undefined)
    .map((project) => repoInfo(project, game.code));
  const lastActivityAt = latest([
    ...docs.map((doc) => doc.modifiedAt),
    ...repos.flatMap((repo) => repo.branches.map((branch) => branch.lastCommitAt)),
  ]);
  return { lastActivityAt, docs, repos };
}

export function collectProgress(game: Game, projects: WorkerProjectConfig[]): GameProgress {
  const activity = gameActivity(game, projects);
  const warnings: string[] = [];
  if (game.docsDir === null) warnings.push("專案卡沒有設定文件資料夾");
  else if (!existsSync(game.docsDir)) warnings.push(`找不到文件資料夾 ${game.docsDir}`);
  else if (activity.docs.length === 0) warnings.push(`文件資料夾裡沒有「${game.filePrefix}」開頭的 .md 檔`);
  for (const name of game.repos) {
    if (!projects.some((project) => project.name === name)) warnings.push(`本機設定裡沒有專案「${name}」`);
  }
  const wanted = sectionMatcher(game);
  const sections: DocSection[] = [];
  let used = 0;
  // 更改紀錄、待確認檔優先，其次依修改時間。
  const ordered = [...activity.docs].sort((left, right) => {
    const rank = (doc: DocFile) => /更改紀錄|待確認/u.test(doc.name) ? 0 : 1;
    return rank(left) - rank(right) || right.modifiedAt.localeCompare(left.modifiedAt);
  });
  for (const doc of ordered) {
    let source: string;
    try {
      source = readFileSync(doc.path, "utf8");
    } catch {
      continue;
    }
    for (const section of extractSections(source, wanted)) {
      if (used >= GAME_MAX_CHARS) break;
      const text = clip(section.text, Math.min(SECTION_MAX_CHARS, GAME_MAX_CHARS - used));
      used += Array.from(text).length;
      sections.push({ file: doc.name, heading: section.heading, text });
    }
  }
  if (used >= GAME_MAX_CHARS) warnings.push(`段落超過 ${GAME_MAX_CHARS} 字，後面的已省略`);
  return { ...activity, game, sections, warnings };
}

export function daysBetween(from: Date, to: Date): number {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day(to) - day(from)) / 86_400_000);
}

/** YYYY-MM-DD 當成本地日期。 */
export function localDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year!, month! - 1, day!);
}

export function deadlineText(deadline: string | null, now: Date): string {
  if (deadline === null) return "沒有截止日";
  const days = daysBetween(now, localDate(deadline));
  if (days < 0) return `截止 ${deadline}（已過 ${-days} 天）`;
  if (days === 0) return `截止 ${deadline}（今天）`;
  return `截止 ${deadline}（剩 ${days} 天）`;
}

function localTime(value: string): string {
  const date = new Date(value);
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 給艾莉絲整理總覽用的文字。 */
const CODEX_STATUS: Record<string, string> = { completed: "完成", failed: "失敗", cancelled: "取消", error: "失敗" };

/** §65：一行 Codex 任務（時間用絕對時間，指紋才不會每天變）。 */
export function codexJobLine(job: CodexJob): string {
  const status = isRunningJob(job) ? "執行中" : CODEX_STATUS[job.status] ?? job.status;
  const kind = job.write === false ? "唯讀審查" : "實作";
  const who = job.by?.session ? `${job.by.session}，` : "";
  const when = isRunningJob(job)
    ? `開始 ${job.startedAt ? localTime(job.startedAt) : "時間不明"}`
    : `${job.completedAt ? localTime(job.completedAt) : "時間不明"} 結束${typeof job.durationMin === "number" ? `，${job.durationMin} 分` : ""}`;
  const reason = job.failReason ? `：${job.failReason.slice(0, 120)}` : "";
  return `  - 〔${status}〕${job.label}（${who}${kind}，${when}）${reason}`;
}

/** stageLines：§72 目前階段的負責 session、完成條件、要主人決定的事（GameService 依知識庫角色頁算好）。 */
export function formatProgress(progress: GameProgress, now: Date, tasks: GameTask[] = [], codexJobs: CodexJob[] = [], stageLines: string[] = []): string {
  const { game } = progress;
  const lines = [
    `## ${game.name}${game.code === "" ? "" : `（${game.code}）`}${game.brand === "" ? "" : `・${game.brand}`}`,
    `- 階段：${stageSummary(game)}${game.versionReason === "" ? "" : `（需求來源：${game.versionReason}）`}；${deadlineText(game.deadline, now)}`,
    `- 最後動靜：${progress.lastActivityAt === null ? "查不到" : `${localTime(progress.lastActivityAt)}（${daysBetween(new Date(progress.lastActivityAt), now)} 天前）`}`,
  ];
  lines.push(...stageLines);
  if (game.sessions.length > 0) lines.push(`- 同事 session：${game.sessions.join("、")}`);
  // §46：任務清單，讓艾莉絲對照更改紀錄與 git 更新狀態。
  const listed = tasks.filter((task) => task.status !== "取消");
  lines.push(listed.length === 0 ? "- 任務清單：（還沒有任務）" : "- 任務清單：");
  for (const task of listed) {
    lines.push(`  - T${task.number}〔${trackLabel(task.track)}・${task.status}・${task.source}・v${task.version}〕${task.title}${task.note === "" ? "" : `— ${task.note}`}（更新 ${task.updatedAt.slice(0, 10)}）`);
  }
  // §65：最近的 Codex 任務（看板）：寫測試或唯讀審查（較早的可能是實作）。
  if (codexJobs.length > 0) {
    lines.push("- Codex 任務（看板，最近 7 天）：");
    for (const job of codexJobs) lines.push(codexJobLine(job));
  }
  for (const repo of progress.repos) {
    if (repo.error !== undefined) {
      lines.push(`- repo ${repo.repo}：讀不到 git 狀態（${repo.error}）`);
      continue;
    }
    const onGame = repo.branches.some((branch) => branch.current);
    const elsewhere = (repo.worktrees ?? []).length > 0;
    lines.push(`- repo ${repo.repo}：${elsewhere ? "主目錄" : "目前"}在 ${repo.currentBranch}${onGame ? "" : elsewhere ? "（不是本專案的分支；本專案在另一個 worktree）" : "（不是本專案的分支）"}，未提交 ${repo.uncommitted} 個檔`);
    for (const worktree of repo.worktrees ?? []) {
      lines.push(worktree.error === undefined
        ? `  - worktree ${worktree.path}：切在 ${worktree.branch}，未提交 ${worktree.uncommitted} 個檔`
        : `  - worktree ${worktree.path}：切在 ${worktree.branch}，讀不到狀態（${worktree.error}）`);
    }
    for (const branch of repo.branches) {
      lines.push(`  - 分支 ${branch.branch}：最後提交 ${localTime(branch.lastCommitAt)}「${branch.subject}」，${branch.unpushed === null ? "沒有遠端追蹤" : `未推送 ${branch.unpushed} 個提交`}`);
    }
    if (repo.branches.length === 0) lines.push(`  - 找不到名稱含「${game.code}」的分支`);
  }
  if (progress.docs.length > 0) {
    lines.push(`- 文件（新到舊）：${progress.docs.slice(0, 8).map((doc) => `${doc.name}（${localTime(doc.modifiedAt)}）`).join("、")}`);
  }
  for (const warning of progress.warnings) lines.push(`- ⚠ ${warning}`);
  for (const section of progress.sections) {
    lines.push("", `### 〈${section.file}〉${section.heading}`, section.text);
  }
  return lines.join("\n");
}
