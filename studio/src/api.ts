/** §78 左側對話分頁。 */
export type Thread = "work" | "chat";

// 呼叫 Alice Core 的 HTTP API。token 由 npm run studio 放在網址 # 後面帶進來（W-2），存在瀏覽器後清掉網址。

import type { Channel, ChannelMessage, CodexJobDetail, CodexJobSummary, CodexQuota, Fortune, FortuneKind, FortuneSlot, GameCard, GameConfirmation, Message, PlanView, Plan, QuotaResult, ReportEntry, Task, Meeting, TrackView, UsageSummary } from "./types";

const TOKEN_KEY = "alice.studio.token";
const CORE_KEY = "alice.studio.core";
export const CLIENT_ID = "studio";

/** §91：放在 GitHub Pages 等其他網址的 Studio（建置時 VITE_HOSTED=1），要自己設定 Core 的網址；由 Core 提供的 Studio 用同一個網址。 */
export const HOSTED = import.meta.env.VITE_HOSTED === "1";

export function takeTokenFromUrl(): void {
  const match = /(?:^#|&)token=([0-9a-fA-F]+)/u.exec(window.location.hash);
  const core = /(?:^#|&)core=([^&]+)/u.exec(window.location.hash);
  if (match === null && core === null) return;
  if (core !== null) setCore(decodeURIComponent(core[1]!));
  if (match !== null) setToken(match[1]!);
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

let memoryToken: string | undefined;
let memoryCore: string | undefined;

/** Core 網址只收 http(s)://主機[:埠]，去掉結尾斜線；格式不對回 undefined。 */
export function normalizeCore(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/u, "");
  return /^https?:\/\/[a-z0-9.\-[\]:]+$/iu.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function getCore(): string | undefined {
  try {
    return window.localStorage.getItem(CORE_KEY) ?? memoryCore;
  } catch {
    return memoryCore;
  }
}

export function setCore(value: string): boolean {
  const core = normalizeCore(value);
  if (core === undefined) return false;
  memoryCore = core;
  try {
    window.localStorage.setItem(CORE_KEY, core);
  } catch {
    // 只存在記憶體。
  }
  return true;
}

/** API 與 WebSocket 的前綴：hosted 用設定的 Core 網址，否則用同一個網址（空字串）。 */
export function coreBase(): string {
  return HOSTED ? getCore() ?? "" : "";
}

/** hosted 而且還沒設定 Core 網址時，不能連線。 */
export function coreReady(): boolean {
  return !HOSTED || getCore() !== undefined;
}

export function getToken(): string | undefined {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string): void {
  memoryToken = token;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 同上：只存在記憶體。
  }
}

export function clearToken(): void {
  memoryToken = undefined;
  memoryCore = undefined;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(CORE_KEY);
  } catch {
    // 忽略。
  }
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${coreBase()}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${getToken() ?? ""}`,
      "x-alice-client": CLIENT_ID,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new ApiError(response.status, body?.error?.message ?? `HTTP ${response.status}`);
  return body as T;
}

/** crypto.randomUUID 只在安全環境（https 或 localhost）有；從其他裝置以 http 開時退回 getRandomValues（§58）。 */
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const uploadUrls = new Map<string, Promise<string>>();

const post = <T>(path: string, body: unknown = {}): Promise<T> => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  messages: (before?: number, thread: Thread = "work") => request<{ messages: Message[] }>(`/api/messages?limit=60${before === undefined ? "" : `&before=${before}`}${thread === "chat" ? "&thread=chat" : ""}`),
  send: (text: string, deep: boolean, thread: Thread = "work", images: string[] = []) =>
    post<{ messageId: string; replyId: string }>("/api/messages", { clientMsgId: newId(), clientId: CLIENT_ID, text, deep, ...(thread === "chat" ? { thread } : {}), ...(images.length > 0 ? { images } : {}) }),
  /** §83：上傳一張截圖，回傳 Core 存的檔名。 */
  uploadImage: (file: Blob) => request<{ name: string }>("/api/uploads", { method: "POST", body: file, headers: { "content-type": file.type } }),
  /** §83：截圖要帶 token 才拿得到，取回後轉成 blob 網址（同一張只取一次）。 */
  uploadUrl: (name: string): Promise<string> => {
    const cached = uploadUrls.get(name);
    if (cached !== undefined) return cached;
    const loading = fetch(`${coreBase()}/api/uploads/${encodeURIComponent(name)}`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } })
      .then(async (response) => {
        if (!response.ok) throw new ApiError(response.status, `HTTP ${response.status}`);
        return URL.createObjectURL(await response.blob());
      });
    uploadUrls.set(name, loading);
    loading.catch(() => uploadUrls.delete(name));
    return loading;
  },
  tasks: () => request<{ tasks: Task[] }>("/api/tasks?limit=20"),
  taskAction: (id: string, action: "approve" | "reject") => post(`/api/tasks/${encodeURIComponent(id)}/${action}`, { clientId: CLIENT_ID }),
  plans: () => request<{ plans: Plan[] }>("/api/plans?limit=30"),
  plan: (id: string) => request<PlanView>(`/api/plans/${encodeURIComponent(id)}`),
  planAction: (id: string, action: "approve" | "reject" | "resume" | "cancel", executor?: "claude") =>
    post(`/api/plans/${encodeURIComponent(id)}/${action}`, { clientId: CLIENT_ID, ...(executor === undefined ? {} : { executor }) }),
  channels: () => request<{ channels: Channel[] }>("/api/channels?limit=30"),
  channel: (id: string) => request<{ channel: Channel; messages: ChannelMessage[] }>(`/api/channels/${encodeURIComponent(id)}`),
  reports: () => request<{ reports: ReportEntry[] }>("/api/reports"),
  report: (kind: ReportEntry["kind"], name: string) =>
    request<{ kind: string; name: string; text: string }>(`/api/reports/${kind}/${encodeURIComponent(name)}`),
  games: () => request<{ games: GameCard[]; tracks?: TrackView[]; taskSources?: string[] }>("/api/games"),
  /** §93：凍結／解凍專案卡（解凍時 Core 把截止日延後凍結的天數）。 */
  setFrozen: (id: string, frozen: boolean, reason = "") => post<{ ok: true }>(`/api/games/${encodeURIComponent(id)}/${frozen ? "freeze" : "unfreeze"}`, frozen && reason !== "" ? { reason } : {}),
  refreshProgress: () => post<{ replyId: string }>("/api/games/refresh"),
  gameConfirmations: () => request<{ confirmations: Array<Omit<GameConfirmation, "kind">> }>("/api/games/confirmations"),
  gameConfirmationAction: (id: string, action: "approve" | "reject") => post(`/api/games/confirmations/${encodeURIComponent(id)}/${action}`),
  fortune: () => request<{ slots: Record<FortuneKind, FortuneSlot> }>("/api/fortune"),
  drawFortune: (kind: FortuneKind) => post<{ fortune: Fortune; slots: Record<FortuneKind, FortuneSlot> }>(`/api/fortune/${kind}`),
  meetings: () => request<{ meetings: Meeting[] }>("/api/meetings"),
  addMeeting: (text: string) => post<{ meeting: Meeting }>("/api/meetings", { text }),
  removeMeeting: (id: string) => request<{ ok: true }>(`/api/meetings/${encodeURIComponent(id)}`, { method: "DELETE" }),
  codexJobs: () => request<{ jobs: CodexJobSummary[]; quota: CodexQuota | null }>("/api/codex/jobs"),
  codexJob: (id: string) => request<CodexJobDetail>(`/api/codex/jobs/${encodeURIComponent(id)}`),
  codexDiff: (id: string) => request<{ text: string }>(`/api/codex/jobs/${encodeURIComponent(id)}/diff`),
  codexOpen: (id: string, target: "watch" | "log" | "repo") => post<{ ok: boolean }>(`/api/codex/jobs/${encodeURIComponent(id)}/open-${target}`),
  proxy: () => request<{ enabled: boolean; changedAt: string | null }>("/api/proxy"),
  setProxy: (enabled: boolean) => post<{ enabled: boolean; changedAt: string | null }>("/api/proxy", { enabled }),
  setup: () => request<{ warnings: string[] }>("/api/setup"),
  usage: () => request<{ work: UsageSummary[]; quotas: { max: QuotaResult; codex: QuotaResult } }>("/api/usage?limit=30"),
};

/** 報告檔名與 Core 相同：<建立日期（本地）>-<短 id>.md。 */
export function reportNameFor(plan: Plan): string {
  const date = new Date(plan.createdAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${plan.id.slice(0, 8)}.md`;
}
