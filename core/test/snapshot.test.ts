import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareReportedFiles,
  diffSnapshots,
  Snapshotter,
  type GitExec,
} from "../src/tasks/snapshot.js";

// 測試 Git 清單快照能辨識新增、修改、刪除與 HEAD 變更，且路徑正規化並排序。
test("Snapshotter and diffSnapshots detect repository changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-snapshot-"));
  writeFileSync(join(directory, "modified.txt"), "before", "utf8");
  writeFileSync(join(directory, "deleted.txt"), "gone", "utf8");
  let head = "head-before";
  let files = "modified.txt\0deleted.txt\0";
  const calls: string[][] = [];
  const exec: GitExec = async (_command, args) => {
    calls.push(args);
    if (args.at(-1) === "--show-toplevel") return { stdout: directory, stderr: "" };
    if (args.at(-1) === "HEAD") return { stdout: `${head}\n`, stderr: "" };
    return { stdout: files, stderr: "" };
  };
  try {
    const snapshotter = new Snapshotter(exec);
    const before = await snapshotter.take(directory);
    writeFileSync(join(directory, "modified.txt"), "after", "utf8");
    unlinkSync(join(directory, "deleted.txt"));
    writeFileSync(join(directory, "added.txt"), "new", "utf8");
    head = "head-after";
    files = "modified.txt\0added.txt\0deleted.txt\0";
    const after = await snapshotter.take(directory);

    assert.deepEqual(diffSnapshots(before, after), {
      added: ["added.txt"], modified: ["modified.txt"], deleted: ["deleted.txt"], headChanged: true,
    });
    assert.deepEqual(calls[0], ["-C", directory, "rev-parse", "--show-toplevel"]);
    assert.deepEqual(calls[2], ["-C", directory, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試回報與快照可同時列出漏報、多報及變更種類不符，避免把自述當成實際修改證據。
test("compareReportedFiles reports both mismatch directions and kind differences", () => {
  const mismatch = compareReportedFiles({
    added: ["src/new.ts"], modified: ["src/edit.ts"], deleted: [], headChanged: false,
  }, [
    { path: "src\\new.ts", change: "modified" },
    { path: "src/unchanged.ts", change: "modified" },
  ]);
  assert.deepEqual(mismatch, {
    reportedButUnchanged: [{ path: "src/unchanged.ts", change: "modified" }],
    changedButUnreported: [{ path: "src/edit.ts", change: "modified" }],
    kindDiffers: [{ path: "src/new.ts", reported: "modified", actual: "added" }],
  });
});

// 測試 Git repo 驗證失敗會回傳固定錯誤，讓執行器能在啟動 Codex 前停止。
test("Snapshotter rejects a non-git repository", async () => {
  const snapshotter = new Snapshotter(async () => { throw new Error("not a repository"); });
  await assert.rejects(snapshotter.take("C:/missing"), /repo 不是 git repo/);
});
