<script setup lang="ts">
// §73 重要會議：一行登記（專案名稱 - 10/08 1500 ~ 1530 api 前端會議），依時間排序；ALICE 會從提示知道近期的會議。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { api } from "../api";
import { meetingEnd, meetingStart, store } from "../store";
import type { Meeting } from "../types";

const text = ref("");
const error = ref("");
const busy = ref(false);
const now = ref(Date.now());
let timer: number | undefined;

onMounted(() => {
  timer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const upcoming = computed(() => store.meetings.filter((meeting) => meetingEnd(meeting) > now.value));
const past = computed(() => store.meetings.filter((meeting) => meetingEnd(meeting) <= now.value).reverse());

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function dateText(meeting: Meeting): string {
  const date = new Date(meetingStart(meeting));
  return `${date.getMonth() + 1}/${date.getDate()}（${WEEKDAYS[date.getDay()]}）`;
}

/** 進行中、N 分鐘後、今天、明天、N 天後。 */
function when(meeting: Meeting): { text: string; level: "" | "is-now" | "is-soon" } {
  const start = meetingStart(meeting);
  if (start <= now.value) return { text: "進行中", level: "is-now" };
  const minutes = Math.ceil((start - now.value) / 60_000);
  if (minutes <= 60) return { text: `${minutes} 分鐘後`, level: "is-soon" };
  const day = (value: number) => { const date = new Date(value); return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(); };
  const days = Math.round((day(start) - day(now.value)) / 86_400_000);
  if (days === 0) return { text: "今天", level: "is-soon" };
  if (days === 1) return { text: "明天", level: "" };
  return { text: `${days} 天後`, level: "" };
}

async function add(): Promise<void> {
  if (text.value.trim() === "" || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await api.addMeeting(text.value);
    text.value = "";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

async function remove(meeting: Meeting): Promise<void> {
  if (!window.confirm(`刪除「${meeting.game === "" ? "" : `${meeting.game} - `}${dateText(meeting)} ${meeting.title}」？`)) return;
  try {
    await api.removeMeeting(meeting.id);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}
</script>

<template>
  <div class="meetings">
    <form class="add" @submit.prevent="add">
      <input
        v-model="text" list="meeting-games" :disabled="busy"
        placeholder="專案名稱 - 10/08 1500 ~ 1530 api 前端會議" aria-label="新增會議"
      />
      <datalist id="meeting-games">
        <option v-for="game in store.games" :key="game.id" :value="`${game.name} - `" />
      </datalist>
      <button class="primary small" type="submit" :disabled="busy || text.trim() === ''">新增</button>
    </form>
    <p v-if="error" class="error small">{{ error }}</p>
    <p v-else class="muted small hint">格式：專案名稱 - 月/日 開始 ~ 結束 主題（專案名稱、結束時間可省略；時間寫 1500 或 15:00）。ALICe 會知道 7 天內的會議，會議當天或前一天問進度時，會列出要帶去會議的事。</p>

    <div v-if="upcoming.length === 0" class="empty muted">沒有即將到來的會議。</div>
    <ul v-else class="list">
      <li v-for="meeting in upcoming" :key="meeting.id" class="item" :class="when(meeting).level">
        <div class="time">
          <span class="date num">{{ dateText(meeting) }}</span>
          <span class="clock num">{{ meeting.start }}<template v-if="meeting.end">～{{ meeting.end }}</template></span>
        </div>
        <div class="body">
          <span v-if="meeting.game" class="game">{{ meeting.game }}</span>
          <span class="title">{{ meeting.title }}</span>
        </div>
        <span class="when small" :class="when(meeting).level">{{ when(meeting).text }}</span>
        <button class="small ghost" title="刪除這個會議" @click="remove(meeting)">刪除</button>
      </li>
    </ul>

    <details v-if="past.length > 0" class="past">
      <summary class="muted small">已結束（近 14 天，{{ past.length }} 個）</summary>
      <ul class="list">
        <li v-for="meeting in past" :key="meeting.id" class="item ended">
          <div class="time">
            <span class="date num">{{ dateText(meeting) }}</span>
            <span class="clock num">{{ meeting.start }}<template v-if="meeting.end">～{{ meeting.end }}</template></span>
          </div>
          <div class="body">
            <span v-if="meeting.game" class="game">{{ meeting.game }}</span>
            <span class="title">{{ meeting.title }}</span>
          </div>
          <span />
          <button class="small ghost" title="刪除這個會議" @click="remove(meeting)">刪除</button>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.meetings { height: 100%; display: flex; flex-direction: column; gap: 10px; padding: 14px; overflow-y: auto; }
.add { display: flex; gap: 8px; }
.add input { flex: 1; min-width: 0; }
.hint { margin: 0 2px; }
.empty { margin: 24px 0; text-align: center; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.item { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 12px; align-items: center; padding: 10px 14px; border: var(--bw) solid var(--border); border-radius: var(--radius-lg); background: var(--panel); box-shadow: var(--card-shadow); }
.item.is-now { border-color: var(--accent); }
.item.ended { opacity: 0.6; box-shadow: none; }
.time { display: flex; flex-direction: column; line-height: 1.25; min-width: 6.5em; }
.date { font-size: 0.82em; color: var(--muted); }
.clock { font-weight: 700; }
.body { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.game { font-size: 0.8em; color: var(--faint); overflow-wrap: anywhere; }
.title { overflow-wrap: anywhere; }
.when { padding: 0 8px; border-radius: 999px; background: var(--sunken); color: var(--muted); white-space: nowrap; }
.when.is-soon { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.when.is-now { background: var(--accent); color: var(--on-accent, #fff); font-weight: 600; }
.past summary { cursor: pointer; margin: 6px 2px; }
.past .list { margin-top: 6px; }
@media (max-width: 520px) {
  .item { grid-template-columns: auto minmax(0, 1fr) auto; }
  .item .when { grid-column: 2; justify-self: start; }
}
</style>
