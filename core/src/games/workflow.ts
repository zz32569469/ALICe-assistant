// 專案卡的流程設定：有幾條進度線、各自的階段、舊名稱對照、負責的 session、角色頁的完成條件、加進提示的規則。
// 程式只內建一條通用流程；團隊自己的流程寫在本機的 JSON（alice.local.json 的 workflowFile，不進版控）。

import { existsSync, readFileSync } from "node:fs";

export type WorkflowTrack = {
  /** 識別字（任務的 track、區塊裡 stages 的 key），例：main。 */
  key: string;
  /** 顯示名稱，例：進度。 */
  label: string;
  /** 依序的階段；最後一個是「完成」。 */
  stages: string[];
  /** 舊名稱或簡寫 → 階段（ALICe 寫錯或流程改名時對得上）。 */
  aliases?: Record<string, string>;
  /** 負責這條線的同事 session：由上往下第一個符合的（pattern 是不分大小寫的正規表示式；fromStage 表示到這個階段以後才換它）。 */
  sessions?: Array<{ pattern: string; fromStage?: string }>;
  /** 完成條件來源：知識庫角色資料夾裡的角色頁檔名、表格所在的標題（預設「大階段」），與「階段 → 表格的 #」。 */
  guide?: { page: string; heading?: string; rows: Record<string, string> };
};

export type Workflow = {
  tracks: WorkflowTrack[];
  /** 任務的需求來源。 */
  taskSources: string[];
  /** 新專案的第一個版本號。 */
  firstVersion: string;
  /** 加進「專案管理」提示的規則（團隊流程的細節）。 */
  rules: string[];
  /** 開新專案時要一次問完的欄位（取代預設）。 */
  newProjectQuestions?: string;
  /** 開新專案建卡後的固定做法（例：預設要開的任務）。 */
  newProjectSteps?: string[];
  /** 會議段落的補充規則。 */
  meetingRules?: string[];
};

export const DEFAULT_WORKFLOW: Workflow = {
  tracks: [{ key: "main", label: "進度", stages: ["規劃", "進行中", "驗證", "完成"] }],
  taskSources: ["需求", "回饋", "其他"],
  firstVersion: "1.0.0",
  rules: [],
};

/** 任務可以指派給主人（例：要主人決定的事）。 */
export const OWNER_TRACK = "owner";
export const OWNER_LABEL = "主人";

let active: Workflow = DEFAULT_WORKFLOW;

export function workflow(): Workflow {
  return active;
}

/** Core 啟動時（或測試）換成本機的流程。 */
export function useWorkflow(next: Workflow): void {
  active = next;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "");

/** 檢查並補齊預設值；格式不對時丟出說明。 */
export function parseWorkflow(raw: unknown): Workflow {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("流程設定必須是 JSON 物件");
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.tracks) || value.tracks.length === 0) throw new Error("tracks 至少要有一條進度線");
  const keys = new Set<string>();
  const tracks = value.tracks.map((entry, index) => {
    const track = entry as Partial<WorkflowTrack>;
    if (typeof track.key !== "string" || !/^[a-z][a-z0-9_-]*$/u.test(track.key) || track.key === OWNER_TRACK) throw new Error(`tracks[${index}].key 要是小寫英文開頭的識別字，而且不能是 ${OWNER_TRACK}`);
    if (keys.has(track.key)) throw new Error(`tracks[${index}].key 重複：${track.key}`);
    keys.add(track.key);
    if (typeof track.label !== "string" || track.label.trim() === "") throw new Error(`tracks[${index}].label 不可空白`);
    if (!isStringArray(track.stages) || track.stages.length < 2) throw new Error(`tracks[${index}].stages 至少要兩個階段`);
    for (const target of Object.values(track.aliases ?? {})) {
      if (!track.stages.includes(target)) throw new Error(`tracks[${index}].aliases 指到不存在的階段：${target}`);
    }
    for (const rule of track.sessions ?? []) {
      new RegExp(rule.pattern, "iu");
      if (rule.fromStage !== undefined && !track.stages.includes(rule.fromStage)) throw new Error(`tracks[${index}].sessions 的 fromStage 不存在：${rule.fromStage}`);
    }
    return { ...track, key: track.key, label: track.label, stages: track.stages } as WorkflowTrack;
  });
  return {
    tracks,
    taskSources: isStringArray(value.taskSources) && value.taskSources.length > 0 ? value.taskSources : DEFAULT_WORKFLOW.taskSources,
    firstVersion: typeof value.firstVersion === "string" && /^\d+(\.\d+){1,3}$/u.test(value.firstVersion) ? value.firstVersion : DEFAULT_WORKFLOW.firstVersion,
    rules: isStringArray(value.rules) ? value.rules : [],
    ...(typeof value.newProjectQuestions === "string" ? { newProjectQuestions: value.newProjectQuestions } : {}),
    ...(isStringArray(value.newProjectSteps) ? { newProjectSteps: value.newProjectSteps } : {}),
    ...(isStringArray(value.meetingRules) ? { meetingRules: value.meetingRules } : {}),
  };
}

/** 讀本機流程檔；沒有設定就用內建的通用流程。回傳流程與（讀不到時的）警告。 */
export function loadWorkflow(path: string | null | undefined): { workflow: Workflow; warning?: string } {
  if (path == null || path === "") return { workflow: DEFAULT_WORKFLOW };
  if (!existsSync(path)) return { workflow: DEFAULT_WORKFLOW, warning: `找不到流程設定 ${path}，改用內建的通用流程` };
  try {
    return { workflow: parseWorkflow(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    return { workflow: DEFAULT_WORKFLOW, warning: `流程設定 ${path} 有錯（${error instanceof Error ? error.message : String(error)}），改用內建的通用流程` };
  }
}

export const trackOf = (key: string): WorkflowTrack | undefined => active.tracks.find((track) => track.key === key);
export const finalStage = (track: WorkflowTrack): string => track.stages[track.stages.length - 1]!;
export const taskTracks = (): string[] => [...active.tracks.map((track) => track.key), OWNER_TRACK];
export const trackLabel = (key: string): string => (key === OWNER_TRACK ? OWNER_LABEL : trackOf(key)?.label ?? key);

/** 一張卡在某條線的階段（還沒記過就是第一個階段）。 */
export function stageIn(trackStages: Record<string, string>, track: WorkflowTrack): string {
  const stage = trackStages[track.key];
  return stage !== undefined && track.stages.includes(stage) ? stage : track.stages[0]!;
}

/** 每條線都到最後一個階段＝目前版本結束。 */
export function allFinished(trackStages: Record<string, string>): boolean {
  return active.tracks.every((track) => stageIn(trackStages, track) === finalStage(track));
}

/** 每條線的第一個階段（新專案、開新版本的預設）。 */
export const firstStages = (): Record<string, string> => Object.fromEntries(active.tracks.map((track) => [track.key, track.stages[0]!]));

const normalizeStage = (value: string): string => value.replace(/[\s、，,／/]+/gu, "").toLowerCase();

/** 把 ALICe 寫的階段對到這條線的正式名稱（含舊名稱與簡寫）；對不上回傳 undefined。 */
export function resolveStage(track: WorkflowTrack, value: string): string | undefined {
  const wanted = normalizeStage(value);
  const alias = Object.entries(track.aliases ?? {}).find(([name]) => normalizeStage(name) === wanted)?.[1];
  const target = normalizeStage(alias ?? value);
  return track.stages.find((stage) => normalizeStage(stage) === target);
}
