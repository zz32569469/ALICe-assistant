import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { formatProgress, parseWorktreeList, repoInfo, type GameProgress } from "../src/games/progress.js";

test("§76 解析 git worktree list：detached 與 bare 略過", () => {
  const text = [
    "worktree C:/repo", "HEAD abc", "branch refs/heads/brandA/gameA", "",
    "worktree C:/wt/repo-b", "HEAD def", "branch refs/heads/rp/gameB", "",
    "worktree C:/wt/detached", "HEAD 123", "detached", "",
  ].join("\n");
  assert.deepEqual(parseWorktreeList(text), [{ path: "C:/repo", branch: "brandA/gameA" }, { path: "C:/wt/repo-b", branch: "rp/gameB" }]);
});

test("§76 專案分支切在其他 worktree 時，讀那裡的未提交狀態", () => {
  const root = mkdtempSync(join(tmpdir(), "alice-wt-"));
  const main = join(root, "repo");
  const other = join(root, "repo-b");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString();
  try {
    execFileSync("git", ["init", "-q", "-b", "main", main]);
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "branch", "live/gameA");
    git(main, "worktree", "add", "-q", other, "-b", "rp/gameB");
    writeFileSync(join(other, "a.txt"), "x");
    writeFileSync(join(other, "b.txt"), "y");
    const project = { name: "tool", path: main } as Parameters<typeof repoInfo>[0];

    const gameB = repoInfo(project, "gameB");
    assert.equal(gameB.currentBranch, "main");
    assert.equal(gameB.uncommitted, 0);
    assert.equal(gameB.worktrees?.length, 1);
    assert.equal(gameB.worktrees![0]!.branch, "rp/gameB");
    assert.equal(gameB.worktrees![0]!.uncommitted, 2);
    assert.equal(repoInfo(project, "gameA").worktrees, undefined);

    const progress: GameProgress = {
      game: { name: "B", code: "gameB", brand: "", trackStages: {}, version: "1.0.0.0", versionReason: "", deadline: null, sessions: [] } as unknown as GameProgress["game"],
      lastActivityAt: null, docs: [], repos: [gameB], sections: [], warnings: [],
    };
    const text = formatProgress(progress, new Date());
    assert.match(text, /- repo tool：主目錄在 main（不是本專案的分支；本專案在另一個 worktree），未提交 0 個檔/u);
    assert.match(text, /  - worktree .*repo-b：切在 rp\/gameB，未提交 2 個檔/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
