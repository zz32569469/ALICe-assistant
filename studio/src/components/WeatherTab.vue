<script setup lang="ts">
// §95 天氣（聊天分頁）：目前天氣、穿搭建議、未來 12 小時、7 天。資料由 Core 從 Open-Meteo 取得（免費、不用金鑰）。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { api } from "../api";
import type { Forecast, WeatherLocation } from "../types";

const location = ref<WeatherLocation | null>(null);
const forecast = ref<Forecast | null>(null);
const loading = ref(false);
const loaded = ref(false);
const error = ref("");

const picking = ref(false);
const query = ref("");
const results = ref<WeatherLocation[]>([]);
const searching = ref(false);
const searched = ref(false);

async function load(refresh = false): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await api.weather(refresh);
    location.value = result.location;
    forecast.value = result.forecast;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
    loaded.value = true;
  }
}

async function search(): Promise<void> {
  if (query.value.trim() === "") return;
  searching.value = true;
  error.value = "";
  try {
    results.value = (await api.searchWeather(query.value)).results;
    searched.value = true;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    searching.value = false;
  }
}

async function choose(entry: WeatherLocation): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await api.setWeatherLocation(entry);
    location.value = result.location;
    forecast.value = result.forecast;
    picking.value = false;
    results.value = [];
    searched.value = false;
    query.value = "";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

const place = (entry: WeatherLocation): string => [entry.name, entry.admin1, entry.country].filter((part, index, all) => part && all.indexOf(part) === index).join("・");

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];
function dayName(date: string, index: number): string {
  if (index === 0) return "今天";
  if (index === 1) return "明天";
  const [year, month, day] = date.split("-").map(Number);
  return `週${WEEKDAY[new Date(year!, month! - 1, day!).getDay()]}`;
}
const hourText = (time: string): string => `${Number(time.slice(11, 13))} 時`;
const clock = (time: string | null): string => (time === null ? "—" : time.slice(11, 16));
const round = (value: number): number => Math.round(value);

/** 7 天溫度條：用這 7 天的最低到最高當範圍。 */
const range = computed(() => {
  const days = forecast.value?.days ?? [];
  if (days.length === 0) return { low: 0, high: 1 };
  return { low: Math.min(...days.map((day) => day.min)), high: Math.max(...days.map((day) => day.max)) };
});
function bar(min: number, max: number): Record<string, string> {
  const span = Math.max(1, range.value.high - range.value.low);
  return { left: `${((min - range.value.low) / span) * 100}%`, width: `${Math.max(6, ((max - min) / span) * 100)}%` };
}

const updated = computed(() => (forecast.value === null ? "" : new Date(forecast.value.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));

// 開著的時候每 30 分鐘更新一次（Core 有 20 分鐘快取）。
let timer: number | undefined;
onMounted(() => {
  void load();
  timer = window.setInterval(() => { if (location.value !== null) void load(); }, 30 * 60_000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="weather">
    <p v-if="error" class="error small">{{ error }}</p>

    <section v-if="loaded && (location === null || picking)" class="picker">
      <h3>{{ location === null ? "設定天氣地點" : "更換地點" }}</h3>
      <p class="muted small">輸入城市名稱搜尋（臺灣縣市可以直接打中文；其他地方找不到時試試英文）。</p>
      <form class="search" @submit.prevent="search">
        <input v-model="query" type="search" placeholder="例如：台北、新竹、Tokyo" autocomplete="off" />
        <button class="primary" type="submit" :disabled="searching || query.trim() === ''">{{ searching ? "搜尋中…" : "搜尋" }}</button>
        <button v-if="location !== null" type="button" @click="picking = false">取消</button>
      </form>
      <ul v-if="results.length > 0" class="results">
        <li v-for="entry in results" :key="`${entry.latitude},${entry.longitude}`">
          <button type="button" :disabled="loading" @click="choose(entry)">{{ place(entry) }}</button>
        </li>
      </ul>
      <p v-else-if="searched" class="muted small">找不到，換個寫法或用英文試試。</p>
    </section>

    <template v-if="location !== null && forecast !== null && !picking">
      <header class="head">
        <div>
          <b class="place">{{ location.name }}</b>
          <button class="link small" @click="picking = true">更換</button>
        </div>
        <span class="muted small">
          {{ updated }} 更新
          <button class="link small" :disabled="loading" @click="load(true)">{{ loading ? "更新中…" : "重新整理" }}</button>
        </span>
      </header>

      <section class="now">
        <span class="big-icon" aria-hidden="true">{{ forecast.current.icon }}</span>
        <div class="now-main">
          <span class="temp num">{{ round(forecast.current.temperature) }}°</span>
          <span class="label">{{ forecast.current.label }}</span>
        </div>
        <dl class="now-meta small">
          <dt>體感</dt><dd class="num">{{ round(forecast.current.feelsLike) }}°</dd>
          <dt>濕度</dt><dd class="num">{{ forecast.current.humidity }}%</dd>
          <dt>風速</dt><dd class="num">{{ round(forecast.current.windSpeed) }} km/h</dd>
          <template v-if="forecast.days[0]">
            <dt>日出／日落</dt><dd class="num">{{ clock(forecast.days[0].sunrise) }}／{{ clock(forecast.days[0].sunset) }}</dd>
          </template>
        </dl>
      </section>

      <ul v-if="forecast.advice.length > 0" class="advice">
        <li v-for="line in forecast.advice" :key="line">{{ line }}</li>
      </ul>

      <section>
        <h4>未來 12 小時</h4>
        <ol class="hours">
          <li v-for="hour in forecast.hours" :key="hour.time">
            <span class="muted small">{{ hourText(hour.time) }}</span>
            <span class="icon" aria-hidden="true">{{ hour.icon }}</span>
            <b class="num">{{ round(hour.temperature) }}°</b>
            <span class="rain small num" :class="{ wet: (hour.rainChance ?? 0) >= 50 }">{{ hour.rainChance === null ? "" : `${hour.rainChance}%` }}</span>
          </li>
        </ol>
      </section>

      <section>
        <h4>7 天</h4>
        <ol class="days">
          <li v-for="(day, index) in forecast.days" :key="day.date">
            <span class="day-name">{{ dayName(day.date, index) }}</span>
            <span class="icon" aria-hidden="true" :title="day.label">{{ day.icon }}</span>
            <span class="day-label small muted">{{ day.label }}</span>
            <span class="rain small num" :class="{ wet: (day.rainChance ?? 0) >= 50 }">{{ day.rainChance === null ? "" : `☂ ${day.rainChance}%` }}</span>
            <span class="num min">{{ round(day.min) }}°</span>
            <span class="range"><i :style="bar(day.min, day.max)" /></span>
            <span class="num max">{{ round(day.max) }}°</span>
          </li>
        </ol>
      </section>
      <p class="muted small note">資料來源：Open-Meteo（免費天氣資料）。建議是依溫度、降雨機率與紫外線的規則產生，不會花 ALICe 的額度。</p>
    </template>

    <p v-else-if="!loaded" class="muted">讀取中…</p>
    <p v-else-if="location !== null && forecast === null && !picking && !error" class="muted">還沒有預報資料，按重新整理試試。</p>
  </div>
</template>

<style scoped>
.weather { height: 100%; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.weather h3, .weather h4 { margin: 0 0 6px; }
.weather h4 { font-size: 0.9em; color: var(--muted); font-weight: 600; }
.picker { border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 14px 16px; background: var(--panel); box-shadow: var(--card-shadow); }
.picker p { margin: 0 0 8px; }
.search { display: flex; gap: 6px; flex-wrap: wrap; }
.search input { flex: 1; min-width: 10em; }
.results { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.results button { width: 100%; text-align: left; }
.head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.place { font-size: 1.1em; margin-right: 6px; }
.now { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 14px 16px; background: var(--panel); box-shadow: var(--card-shadow); }
.big-icon { font-size: 3em; line-height: 1; }
.now-main { display: flex; flex-direction: column; }
.temp { font-size: 2.4em; font-weight: 700; line-height: 1; }
.label { color: var(--muted); }
.now-meta { margin: 0 0 0 auto; display: grid; grid-template-columns: auto auto; gap: 2px 10px; }
.now-meta dt { color: var(--muted); }
.now-meta dd { margin: 0; text-align: right; }
.advice { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.advice li { padding: 3px 10px; border-radius: 999px; background: var(--accent-soft, var(--sunken)); border: 1px solid var(--border); font-size: 0.88em; }
.hours { list-style: none; margin: 0; padding: 0 0 4px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(52px, 1fr); gap: 6px; overflow-x: auto; }
.hours li { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 8px 4px; border-radius: 10px; background: var(--panel); border: 1px solid var(--border); }
.hours .icon { font-size: 1.3em; }
.rain { color: var(--muted); min-height: 1.2em; }
.rain.wet { color: var(--accent); font-weight: 600; }
.days { list-style: none; margin: 0; padding: 0; border: var(--bw) solid var(--border); border-radius: var(--radius-lg); background: var(--panel); box-shadow: var(--card-shadow); }
.days li { display: grid; grid-template-columns: 3em 1.6em minmax(3em, 1fr) 4.2em 2.4em minmax(60px, 1.4fr) 2.4em; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); }
.days li:last-child { border-bottom: none; }
.days .icon { font-size: 1.2em; text-align: center; }
.days .min { color: var(--muted); text-align: right; }
.range { position: relative; height: 6px; border-radius: 3px; background: var(--sunken); }
.range i { position: absolute; top: 0; bottom: 0; border-radius: 3px; background: linear-gradient(90deg, #6fb7e8, #f2b04b, #e8664b); }
.note { margin: 0; }
@media (max-width: 520px) {
  .days li { grid-template-columns: 2.6em 1.4em 3.6em 2em minmax(40px, 1fr) 2em; }
  .days .day-label { display: none; }
  .now-meta { margin-left: 0; }
}
</style>
