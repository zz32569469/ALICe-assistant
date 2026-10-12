// 高風險路徑樣式（C2-4）：`**` 可跨資料夾、`*` 不跨 `/`、`?` 一個字元；比對 repo 相對路徑，不分大小寫。

function toRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//u, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*") {
      if (normalized[index + 1] === "*") {
        // `**/` 可比對零層或多層資料夾；結尾的 `**` 比對其後全部。
        if (normalized[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "iu");
}

export function matchesAnyPattern(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  return patterns.some((pattern) => toRegExp(pattern).test(normalized));
}

export function highRiskPaths(paths: readonly string[], patterns: readonly string[]): string[] {
  return paths.filter((path) => matchesAnyPattern(path, patterns));
}
