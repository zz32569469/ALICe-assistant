import { appendFileSync, mkdirSync } from "node:fs";

import type { Config } from "../config.js";
import type { ChannelFollowup, ChannelService } from "../channels/channelService.js";
import type { LocalConfig } from "../localConfig.js";
import { EventHub } from "../protocol/eventHub.js";
import { buildChatPrompt, buildPrompt, loadFacts, loadPersona } from "../prompt/promptBuilder.js";
import { uploadsDir } from "../uploads/uploadStore.js";
import type { MemoryKeeper } from "../memory/memoryKeeper.js";
import { KnowledgeSummaryLoader } from "../prompt/knowledgeSummary.js";
import { ErrorLogger } from "../reliability/errorLog.js";
import {
  ReasoningError,
  type ReasoningErrorKind,
  type ReasoningProvider,
  type ReasoningResult,
} from "../reasoning/provider.js";
import { MessageStore, type Message } from "../store/messageStore.js";
import { CharacterState } from "../state/characterState.js";
import { AliceBlockFilter } from "../tasks/aliceBlockFilter.js";
import type { TaskService } from "../tasks/taskService.js";
import type { Task } from "../tasks/taskStore.js";
import type { UsageStore } from "../usage/usageStore.js";
import { planResultForPrompt, type PlanFiles, type PlanNotificationKind, type PlanService } from "../plans/planService.js";
import type { Plan, PlanItem } from "../plans/planStore.js";
import { appendSuggestion, parseSuggestBlock } from "../suggestions/suggestionLog.js";
import type { OutboxService } from "../relay/outboxService.js";
import { parsePeer } from "../relay/peer.js";
import { writeDocBlock } from "../docs/docWriter.js";
import { parseProgressBlock, type GameService } from "../games/gameService.js";
import { PROGRESS_NOTICE_PREFIX } from "../games/progressNotice.js";
import type { ProxyMode } from "./proxyMode.js";
import { ALICE_BLOCK_MARKERS } from "../tasks/aliceBlockFilter.js";

export type SubmitMessageInput = {
  clientMsgId: string;
  text: string;
  clientId: string;
  deep?: boolean;
  /** §78：聊天分頁；沒有＝工作。 */
  thread?: "chat";
  /** §83：附的截圖檔名（已上傳到 data/uploads）。 */
  images?: string[];
};

export type SubmitMessageResult = {
  messageId: string;
  replyId: string;
};

type QueueItem = {
  message: Message;
  replyId: string;
  promptText?: string;
  taskResult?: Task;
  ignoreTaskBlock?: boolean;
  channelId?: string;
  rawCurrentText?: boolean;
  effort?: "low" | "medium" | "high" | "max";
  planResult?: string;
  /** 進度資料整理（§30）：這一輪不再處理進度區塊，避免來回。 */
  ignoreProgress?: boolean;
};

/** §78：聊天分頁的訊息。 */
const isChat = (message: Message): boolean => message.thread === "chat";

const PLAN_NOTIFICATION_TEXT: Record<PlanNotificationKind, string> = {
  completed: "計畫完成，請向主人彙整回報：結論 → 各項目結果與驗收（引用變更的檔案與測試）→ 未完成或需要主人做的事（例如是否 commit）。",
  paused: "計畫暫停，請向主人說明原因與目前進度，並詢問要用 /plan resume <短 id> 繼續（Codex 額度不足時可用 /plan resume <短 id> claude 授權改派），或 /plan cancel <短 id> 取消。",
  rejected: "計畫未執行：主人拒絕，請用一兩句告知主人。",
  expired: "計畫未執行：確認逾時，請用一兩句告知主人。",
  cancelled: "計畫已取消，請用一兩句告知主人目前完成到哪裡。",
  restarted: "Core 剛重啟，這份計畫在執行中被中斷，已暫停。請向主人說明停在哪一項、哪些已完成不會重做、中斷的項目會從頭重做；暫停細節若列出中斷項目可能留下的半成品檔，要照列告訴主人（沒有看到就說沒有；不要提欄位名稱），並用 /plan resume <短 id> 從中斷處接續（或 /plan cancel <短 id> 取消）。",
};
type RequestStatus = "queued" | "processing" | "succeeded" | "failed";

type ProtocolError = {
  code: "reasoning_unavailable" | "rate_limited" | "refused" | "internal";
  message: string;
  retryable: boolean;
};

function replyIdFor(messageId: string): string {
  return `${messageId}:reply`;
}

function protocolError(error: unknown): { error: ProtocolError; stateKind: ReasoningErrorKind } {
  if (error instanceof ReasoningError) {
    if (error.kind === "rate_limited") {
      return {
        error: { code: "rate_limited", message: "推理引擎目前忙碌", retryable: true },
        stateKind: error.kind,
      };
    }
    if (error.kind === "refused") {
      return {
        error: { code: "refused", message: "模型拒絕回答此訊息", retryable: false },
        stateKind: error.kind,
      };
    }
    if (error.kind === "other" && !error.apiError) {
      return {
        error: { code: "internal", message: "Core 內部錯誤", retryable: true },
        stateKind: error.kind,
      };
    }
    return {
      error: { code: "reasoning_unavailable", message: "推理引擎無法連線", retryable: true },
      stateKind: error.kind,
    };
  }
  return {
    error: { code: "internal", message: "Core 內部錯誤", retryable: true },
    stateKind: "other",
  };
}

export class ConversationService {
  readonly #config: Config;
  readonly #store: MessageStore;
  readonly #state: CharacterState;
  readonly #provider: ReasoningProvider;
  readonly #events: EventHub;
  readonly #tasks: TaskService | undefined;
  readonly #channels: ChannelService | undefined;
  readonly #plans: PlanService | undefined;
  readonly #outbox: OutboxService | undefined;
  readonly #games: GameService | undefined;
  readonly #memory: MemoryKeeper | undefined;
  readonly #proxy: ProxyMode | undefined;
  readonly #local: LocalConfig | undefined;
  readonly #summary: KnowledgeSummaryLoader | undefined;
  readonly #usage: UsageStore | undefined;
  readonly #errors: ErrorLogger;
  readonly #queue: QueueItem[] = [];
  readonly #statuses = new Map<string, RequestStatus>();
  #refreshNoticeId: string | undefined;
  #processing = false;

  constructor(options: {
    config: Config;
    store: MessageStore;
    state: CharacterState;
    provider: ReasoningProvider;
    events: EventHub;
    tasks?: TaskService;
    channels?: ChannelService;
    plans?: PlanService;
    outbox?: OutboxService;
    games?: GameService;
    /** §85 長期記憶。 */
    memory?: MemoryKeeper;
    local?: LocalConfig;
    /** §64 代理人模式。 */
    proxy?: ProxyMode;
    usage?: UsageStore;
    errors?: ErrorLogger;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#state = options.state;
    this.#provider = options.provider;
    this.#events = options.events;
    this.#tasks = options.tasks;
    this.#channels = options.channels;
    this.#plans = options.plans;
    this.#outbox = options.outbox;
    this.#games = options.games;
    this.#memory = options.memory;
    this.#proxy = options.proxy;
    this.#local = options.local;
    this.#summary = options.local === undefined ? undefined : new KnowledgeSummaryLoader(options.local);
    this.#usage = options.usage;
    this.#errors = options.errors ?? new ErrorLogger(options.config.dataDir);
  }

  submit(input: SubmitMessageInput): SubmitMessageResult {
    const existing = this.#store.findByClientMsgId(input.clientMsgId);
    if (existing !== undefined) {
      const replyId = replyIdFor(existing.id);
      if (this.#statuses.get(existing.id) === "failed") {
        this.#statuses.set(existing.id, "queued");
        this.#queue.push({ message: existing, replyId, ...(input.deep === true ? { effort: "high" } : {}) });
        this.#startQueue();
      }
      return { messageId: existing.id, replyId };
    }

    const message = this.#store.append({
      role: "user",
      text: input.text,
      clientId: input.clientId,
      clientMsgId: input.clientMsgId,
      ...(input.thread === "chat" ? { thread: "chat" as const } : {}),
      ...(input.images === undefined || input.images.length === 0 ? {} : { images: input.images }),
    });
    const replyId = replyIdFor(message.id);
    this.#statuses.set(message.id, "queued");
    this.#events.broadcast("message.created", message);
    // §78：聊天分頁直接排隊，不經同事回報與頻道。
    if (isChat(message)) {
      this.#queue.push({ message, replyId, ...(input.deep === true ? { effort: "high" } : {}) });
      this.#startQueue();
      return { messageId: message.id, replyId };
    }
    // §27：同事 session 的派工回報先交給計畫處理（記錄、驗收），艾莉絲再看到處理結果。
    const peer = parsePeer(input.text);
    if (peer !== undefined) this.#plans?.handleSessionReport(peer.body, peer.name);
    if (this.#channels?.handleUserMention(message) === true) {
      return { messageId: message.id, replyId };
    }
    this.#queue.push({ message, replyId, ...(input.deep === true ? { effort: "high" } : {}) });
    this.#startQueue();
    return { messageId: message.id, replyId };
  }

  enqueueTaskCompletion(message: Message, task: Task): void {
    const replyId = replyIdFor(message.id);
    this.#statuses.set(message.id, "queued");
    this.#queue.push({
      message,
      replyId,
      promptText: task.status === "rejected"
        ? "任務未執行：主人拒絕，請用一兩句告知主人。"
        : task.status === "expired"
          ? "任務未執行：確認逾時，請用一兩句告知主人。"
          : "任務完成，請向主人回報。",
      taskResult: task,
      ignoreTaskBlock: true,
    });
    this.#startQueue();
  }

  enqueuePlanNotification(message: Message, kind: PlanNotificationKind, plan: Plan, items: PlanItem[], files?: PlanFiles): void {
    const replyId = replyIdFor(message.id);
    this.#statuses.set(message.id, "queued");
    const fileNotes = files === undefined ? "" : [
      `\n完整報告已存在 ${files.reportPath}（本機）。`,
      files.writebackPath === undefined ? "" : `這份計畫有知識庫回寫候選，整理在 ${files.writebackPath}；請提醒主人：要不要送、何時送由主人決定，要送時把這個檔案路徑交給知識庫管理員 session。`,
    ].join("");
    this.#queue.push({
      message,
      replyId,
      promptText: `${PLAN_NOTIFICATION_TEXT[kind]}${fileNotes}`,
      planResult: planResultForPrompt(plan, items),
      ignoreTaskBlock: true,
      ...(kind === "completed" || kind === "paused" || kind === "restarted" ? { effort: "high" as const } : {}),
    });
    this.#startQueue();
  }

  enqueueChannelFollowup(followup: ChannelFollowup): void {
    const latestSeq = this.#store.list({ limit: 1 })[0]?.seq ?? 0;
    const message: Message = {
      id: `channel:${followup.channel.id}:${followup.channel.rounds}:${Date.now()}`,
      seq: latestSeq,
      role: "system",
      text: followup.transcript,
      createdAt: new Date().toISOString(),
    };
    const replyId = replyIdFor(message.id);
    this.#statuses.set(message.id, "queued");
    this.#queue.push({
      message,
      replyId,
      promptText: followup.transcript,
      channelId: followup.channel.id,
      rawCurrentText: true,
      effort: "high",
    });
    this.#startQueue();
  }

  recoverUnanswered(now = new Date()): { queued: number; skipped: number } {
    const unanswered = this.#store.unansweredUserMessages();
    const recent: Message[] = [];
    const skipped: Message[] = [];
    for (const message of unanswered) {
      const ageMs = now.getTime() - new Date(message.createdAt).getTime();
      if (Number.isFinite(ageMs) && ageMs <= 30 * 60_000 && recent.length < 3) recent.push(message);
      else skipped.push(message);
    }
    if (skipped.length > 0) {
      const summary = skipped.map((message) => `「${Array.from(message.text).slice(0, 60).join("")}」`).join("、");
      const system = this.#store.append({ role: "system", text: `Core 重啟前這些訊息沒有回覆：${summary}` });
      this.#events.broadcast("message.created", system);
    }
    for (const message of recent) {
      const replyId = replyIdFor(message.id);
      this.#statuses.set(message.id, "queued");
      this.#queue.push({ message, replyId });
    }
    if (recent.length > 0) this.#startQueue();
    return { queued: recent.length, skipped: skipped.length };
  }

  #startQueue(): void {
    if (this.#processing) {
      return;
    }
    this.#processing = true;
    void this.#drainQueue().catch((error: unknown) => {
      console.error("Conversation queue failed:", error instanceof Error ? error.message : error);
    }).finally(() => {
      this.#processing = false;
      if (this.#queue.length > 0) {
        this.#startQueue();
      }
    });
  }

  async #drainQueue(): Promise<void> {
    for (;;) {
      const item = this.#queue.shift();
      if (item === undefined) {
        return;
      }
      await this.#process(item);
    }
  }

  async #process(item: QueueItem): Promise<void> {
    this.#statuses.set(item.message.id, "processing");
    this.#state.onUserMessage();
    this.#events.broadcast("reply.start", {
      replyId: item.replyId,
      inReplyTo: item.message.id,
      ...(isChat(item.message) ? { thread: "chat" } : {}),
    });

    try {
      const chat = isChat(item.message);
      const history = this.#store
        .list({ limit: 200, ...(chat ? { thread: "chat" as const } : {}) })
        .filter((message) =>
          message.id !== item.message.id &&
          (message.seq < item.message.seq || message.role === "alice"),
        )
        .sort((left, right) => left.seq - right.seq)
        .slice(-this.#config.historyLimit);
      const prompt = chat ? buildChatPrompt({
        personaText: loadPersona(this.#config.personaPath),
        factsText: loadFacts(this.#config.factsPath),
        history,
        userText: item.message.text,
        uploadsDir: uploadsDir(this.#config.dataDir),
        currentImages: item.message.images,
        state: this.#state.getState(),
        justWoken: this.#state.isJustWoken(),
        now: new Date(),
      }) : buildPrompt({
        personaText: loadPersona(this.#config.personaPath),
        factsText: loadFacts(this.#config.factsPath),
        history,
        userText: item.promptText ?? item.message.text,
        uploadsDir: uploadsDir(this.#config.dataDir),
        ...(item.promptText === undefined ? { currentImages: item.message.images } : {}),
        currentRole: item.message.role,
        state: this.#state.getState(),
        justWoken: this.#state.isJustWoken(),
        now: new Date(),
        tools: this.#dispatch ? this.#config.tools : { ...this.#config.tools, codex: { ...this.#config.tools.codex, enabled: false } },
        activeTask: this.#tasks?.active(),
        taskResult: item.taskResult,
        knowledgeSummaryText: this.#summary?.load(),
        workerProjects: this.#dispatch && this.#local?.workersEnabled === true ? this.#local.projects : undefined,
        rawCurrentText: item.rawCurrentText,
        ...(this.#games === undefined ? {} : { games: this.#games.promptLines(), meetings: this.#games.meetingLines() }),
        ...((this.#local?.docRoots.length ?? 0) === 0 ? {} : { docRoots: this.#local!.docRoots }),
        artDirs: this.#config.artDirs,
        proxyMode: this.#proxy?.enabled === true,
        dispatch: { enabled: this.#dispatch, projectNames: (this.#local?.projects ?? []).map((project) => project.name) },
        ...this.#planPromptInput(item),
      });
      const filter = new AliceBlockFilter((text) => {
        this.#events.broadcast("reply.delta", { replyId: item.replyId, text });
      });
      const result = await this.#provider.streamReply(
        prompt,
        (text) => filter.push(text),
        item.effort === undefined ? undefined : { effort: item.effort },
      );
      const filtered = filter.finish();
      const response = this.#store.append({ role: "alice", text: filtered.visibleText, mode: "chat", ...(chat ? { thread: "chat" as const } : {}) });
      this.#writeUsage(item.replyId, response.id, result);
      // §64：艾莉絲用 SendMessage 送出的訊息逐則記下來，主人在 Web Studio 看得到她代你說了什麼。
      for (const sent of result.sentMessages ?? []) {
        const note = this.#store.append({ role: "system", text: `ALICe 傳給〈${sent.to}〉：\n${sent.message}` });
        this.#events.broadcast("message.created", note);
      }
      this.#statuses.set(item.message.id, "succeeded");
      this.#events.broadcast("reply.end", { replyId: item.replyId, message: response });
      // §85：記憶區塊兩個分頁都處理。
      for (const block of filtered.memoryBlockTexts ?? []) this.#applyMemoryBlock(block);
      // §78：聊天分頁不處理其他區塊（不改專案卡、不派工）。
      if (chat) return;
      // 一則回覆同時有計畫與任務區塊時只處理計畫（spec-plans §2）；通知推理的區塊一律忽略。
      if (filtered.planBlockText !== undefined && item.ignoreTaskBlock !== true && this.#plans !== undefined) {
        this.#plans.createFromBlock(filtered.planBlockText, response.id);
      } else if (filtered.taskBlockText !== undefined && item.ignoreTaskBlock !== true) {
        this.#tasks?.createFromBlock(filtered.taskBlockText, response.id);
      }
      if (filtered.suggestBlockText !== undefined) this.#recordSuggestion(filtered.suggestBlockText);
      for (const block of filtered.sendBlockTexts ?? []) this.#outbox?.sendFromBlock(block);
      for (const block of filtered.gameBlockTexts ?? []) this.#applyGameBlock(block);
      for (const block of filtered.docBlockTexts ?? []) this.#writeDoc(block);
      for (const block of filtered.meetingBlockTexts ?? []) this.#applyMeetingBlock(block);
      if (filtered.progressBlockText !== undefined && item.ignoreProgress !== true) this.#enqueueProgress(filtered.progressBlockText);
      if (filtered.askBlockText !== undefined) {
        this.#channels?.createFromBlock(filtered.askBlockText, item.channelId);
      } else if (item.channelId !== undefined) {
        this.#channels?.closeWithConclusion(item.channelId);
      }
      this.#state.onReplyEnd({ ok: true });
    } catch (error) {
      const mapped = protocolError(error);
      this.#statuses.set(item.message.id, "failed");
      this.#events.broadcast("reply.error", { replyId: item.replyId, error: mapped.error });
      this.#state.onReplyEnd({ ok: false, kind: mapped.stateKind });
      this.#errors.write({
        replyId: item.replyId,
        kind: mapped.stateKind,
        message: error instanceof Error ? error.message : String(error),
        attempts: 1,
        source: "alice",
      });
    }
  }

  /** §45：寫 .md 文件到 docRoots，留一則系統訊息。 */
  #writeDoc(blockText: string): void {
    const message = this.#store.append({ role: "system", text: writeDocBlock(this.#local?.docRoots ?? [], blockText, this.#config.dataDir) });
    this.#events.broadcast("message.created", message);
  }

  #applyGameBlock(blockText: string): void {
    if (this.#games === undefined) return;
    const message = this.#store.append({ role: "system", text: this.#games.applyBlock(blockText) });
    this.#events.broadcast("message.created", message);
  }

  /** §85：ALICe 記下要長期記住的事（每天整理進事實檔）。 */
  #applyMemoryBlock(blockText: string): void {
    if (this.#memory === undefined) return;
    this.postNotice(this.#memory.applyBlock(blockText, ALICE_BLOCK_MARKERS.memory));
  }

  /** §74：ALICE 從對話新增或刪除會議。 */
  #applyMeetingBlock(blockText: string): void {
    if (this.#games === undefined) return;
    this.postNotice(this.#games.applyMeetingBlock(blockText, ALICE_BLOCK_MARKERS.meeting));
  }

  /** 在對話裡留一則系統訊息（§74 會議提醒也用這個）。 */
  postNotice(text: string): void {
    const message = this.#store.append({ role: "system", text });
    this.#events.broadcast("message.created", message);
  }

  /** §30 M-3：Core 收集進度資料（不用推理），再請艾莉絲整理成總覽。 */
  #enqueueProgress(blockText: string): void {
    if (this.#games === undefined) return;
    let names: string[];
    try {
      names = parseProgressBlock(blockText, ALICE_BLOCK_MARKERS.progress);
    } catch (error) {
      const message = this.#store.append({ role: "system", text: `進度區塊無法解析：${error instanceof Error ? error.message : String(error)}` });
      this.#events.broadcast("message.created", message);
      return;
    }
    this.#enqueueProgressRound(names, "ask");
  }

  /** §46：每天早上的任務核對（main 依 GameService.reviewDue 呼叫）。用同一份進度資料，請艾莉絲更新任務並簡短回報。 */
  enqueueDailyReview(): void {
    if (this.#games === undefined) return;
    // §57：資料和上次核對時一樣就不呼叫模型，只留一則系統訊息。
    if (!this.#games.reviewInputChanged()) {
      const message = this.#store.append({ role: "system", text: "每日任務核對：更改紀錄、分支與專案卡和上次核對時一樣，這次沒有請 ALICe 核對。" });
      this.#events.broadcast("message.created", message);
      return;
    }
    this.#enqueueProgressRound([], "daily");
  }

  /**
   * §51：主人按了 Studio 的「更新進度」：用同一份進度資料請艾莉絲對照任務清單更新。
   * 回傳這輪回覆的 replyId；上一輪還沒做完時不再排，回傳 undefined。
   */
  requestProgressRefresh(): string | undefined {
    if (this.#games === undefined) return undefined;
    if (this.#refreshNoticeId !== undefined) {
      const status = this.#statuses.get(this.#refreshNoticeId);
      if (status === "queued" || status === "processing") return undefined;
    }
    this.#refreshNoticeId = this.#enqueueProgressRound([], "refresh");
    return this.#refreshNoticeId === undefined ? undefined : replyIdFor(this.#refreshNoticeId);
  }

  #enqueueProgressRound(names: string[], mode: "ask" | "daily" | "refresh"): string | undefined {
    if (this.#games === undefined) return undefined;
    const progress = this.#games.progress(names);
    if (mode === "daily" && progress.games.length === 0) return undefined;
    const waiting = (this.#plans?.activeAll() ?? [])
      .filter((entry) => entry.plan.status === "paused" || entry.plan.status === "pending_approval")
      .map((entry) => `- 計畫 ${entry.plan.id.slice(0, 8)}「${entry.plan.goal}」：${entry.plan.status === "paused" ? `暫停（${entry.plan.pauseDetail ?? entry.plan.pauseReason ?? ""}）` : "等主人核准"}`);
    const notice = this.#store.append({
      role: "system",
      text: progress.games.length === 0
        ? `進度資料：沒有符合的專案卡${progress.missing.length === 0 ? "" : `（找不到：${progress.missing.join("、")}）`}`
        : `${PROGRESS_NOTICE_PREFIX}${progress.games.join("、")} 的進度資料，ALICe ${{ daily: "做每日任務核對", refresh: "依任務清單更新進度", ask: "整理中" }[mode]}${progress.missing.length === 0 ? "" : `（找不到：${progress.missing.join("、")}）`}`,
    });
    this.#events.broadcast("message.created", notice);
    const instruction = mode === "refresh"
      ? "（系統通知）主人在 Studio 按了「更新進度」：以下是 Core 剛收集的進度資料。請逐款對照任務清單，把狀態有變的任務用 ALICE_GAME 的 tasks 更新（note 寫依據，例如更改紀錄哪一段、哪個 commit），紀錄裡出現但清單沒有的工作加成任務。階段看起來該換時只問主人，不要改。符合「直接傳訊給同事」條件的卡住或沒動靜的任務，可以直接追問或確認進度。回報只寫幾行：每款改了哪些任務、卡住的、追問了誰、等主人決定的；沒有變化就說「任務沒有變化」。資料裡沒有的不要猜。不要再放進度區塊。"
      : mode === "daily"
      ? "（系統通知）每日任務核對：以下是 Core 剛收集的進度資料。請對照每個專案的任務清單，把狀態有變的任務用 ALICE_GAME 的 tasks 更新（note 寫依據，例如更改紀錄哪一段、哪個 commit），紀錄裡出現但清單沒有的工作加成任務。階段看起來該換時只問主人，不要改。符合「直接傳訊給同事」條件的卡住或沒動靜的任務，可以直接追問或確認進度。回報只寫幾行：改了哪些任務、卡住的、追問了誰、等主人決定的；沒有變化就說「今天核對沒有變化」。資料裡沒有的不要猜。不要再放進度區塊。"
      : "（系統通知）以下是 Core 剛收集的進度資料。請照「# 專案管理」的整理格式向主人回報進度總覽；同時對照任務清單，狀態有變的任務用 ALICE_GAME 的 tasks 更新（note 寫依據）。資料裡沒有的不要猜。不要再放進度區塊。";
    const promptText = [
      instruction,
      progress.missing.length === 0 ? "" : `找不到這些專案卡：${progress.missing.join("、")}（請告訴主人，並問要不要建立）`,
      "",
      progress.text === "" ? "（沒有符合的專案卡）" : progress.text,
      "",
      "## Core 裡等主人決定的事",
      waiting.length === 0 ? "- （沒有）" : waiting.join("\n"),
    ].join("\n");
    const replyId = replyIdFor(notice.id);
    this.#statuses.set(notice.id, "queued");
    this.#queue.push({ message: notice, replyId, promptText, rawCurrentText: true, ignoreProgress: true, ignoreTaskBlock: true });
    this.#startQueue();
    return notice.id;
  }

  #recordSuggestion(blockText: string): void {
    let text: string;
    try {
      const suggestion = parseSuggestBlock(blockText);
      appendSuggestion(this.#config.suggestionsPath, suggestion, new Date());
      text = `已記錄艾莉絲的建議：${suggestion.title}（${this.#config.suggestionsPath}，等主人決定）`;
    } catch (error) {
      text = `建議未記錄：${error instanceof Error ? error.message : String(error)}`;
    }
    const message = this.#store.append({ role: "system", text });
    this.#events.broadcast("message.created", message);
  }

  get #dispatch(): boolean {
    return this.#local?.dispatch === true;
  }

  #planPromptInput(item: QueueItem): {
    planTargets?: Array<{ name: string; description?: string; testCommands?: string[]; forbidden?: string[]; askBeforeClaude?: boolean }>;
    sessionTargets?: Array<{ session: string; role: string; project: string }>;
    relaySession?: string;
    activePlans?: Array<{ id: string; goal: string; status: string; items: Array<{ key: string; title: string; status: string }> }>;
    planResult?: string;
  } {
    // §57：派工關閉時只留轉接 session 名稱（【進度】回報規則要用）與計畫結果通知。
    if (!this.#dispatch) {
      return {
        ...(this.#outbox === undefined ? {} : { relaySession: this.#outbox.relaySession }),
        ...(item.planResult === undefined ? {} : { planResult: item.planResult }),
      };
    }
    if (this.#plans === undefined) return {};
    const descriptions = this.#config.tools.codex.repos;
    const active = this.#plans.activeAll();
    return {
      planTargets: this.#plans.writableTargets().map((target) => ({
        name: target.name,
        ...(descriptions[target.name]?.description ? { description: descriptions[target.name]!.description } : {}),
        testCommands: target.testCommands,
        forbidden: [...new Set([...target.forbiddenPatterns, ...target.watchPaths.map((path) => `${path.replace(/\/+$/u, "")}/**`)])],
        askBeforeClaude: target.claudeFallback === "ask",
      })),
      ...(this.#outbox === undefined ? {} : { sessionTargets: this.#outbox.targets(), relaySession: this.#outbox.relaySession }),
      ...(active.length === 0 ? {} : {
        activePlans: active.map((entry) => ({
          id: entry.plan.id, goal: entry.plan.goal, status: entry.plan.status,
          items: entry.items.map((planItem) => ({ key: planItem.key, title: planItem.title, status: planItem.status })),
        })),
      }),
      ...(item.planResult === undefined ? {} : { planResult: item.planResult }),
    };
  }

  #writeUsage(replyId: string, messageId: string, result: ReasoningResult): void {
    try {
      mkdirSync(this.#config.dataDir, { recursive: true });
      appendFileSync(
        `${this.#config.dataDir}/usage.log`,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          replyId,
          duration_ms: result.durationMs,
          duration_api_ms: result.durationApiMs,
          model: result.model,
          initModel: result.initModel,
          models: result.models,
          attempts: result.attempts,
          suspect: result.suspect,
          ...result.usage,
        })}\n`,
        "utf8",
      );
      for (const model of result.models) {
        this.#usage?.append({
          kind: "alice",
          refType: "message",
          refId: messageId,
          model: model.model,
          inputTokens: model.inputTokens,
          outputTokens: model.outputTokens,
          cacheReadInputTokens: model.cacheReadInputTokens,
          cacheCreationInputTokens: model.cacheCreationInputTokens,
          reasoningTokens: 0,
          durationMs: result.durationMs,
          attempts: result.attempts,
        });
      }
    } catch (error) {
      console.warn("Unable to write usage log:", error instanceof Error ? error.message : error);
    }
  }
}
