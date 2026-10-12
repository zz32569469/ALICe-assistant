import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ChannelService } from "../src/channels/channelService.js";
import { ChannelStore } from "../src/channels/channelStore.js";
import { defaultConfig } from "../src/config.js";
import { ConversationService } from "../src/conversation/conversationService.js";
import type { LocalConfig } from "../src/localConfig.js";
import { EventHub } from "../src/protocol/eventHub.js";
import { CharacterState } from "../src/state/characterState.js";
import { MessageStore } from "../src/store/messageStore.js";
import { FakeProvider } from "./fakeProvider.js";

async function waitFor(check: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// 測試重啟時只重排 30 分鐘內最多三則主人訊息，較早訊息會以 60 字摘要寫進 system 訊息。
test("restart requeues recent unanswered messages and summarizes older ones", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-restart-messages-"));
  const personaPath = join(directory, "persona.md");
  const factsPath = join(directory, "facts.md");
  writeFileSync(personaPath, "# Alice", "utf8");
  writeFileSync(factsPath, "主人事實", "utf8");
  const store = new MessageStore(join(directory, "alice.db"));
  try {
    store.append({ role: "alice", text: "上次回答", createdAt: "2026-09-30T08:00:00.000Z" });
    const oldText = "兩小時前未回覆-" + "舊".repeat(80);
    store.append({ role: "user", text: oldText, createdAt: "2026-09-30T10:00:00.000Z" });
    store.append({ role: "user", text: "十分鐘前第一則", createdAt: "2026-09-30T11:50:00.000Z" });
    store.append({ role: "user", text: "十分鐘前第二則", createdAt: "2026-09-30T11:51:00.000Z" });
    const config = { ...defaultConfig, dataDir: directory, personaPath, factsPath, requireThinking: false };
    const provider = new FakeProvider([{ text: "補答一" }, { text: "補答二" }]);
    const events = new EventHub();
    const state = new CharacterState({ config, now: () => new Date("2026-09-30T12:00:00.000Z") });
    const conversation = new ConversationService({ config, store, state, provider, events });

    assert.deepEqual(conversation.recoverUnanswered(new Date("2026-09-30T12:00:00.000Z")), { queued: 2, skipped: 1 });
    await waitFor(() => provider.calls === 2, "recovered replies");
    const messages = store.list({ limit: 20 });
    const system = messages.find((message) => message.role === "system");
    assert.match(system?.text ?? "", /Core 重啟前這些訊息沒有回覆/);
    assert.match(system?.text ?? "", /兩小時前未回覆/);
    assert.doesNotMatch(system?.text ?? "", /舊{61}/u);
    assert.deepEqual(messages.filter((message) => message.role === "alice").map((message) => message.text), ["補答二", "補答一", "上次回答"]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// 測試重啟復原會把所有 open 頻道標為 failed，並留下固定 system 中斷原因。
test("restart marks open channels failed with a system message", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-restart-channels-"));
  const databasePath = join(directory, "alice.db");
  const messages = new MessageStore(databasePath);
  const channelStore = new ChannelStore(databasePath);
  try {
    const projectPath = join(directory, "project");
    const vault = join(directory, "vault");
    mkdirSync(projectPath);
    mkdirSync(vault);
    const local: LocalConfig = {
      path: join(directory, "alice.local.json"), knowledgeBase: null, docRoots: [], codexAvailable: false,
      projects: [], workerTimeoutMin: 5, summaryEnabled: false, workersEnabled: false, dispatch: true, remoteOrigins: [], workflowFile: null, translateGlossary: [], reasons: [],
    };
    const channel = channelStore.create({ title: "中斷工作", project: "p", role: "r" });
    const service = new ChannelService({ local, channels: channelStore, messages, events: new EventHub() });
    assert.equal(service.recover(), 1);
    assert.equal(channelStore.get(channel.id)?.status, "failed");
    assert.equal(channelStore.messages(channel.id).at(-1)?.text, "Core 重啟，頻道中斷");
  } finally {
    channelStore.close();
    messages.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
