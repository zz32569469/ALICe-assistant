// 與 Alice Core 相同的資料形狀（只列網頁用到的欄位）。

export type Message = {
  id: string;
  seq: number;
  role: "user" | "alice" | "system";
  text: string;
  clientId?: string;
  mode?: "work" | "chat";
  /** §78 對話分頁：沒有＝工作，"chat"＝聊天。 */
  thread?: "chat";
  /** §83 附的截圖（Core data/uploads 裡的檔名）。 */
  images?: string[];
  createdAt: string;
};

export type CharacterState = {
  activity: string;
  energy: string;
  sleepReason?: string;
  [key: string]: unknown;
};

export type PlanStatus =
  | "pending_approval" | "queued" | "running" | "paused" | "completed" | "cancelled" | "rejected" | "expired" | "failed";

export type Plan = {
  id: string;
  goal: string;
  status: PlanStatus;
  risks: string[];
  decisions: string[];
  preauthorizeClaudeFallback: boolean;
  pauseReason: string | null;
  pauseDetail: string | null;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  endedAt: string | null;
};

export type PlanItem = {
  id: string;
  planId: string;
  seq: number;
  key: string;
  title: string;
  kind: "read" | "modify" | "review" | "session";
  project: string;
  role: string | null;
  instructions: string;
  acceptance: string[];
  dependsOn: string[];
  risk: "normal" | "high";
  estimateMin: number | null;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  attempts: number;
  executor: string | null;
  result: unknown;
  error: string | null;
  reviewOf: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export type PlanView = { plan: Plan; items: PlanItem[] };

export type Task = {
  id: string;
  planId: string | null;
  tool: string;
  repo: string;
  repoPath: string;
  goal: string;
  acceptance: string[];
  estimateMin: number | null;
  status: string;
  createdAt: string;
};

export type Channel = {
  id: string;
  title: string;
  project: string;
  role: string;
  status: "open" | "running" | "closed" | "failed" | string;
  rounds: number;
  createdAt: string;
  updatedAt: string;
};

export type ChannelMessage = {
  id: string;
  channelId: string;
  seq: number;
  author: "alice" | "worker" | "owner" | "system" | string;
  text: string;
  createdAt: string;
};

export type ReportEntry = { kind: "report" | "writeback"; name: string; size: number; modifiedAt: string };

export type QuotaWindow = { usedPercent: number; resets: string };
export type QuotaResult =
  | { status: "ok"; currentSession?: QuotaWindow; currentWeek?: QuotaWindow; primary?: QuotaWindow; secondary?: QuotaWindow }
  | { status: "error"; message: string; reason: string };

export type UsageSummary = {
  kind: string;
  refType: string;
  refId: string;
  title: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  durationMs: number;
  attempts: number;
  time: string;
};

/** 任務確認卡（來自 permission.request 事件或載入時的等待確認任務）。 */
export type TaskConfirmation = {
  kind: "task";
  id: string;
  repo: string;
  repoPath: string;
  goal: string;
  acceptance: string[];
  estimateMin: number | null;
  expiresAt?: string;
  dirtyFiles?: string[];
};

export type PlanConfirmation = { kind: "plan"; id: string; view: PlanView; expiresAt?: string };

/** §75 進度確認：同事回報做完時，任務完成與換階段等主人確認。 */
export type GameConfirmation = { kind: "game"; id: string; gameName: string; lines: string[]; reason: string; createdAt: string; expiresAt?: string };
export type Confirmation = TaskConfirmation | PlanConfirmation | GameConfirmation;

/** 專案卡：每條進度線目前的階段（線與階段由 Core 的流程設定決定）、版本、任務。 */
export type GameCard = {
  id: string;
  name: string;
  code: string;
  brand: string;
  docsDir: string | null;
  filePrefix: string;
  spec: string;
  reference: string;
  deadline: string | null;
  /** 每條線目前的階段（key 是線的 key）。 */
  trackStages: Record<string, string>;
  version: string;
  versionReason: string;
  repos: string[];
  sessions: string[];
  note: string;
  /** §93：凍結的時間（null＝沒凍結）與原因。 */
  frozenAt?: string | null;
  frozenReason?: string;
  stages: Array<{ track: string; stage: string; at: string }>;
  /** §46 任務清單。 */
  tasks: Array<{ number: number; title: string; track: string; status: string; source: string; version: string; note: string; updatedAt: string }>;
  lastActivityAt: string | null;
  updatedAt: string;
  /** §72：每條線目前負責的 session、目前階段的完成條件與要主人決定的事（知識庫角色頁）。 */
  tracks?: Record<string, { owner: string | null; guide: { criteria: string | null; decisions: string | null } | null }>;
};

/** §73 重要會議（日期 YYYY-MM-DD、時間 HH:MM；end 為 null 表示沒寫結束時間）。 */
export type Meeting = { id: string; game: string; date: string; start: string; end: string | null; title: string; createdAt: string };

/** §77 塔羅占卜。 */
export type FortuneKind = "short" | "long";
export type TarotCard = { name: string; reversed: boolean; position: string };
export type Fortune = { id: string; kind: FortuneKind; period: string; cards: TarotCard[]; text: string; createdAt: string };
export type FortuneSlot = { latest: Fortune | null; done: boolean; nextAt: string; generating: boolean };

/** 進度線（Core 的流程設定）。 */
export type TrackView = { key: string; label: string; stages: string[] };

export type EventEnvelope = { v: number; type: string; seq: number; ts: string; data: Record<string, unknown> };

/** §65 Codex 任務看板（Core 轉接本機看板伺服器）。 */
export type CodexJobSummary = {
  id: string;
  label: string;
  repo: string;
  status: string;
  rawStatus?: string;
  phase?: string;
  lastEventAt?: string | null;
  lastEvent?: { kind: string; text: string } | null;
  counts?: { cmd: number; cmdFail: number; edits: number; msgs: number };
  tokens?: {
    input: number; uncached: number; output: number; reasoning: number; ctx: number; ctxWindow: number; resumed?: boolean;
    primary?: [number | null, number | null]; weekly?: [number | null, number | null];
  } | null;
  write?: boolean;
  startedAt?: string;
  completedAt?: string | null;
  durationMin?: number;
  failReason?: string;
  by?: { role?: string; session?: string; cwd?: string } | null;
  lastMsg?: string;
  hasSnapshot?: boolean;
};

export type CodexJobDetail = CodexJobSummary & {
  prompt?: string;
  events: Array<{ t: string; kind: string; text: string; exit?: number }>;
  finalOutput: string;
  touchedFiles: string[];
};

export type CodexQuota = {
  at?: string;
  primary?: { used_percent: number; window_minutes?: number; resets_at?: number };
  secondary?: { used_percent: number; window_minutes?: number; resets_at?: number };
};
