// 網頁的共用狀態：事件進來就更新；每次（重新）連上 Core 都重新載入，補上斷線期間漏掉的事件。

import { reactive } from "vue";

import { api, type Thread } from "./api";
import { CoreSocket, type ConnectionStatus } from "./socket";
import type {
  Channel, ChannelMessage, GameCard, CharacterState, Confirmation, EventEnvelope, Message, Plan, PlanView, FortuneKind, FortuneSlot, GameConfirmation, Meeting, TaskConfirmation, TrackView,
} from "./types";

type ReplyError = { replyId: string; message: string; at: string };

export const store = reactive({
  connection: "connecting" as ConnectionStatus,
  character: undefined as CharacterState | undefined,
  messages: [] as Message[],
  hasOlder: true,
  /** §78 聊天分頁的紀錄（和工作分開）。 */
  chatMessages: [] as Message[],
  chatHasOlder: true,
  /** 屬於聊天分頁的回覆（replyId）。 */
  chatReplies: {} as Record<string, true>,
  /** 左側目前的分頁、另一個分頁有沒有新回覆。 */
  thread: "work" as Thread,
  unread: { work: false, chat: false } as Record<Thread, boolean>,
  /** 串流中的回覆（replyId → 目前文字）。 */
  streaming: {} as Record<string, string>,
  replyErrors: [] as ReplyError[],
  confirmations: [] as Confirmation[],
  plans: [] as Plan[],
  planViews: {} as Record<string, PlanView>,
  planProgress: {} as Record<string, string[]>,
  channels: [] as Channel[],
  channelMessages: {} as Record<string, ChannelMessage[]>,
  /** 部下正在寫的回覆（channelId → 串流文字）。 */
  channelLive: {} as Record<string, string>,
  /** 報告有變動（計畫完成、暫停、取消）時加一，報告分頁據此重新整理。 */
  reportsVersion: 0,
  loadError: "",
  /** Core 啟動時發現的設定問題（§29）。 */
  setupWarnings: [] as string[],
  /** 專案卡（§30）。 */
  games: [] as GameCard[],
  /** §72：階段清單由 Core 給（只維護一處）。 */
  tracks: [] as TrackView[],
  taskSources: [] as string[],
  /** §73 重要會議（過去 14 天起）。 */
  meetings: [] as Meeting[],
  /** §77 塔羅占卜（占卜分頁開啟時載入，之後由 fortune.updated 更新）。 */
  fortune: undefined as Record<FortuneKind, FortuneSlot> | undefined,
  /** §64 代理人模式（開啟時艾莉絲可以把主人交代的指示直接傳給同事 session）。 */
  proxy: false,
  /** §71：要切到 Codex 分頁並選的任務（n 每次加一，同一個任務再按也會觸發）。 */
  codexFocus: { id: "", n: 0 },
  /** 最近結束（完成或失敗）的回覆 id，「更新進度」按鈕用來知道這輪做完了（§51）。 */
  endedReplies: [] as string[],
  /** 工作面板目前選取的計畫與頻道（切換分頁後保留）。 */
  selectedPlanId: undefined as string | undefined,
  selectedChannelId: undefined as string | undefined,
});

function upsertMessage(message: Message): void {
  const thread: Thread = message.thread === "chat" ? "chat" : "work";
  const list = thread === "chat" ? store.chatMessages : store.messages;
  const index = list.findIndex((existing) => existing.id === message.id);
  if (index >= 0) list[index] = message;
  else {
    list.push(message);
    list.sort((left, right) => left.seq - right.seq);
    if (message.role === "alice" && store.thread !== thread) store.unread[thread] = true;
  }
}

function upsertPlan(view: PlanView): void {
  store.planViews[view.plan.id] = view;
  const index = store.plans.findIndex((plan) => plan.id === view.plan.id);
  if (index >= 0) store.plans[index] = view.plan;
  else store.plans.unshift(view.plan);
}

function upsertChannel(channel: Channel): void {
  const index = store.channels.findIndex((existing) => existing.id === channel.id);
  if (index >= 0) store.channels[index] = channel;
  else store.channels.unshift(channel);
}

function removeConfirmation(kind: Confirmation["kind"], id: string): void {
  store.confirmations = store.confirmations.filter((entry) => !(entry.kind === kind && entry.id === id));
}

function addConfirmation(confirmation: Confirmation): void {
  removeConfirmation(confirmation.kind, confirmation.id);
  store.confirmations.push(confirmation);
}

export async function refreshPlan(id: string): Promise<void> {
  try {
    upsertPlan(await api.plan(id));
  } catch {
    // 計畫可能已不存在；忽略。
  }
}

export async function loadChannel(id: string): Promise<void> {
  const found = await api.channel(id);
  upsertChannel(found.channel);
  store.channelMessages[id] = found.messages;
}

export async function loadOlderMessages(thread: Thread = "work"): Promise<void> {
  const oldest = (thread === "chat" ? store.chatMessages : store.messages)[0];
  if (oldest === undefined) return;
  const { messages } = await api.messages(oldest.seq, thread);
  if (messages.length === 0) {
    if (thread === "chat") store.chatHasOlder = false;
    else store.hasOlder = false;
  }
  for (const message of messages) upsertMessage(message);
}

/** 連上（或重連）時重新載入全部狀態。 */
async function reloadAll(): Promise<void> {
  try {
    const [{ messages }, { plans }, { tasks }, { channels }] = await Promise.all([
      api.messages(), api.plans(), api.tasks(), api.channels(),
    ]);
    store.messages = [...messages].sort((left, right) => left.seq - right.seq);
    store.hasOlder = messages.length >= 60;
    const chat = (await api.messages(undefined, "chat").catch(() => ({ messages: [] as Message[] }))).messages;
    store.chatMessages = [...chat].sort((left, right) => left.seq - right.seq);
    store.chatHasOlder = chat.length >= 60;
    store.plans = plans;
    store.channels = channels;
    const confirmations: Confirmation[] = tasks
      .filter((task) => task.status === "pending_approval")
      .map((task): TaskConfirmation => ({
        kind: "task", id: task.id, repo: task.repo, repoPath: task.repoPath, goal: task.goal,
        acceptance: task.acceptance, estimateMin: task.estimateMin,
      }));
    for (const plan of plans.filter((candidate) => ["pending_approval", "running", "paused", "queued"].includes(candidate.status))) {
      const view = await api.plan(plan.id);
      upsertPlan(view);
      if (plan.status === "pending_approval") confirmations.push({ kind: "plan", id: plan.id, view });
    }
    // §75 進度確認卡片。
    for (const entry of (await api.gameConfirmations().catch(() => ({ confirmations: [] }))).confirmations) confirmations.push({ kind: "game", ...entry });
    store.confirmations = confirmations;
    store.loadError = "";
    store.reportsVersion += 1;
    store.setupWarnings = (await api.setup().catch(() => ({ warnings: [] as string[] }))).warnings;
    const loaded = await api.games().catch(() => ({ games: [] as GameCard[], tracks: undefined, taskSources: undefined }));
    store.games = loaded.games;
    if (loaded.tracks !== undefined) store.tracks = loaded.tracks;
    if (loaded.taskSources !== undefined) store.taskSources = loaded.taskSources;
    store.meetings = (await api.meetings().catch(() => ({ meetings: [] as Meeting[] }))).meetings;
    store.proxy = (await api.proxy().catch(() => ({ enabled: false }))).enabled;
  } catch (error) {
    store.loadError = error instanceof Error ? error.message : String(error);
  }
}

function handleEvent(event: EventEnvelope): void {
  const data = event.data;
  switch (event.type) {
    case "hello":
      store.character = data.state as CharacterState;
      return;
    case "state.changed":
      store.character = data as CharacterState;
      return;
    case "message.created":
      upsertMessage(data as unknown as Message);
      return;
    case "reply.start":
      store.streaming[String(data.replyId)] = "";
      if (data.thread === "chat") store.chatReplies[String(data.replyId)] = true;
      return;
    case "reply.delta": {
      const replyId = String(data.replyId);
      store.streaming[replyId] = (store.streaming[replyId] ?? "") + String(data.text ?? "");
      return;
    }
    case "reply.end":
      delete store.streaming[String(data.replyId)];
      markEnded(String(data.replyId));
      if (data.message !== undefined) upsertMessage(data.message as Message);
      return;
    case "reply.error": {
      const replyId = String(data.replyId);
      delete store.streaming[replyId];
      markEnded(replyId);
      const error = data.error as { message?: string } | undefined;
      store.replyErrors.push({ replyId, message: error?.message ?? "回覆失敗", at: event.ts });
      return;
    }
    case "permission.request":
      addConfirmation({
        kind: "task",
        id: String(data.taskId),
        repo: String(data.repo),
        repoPath: String(data.repoPath),
        goal: String(data.goal),
        acceptance: Array.isArray(data.acceptance) ? data.acceptance.map(String) : [],
        estimateMin: typeof data.estimateMin === "number" ? data.estimateMin : null,
        ...(typeof data.expiresAt === "string" ? { expiresAt: data.expiresAt } : {}),
        ...(Array.isArray(data.dirtyFiles) ? { dirtyFiles: data.dirtyFiles.map(String) } : {}),
      });
      return;
    case "permission.resolved":
      removeConfirmation("task", String(data.taskId));
      return;
    case "plan.permission.request": {
      const view = { plan: data.plan, items: data.items } as unknown as PlanView;
      upsertPlan(view);
      addConfirmation({ kind: "plan", id: view.plan.id, view, ...(typeof data.expiresAt === "string" ? { expiresAt: data.expiresAt } : {}) });
      return;
    }
    case "plan.permission.resolved":
      removeConfirmation("plan", String(data.planId));
      void refreshPlan(String(data.planId));
      return;
    case "plan.created":
    case "plan.updated":
      upsertPlan({ plan: data.plan, items: data.items } as unknown as PlanView);
      return;
    case "plan.progress": {
      const planId = String(data.planId);
      const lines = store.planProgress[planId] ?? [];
      lines.push(`${new Date(event.ts).toLocaleTimeString()}　${String(data.itemKey)}　${String(data.text)}`);
      store.planProgress[planId] = lines.slice(-40);
      return;
    }
    case "plan.paused":
    case "plan.done":
    case "plan.queued":
      void refreshPlan(String(data.planId));
      if (event.type !== "plan.queued") store.reportsVersion += 1;
      return;
    case "codex.focus":
      store.codexFocus = { id: String(data.id ?? ""), n: store.codexFocus.n + 1 };
      return;
    case "proxy.changed":
      store.proxy = data.enabled === true;
      return;
    case "game.confirmation.created":
      addConfirmation({ kind: "game", ...(data.confirmation as unknown as Omit<GameConfirmation, "kind">) });
      return;
    case "game.confirmation.resolved":
      removeConfirmation("game", String(data.id));
      return;
    case "fortune.updated":
      store.fortune = data.slots as unknown as Record<FortuneKind, FortuneSlot>;
      return;
    case "meetings.updated":
      store.meetings = data.meetings as unknown as Meeting[];
      return;
    case "games.updated":
      store.games = data.games as unknown as GameCard[];
      return;
    case "channel.created":
    case "channel.closed":
      upsertChannel(data as unknown as Channel);
      if (event.type === "channel.closed") delete store.channelLive[String(data.id)];
      return;
    case "channel.message": {
      const message = data as unknown as ChannelMessage;
      const list = store.channelMessages[message.channelId];
      if (list !== undefined && !list.some((existing) => existing.id === message.id)) list.push(message);
      delete store.channelLive[message.channelId];
      const channel = store.channels.find((candidate) => candidate.id === message.channelId);
      if (channel !== undefined) channel.updatedAt = message.createdAt;
      else void loadChannel(message.channelId).catch(() => undefined);
      return;
    }
    case "channel.delta": {
      const channelId = String(data.channelId);
      store.channelLive[channelId] = (store.channelLive[channelId] ?? "") + String(data.text ?? "");
      return;
    }
    default:
      return;
  }
}

let socket: CoreSocket | undefined;

function markEnded(replyId: string): void {
  store.endedReplies = [...store.endedReplies.slice(-49), replyId];
}

export function connect(): void {
  socket?.stop();
  socket = new CoreSocket(handleEvent, (status) => {
    store.connection = status;
    if (status === "open") void reloadAll();
  });
  socket.start();
}

/** §73：會議開始、結束的時間（毫秒）；沒寫結束時間的，開始後一小時算結束（與 Core 相同）。 */
export function meetingStart(meeting: Meeting): number {
  const [year, month, day] = meeting.date.split("-").map(Number);
  const [hour, minute] = meeting.start.split(":").map(Number);
  return new Date(year!, month! - 1, day!, hour!, minute!).getTime();
}

export function meetingEnd(meeting: Meeting): number {
  if (meeting.end === null) return meetingStart(meeting) + 3_600_000;
  const [year, month, day] = meeting.date.split("-").map(Number);
  const [hour, minute] = meeting.end.split(":").map(Number);
  return new Date(year!, month! - 1, day!, hour!, minute!).getTime();
}
