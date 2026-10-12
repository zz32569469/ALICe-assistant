import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseDocBlock, withFrontmatter, writeDocBlock } from "../src/docs/docWriter.js";
import { loadLocalConfig } from "../src/localConfig.js";
import { formatDocs } from "../src/prompt/promptBuilder.js";
import { AliceBlockFilter } from "../src/tasks/aliceBlockFilter.js";

const block = (header: Record<string, unknown>, content: string): string => `<<<ALICE_DOC\n${JSON.stringify(header)}\n${content}\nALICE_DOC>>>`;
const now = new Date(2026, 9, 2, 14, 0);

// 測試寫新文件：建立子資料夾、沒有屬性區時補上 Obsidian 的 YAML 屬性；已有屬性就照原樣。
test("writeDocBlock writes a new Obsidian note and adds frontmatter when missing", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-doc-"));
  try {
    const roots = [{ name: "專案文件", path: join(directory, "Projects") }];
    const message = writeDocBlock(roots, block({ path: "Test Game/規格疑問與矛盾.md" }, "# 規格疑問\n\n- [ ] Q1"), join(directory, "data"), now);
    assert.match(message, /^已寫入文件：.*Projects\/Test Game\/規格疑問與矛盾\.md$/u);
    const text = readFileSync(join(directory, "Projects", "Test Game", "規格疑問與矛盾.md"), "utf8");
    assert.equal(text, "---\ncreated: 2026-10-02\nsource: ALICe\n---\n\n# 規格疑問\n\n- [ ] Q1\n");
    assert.equal(withFrontmatter("---\ntags: [a]\n---\n# x", now), "---\ntags: [a]\n---\n# x\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試已存在的檔案：沒有 overwrite 不覆蓋；有 overwrite 先把舊版備份到 data/doc-backups 再覆蓋。
test("writeDocBlock refuses to overwrite unless asked, and backs up the old version", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-doc-"));
  try {
    const root = join(directory, "Projects");
    mkdirSync(join(root, "G"), { recursive: true });
    writeFileSync(join(root, "G", "a.md"), "舊內容\n");
    const roots = [{ name: "專案文件", path: root }];
    assert.match(writeDocBlock(roots, block({ path: "G/a.md" }, "新內容"), join(directory, "data"), now), /已經有.*overwrite/u);
    assert.equal(readFileSync(join(root, "G", "a.md"), "utf8"), "舊內容\n");
    const message = writeDocBlock(roots, block({ path: "G/a.md", overwrite: true }, "新內容"), join(directory, "data"), now);
    assert.match(message, /^已覆蓋文件：.*舊版備份在/u);
    assert.match(readFileSync(join(root, "G", "a.md"), "utf8"), /新內容/u);
    const backups = readdirSync(join(directory, "data", "doc-backups"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(join(directory, "data", "doc-backups", backups[0]!), "utf8"), "舊內容\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試路徑檢查：不能跳出資料夾、不能寫絕對路徑、只能 .md、不能寫進 .obsidian、資料夾名稱要對、內容不能空。
test("writeDocBlock rejects unsafe paths and bad blocks", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-doc-"));
  try {
    const roots = [{ name: "專案文件", path: join(directory, "Projects") }];
    const write = (header: Record<string, unknown>, content = "x") => writeDocBlock(roots, block(header, content), join(directory, "data"), now);
    assert.match(write({ path: "../外面.md" }), /文件未寫入：path 不能有/u);
    assert.match(write({ path: "C:/Windows/a.md" }), /相對路徑/u);
    assert.match(write({ path: "a.txt" }), /只能寫 \.md/u);
    assert.match(write({ path: ".obsidian/workspace.md" }), /隱藏資料夾/u);
    assert.match(write({ path: "a?.md" }), /不允許的字元/u);
    assert.match(write({ path: "a.md", root: "別的" }), /沒有叫「別的」/u);
    assert.match(write({ path: "a.md" }, "   "), /內容是空的/u);
    assert.match(writeDocBlock([], block({ path: "a.md" }, "x"), directory, now), /沒有 docRoots/u);
    assert.throws(() => parseDocBlock("<<<ALICE_DOC\n不是 JSON\n內容\nALICE_DOC>>>"), /JSON 標頭/u);
    assert.equal(existsSync(join(directory, "外面.md")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試本機設定：docRoots 讀成絕對路徑；放在知識庫裡面的會被略過（知識庫只能由管理員寫入）。
test("local config loads docRoots but skips folders inside the knowledge base", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-doc-config-"));
  try {
    const path = join(directory, "alice.local.json");
    writeFileSync(path, JSON.stringify({
      knowledgeBase: { path: join(directory, "vault"), summaryPage: "s.md", rolesDir: "roles" },
      codex: { available: false },
      projects: [{ name: "p", path: directory, role: "r" }],
      docRoots: [{ name: "專案文件", path: "Projects" }, { name: "知識庫裡", path: join(directory, "vault", "sub") }],
      remoteOrigins: ["https://PC.tail1.ts.net", "http://pc.local:7788", "https://pc.tail1.ts.net/studio"],
    }));
    const warnings: string[] = [];
    const config = loadLocalConfig(path, (message) => warnings.push(message));
    assert.deepEqual(config.docRoots, [{ name: "專案文件", path: join(directory, "Projects") }]);
    assert.ok(warnings.some((warning) => /知識庫裡面/u.test(warning)));
    // §58：remoteOrigins 只收 https://主機（可帶埠），轉成小寫。
    assert.deepEqual(config.remoteOrigins, ["https://pc.tail1.ts.net"]);
    assert.equal(warnings.filter((warning) => /remoteOrigins/u.test(warning)).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試提示與區塊過濾：有 docRoots 才有「# 寫文件」；文件區塊可以有多個，而且不會出現在回覆裡。
test("prompt describes doc writing and the filter collects doc blocks", () => {
  assert.equal(formatDocs([]), null);
  const section = formatDocs([{ name: "專案文件", path: "C:/Projects" }])!;
  assert.match(section, /# 寫文件/u);
  assert.match(section, /專案文件：C:\/Projects/u);
  assert.match(section, /\[!warning\]/u);
  const filter = new AliceBlockFilter(() => undefined);
  filter.push(`寫好了。${block({ path: "a.md" }, "# A")}`);
  filter.push(block({ path: "b.md" }, "# B"));
  const result = filter.finish();
  assert.equal(result.visibleText, "寫好了。");
  assert.equal(result.docBlockTexts?.length, 2);
});
