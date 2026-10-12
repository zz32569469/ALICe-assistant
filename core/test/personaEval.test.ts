import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { runPersonaEval } from "../src/eval/personaEval.js";
import { FakeProvider } from "./fakeProvider.js";

// 測試單一推理案例失敗仍會依序完成六案並保存狀態、usage 與錯誤，避免批次評測中途遺失結果。
test("persona evaluation records all cases and continues after one failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-persona-eval-"));
  const personaPath = join(directory, "persona.md");
  const factsPath = join(directory, "facts.md");
  const outputPath = join(directory, "persona-eval.md");
  const provider = new FakeProvider([
    { text: "回覆一" },
    { text: "回覆二" },
    { error: "network" },
    { text: "回覆四" },
    { text: "回覆五" },
    { text: "回覆六" },
  ]);

  try {
    writeFileSync(
      personaPath,
      "# Identity\n人格本文\n## 外觀（略過）\n銀髮\n# Personality\n個性本文",
      "utf8",
    );
    writeFileSync(factsPath, "主人喜歡咖啡", "utf8");

    await runPersonaEval({
      config: { ...defaultConfig, personaPath, factsPath },
      provider,
      outputPath,
      startedAt: new Date("2026-09-29T00:00:00.000Z"),
      log: () => {},
    });

    const report = readFileSync(outputPath, "utf8");
    assert.equal((report.match(/^## T[1-6]$/gm) ?? []).length, 6);
    assert.match(
      report,
      /## T6[\s\S]*送出的狀態行：\[目前狀態\][^\n]*精神：低[^\n]*23:30/,
    );
    assert.match(report, /## T3[\s\S]*錯誤種類：network[\s\S]*## T4/);
    assert.match(report, /推理引擎：Claude Code（訂閱）/);
    assert.equal(provider.calls, 6);
    assert.equal(provider.prompts.length, 6);
    assert.ok(provider.prompts.every((prompt) => !prompt.transcript.includes("對話紀錄")));
    assert.doesNotMatch(provider.prompts[0]?.systemPrompt ?? "", /銀髮|## 外觀/);
    assert.match(provider.prompts[0]?.systemPrompt ?? "", /主人喜歡咖啡/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
