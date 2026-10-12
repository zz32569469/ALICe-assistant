import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type GitExec = (
  command: string,
  args: string[],
  options: { shell: false; windowsHide: true; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export type RepoSnapshot = {
  head: string | null;
  files: Record<string, string>;
};

export type SnapshotDiff = {
  added: string[];
  modified: string[];
  deleted: string[];
  headChanged: boolean;
};

export type ReportedFile = {
  path: string;
  change: "added" | "modified" | "deleted";
};

export type SnapshotMismatch = {
  reportedButUnchanged: ReportedFile[];
  changedButUnreported: ReportedFile[];
  kindDiffers: Array<{ path: string; reported: ReportedFile["change"]; actual: ReportedFile["change"] }>;
};

const defaultExec: GitExec = async (command, args, options) =>
  await new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error !== null) {
        rejectPromise(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

export class Snapshotter {
  readonly #exec: GitExec;

  constructor(exec: GitExec = defaultExec) {
    this.#exec = exec;
  }

  async take(repoPath: string): Promise<RepoSnapshot> {
    const options = { shell: false as const, windowsHide: true as const, maxBuffer: 16 * 1024 * 1024 };
    try {
      await this.#exec("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], options);
    } catch (error) {
      throw new Error("repo 不是 git repo", { cause: error });
    }

    let head: string | null = null;
    try {
      const result = await this.#exec("git", ["-C", repoPath, "rev-parse", "HEAD"], options);
      head = result.stdout.trim() || null;
    } catch {
      head = null;
    }

    const listed = await this.#exec(
      "git",
      ["-C", repoPath, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      options,
    );
    const paths = listed.stdout.split("\0").filter((path) => path !== "").map(normalizePath);
    const files: Record<string, string> = {};
    for (const path of paths) {
      try {
        const contents = await readFile(resolve(repoPath, path));
        files[path] = createHash("sha256").update(contents).digest("hex");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { head, files };
  }
}

export function diffSnapshots(before: RepoSnapshot, after: RepoSnapshot): SnapshotDiff {
  const beforePaths = new Set(Object.keys(before.files));
  const afterPaths = new Set(Object.keys(after.files));
  return {
    added: [...afterPaths].filter((path) => !beforePaths.has(path)).sort(),
    modified: [...afterPaths]
      .filter((path) => beforePaths.has(path) && before.files[path] !== after.files[path])
      .sort(),
    deleted: [...beforePaths].filter((path) => !afterPaths.has(path)).sort(),
    headChanged: before.head !== after.head,
  };
}

export function compareReportedFiles(diff: SnapshotDiff, reported: ReportedFile[]): SnapshotMismatch {
  const actual = new Map< string, ReportedFile["change"]>();
  for (const change of ["added", "modified", "deleted"] as const) {
    for (const path of diff[change]) actual.set(normalizePath(path), change);
  }
  const normalizedReported = reported.map((item) => ({ ...item, path: normalizePath(item.path) }));
  const reportedByPath = new Map(normalizedReported.map((item) => [item.path, item.change]));
  const reportedButUnchanged: ReportedFile[] = [];
  const kindDiffers: SnapshotMismatch["kindDiffers"] = [];
  for (const item of normalizedReported) {
    const actualChange = actual.get(item.path);
    if (actualChange === undefined) reportedButUnchanged.push(item);
    else if (actualChange !== item.change) {
      kindDiffers.push({ path: item.path, reported: item.change, actual: actualChange });
    }
  }
  const changedButUnreported = [...actual]
    .filter(([path]) => !reportedByPath.has(path))
    .map(([path, change]) => ({ path, change }));
  const byPath = (left: { path: string }, right: { path: string }): number => left.path.localeCompare(right.path);
  return {
    reportedButUnchanged: reportedButUnchanged.sort(byPath),
    changedButUnreported: changedButUnreported.sort(byPath),
    kindDiffers: kindDiffers.sort(byPath),
  };
}
