import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultConfig } from "../src/config.js";
import { ConversationService } from "../src/conversation/conversationService.js";
import { GameService } from "../src/games/gameService.js";
import { GameStore } from "../src/games/gameStore.js";
import { EventHub } from "../src/protocol/eventHub.js";
import { CharacterState } from "../src/state/characterState.js";
import { MessageStore } from "../src/store/messageStore.js";
import { FakeProvider } from "./fakeProvider.js";

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("§78 訊息依分頁分開：清單、未回覆都各自算", () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-thread-"));
  const store = new MessageStore(join(directory, "alice.db"));
  try {
    store.append({ role: "user", text: "工作 1" });
    store.append({ role: "alice", text: "工作回覆" });
    store.append({ role: "user", text: "聊天 1", thread: "chat" });
    store.append({ role: "system", text: "系統" });
    assert.deepEqual(store.list().map((message) => message.text), ["系統", "工作回覆", "工作 1"]);
    assert.deepEqual(store.list({ thread: "chat" }).map((message) => [message.text, message.thread]), [["聊天 1", "chat"]]);
    assert.deepEqual(store.unansweredUserMessages().map((message) => message.text), ["聊天 1"]);
    store.append({ role: "alice", text: "聊天回覆", thread: "chat" });
    store.append({ role: "user", text: "工作 2" });
    assert.deepEqual(store.unansweredUserMessages().map((message) => message.text), ["工作 2"]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("§78 聊天分頁：只帶聊天紀錄、不帶專案資料，回覆裡的區塊不處理", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alice-thread-"));
  const messages = new MessageStore(join(directory, "alice.db"));
  const gameStore = new GameStore(join(directory, "alice.db"));
  const config = { ...defaultConfig, dataDir: join(directory, "data") };
  const events = new EventHub();
  const starts: Array<Record<string, unknown>> = [];
  const originalBroadcast = events.broadcast.bind(events);
  events.broadcast = ((type: string, data: Record<string, unknown>) => {
    if (type === "reply.start") starts.push(data);
    return originalBroadcast(type, data);
  }) as typeof events.broadcast;
  const games = new GameService({ store: gameStore, projects: () => [], events });
  gameStore.create({ name: "測試專案" });
  const sneaky = `今天天氣不錯呢。<<<ALICE_GAME\n${JSON.stringify({ action: "update", name: "測試專案", deadline: "2026-12-31" })}\nALICE_GAME>>>`;
  const provider = new FakeProvider([{ text: "工作的回覆" }, { text: sneaky }]);
  const conversation = new ConversationService({ config, store: messages, state: new CharacterState({ now: () => new Date(), config }), provider, events, games });
  try {
    conversation.submit({ clientMsgId: "w1", clientId: "test", text: "各專案現在怎樣" });
    await waitFor(() => messages.list().some((message) => message.role === "alice"), "工作回覆");
    conversation.submit({ clientMsgId: "c1", clientId: "test", text: "最近有什麼好看的電影", thread: "chat" });
    await waitFor(() => messages.list({ thread: "chat" }).some((message) => message.role === "alice"), "聊天回覆");

    const chatPrompt = provider.prompts[1]!;
    assert.match(chatPrompt.systemPrompt, /# 聊天分頁/u);
    assert.doesNotMatch(chatPrompt.systemPrompt, /# 專案管理|測試專案/u);
    assert.doesNotMatch(chatPrompt.transcript, /各專案現在怎樣|工作的回覆/u);
    assert.match(chatPrompt.transcript, /主人的新訊息：\n最近有什麼好看的電影/u);
    assert.match(provider.prompts[0]!.systemPrompt, /# 專案管理/u);

    const reply = messages.list({ thread: "chat" }).find((message) => message.role === "alice")!;
    assert.equal(reply.text, "今天天氣不錯呢。");
    assert.equal(reply.thread, "chat");
    assert.equal(gameStore.find("測試專案")!.deadline, null);
    assert.equal(messages.list().some((message) => message.text.includes("電影")), false);
    assert.deepEqual(starts.map((data) => data.thread ?? "work"), ["work", "chat"]);
  } finally {
    gameStore.close();
    messages.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
