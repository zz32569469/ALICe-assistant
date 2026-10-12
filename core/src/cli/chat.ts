import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import WebSocket from "ws";

import { readToken } from "../auth/token.js";
import { loadConfig } from "../config.js";
import type { EventEnvelope } from "../protocol/eventHub.js";

type PendingMessage = {
  clientMsgId: string;
  text: string;
  deep?: boolean;
};

const config = loadConfig(process.env.ALICE_CONFIG);
let token: string;
try {
  token = readToken(config.tokenPath);
} catch {
  console.error("找不到 Alice Core token；請先執行 npm start。");
  process.exit(1);
}
const httpBase = `http://${config.host}:${config.port}`;
const wsUrl = `ws://${config.host}:${config.port}/ws?token=${encodeURIComponent(token)}`;
const pendingByReplyId = new Map<string, PendingMessage>();
let retryCandidate: PendingMessage | undefined;
let pendingPermission: { kind: "task" | "plan"; id: string; goal: string } | undefined;

type PlanView = {
  plan: { id: string; goal: string; status: string; risks: string[]; decisions: string[]; pauseReason: string | null; pauseDetail: string | null; preauthorizeClaudeFallback?: boolean };
  items: Array<{ key: string; title: string; kind: string; project: string; role: string | null; status: string; attempts: number; executor: string | null; dependsOn: string[]; risk: string; acceptance: string[]; error: string | null }>;
};

function formatPlan(view: PlanView): string {
  const lines = [
    `計畫 ${view.plan.id.slice(0, 8)}：${view.plan.goal}（${view.plan.status}${view.plan.pauseReason ? `／${view.plan.pauseReason}` : ""}）`,
    ...(view.plan.pauseDetail ? [`暫停原因：${view.plan.pauseDetail}`] : []),
    ...view.items.map((item) => {
      const depends = item.dependsOn.length === 0 ? "" : `，依賴 ${item.dependsOn.join("、")}`;
      const who = item.kind === "session" ? "同事 session" : item.kind === "read" || item.kind === "review" ? `${item.role ?? "部下"}（唯讀）` : (item.executor ?? "Codex／Claude");
      return `  ${item.key}. [${item.status}] ${item.title}（${item.kind}・${item.project}・${who}${item.risk === "high" ? "・高風險" : ""}${depends}）${item.error ? `\n     錯誤：${item.error}` : ""}`;
    }),
  ];
  if (view.plan.risks.length > 0) lines.push(`風險：${view.plan.risks.join("；")}`);
  if (view.plan.decisions.length > 0) lines.push(`需要主人決定：${view.plan.decisions.join("；")}`);
  if (view.plan.preauthorizeClaudeFallback === true) lines.push("⚠ 這份計畫預先授權：Codex 不可用或額度不足時改由 Claude 寫程式");
  return lines.join("\n");
}

async function planAction(planId: string, action: "approve" | "reject" | "resume" | "cancel", executor?: "claude"): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/plans/${encodeURIComponent(planId)}/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-alice-client": "cli" },
      body: JSON.stringify({ clientId: "cli", ...(executor === undefined ? {} : { executor }) }),
    });
    if (!response.ok) console.error(`計畫操作失敗（HTTP ${response.status}）：${await response.text()}`);
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function listPlans(): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/plans`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      console.error(`讀取計畫失敗（HTTP ${response.status}）`);
      return;
    }
    const body = await response.json() as { plans: Array<{ id: string; status: string; goal: string }> };
    if (body.plans.length === 0) console.log("目前沒有計畫紀錄。");
    else for (const plan of body.plans) console.log(`${plan.id.slice(0, 8)}  ${plan.status}  ${plan.goal}`);
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function showPlan(id: string): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/plans/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) {
      console.error(`讀取計畫失敗（HTTP ${response.status}）：${await response.text()}`);
      return;
    }
    console.log(formatPlan(await response.json() as PlanView));
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function postMessage(message: PendingMessage): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...message, clientId: "cli" }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error(`送出失敗（HTTP ${response.status}）：${detail}`);
      return;
    }
    const result = await response.json() as { replyId: string };
    pendingByReplyId.set(result.replyId, message);
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function taskAction(taskId: string, action: "approve" | "reject" | "cancel"): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/tasks/${encodeURIComponent(taskId)}/${action}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-alice-client": "cli",
      },
      body: JSON.stringify({ clientId: "cli" }),
    });
    if (!response.ok) console.error(`任務操作失敗（HTTP ${response.status}）：${await response.text()}`);
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function listTasks(cancelRunning = false): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      console.error(`讀取任務失敗（HTTP ${response.status}）`);
      return;
    }
    const body = await response.json() as { tasks: Array<{ id: string; status: string; goal: string }> };
    if (cancelRunning) {
      const running = body.tasks.find((task) => task.status === "running");
      if (running === undefined) console.log("目前沒有執行中的任務。");
      else await taskAction(running.id, "cancel");
      return;
    }
    if (body.tasks.length === 0) console.log("目前沒有任務紀錄。");
    else for (const task of body.tasks) console.log(`${task.id.slice(0, 8)}  ${task.status}  ${task.goal}`);
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function listChannels(): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/channels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      console.error(`讀取頻道失敗（HTTP ${response.status}）`);
      return;
    }
    const body = await response.json() as {
      channels: Array<{ id: string; status: string; role: string; project: string; title: string; rounds: number }>;
    };
    if (body.channels.length === 0) console.log("目前沒有工作頻道。");
    else for (const channel of body.channels) {
      console.log(`${channel.id.slice(0, 8)}  ${channel.status}  ${channel.role} / ${channel.project}  ${channel.title}（${channel.rounds} 輪）`);
    }
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function showChannel(id: string): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/channels/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      console.error(`讀取頻道失敗（HTTP ${response.status}）：${await response.text()}`);
      return;
    }
    const body = await response.json() as {
      channel: { id: string; status: string; role: string; project: string; title: string; rounds: number };
      messages: Array<{ author: string; text: string }>;
    };
    const channel = body.channel;
    console.log(`[頻道 ${channel.id.slice(0, 8)}・${channel.role}] ${channel.status} / ${channel.project} / ${channel.rounds} 輪`);
    console.log(channel.title);
    for (const message of body.messages) console.log(`${message.author}：${message.text}`);
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function showUsage(): Promise<void> {
  try {
    const response = await fetch(`${httpBase}/api/usage?limit=10`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      console.error(`讀取用量失敗（HTTP ${response.status}）：${await response.text()}`);
      return;
    }
    const body = await response.json() as {
      work: Array<{ kind: string; title: string; totalTokens: number; durationMs: number; time: string }>;
      quotas: Record<string, { status: "ok" | "error"; message?: string; reason?: string; [key: string]: unknown }>;
    };
    if (body.work.length === 0) console.log("目前沒有用量紀錄。");
    else console.table(body.work.map((item) => ({
      類型: item.kind,
      標題: item.title,
      token: item.totalTokens,
      耗時: `${item.durationMs} ms`,
      時間: item.time,
    })));
    const describe = (name: "max" | "codex"): string => {
      const quota = body.quotas[name]!;
      if (quota.status === "error") return `${quota.message ?? "無法讀取"}（${quota.reason ?? "未知原因"}）`;
      const windows = Object.entries(quota)
        .filter(([key, value]) => key !== "status" && typeof value === "object" && value !== null)
        .map(([key, value]) => {
          const window = value as { usedPercent?: number; resets?: string };
          return `${key} ${window.usedPercent ?? "?"}%・${window.resets ?? "重置時間未知"}`;
        });
      return windows.join("；");
    };
    console.log(`Max 額度：${describe("max")}`);
    console.log(`Codex 額度：${describe("codex")}`);
  } catch {
    console.error("無法連線到 Alice Core；請先執行 npm start。");
  }
}

async function connect(): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

let socket: WebSocket;
try {
  socket = await connect();
} catch {
  console.error("無法連線到 Alice Core；請先執行 npm start。");
  process.exitCode = 1;
  process.exit();
}

socket.on("message", (raw) => {
  const event = JSON.parse(raw.toString()) as EventEnvelope<Record<string, unknown>>;
  if (event.type === "ping") {
    socket.send(JSON.stringify({ type: "pong" }));
    return;
  }
  if (event.type === "reply.delta") {
    process.stdout.write(String(event.data.text ?? ""));
    return;
  }
  if (event.type === "reply.end") {
    process.stdout.write("\n");
    pendingByReplyId.delete(String(event.data.replyId));
    retryCandidate = undefined;
    return;
  }
  if (event.type === "state.changed") {
    const reason = event.data.sleepReason === undefined ? "" : ` / ${String(event.data.sleepReason)}`;
    console.log(`\n[狀態] ${String(event.data.activity)} / ${String(event.data.energy)}${reason}`);
    return;
  }
  if (event.type === "reply.error") {
    const replyId = String(event.data.replyId);
    const pending = pendingByReplyId.get(replyId);
    const error = event.data.error as { code?: string; message?: string } | undefined;
    if (error?.code === "reasoning_unavailable" && pending !== undefined) {
      retryCandidate = pending;
      console.error(`\n艾莉絲睡著了（${error.message ?? "推理引擎無法連線"}）……訊息已保留，按 Enter 重送`);
    } else {
      console.error(`\n回覆失敗：${error?.message ?? "未知錯誤"}`);
    }
    return;
  }
  if (event.type === "permission.request") {
    const acceptance = Array.isArray(event.data.acceptance)
      ? event.data.acceptance.map((item) => `  - ${String(item)}`).join("\n")
      : "  - （未提供）";
    console.log([
      "\n[任務確認]",
      `repo：${String(event.data.repo)} (${String(event.data.repoPath)})`,
      `目標：${String(event.data.goal)}`,
      "驗收標準：",
      acceptance,
      `預估時間：${event.data.estimateMin == null ? "未提供" : `${String(event.data.estimateMin)} 分鐘`}`,
      ...(Array.isArray(event.data.dirtyFiles) && event.data.dirtyFiles.length > 0
        ? [`⚠ 這個 repo 有未提交的改動（${event.data.dirtyFiles.length} 個檔）：${event.data.dirtyFiles.slice(0, 10).map(String).join("、")}${event.data.dirtyFiles.length > 10 ? " 等" : ""}；核准後 Codex／Claude 會在這些改動之上工作。`]
        : []),
      `確認期限：${String(event.data.expiresAt)}`,
      "核准這個任務嗎？(y/n)",
    ].join("\n"));
    pendingPermission = { kind: "task", id: String(event.data.taskId), goal: String(event.data.goal) };
    return;
  }
  if (event.type === "permission.resolved") {
    if (pendingPermission?.kind === "task" && pendingPermission.id === String(event.data.taskId)) pendingPermission = undefined;
    console.log(`\n[任務確認] ${String(event.data.result)}`);
    return;
  }
  if (event.type === "plan.permission.request") {
    const view = event.data as unknown as PlanView & { expiresAt: string };
    console.log(["\n[計畫確認]", formatPlan(view), `確認期限：${view.expiresAt}`, "核准這份計畫嗎？(y/n)"].join("\n"));
    pendingPermission = { kind: "plan", id: view.plan.id, goal: view.plan.goal };
    return;
  }
  if (event.type === "plan.permission.resolved") {
    if (pendingPermission?.kind === "plan" && pendingPermission.id === String(event.data.planId)) pendingPermission = undefined;
    console.log(`\n[計畫確認] ${String(event.data.result)}`);
    return;
  }
  if (event.type === "plan.progress") {
    console.log(`\n[計畫 ${String(event.data.planId).slice(0, 8)}・${String(event.data.itemKey)}] ${String(event.data.text)}`);
    return;
  }
  if (event.type === "plan.paused") {
    console.log(`\n[計畫 ${String(event.data.planId).slice(0, 8)}] 暫停（${String(event.data.reason)}）：${String(event.data.detail)}`);
    console.log(`繼續：/plan resume ${String(event.data.planId).slice(0, 8)}　取消：/plan cancel ${String(event.data.planId).slice(0, 8)}`);
    return;
  }
  if (event.type === "plan.queued") {
    console.log(`\n[計畫 ${String(event.data.planId).slice(0, 8)}] 已有 2 份計畫執行中，排隊等候；前一份結束後自動開始`);
    return;
  }
  if (event.type === "plan.done") {
    console.log(`\n[計畫 ${String(event.data.planId).slice(0, 8)}] ${String(event.data.status)}`);
    return;
  }
  if (event.type === "task.progress") {
    console.log(`\n[任務] ${String(event.data.text)}`);
    return;
  }
  if (event.type === "task.done") {
    console.log(`\n[任務] ${String(event.data.taskId).slice(0, 8)} ${String(event.data.status)}`);
    return;
  }
  if (event.type === "channel.message") {
    const fullText = String(event.data.text ?? "");
    const author = String(event.data.author ?? "system");
    const truncated = author === "worker" && Array.from(fullText).length > 600
      ? `${Array.from(fullText).slice(0, 600).join("")}……（用 /channel ${String(event.data.channelId)} 看全文）`
      : fullText;
    console.log(`\n[頻道 ${String(event.data.channelId).slice(0, 8)}・${String(event.data.role)}] ${author}：${truncated}`);
  }
});
socket.on("close", () => console.error("\n與 Alice Core 的連線已中斷。"));

const terminal = createInterface({ input: process.stdin, output: process.stdout });
terminal.setPrompt("> ");
terminal.prompt();
terminal.on("line", (line) => {
  const text = line.trim();
  if (pendingPermission !== undefined) {
    if (/^y(?:es)?$/i.test(text) || /^n(?:o)?$/i.test(text)) {
      const pending = pendingPermission;
      const action = /^y/i.test(text) ? "approve" : "reject";
      pendingPermission = undefined;
      if (pending.kind === "plan") void planAction(pending.id, action);
      else void taskAction(pending.id, action);
    } else {
      console.log("請輸入 y 或 n。");
    }
    terminal.prompt();
    return;
  }
  if (text === "/quit") {
    terminal.close();
    return;
  }
  const planCommand = /^\/plan\s+(resume|cancel)\s+(\S+)(?:\s+(claude))?$/u.exec(text);
  if (text === "/plans") {
    void listPlans();
  } else if (planCommand !== null) {
    void planAction(planCommand[2]!, planCommand[1] as "resume" | "cancel", planCommand[3] === "claude" ? "claude" : undefined);
  } else if (/^\/plan\s+\S+$/u.test(text)) {
    void showPlan(text.split(/\s+/u)[1]!);
  } else if (text === "/計畫" || text.startsWith("/計畫 ")) {
    const request = text.slice("/計畫".length).trim();
    if (request === "") console.log("用法：/計畫 <需求>");
    else {
      retryCandidate = undefined;
      void postMessage({ clientMsgId: randomUUID(), text: `${request}\n\n（主人要求把這件事做成計畫，請提出計畫草案。）`, deep: true });
    }
  } else if (text === "/tasks") {
    void listTasks();
  } else if (text === "/channels") {
    void listChannels();
  } else if (text === "/usage") {
    void showUsage();
  } else if (text === "/深想" || text.startsWith("/深想 ")) {
    const message = text.slice("/深想".length).trim();
    if (message === "") console.log("用法：/深想 <訊息>");
    else {
      retryCandidate = undefined;
      void postMessage({ clientMsgId: randomUUID(), text: message, deep: true });
    }
  } else if (text.startsWith("/channel ")) {
    const id = text.slice("/channel ".length).trim();
    if (id === "") console.log("用法：/channel <id>");
    else void showChannel(id);
  } else if (text === "/cancel") {
    void listTasks(true);
  } else if (text === "/help" || /^\/[A-Za-z]+(\s|$)/u.test(text)) {
    // 打錯的指令（例如 /usag）不要當成一般訊息送給艾莉絲。
    if (text !== "/help") console.log(`未知指令：${text.split(/\s/u)[0]}`);
    console.log("可用指令：/usage、/深想 <訊息>、/計畫 <需求>、/plans、/plan <id>、/plan resume <id> [claude]、/plan cancel <id>、/channels、/channel <id>、/tasks、/cancel、/quit；以「@角色」開頭可直接對部下說話。");
  } else if (text === "" && retryCandidate !== undefined) {
    void postMessage(retryCandidate);
  } else if (text !== "") {
    retryCandidate = undefined;
    void postMessage({ clientMsgId: randomUUID(), text: line });
  }
  terminal.prompt();
});
terminal.on("close", () => socket.close());
