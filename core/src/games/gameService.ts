// 專案卡服務（§30）：給提示、Web Studio、每日彙整與進度總覽用。

import { createHash } from "node:crypto";

import { isRunningJob, jobsForGame, type CodexJob } from "../codex/codexBoard.js";

import type { WorkerProjectConfig } from "../localConfig.js";
import type { EventHub } from "../protocol/eventHub.js";
import { applyParsedGameBlock, parseGameBlock } from "./gameBlock.js";
import { splitForConfirmation, type GameConfirmation, type GameConfirmationStore } from "./gameConfirmations.js";
import { isFinished, isOpenTask, stageSummary, type Game, type GameStageEntry, type GameStore, type GameTask } from "./gameStore.js";
import { finalStage, stageIn, trackLabel, workflow } from "./workflow.js";
import { LIST_PAST_DAYS, MeetingParseError, PROMPT_DAYS, daysFrom, dueReminder, meetingEnded, meetingLine, meetingStartAt, parseMeetingText, type Meeting, type MeetingStore } from "./meetings.js";
import { responsibleSession, type StageGuideEntry, type StageGuideLookup } from "./stageGuide.js";
import { collectProgress, daysBetween, deadlineText, formatProgress, gameActivity, type GameActivity } from "./progress.js";

const ACTIVITY_CACHE_MS = 60_000;
/** §65：進度資料列最近幾天、最多幾個 Codex 任務。 */
const CODEX_DAYS = 7;
const CODEX_LIMIT = 8;
/** 提示裡每個專案最多列幾個未完成任務（其餘只算數量）。 */
const PROMPT_TASK_LIMIT = 20;
/** 每日任務核對的時間（§46），與每日彙整同一小時。 */
const REVIEW_HOUR = 9;

/** 任務一行：T3〔進度・進行中・需求〕標題（v1.0.1）— 備註。 */
export function taskLine(task: GameTask, gameVersion: string): string {
  return `T${task.number}〔${trackLabel(task.track)}・${task.status}・${task.source}〕${task.title}${task.version === gameVersion ? "" : `（v${task.version}）`}${task.note === "" ? "" : `— ${task.note}`}`;
}

/** §72：每條線目前由哪個 session 負責、目前階段的判定與要主人決定的事（知識庫角色頁）。 */
export type TrackInfo = { owner: string | null; guide: StageGuideEntry | null };
export type GameCard = Game & { stages: GameStageEntry[]; tasks: GameTask[]; lastActivityAt: string | null; tracks: Record<string, TrackInfo> };

export class GameService {
  readonly #store: GameStore;
  readonly #projects: () => WorkerProjectConfig[];
  readonly #events: EventHub | undefined;
  readonly #codexJobs: () => CodexJob[];
  readonly #now: () => Date;
  readonly #guide: StageGuideLookup;
  readonly #meetings: MeetingStore | undefined;
  readonly #confirmations: GameConfirmationStore | undefined;
  readonly #onConfirmation: (confirmation: GameConfirmation) => void;
  readonly #activity = new Map<string, { at: number; value: GameActivity }>();

  constructor(options: { store: GameStore; projects: () => WorkerProjectConfig[]; events?: EventHub; now?: () => Date; codexJobs?: () => CodexJob[]; guide?: StageGuideLookup; meetings?: MeetingStore;
    /** §75：有這個才會把任務完成與換階段保留給主人確認；onConfirmation 在新增確認卡片時呼叫（跳通知）。 */
    confirmations?: GameConfirmationStore; onConfirmation?: (confirmation: GameConfirmation) => void }) {
    this.#confirmations = options.confirmations;
    this.#onConfirmation = options.onConfirmation ?? (() => {});
    this.#meetings = options.meetings;
    this.#guide = options.guide ?? (() => null);
    this.#store = options.store;
    this.#codexJobs = options.codexJobs ?? (() => []);
    this.#projects = options.projects;
    this.#events = options.events;
    this.#now = options.now ?? (() => new Date());
  }

  list(): Game[] {
    return this.#store.list();
  }

  /** 專案卡加上最後動靜（git 與檔案時間，快取 1 分鐘）。 */
  cards(): GameCard[] {
    return this.#store.list().map((game) => ({ ...game, stages: this.#store.stages(game.id), tasks: this.#store.tasks(game.id), lastActivityAt: this.#activityOf(game).lastActivityAt, tracks: this.#tracks(game) }));
  }

  knownRepos(): string[] {
    return this.#projects().map((project) => project.name);
  }

  applyBlock(blockText: string): string {
    let block;
    try {
      block = parseGameBlock(blockText);
    } catch (error) {
      return `專案卡未更新：${error instanceof Error ? error.message : String(error)}`;
    }
    // §75：任務完成與換階段先保留，等主人確認。
    const game = this.#store.find(block.name);
    const split = this.#confirmations === undefined
      ? { direct: block, held: null, lines: [] as string[] }
      : splitForConfirmation(block, game, game === undefined ? [] : this.#store.tasks(game.id));
    const parts: string[] = [];
    if (split.direct !== null) {
      parts.push(applyParsedGameBlock(this.#store, split.direct, this.knownRepos(), this.#now()));
      this.#activity.clear();
      this.#events?.broadcast("games.updated", { games: this.cards() });
    }
    if (split.held !== null) {
      const confirmation = this.#confirmations!.add(split.held, split.lines, this.#now().toISOString());
      this.#events?.broadcast("game.confirmation.created", { confirmation });
      this.#onConfirmation(confirmation);
      parts.push(`${split.held.name}：等主人確認後才更新\n- ${split.lines.join("\n- ")}`);
    }
    return parts.join("\n\n");
  }

  /** §75：等主人確認的進度變更。 */
  pendingConfirmations(): GameConfirmation[] {
    return this.#confirmations?.pending() ?? [];
  }

  /** §75：主人確認或不要。回傳給對話的系統訊息；找不到或已處理回傳 undefined。 */
  resolveConfirmation(id: string, decision: "approve" | "reject"): string | undefined {
    const pending = this.#confirmations?.pendingBlock(id);
    if (pending === undefined) return undefined;
    this.#confirmations!.resolve(id, decision, this.#now().toISOString());
    this.#events?.broadcast("game.confirmation.resolved", { id });
    const list = pending.confirmation.lines.join("、");
    if (decision === "reject") return `主人沒有確認，${pending.confirmation.gameName}維持原狀：${list}`;
    const result = applyParsedGameBlock(this.#store, pending.block, this.knownRepos(), this.#now());
    this.#activity.clear();
    this.#events?.broadcast("games.updated", { games: this.cards() });
    return `主人確認了：${list}\n${result}`;
  }

  /** 進度資料：names 空白時是所有目前版本還沒完成的專案。回傳給艾莉絲整理的文字與找不到的名稱。 */
  progress(names: string[]): { text: string; missing: string[]; games: string[] } {
    const missing: string[] = [];
    let games: Game[];
    if (names.length === 0) games = this.#store.list().filter((game) => !isFinished(game));
    else {
      games = [];
      for (const name of names) {
        const game = this.#store.find(name);
        if (game === undefined) missing.push(name);
        else if (!games.some((entry) => entry.id === game.id)) games.push(game);
      }
    }
    const now = this.#now();
    const text = games.map((game) => formatProgress(collectProgress(game, this.#projects()), now, this.#store.tasks(game.id), this.#recentCodex(game, now), this.#stageLines(game))).join("\n\n");
    return { text, missing, games: games.map((game) => game.name) };
  }

  /** 提示裡的專案卡清單（每次對話都帶，所以只放一行摘要）。 */
  promptLines(): string[] {
    const now = this.#now();
    return this.#store.list().map((game) => {
      const activity = this.#activityOf(game).lastActivityAt;
      const idle = activity === null ? "最後動靜查不到" : `最後動靜 ${daysBetween(new Date(activity), now)} 天前`;
      const extras = [
        game.brand === "" ? "" : `品牌 ${game.brand}`,
        game.reference === "" ? "" : `參考資料 ${game.reference}`,
        game.sessions.length === 0 ? "" : `同事 ${game.sessions.join("、")}`,
        game.note === "" ? "" : `備註：${game.note}`,
      ].filter(Boolean);
      const head = `- ${game.name}${game.code === "" ? "" : `（${game.code}）`}：${stageSummary(game)}；${deadlineText(game.deadline, now)}；${idle}${extras.length === 0 ? "" : `；${extras.join("；")}`}`;
      const tasks = this.#store.tasks(game.id);
      const open = tasks.filter(isOpenTask);
      const done = tasks.length - open.length;
      const taskLines = open.slice(0, PROMPT_TASK_LIMIT).map((task) => `  - ${taskLine(task, game.version)}`);
      if (open.length > PROMPT_TASK_LIMIT) taskLines.push(`  - …還有 ${open.length - PROMPT_TASK_LIMIT} 個未完成任務`);
      const summary = tasks.length === 0 ? "  - （還沒有任務）" : `  - 已完成或取消 ${done} 個任務`;
      return [head, ...taskLines, summary].join("\n");
    });
  }

  /** §73：Studio 會議分頁的清單（過去 14 天起）。 */
  meetings(): Meeting[] {
    return this.#meetings?.since(daysFrom(this.#now(), -LIST_PAST_DAYS)) ?? [];
  }

  /** §73：照一行文字登記會議；專案名稱對得上專案卡（中文名或英文代號）就換成卡片名稱。 */
  addMeeting(text: string): Meeting {
    if (this.#meetings === undefined) throw new Error("會議功能沒有開");
    const fields = parseMeetingText(text, this.#now());
    const game = fields.game === "" ? undefined : this.#store.find(fields.game)
      ?? this.#store.list().find((entry) => entry.code !== "" && entry.code.toLowerCase() === fields.game.toLowerCase());
    const meeting = this.#meetings.add({ ...fields, game: game?.name ?? fields.game });
    this.#broadcastMeetings();
    return meeting;
  }

  removeMeeting(id: string): boolean {
    const removed = this.#meetings?.remove(id) ?? false;
    if (removed) this.#broadcastMeetings();
    return removed;
  }

  /** §73：提示裡的近期會議（今天起 7 天內、還沒結束的）。 */
  meetingLines(): string[] | undefined {
    if (this.#meetings === undefined) return undefined;
    const now = this.#now();
    return this.#meetings.since(daysFrom(now, 0))
      .filter((meeting) => meeting.date <= daysFrom(now, PROMPT_DAYS) && !meetingEnded(meeting, now))
      .map((meeting) => `- ${meetingLine(meeting)}（id ${meeting.id.slice(0, 8)}）`);
  }

  /** §74：ALICE_MEETING 區塊：{"add":"一行會議"} 或 {"remove":"短 id"}。回傳給主人看的系統訊息。 */
  applyMeetingBlock(blockText: string, markers: { start: string; end: string }): string {
    if (this.#meetings === undefined) return "會議功能沒有開，沒有登記。";
    let body: unknown;
    try {
      body = JSON.parse(blockText.replace(markers.start, "").replace(markers.end, "").trim());
    } catch {
      return "會議區塊不是 JSON，沒有登記。";
    }
    const value = typeof body === "object" && body !== null ? body as { add?: unknown; remove?: unknown } : {};
    if (typeof value.add === "string") {
      try {
        return `已新增會議：${meetingLine(this.addMeeting(value.add))}`;
      } catch (error) {
        return `會議沒有登記：${error instanceof MeetingParseError ? error.message : String(error)}`;
      }
    }
    if (typeof value.remove === "string" && value.remove.trim().length >= 4) {
      const prefix = value.remove.trim().toLowerCase();
      const matches = this.#meetings.since(daysFrom(this.#now(), -LIST_PAST_DAYS)).filter((meeting) => meeting.id.startsWith(prefix));
      if (matches.length !== 1) return `會議沒有刪除：${matches.length === 0 ? "找不到" : "對到不只一個"} id ${prefix}`;
      this.removeMeeting(matches[0]!.id);
      return `已刪除會議：${meetingLine(matches[0]!)}`;
    }
    return "會議區塊要寫 add（一行會議）或 remove（id），沒有登記。";
  }

  /** §74：現在該提醒的會議（會議前 30、10 分鐘，REMINDER_MINUTES），並記下已提醒。 */
  meetingReminders(): Array<{ meeting: Meeting; minutes: number; text: string }> {
    if (this.#meetings === undefined) return [];
    const now = this.#now();
    const due: Array<{ meeting: Meeting; minutes: number; text: string }> = [];
    for (const meeting of this.#meetings.since(daysFrom(now, 0))) {
      const mark = dueReminder(meeting, now);
      if (mark === null) continue;
      this.#meetings.markReminded(meeting.id, [...meeting.reminded, mark]);
      const minutes = Math.max(1, Math.round((meetingStartAt(meeting) - now.getTime()) / 60_000));
      due.push({ meeting, minutes, text: `${minutes} 分鐘後開會：${meetingLine(meeting)}` });
    }
    return due;
  }

  #broadcastMeetings(): void {
    this.#events?.broadcast("meetings.updated", { meetings: this.meetings() });
  }

  /** §46：每天 9 點後第一次檢查時回傳 true（一天一次，Core 晚開機也會補）；沒有進行中的專案就不核對。 */
  reviewDue(now = this.#now()): boolean {
    if (now.getHours() < REVIEW_HOUR) return false;
    const pad = (value: number) => String(value).padStart(2, "0");
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    if (this.#store.getMeta("review.date") === today) return false;
    this.#store.setMeta("review.date", today);
    return this.#store.list().some((game) => !isFinished(game));
  }

  /**
   * §57：每日核對的資料和上次核對時比，有沒有變。比的是未完成專案的進度資料（卡片、更改紀錄段落、分支與未提交狀態），
   * 不含任務清單（那是艾莉絲核對的結果）和相對時間（「N 天前」每天都會變）。有變就記下新指紋。
   */
  reviewInputChanged(): boolean {
    const fixedNow = new Date(0);
    const text = this.#store.list().filter((game) => !isFinished(game))
      .map((game) => formatProgress(collectProgress(game, this.#projects()), fixedNow, [], this.#recentCodex(game, this.#now()), this.#stageLines(game)))
      .join("\n\n");
    const fingerprint = createHash("sha256").update(text).digest("hex");
    if (this.#store.getMeta("review.fingerprint") === fingerprint) return false;
    this.#store.setMeta("review.fingerprint", fingerprint);
    return true;
  }

  #tracks(game: Game): Record<string, TrackInfo> {
    return Object.fromEntries(workflow().tracks.map((track) => {
      const stage = stageIn(game.trackStages, track);
      const done = stage === finalStage(track);
      return [track.key, { owner: done ? null : responsibleSession(game.sessions, track.key, stage), guide: done ? null : this.#guide(track.key, stage) }];
    }));
  }

  /** §72：進度資料裡每條線一行「負責、完成條件、要主人決定的事」。 */
  #stageLines(game: Game): string[] {
    if (isFinished(game)) return [];
    const tracks = this.#tracks(game);
    return workflow().tracks.flatMap((track) => {
      const stage = stageIn(game.trackStages, track);
      if (stage === finalStage(track)) return [];
      const { owner, guide } = tracks[track.key]!;
      const parts = [
        `負責 ${owner ?? "（專案卡 sessions 沒有對應的 session）"}`,
        guide?.criteria ? `完成條件：${guide.criteria}` : "",
        guide?.decisions ? `要主人決定：${guide.decisions}` : "",
      ].filter(Boolean);
      return [`- ${track.label}「${stage}」：${parts.join("；")}`];
    });
  }

  /** §65：這個專案最近的 Codex 任務：執行中的全部，加上 7 天內結束的，最多 8 個。 */
  #recentCodex(game: Game, now: Date): CodexJob[] {
    const since = now.getTime() - CODEX_DAYS * 86_400_000;
    return jobsForGame(this.#codexJobs(), game)
      .filter((job) => isRunningJob(job) || new Date(job.completedAt ?? job.startedAt ?? 0).getTime() >= since)
      .slice(0, CODEX_LIMIT);
  }

  #activityOf(game: Game): GameActivity {
    const cached = this.#activity.get(game.id);
    if (cached !== undefined && Date.now() - cached.at < ACTIVITY_CACHE_MS) return cached.value;
    const value = gameActivity(game, this.#projects());
    this.#activity.set(game.id, { at: Date.now(), value });
    return value;
  }
}

export function parseProgressBlock(blockText: string, markers: { start: string; end: string }): string[] {
  const body = blockText.replace(markers.start, "").replace(markers.end, "").trim();
  if (body === "") return [];
  const parsed: unknown = JSON.parse(body);
  const games = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { games?: unknown }).games : undefined;
  if (games === undefined) return [];
  if (!Array.isArray(games) || !games.every((entry) => typeof entry === "string")) throw new Error("games 必須是字串陣列");
  return games.map((entry: string) => entry.trim()).filter(Boolean);
}
