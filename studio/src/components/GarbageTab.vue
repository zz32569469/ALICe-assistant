<script setup lang="ts">
// §97 垃圾車、回收車：今天要收的（可以略過今天）、這週一覽、固定時間的設定。
// 到了提醒時間 Core 會跳桌面通知，並在聊天分頁留一則訊息。
// §98：可以輸入地址查附近的清運點（新北市開放資料，地址只在本機比對），一鍵把時間加進提醒。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { api } from "../api";
import type { GarbageEntry, GarbageKind, GarbageView, StopResult, StopSchedule, StopSearch } from "../types";

const view = ref<GarbageView | null>(null);
const draft = ref<GarbageEntry[]>([]);
const dirty = ref(false);
const saving = ref(false);
const error = ref("");
const savedNote = ref("");
const now = ref(Date.now());

const KIND_LABEL: Record<GarbageKind, string> = { garbage: "一般垃圾", recycle: "資源回收", other: "其他" };
const KIND_ICON: Record<GarbageKind, string> = { garbage: "🗑️", recycle: "♻️", other: "🥬" };
/** 週一排第一個。 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
const MARKS = [30, 15, 10, 5];

function apply(result: GarbageView): void {
  view.value = result;
  if (!dirty.value) draft.value = result.entries.map((entry) => ({ ...entry, weekdays: [...entry.weekdays], before: [...entry.before] }));
}

async function load(): Promise<void> {
  try {
    apply(await api.garbage());
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const byId = computed(() => new Map((view.value?.entries ?? []).map((entry) => [entry.id, entry])));

/** 今天要收的，依時間排序；同一時間的放在一起。 */
const today = computed(() => (view.value?.today ?? [])
  .map((item) => ({ ...item, entry: byId.value.get(item.id)! }))
  .filter((item) => item.entry !== undefined));

function countdown(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(now.value);
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour!, minute!).getTime();
  const minutes = Math.round((target - now.value) / 60_000);
  if (minutes <= 0) return "已經過了";
  if (minutes < 60) return `${minutes} 分鐘後`;
  return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分後`;
}

async function toggleSkip(id: string, skip: boolean): Promise<void> {
  error.value = "";
  try {
    apply(await api.skipGarbage(id, skip));
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

function dayName(date: string, index: number): string {
  if (index === 0) return "今天";
  if (index === 1) return "明天";
  const [year, month, day] = date.split("-").map(Number);
  return `週${WEEKDAY[new Date(year!, month! - 1, day!).getDay()]}`;
}

function add(kind: GarbageKind): void {
  draft.value.push({ id: `new-${Date.now()}-${draft.value.length}`, label: KIND_LABEL[kind], kind, weekdays: [], time: "19:30", before: [15, 5], place: "", enabled: true });
  dirty.value = true;
}
function remove(index: number): void {
  draft.value.splice(index, 1);
  dirty.value = true;
}
function toggleDay(entry: GarbageEntry, day: number): void {
  entry.weekdays = entry.weekdays.includes(day) ? entry.weekdays.filter((value) => value !== day) : [...entry.weekdays, day];
  dirty.value = true;
}
function toggleMark(entry: GarbageEntry, mark: number): void {
  entry.before = entry.before.includes(mark) ? entry.before.filter((value) => value !== mark) : [...entry.before, mark];
  dirty.value = true;
}
function changeKind(entry: GarbageEntry, kind: GarbageKind): void {
  if (Object.values(KIND_LABEL).includes(entry.label)) entry.label = KIND_LABEL[kind];
  entry.kind = kind;
  dirty.value = true;
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = "";
  savedNote.value = "";
  try {
    // 新增的 id 讓 Core 自己產生。
    const result = await api.saveGarbage(draft.value.map((entry) => (entry.id.startsWith("new-") ? { ...entry, id: "" } : entry)));
    dirty.value = false;
    apply(result);
    savedNote.value = "已儲存";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    saving.value = false;
  }
}

// §98 查附近的清運點。地址只存在這個瀏覽器，方便下次再查。
const QUERY_KEY = "alice.garbage.query";
const stopQuery = ref(readQuery());
const stopResult = ref<StopSearch | null>(null);
const stopSearching = ref(false);
const stopError = ref("");
const addedNote = ref("");
function readQuery(): string {
  try {
    return window.localStorage.getItem(QUERY_KEY) ?? "";
  } catch {
    return "";
  }
}

async function searchStops(): Promise<void> {
  if (stopQuery.value.trim() === "") return;
  stopSearching.value = true;
  stopError.value = "";
  addedNote.value = "";
  try {
    window.localStorage.setItem(QUERY_KEY, stopQuery.value.trim());
  } catch {
    // 不能存就算了。
  }
  try {
    stopResult.value = await api.garbageStops(stopQuery.value.trim());
  } catch (caught) {
    stopError.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    stopSearching.value = false;
  }
}

const dayList = (days: number[]): string => (days.length === 0 ? "—" : WEEK_ORDER.filter((day) => days.includes(day)).map((day) => WEEKDAY[day]).join(""));

/** 把某個點的某個時段加進提醒：一般垃圾、資源回收、廚餘各一筆（同種類、同時間、同地點的就合併星期），然後直接儲存。 */
async function useSchedule(stop: StopResult, schedule: StopSchedule): Promise<void> {
  const kinds: Array<{ kind: GarbageKind; label: string; days: number[] }> = [
    { kind: "garbage", label: "一般垃圾", days: schedule.garbage },
    { kind: "recycle", label: "資源回收", days: schedule.recycle },
    { kind: "other", label: "廚餘", days: schedule.food },
  ];
  const added: string[] = [];
  for (const { kind, label, days } of kinds) {
    if (days.length === 0) continue;
    const same = draft.value.find((entry) => entry.kind === kind && entry.time === schedule.time && entry.place === stop.name);
    if (same !== undefined) same.weekdays = [...new Set([...same.weekdays, ...days])];
    else draft.value.push({ id: `new-${Date.now()}-${draft.value.length}`, label, kind, weekdays: [...days], time: schedule.time, before: [15, 5], place: stop.name, enabled: true });
    added.push(`${label}（${dayList(days)}）`);
  }
  if (added.length === 0) return;
  dirty.value = true;
  await save();
  if (!dirty.value) addedNote.value = `已加入 ${schedule.time} ${stop.name}：${added.join("、")}`;
}

function discard(): void {
  dirty.value = false;
  if (view.value !== null) apply(view.value);
}
</script>

<template>
  <div class="garbage">
    <p v-if="error" class="error small">{{ error }}</p>

    <section v-if="view" class="today">
      <h4>今天</h4>
      <p v-if="today.length === 0" class="muted small">今天沒有設定的收運。</p>
      <ul v-else>
        <li v-for="item in today" :key="item.id" :class="{ skipped: item.skipped, passed: item.passed }">
          <span class="icon" aria-hidden="true">{{ KIND_ICON[item.entry.kind] }}</span>
          <b class="num">{{ item.entry.time }}</b>
          <span>{{ item.entry.label }}<span v-if="item.entry.place" class="muted small">・{{ item.entry.place }}</span></span>
          <span class="when small" :class="{ muted: item.passed || item.skipped }">{{ item.skipped ? "今天略過" : countdown(item.entry.time) }}</span>
          <button v-if="!item.passed" class="link small" @click="toggleSkip(item.id, !item.skipped)">{{ item.skipped ? "取消略過" : "今天略過" }}</button>
        </li>
      </ul>
    </section>

    <section v-if="view && view.entries.length > 0">
      <h4>這週</h4>
      <ol class="week">
        <li v-for="(day, index) in view.week" :key="day.date" :class="{ empty: day.items.length === 0 }">
          <span class="day small">{{ dayName(day.date, index) }}</span>
          <span v-for="item in day.items" :key="item.id" class="chip small" :class="[item.kind, { skipped: item.skipped }]" :title="`${item.time} ${item.label}`">{{ KIND_ICON[item.kind] }} {{ item.time }}</span>
          <span v-if="day.items.length === 0" class="muted small">—</span>
        </li>
      </ol>
    </section>

    <section class="stops">
      <h4>查附近的垃圾車（新北市）</h4>
      <p class="muted small">輸入地址（例如「板橋區文化路一段」），會列出同一條路、同一巷附近的清運點和時間。第一次查詢要下載新北市的路線資料（約 20 秒），之後一週更新一次；地址只在這台電腦比對，不會送到其他網站。</p>
      <form class="search" @submit.prevent="searchStops">
        <input v-model="stopQuery" type="search" placeholder="區＋路名＋巷，例如：板橋區文化路一段" autocomplete="off" maxlength="80" />
        <button class="primary" type="submit" :disabled="stopSearching || stopQuery.trim() === ''">{{ stopSearching ? "查詢中…" : "查詢" }}</button>
      </form>
      <p v-if="stopError" class="error small">{{ stopError }}</p>
      <p v-if="addedNote" class="ok small">{{ addedNote }}</p>
      <template v-if="stopResult">
        <p v-if="stopResult.results.length === 0" class="muted small">找不到符合的清運點。試試只寫區和路名，或換附近的大路。</p>
        <p v-else class="muted small">
          {{ stopResult.district ?? "全市" }}{{ stopResult.street ? `・${stopResult.street}` : "" }}{{ stopResult.lane !== null ? `・${stopResult.lane} 巷` : "" }}：
          最接近的點排最前面，距離是跟第一個點的直線距離。
        </p>
        <article v-for="stop in stopResult.results" :key="`${stop.name}${stop.lat}${stop.lon}`" class="stop">
          <header>
            <b>{{ stop.name }}</b>
            <span class="muted small">{{ stop.village }}<template v-if="stop.distance !== null && stop.distance > 0">・約 {{ stop.distance }} 公尺</template></span>
          </header>
          <table>
            <thead><tr><th>時間</th><th>🗑️ 垃圾</th><th>♻️ 回收</th><th>🥬 廚餘</th><th class="line-col">路線</th><th /></tr></thead>
            <tbody>
              <tr v-for="schedule in stop.schedules" :key="schedule.time + schedule.line">
                <td class="num"><b>{{ schedule.time }}</b></td>
                <td>{{ dayList(schedule.garbage) }}</td>
                <td>{{ dayList(schedule.recycle) }}</td>
                <td>{{ dayList(schedule.food) }}</td>
                <td class="muted small line-col">{{ schedule.line }}<template v-if="schedule.memo">（{{ schedule.memo }}）</template></td>
                <td><button class="link small" :disabled="saving" @click="useSchedule(stop, schedule)">加入提醒</button></td>
              </tr>
            </tbody>
          </table>
        </article>
        <p class="muted small">資料來源：新北市政府環境保護局「新北市垃圾車路線」開放資料{{ stopResult.updatedAt ? `（${new Date(stopResult.updatedAt).toLocaleDateString()} 下載）` : "" }}。實際以現場為準。</p>
      </template>
    </section>

    <section class="settings">
      <h4>固定時間</h4>
      <p class="muted small">選每週哪幾天、幾點到，以及提前幾分鐘提醒（可以選兩三個）。到時間會跳桌面通知，聊天分頁也會留一則。</p>
      <article v-for="(entry, index) in draft" :key="entry.id" class="entry" :class="{ off: !entry.enabled }">
        <div class="line">
          <select :value="entry.kind" aria-label="種類" @change="changeKind(entry, ($event.target as HTMLSelectElement).value as GarbageKind)">
            <option v-for="(label, kind) in KIND_LABEL" :key="kind" :value="kind">{{ KIND_ICON[kind] }} {{ label }}</option>
          </select>
          <input v-model="entry.label" class="label-input" maxlength="30" aria-label="名稱" @input="dirty = true" />
          <input v-model="entry.time" type="time" aria-label="時間" @input="dirty = true" />
          <label class="small enabled"><input v-model="entry.enabled" type="checkbox" @change="dirty = true" /> 啟用</label>
          <button class="link small danger" @click="remove(index)">刪除</button>
        </div>
        <div class="line">
          <span class="muted small">星期</span>
          <button v-for="day in WEEK_ORDER" :key="day" type="button" class="toggle small" :class="{ on: entry.weekdays.includes(day) }" :aria-pressed="entry.weekdays.includes(day)" @click="toggleDay(entry, day)">{{ WEEKDAY[day] }}</button>
        </div>
        <div class="line">
          <span class="muted small">提前</span>
          <button v-for="mark in MARKS" :key="mark" type="button" class="toggle small" :class="{ on: entry.before.includes(mark) }" :aria-pressed="entry.before.includes(mark)" @click="toggleMark(entry, mark)">{{ mark }} 分</button>
          <input v-model="entry.place" class="place" maxlength="40" placeholder="地點（選填，例如巷口）" aria-label="地點" @input="dirty = true" />
        </div>
      </article>
      <div class="add">
        <button class="small" @click="add('garbage')">＋ 一般垃圾</button>
        <button class="small" @click="add('recycle')">＋ 資源回收</button>
        <button class="small" @click="add('other')">＋ 其他（廚餘…）</button>
      </div>
      <div v-if="dirty || savedNote" class="save">
        <button v-if="dirty" class="primary" :disabled="saving" @click="save">{{ saving ? "儲存中…" : "儲存" }}</button>
        <button v-if="dirty" :disabled="saving" @click="discard">還原</button>
        <span v-if="!dirty && savedNote" class="muted small">{{ savedNote }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.garbage { height: 100%; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
h4 { margin: 0 0 6px; font-size: 0.9em; color: var(--muted); font-weight: 600; }
.today ul { list-style: none; margin: 0; padding: 0; border: var(--bw) solid var(--border); border-radius: var(--radius-lg); background: var(--panel); box-shadow: var(--card-shadow); }
.today li { display: grid; grid-template-columns: 1.6em 3.4em minmax(0, 1fr) auto auto; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); }
.today li:last-child { border-bottom: none; }
.today li.skipped > :not(button), .today li.passed > :not(button) { opacity: 0.55; }
.today li.skipped b { text-decoration: line-through; }
.when { color: var(--accent); font-weight: 600; }
.icon { text-align: center; }
.week { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
.week li { display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 2px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); min-width: 0; }
.week li.empty { opacity: 0.6; }
.chip { white-space: nowrap; padding: 0 4px; border-radius: 6px; background: var(--sunken); }
.chip.recycle { background: color-mix(in srgb, #3aa676 18%, var(--panel)); }
.chip.skipped { text-decoration: line-through; opacity: 0.6; }
.settings > p { margin: 0 0 8px; }
.entry { border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 10px 12px; background: var(--panel); box-shadow: var(--card-shadow); display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.entry.off { opacity: 0.6; }
.line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.label-input { flex: 1; min-width: 6em; }
.place { flex: 1; min-width: 9em; }
.enabled { display: inline-flex; align-items: center; gap: 4px; }
.toggle { min-width: 2.2em; padding: 2px 8px; border-radius: 999px; }
.toggle.on { background: var(--accent-soft, var(--sunken)); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.danger { color: var(--danger); }
.stops > p { margin: 0 0 8px; }
.search { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.search input { flex: 1; min-width: 12em; }
.ok { color: var(--ok); }
.stop { border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 8px 12px; background: var(--panel); box-shadow: var(--card-shadow); margin-bottom: 8px; overflow-x: auto; }
.stop header { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; margin-bottom: 4px; }
.stop table { border-collapse: collapse; width: 100%; font-size: 0.88em; }
.stop th, .stop td { text-align: left; padding: 3px 6px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.stop th { color: var(--muted); font-weight: 600; }
.stop tr:last-child td { border-bottom: none; }
@media (max-width: 520px) { .line-col { display: none; } }
.add, .save { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.save { margin-top: 8px; }
</style>
