<script setup lang="ts">
// 專案卡：每個專案的版本、各條進度線的階段、任務、截止日、最後動靜。建立與修改都在對話裡跟 ALICe 說。
import { computed, ref } from "vue";

import { store } from "../store";
import type { GameCard, TrackView } from "../types";

/** 進度線與階段從 Core 取得（/api/games 的 tracks，來自流程設定），不在這裡再寫一份。 */
type TrackKey = string;
const TRACKS = computed(() => store.tracks);
const finalOf = (track: TrackView): string => track.stages[track.stages.length - 1] ?? "";
const STALE_DAYS = 5;

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function daysUntil(deadline: string): number {
  const [year, month, day] = deadline.split("-").map(Number);
  return Math.round((new Date(year!, month! - 1, day!).getTime() - startOfDay(new Date())) / DAY_MS);
}

function shortDate(value: string): string {
  const [, month, day] = value.split("-").map(Number);
  return `${month}/${day}`;
}

const finished = (game: GameCard): boolean => TRACKS.value.length > 0 && TRACKS.value.every((track) => current(game, track.key) === finalOf(track));

function deadline(game: GameCard): { main: string; sub: string; level: "" | "is-warn" | "is-danger" | "is-none" } {
  if (game.deadline === null) return { main: "未定", sub: "截止日", level: "is-none" };
  if (finished(game)) return { main: shortDate(game.deadline), sub: "截止日", level: "" };
  const days = daysUntil(game.deadline);
  if (days < 0) return { main: `過 ${-days} 天`, sub: `截止 ${shortDate(game.deadline)}`, level: "is-danger" };
  if (days === 0) return { main: "今天", sub: `截止 ${shortDate(game.deadline)}`, level: "is-danger" };
  return { main: `剩 ${days} 天`, sub: `截止 ${shortDate(game.deadline)}`, level: days <= 3 ? "is-warn" : "" };
}

function idleDays(game: GameCard): number | undefined {
  return game.lastActivityAt === null ? undefined : Math.round((startOfDay(new Date()) - startOfDay(new Date(game.lastActivityAt))) / DAY_MS);
}

function idleText(game: GameCard): string {
  const days = idleDays(game);
  if (days === undefined) return "查不到";
  return days === 0 ? "今天" : `${days} 天前`;
}

function current(game: GameCard, key: TrackKey): string {
  const track = TRACKS.value.find((entry) => entry.key === key);
  const stage = game.trackStages?.[key];
  return stage !== undefined && track?.stages.includes(stage) ? stage : track?.stages[0] ?? "";
}

function stageIndex(game: GameCard, track: TrackView): number {
  return track.stages.indexOf(current(game, track.key));
}

const trackInfo = (game: GameCard, key: TrackKey) => game.tracks?.[key];

function stageSince(game: GameCard, key: TrackKey): string {
  const entry = [...game.stages].reverse().find((candidate) => (candidate.track ?? TRACKS.value[0]?.key) === key && candidate.stage === current(game, key));
  return entry === undefined ? "" : new Date(entry.at).toLocaleDateString([], { month: "numeric", day: "numeric" });
}

const TRACK_LABEL = computed<Record<string, string>>(() => ({ ...Object.fromEntries(TRACKS.value.map((track) => [track.key, track.label])), owner: "主人" }));
const STATUS_ORDER: Record<string, number> = { 卡住: 0, 進行中: 1, 待辦: 2, 完成: 3, 取消: 4 };
const STATUS_CLASS: Record<string, string> = { 卡住: "is-stuck", 進行中: "is-doing", 待辦: "is-todo", 完成: "is-done", 取消: "is-done" };

/** 未完成的任務：卡住的排最前面，再來進行中、待辦。 */
function openTasks(game: GameCard): GameCard["tasks"] {
  return (game.tasks ?? []).filter((task) => task.status !== "完成" && task.status !== "取消")
    .sort((left, right) => (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9) || left.number - right.number);
}

function doneCount(game: GameCard): number {
  return (game.tasks ?? []).filter((task) => task.status === "完成").length;
}

// §86 專案卡可以收合：收合時只留標題列和一行摘要。收合狀態記在這個瀏覽器（重新整理後保留）；
// 還沒設定過的卡片，已完成的預設收合、進行中的預設展開。
const COLLAPSE_KEY = "alice.games.collapsed";
function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}
const collapsedState = ref<Record<string, boolean>>(loadCollapsed());
function saveCollapsed(): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsedState.value));
  } catch {
    // 瀏覽器不允許儲存時，這次開著的期間仍有效。
  }
}
const isCollapsed = (game: GameCard): boolean => collapsedState.value[game.id] ?? finished(game);
function toggle(game: GameCard): void {
  collapsedState.value = { ...collapsedState.value, [game.id]: !isCollapsed(game) };
  saveCollapsed();
}
function setAll(collapsed: boolean): void {
  collapsedState.value = Object.fromEntries(store.games.map((game) => [game.id, collapsed]));
  saveCollapsed();
}
const allCollapsed = computed(() => store.games.length > 0 && store.games.every(isCollapsed));

/** 收合時的一行摘要：兩條線的階段與進度、未完成與卡住的任務數。 */
function summary(game: GameCard): string {
  if (finished(game)) return "兩條線都完成";
  const parts = TRACKS.value.map((track) => `${track.label} ${current(game, track.key)}（${stageIndex(game, track) + 1}／${track.stages.length}）`);
  const open = openTasks(game);
  const stuck = open.filter((task) => task.status === "卡住").length;
  if (open.length > 0) parts.push(`未完成 ${open.length}${stuck > 0 ? `，卡住 ${stuck}` : ""}`);
  return parts.join("・");
}

const sorted = computed(() => [...store.games].sort((left, right) => {
  const done = (game: GameCard) => (finished(game) ? 1 : 0);
  return done(left) - done(right) || (left.deadline ?? "9999").localeCompare(right.deadline ?? "9999");
}));
</script>

<template>
  <div class="games">
    <div v-if="store.games.length === 0" class="empty">
      <p><b>還沒有專案卡</b></p>
      <p class="muted">在對話裡跟 ALICe 說「開新專案 專案名稱」，她會問完需要的欄位再建立。</p>
    </div>
    <div v-if="store.games.length > 1" class="toolbar">
      <button class="link small" @click="setAll(!allCollapsed)">{{ allCollapsed ? "全部展開" : "全部收合" }}</button>
    </div>
    <article v-for="game in sorted" :key="game.id" class="card" :class="{ ended: finished(game), collapsed: isCollapsed(game) }">
      <header class="card-head" role="button" tabindex="0" :aria-expanded="!isCollapsed(game)" :title="isCollapsed(game) ? '展開' : '收合'" @click="toggle(game)" @keydown.enter.prevent="toggle(game)" @keydown.space.prevent="toggle(game)">
        <span class="chevron" aria-hidden="true">{{ isCollapsed(game) ? "▸" : "▾" }}</span>
        <div class="title">
          <h3>{{ game.name }}</h3>
          <span class="version" :class="{ done: finished(game) }">v{{ game.version }}{{ finished(game) ? " 完成" : "" }}</span>
          <span v-if="game.brand" class="code">{{ game.brand }}</span>
          <span v-if="game.code" class="code branch">{{ game.code }}</span>
        </div>
        <div class="deadline" :class="deadline(game).level">
          <span class="main num">{{ deadline(game).main }}</span>
          <span class="sub num">{{ deadline(game).sub }}</span>
        </div>
      </header>
      <p v-if="isCollapsed(game)" class="collapsed-summary small muted" @click="toggle(game)">{{ summary(game) }}</p>

      <template v-if="!isCollapsed(game)">
      <div v-for="track in TRACKS" :key="track.key" class="stage">
        <p class="stage-name">
          <span class="lane">{{ track.label }}</span>
          <b>{{ current(game, track.key) }}</b>
          <span class="muted small num">{{ stageIndex(game, track) + 1 }}／{{ track.stages.length }}<template v-if="stageSince(game, track.key)">，{{ stageSince(game, track.key) }} 開始</template></span>
        </p>
        <ol
          class="track"
          :style="{ gridTemplateColumns: `repeat(${track.stages.length}, 1fr)` }"
          :aria-label="`${track.label} 階段 ${stageIndex(game, track) + 1}／${track.stages.length}：${current(game, track.key)}`"
        >
          <li
            v-for="(stage, index) in track.stages"
            :key="stage"
            :class="{ done: index < stageIndex(game, track) || current(game, track.key) === finalOf(track), current: index === stageIndex(game, track) && current(game, track.key) !== finalOf(track) }"
            :title="stage"
          />
        </ol>
        <p v-if="trackInfo(game, track.key)?.guide?.criteria" class="next small"><span class="muted">完成條件：</span>{{ trackInfo(game, track.key)!.guide!.criteria }}</p>
        <p v-if="trackInfo(game, track.key)?.guide?.decisions" class="next small"><span class="muted">要你決定：</span>{{ trackInfo(game, track.key)!.guide!.decisions }}</p>
        <p v-if="stageIndex(game, track) >= 0 && stageIndex(game, track) < track.stages.length - 1" class="next muted small">
          下一步：{{ track.stages[stageIndex(game, track) + 1] }}<template v-if="trackInfo(game, track.key)?.owner">・負責 {{ trackInfo(game, track.key)!.owner }}</template>
        </p>
      </div>

      <section v-if="(game.tasks ?? []).length > 0" class="tasks">
        <p class="tasks-head small"><b>任務</b><span class="muted">未完成 {{ openTasks(game).length }}・已完成 {{ doneCount(game) }}</span></p>
        <ul>
          <li v-for="task in openTasks(game)" :key="task.number" :title="task.note || undefined">
            <span class="status small" :class="STATUS_CLASS[task.status]">{{ task.status }}</span>
            <span class="task-title">T{{ task.number }} {{ task.title }}</span>
            <span class="task-meta muted small">{{ TRACK_LABEL[task.track] ?? task.track }}<template v-if="task.source !== store.taskSources[0]">・{{ task.source }}</template><template v-if="task.version !== game.version">・v{{ task.version }}</template></span>
          </li>
        </ul>
        <p v-if="openTasks(game).length === 0" class="muted small">沒有未完成的任務。</p>
      </section>

      <dl class="meta small">
        <template v-if="game.versionReason">
          <dt>需求來源</dt>
          <dd>{{ game.versionReason }}</dd>
        </template>
        <dt>最後動靜</dt>
        <dd :class="{ stale: (idleDays(game) ?? 0) > STALE_DAYS && !finished(game) }">{{ idleText(game) }}</dd>
        <template v-if="game.sessions.length > 0">
          <dt>同事</dt>
          <dd>{{ game.sessions.join("、") }}</dd>
        </template>
        <template v-if="game.reference">
          <dt>參考資料</dt>
          <dd>{{ game.reference }}</dd>
        </template>
        <template v-if="game.note">
          <dt>備註</dt>
          <dd>{{ game.note }}</dd>
        </template>
      </dl>
      </template>
    </article>
    <p v-if="store.games.length > 0" class="muted small hint">每條線都到最後一個階段，這個版本就完成；之後有新需求再開新版本。按右上「更新進度」，ALICe 會依任務清單核對並更新卡片；要看詳細總覽，在對話裡問 ALICe「各專案現在怎樣」。</p>
  </div>
</template>

<style scoped>
.games { height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 14px; overflow-y: auto; }
.empty { margin: 32px 12px; text-align: center; }
.empty p { margin: 4px 0; }
.card { border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 14px 16px 12px; background: var(--panel); box-shadow: var(--card-shadow); }
.card.ended { opacity: 0.6; }
.card header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.card-head { cursor: pointer; user-select: none; }
.card-head:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 4px; }
.chevron { flex: none; width: 1em; color: var(--faint); line-height: 1.6; }
.card-head .title { flex: 1; }
.card.collapsed { padding-bottom: 10px; }
.collapsed-summary { margin: 6px 0 0 1.6em; cursor: pointer; overflow-wrap: anywhere; }
.toolbar { display: flex; justify-content: flex-end; margin: -4px 2px -6px; }
.title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
.title h3 { margin: 0; font-size: 1.12em; line-height: 1.3; }
.code { font-size: 0.82em; color: var(--faint); }
/* 分支代號固定放在名稱下一行的左邊（名稱短時不跟品牌擠在同一行）。 */
.code.branch { flex-basis: 100%; margin-top: -4px; }
.version { font-size: 0.78em; font-weight: 600; padding: 0 7px; border-radius: 999px; background: var(--sunken); color: var(--muted); font-variant-numeric: tabular-nums; }
.version.done { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }

/* 截止日：卡片上最醒目的資訊。 */
.deadline { display: flex; flex-direction: column; align-items: flex-end; line-height: 1.2; flex: none; }
.deadline .main { font-size: 1.05em; font-weight: 700; }
.deadline .sub { font-size: 0.76em; color: var(--muted); margin-top: 2px; }
.deadline.is-warn .main { color: var(--warn); }
.deadline.is-danger .main { color: var(--danger); }
.deadline.is-none .main { color: var(--faint); font-weight: 500; }

.stage { margin: 10px 0 0; }
.stage + .stage { margin-top: 12px; }
.track { display: grid; gap: 3px; list-style: none; padding: 0; margin: 5px 0 0; }
.track li { height: 6px; border-radius: 3px; background: var(--sunken); }
.track li.done { background: color-mix(in srgb, var(--ok) 55%, transparent); }
.track li.current { background: var(--accent); }
.stage-name { margin: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.lane { font-size: 0.78em; color: var(--faint); min-width: 4.2em; }
.next { margin: 3px 0 0; }

.tasks { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--border); }
.tasks-head { margin: 0 0 6px; display: flex; gap: 10px; align-items: baseline; }
.tasks ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.tasks li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: baseline; }
.task-title { overflow-wrap: anywhere; }
.task-meta { white-space: nowrap; }
.status { padding: 0 7px; border-radius: 999px; background: var(--sunken); color: var(--muted); white-space: nowrap; }
.status.is-stuck { background: var(--danger-bg); color: var(--danger); font-weight: 600; }
.status.is-doing { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.meta { display: grid; grid-template-columns: auto 1fr; gap: 3px 14px; margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--border); }
.meta dt { color: var(--faint); }
.meta dd { margin: 0; overflow-wrap: anywhere; }
.meta dd.stale { color: var(--danger); font-weight: 600; }
.hint { margin: 2px 4px; }
</style>
