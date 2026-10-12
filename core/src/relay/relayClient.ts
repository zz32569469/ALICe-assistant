// 轉接 session 用的用戶端：送一則訊息給 Core、等艾莉絲回完，連同期間的確認請求與系統通知一起回傳。
// 確認只由主人在轉接 session 裡下指令核准（S-4），這裡只負責列出。

import { randomUUID } from "node:crypto";

import WebSocket from "ws";

import { PROGRESS_NOTICE_PREFIX } from "../games/progressNotice.js";
import type { EventEnvelope } from "../protocol/eventHub.js";
import { PEER_CLIENT_PREFIX, peerText } from "./peer.js";

export const RELAY_TIMEOUT_MS = 180_000;
/** 回覆結束後再等一下，收下緊接著的確認請求與系統通知（計畫、任務建立在回覆之後）。 */
const SETTLE_MS = 1_500;

export type RelayConnection = { baseUrl: string; token: string };

export type RelayOutcome = {
  replyText?: string;
  error?: string;
  timedOut: boolean;
  confirmations: string[];
  systemNotes: string[];
};

type PlanView = {
  plan: { id: string; goal: string; risks: string[]; decisions: string[]; preauthorizeClaudeFallback?: boolean };
  items: Array<{ key: string; title: string; kind: string; project: string; role: string | null; risk: string; dependsOn: string[]; acceptance: string[] }>;
};

export function formatPlanConfirmation(view: PlanView): string {
  const short = view.plan.id.slice(0, 8);
  return [
    `計畫 ${short}：${view.plan.goal}`,
    ...view.items.map((item) => {
      const who = item.kind === "modify" ? "Codex／Claude" : item.kind === "session" ? "同事 session" : `${item.role ?? "部下"}（唯讀）`;
      const extra = [item.risk === "high" ? "高風險" : "", item.dependsOn.length > 0 ? `依賴 ${item.dependsOn.join("、")}` : ""].filter((part) => part !== "");
      return `  ${item.key}. ${item.title}（${item.kind}・${item.project}・${who}${extra.length > 0 ? `・${extra.join("・")}` : ""}）\n     驗收：${item.acceptance.join("；")}`;
    }),
    ...(view.plan.risks.length > 0 ? [`  風險：${view.plan.risks.join("；")}`] : []),
    ...(view.plan.decisions.length > 0 ? [`  需要主人決定：${view.plan.decisions.join("；")}`] : []),
    ...(view.plan.preauthorizeClaudeFallback === true ? ["  ⚠ 預先授權：Codex 不可用或額度不足時改由 Claude 寫程式"] : []),
    `  → 主人在這個 session 打「核准 ${short}」或「拒絕 ${short}」`,
  ].join("\n");
}

export function formatTaskConfirmation(data: Record<string, unknown>): string {
  const short = String(data.taskId).slice(0, 8);
  const acceptance = Array.isArray(data.acceptance) ? data.acceptance.map(String).join("；") : "";
  const dirty = Array.isArray(data.dirtyFiles) && data.dirtyFiles.length > 0
    ? `\n  ⚠ repo 有未提交的改動：${data.dirtyFiles.slice(0, 10).map(String).join("、")}`
    : "";
  return `任務 ${short}：${String(data.goal)}（repo：${String(data.repo)}）\n  驗收：${acceptance}${dirty}\n  → 主人在這個 session 打「核准 ${short}」或「拒絕 ${short}」`;
}

/** 送出一則訊息並等回覆。from 有值時以同事 session 的身分送出（S-1）。 */
export async function relayMessage(
  connection: RelayConnection,
  text: string,
  options: { from?: string; timeoutMs?: number } = {},
): Promise<RelayOutcome> {
  const wsUrl = `${connection.baseUrl.replace(/^http/u, "ws")}/ws?token=${encodeURIComponent(connection.token)}`;
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const outcome: RelayOutcome = { timedOut: false, confirmations: [], systemNotes: [] };
  const events: EventEnvelope<Record<string, unknown>>[] = [];
  let replyId: string | undefined;
  let finish: (() => void) | undefined;
  let settleTimer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => { finish = resolve; });

  const handle = (event: EventEnvelope<Record<string, unknown>>): void => {
    const data = event.data;
    if (event.type === "plan.permission.request") outcome.confirmations.push(formatPlanConfirmation(data as unknown as PlanView));
    else if (event.type === "permission.request") outcome.confirmations.push(formatTaskConfirmation(data));
    else if (event.type === "message.created" && data.role === "system") {
      outcome.systemNotes.push(String(data.text));
      // §30：艾莉絲要了進度資料，Core 收集後會再請她整理一次；接著等那一則，手機上才看得到總覽。
      if (replyId !== undefined && outcome.replyText !== undefined && String(data.text).startsWith(PROGRESS_NOTICE_PREFIX)) {
        if (settleTimer !== undefined) clearTimeout(settleTimer);
        replyId = `${String(data.id)}:reply`;
      }
    }
    if (replyId === undefined) return;
    if (event.type === "reply.end" && data.replyId === replyId) {
      const message = data.message as { text?: string } | undefined;
      const text = (message?.text ?? "").trim();
      outcome.replyText = outcome.replyText === undefined || outcome.replyText.trim() === "" ? text : `${outcome.replyText.trim()}\n\n${text}`;
      settleTimer = setTimeout(() => finish?.(), SETTLE_MS);
    } else if (event.type === "reply.error" && data.replyId === replyId) {
      const error = data.error as { message?: string } | undefined;
      outcome.error = error?.message ?? "回覆失敗";
      finish?.();
    }
  };

  socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString()) as EventEnvelope<Record<string, unknown>>;
    if (event.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (replyId === undefined) events.push(event);
    else handle(event);
  });

  try {
    const from = options.from?.trim();
    const response = await fetch(`${connection.baseUrl}/api/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", "x-alice-client": "relay" },
      body: JSON.stringify({
        clientMsgId: randomUUID(),
        clientId: from === undefined || from === "" ? "relay" : `${PEER_CLIENT_PREFIX}${from}`,
        text: from === undefined || from === "" ? text : peerText(from, text),
      }),
    });
    const body = await response.json() as { replyId?: string; error?: { message?: string } };
    if (!response.ok || body.replyId === undefined) {
      outcome.error = body.error?.message ?? `HTTP ${response.status}`;
      return outcome;
    }
    replyId = body.replyId;
    // POST 回來之前就到的事件（例如 reply.start）補處理一次。
    for (const event of events.splice(0)) handle(event);
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      finish?.();
    }, options.timeoutMs ?? RELAY_TIMEOUT_MS);
    await done;
    clearTimeout(timer);
    return outcome;
  } finally {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    socket.close();
  }
}

type PendingItem = { kind: "plan" | "task"; id: string; label: string };

async function getJson<T>(connection: RelayConnection, path: string): Promise<T> {
  const response = await fetch(`${connection.baseUrl}${path}`, { headers: { authorization: `Bearer ${connection.token}` } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as T;
}

/** 沒啟用計畫或任務模組時端點不存在（404），視為沒有待確認項目。 */
async function listOrEmpty<T>(connection: RelayConnection, path: string, key: "plans" | "tasks"): Promise<T[]> {
  try {
    return (await getJson<Record<string, T[]>>(connection, path))[key] ?? [];
  } catch (error) {
    if (error instanceof Error && error.message === "HTTP 404") return [];
    throw error;
  }
}

export async function pendingConfirmations(connection: RelayConnection): Promise<PendingItem[]> {
  type Pending = { id: string; goal: string; status: string };
  const [plans, tasks] = await Promise.all([
    listOrEmpty<Pending>(connection, "/api/plans?limit=20", "plans"),
    listOrEmpty<Pending>(connection, "/api/tasks?limit=20", "tasks"),
  ]);
  return [
    ...plans.filter((plan) => plan.status === "pending_approval").map((plan) => ({ kind: "plan" as const, id: plan.id, label: `計畫 ${plan.id.slice(0, 8)}：${plan.goal}` })),
    ...tasks.filter((task) => task.status === "pending_approval").map((task) => ({ kind: "task" as const, id: task.id, label: `任務 ${task.id.slice(0, 8)}：${task.goal}` })),
  ];
}

/** 主人的核准／拒絕（S-4）。id 可省略（只有一個待確認時）或給前綴。 */
export async function decide(connection: RelayConnection, action: "approve" | "reject", idPrefix?: string): Promise<string> {
  const pending = await pendingConfirmations(connection);
  const matches = idPrefix === undefined || idPrefix === "" ? pending : pending.filter((item) => item.id.startsWith(idPrefix));
  if (matches.length === 0) return idPrefix ? `沒有 id 開頭為 ${idPrefix} 的待確認項目。` : "目前沒有待確認的計畫或任務。";
  if (matches.length > 1) return `有 ${matches.length} 個待確認項目，請指定 id：\n${matches.map((item) => `- ${item.label}`).join("\n")}`;
  const target = matches[0]!;
  const response = await fetch(`${connection.baseUrl}/api/${target.kind === "plan" ? "plans" : "tasks"}/${target.id}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", "x-alice-client": "relay" },
    body: JSON.stringify({ clientId: "relay" }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    return `${action === "approve" ? "核准" : "拒絕"}失敗：${body?.error?.message ?? `HTTP ${response.status}`}`;
  }
  return `已${action === "approve" ? "核准" : "拒絕"}：${target.label}`;
}

// ─── 待送信件（§27）──────────────────────────────────────────────────────

export type OutboxEntry = { id: string; recipient: string; text: string; kind: string };

export async function outboxPending(connection: RelayConnection): Promise<OutboxEntry[]> {
  return (await getJson<{ messages: OutboxEntry[] }>(connection, "/api/outbox?status=pending")).messages;
}

export async function markOutbox(connection: RelayConnection, id: string, status: "sent" | "failed", reason?: string): Promise<string> {
  const response = await fetch(`${connection.baseUrl}/api/outbox/${encodeURIComponent(id)}/${status}`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", "x-alice-client": "relay" },
    body: JSON.stringify(reason === undefined ? {} : { reason }),
  });
  const body = await response.json().catch(() => null) as { message?: { recipient: string }; error?: { message?: string } } | null;
  if (!response.ok) return `【錯誤】${body?.error?.message ?? `HTTP ${response.status}`}`;
  return status === "sent" ? `已記錄送出給〈${body?.message?.recipient ?? "?"}〉` : `已記錄送出失敗`;
}

// ─── 手機推播（§30）──────────────────────────────────────────────────────

export type NotificationEntry = { id: string; text: string; kind: string };

export async function notificationsPending(connection: RelayConnection): Promise<NotificationEntry[]> {
  try {
    return (await getJson<{ notifications: NotificationEntry[] }>(connection, "/api/notifications?status=pending")).notifications;
  } catch {
    // 舊版 Core 沒有推播 API。
    return [];
  }
}

export async function markNotificationDelivered(connection: RelayConnection, id: string): Promise<void> {
  await fetch(`${connection.baseUrl}/api/notifications/${encodeURIComponent(id)}/delivered`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json", "x-alice-client": "relay" },
    body: "{}",
  });
}

/**
 * 給轉接 session 的 Monitor 用：每有一封新信件或計畫暫停／結束就印一行（印出即喚醒轉接 session）。
 * 啟動時先印出已在等的信件；Core 重啟時自動重連。不會自己結束。
 */
/**
 * §42：背景等待。有待送信件或待推播才結束（沒有時間上限、Core 重啟會自動重連），
 * 轉接 session 用 Bash run_in_background 執行，結束時才被叫醒，再用 checkWork 取出要做的事。
 * 取代 Monitor 版的 --watch（Monitor 最多 30 分鐘，每次到期都會叫醒 session）。
 */
/** 兩種待辦各自查，其中一個失敗（例如沒有派工功能時沒有待送信件 API）不影響另一個；Core 沒開時兩個都是空的。 */
async function hasWork(connection: RelayConnection): Promise<boolean> {
  const [outbox, notifications] = await Promise.all([
    outboxPending(connection).catch(() => []),
    notificationsPending(connection).catch(() => []),
  ]);
  return outbox.length > 0 || notifications.length > 0;
}

export async function waitForWork(connection: RelayConnection, retryLimitMs = 30_000): Promise<void> {
  const wsUrl = `${connection.baseUrl.replace(/^http/u, "ws")}/ws?token=${encodeURIComponent(connection.token)}`;
  let retryMs = 1_000;
  for (;;) {
    try {
      if (await hasWork(connection)) return;
      const found = await new Promise<boolean>((resolve) => {
        const socket = new WebSocket(wsUrl);
        const finish = (): void => {
          socket.removeAllListeners("close");
          socket.close();
          resolve(true);
        };
        socket.on("open", () => {
          retryMs = 1_000;
          // 連線建立前剛好發生的事件會錯過，連上後再查一次。
          void hasWork(connection).then((found) => { if (found) finish(); });
        });
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as EventEnvelope<Record<string, unknown>>;
          if (event.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
          else if (event.type === "outbox.created" || event.type === "notify.created") finish();
        });
        socket.on("close", () => resolve(false));
        socket.on("error", () => resolve(false));
      });
      if (found) return;
    } catch {
      // Core 沒開：稍後重試。
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    retryMs = Math.min(retryMs * 2, retryLimitMs);
  }
}

/** §42：列出要處理的事（待送信件、待推播），推播印出後標成已送。回傳印了幾行。 */
export async function checkWork(connection: RelayConnection, write: (line: string) => void = (line) => console.log(line)): Promise<number> {
  let count = 0;
  for (const message of await outboxPending(connection).catch(() => [])) {
    write(`📤 有待送信件 ${message.id.slice(0, 8)} → ${message.recipient}（執行 --outbox 取出並送出）`);
    count += 1;
  }
  for (const notification of await notificationsPending(connection).catch(() => [])) {
    write(`🔔 推播：${notification.text}`);
    await markNotificationDelivered(connection, notification.id).catch(() => undefined);
    count += 1;
  }
  return count;
}

export async function watchOutbox(connection: RelayConnection, write: (line: string) => void = (line) => console.log(line)): Promise<never> {
  const announced = new Set<string>();
  const announce = (id: string, recipient: string): void => {
    if (announced.has(id)) return;
    announced.add(id);
    write(`📤 有待送信件 ${id.slice(0, 8)} → ${recipient}（執行 --outbox 取出並送出）`);
  };
  // §30：Core 排入的手機推播。印出後就標成已送，轉接 session 看到「🔔 推播：」就用 PushNotification 推出去。
  const pushed = new Set<string>();
  const push = (id: string, text: string): void => {
    if (pushed.has(id)) return;
    pushed.add(id);
    write(`🔔 推播：${text}`);
    void markNotificationDelivered(connection, id).catch(() => undefined);
  };
  const wsUrl = `${connection.baseUrl.replace(/^http/u, "ws")}/ws?token=${encodeURIComponent(connection.token)}`;
  let retryMs = 1_000;
  for (;;) {
    try {
      for (const message of await outboxPending(connection)) announce(message.id, message.recipient);
      for (const notification of await notificationsPending(connection)) push(notification.id, notification.text);
      await new Promise<void>((resolve) => {
        const socket = new WebSocket(wsUrl);
        socket.on("open", () => { retryMs = 1_000; });
        socket.on("message", (raw) => {
          const event = JSON.parse(raw.toString()) as EventEnvelope<Record<string, unknown>>;
          if (event.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
          else if (event.type === "outbox.created") announce(String(event.data.id), String(event.data.recipient));
          else if (event.type === "notify.created") push(String(event.data.id), String(event.data.text));
          else if (event.type === "plan.paused") write(`⏸ 計畫 ${String(event.data.planId).slice(0, 8)} 暫停（${String(event.data.reason)}）：${String(event.data.detail).slice(0, 200)}`);
          else if (event.type === "plan.done") write(`🏁 計畫 ${String(event.data.planId).slice(0, 8)} ${String(event.data.status)}`);
        });
        socket.on("close", () => resolve());
        socket.on("error", () => resolve());
      });
    } catch {
      // Core 沒開：稍後重試。
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    retryMs = Math.min(retryMs * 2, 30_000);
  }
}
