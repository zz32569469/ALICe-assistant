<script setup lang="ts">
// §96 早安小卡：聊天分頁最上面，每天顯示一次（按 × 收起，隔天再出現）。
// 內容是今天的天氣、穿搭建議、今天的垃圾車（§97）和今日運勢的總結句；只組合現有資料，不花 token。
import { computed, onMounted, ref } from "vue";

import { api } from "../api";
import { store } from "../store";
import type { Forecast, GarbageView, WeatherLocation } from "../types";

const emit = defineEmits<{ open: [tab: "weather" | "fortune" | "garbage"] }>();

const KEY = "alice.morning.closed";
const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
};
function closedToday(): boolean {
  try {
    return window.localStorage.getItem(KEY) === today();
  } catch {
    return false;
  }
}
const visible = ref(!closedToday());
function close(): void {
  visible.value = false;
  try {
    window.localStorage.setItem(KEY, today());
  } catch {
    // 瀏覽器不讓存就只收起這一次。
  }
}

const location = ref<WeatherLocation | null>(null);
const forecast = ref<Forecast | null>(null);
const weatherLoaded = ref(false);
const garbage = ref<GarbageView | null>(null);
/** 今天的垃圾車：同一時間合成一項（略過的不列）；有設定才顯示這一列。 */
const garbageToday = computed(() => {
  const items = garbage.value?.week[0]?.items.filter((item) => !item.skipped) ?? [];
  const byTime = new Map<string, string[]>();
  for (const item of items) byTime.set(item.time, [...(byTime.get(item.time) ?? []), item.label]);
  return [...byTime].map(([time, labels]) => `${time} ${labels.join("、")}`).join("；");
});

onMounted(() => {
  if (!visible.value) return;
  void api.weather().then((result) => {
    location.value = result.location;
    forecast.value = result.forecast;
  }).catch(() => undefined).finally(() => { weatherLoaded.value = true; });
  void api.garbage().then((result) => { garbage.value = result; }).catch(() => undefined);
  if (store.fortune === undefined) void api.fortune().then((result) => { store.fortune = result.slots; }).catch(() => undefined);
});

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "早安";
  if (hour >= 11 && hour < 17) return "午安";
  return "晚安";
});
const dateText = computed(() => new Date().toLocaleDateString([], { month: "numeric", day: "numeric", weekday: "short" }));

/** 今日運勢：這一期占過才顯示，取解讀的第一行（總結句），去掉 Markdown 符號。 */
const fortune = computed(() => {
  const slot = store.fortune?.short;
  if (slot === undefined || !slot.done || slot.latest === null) return undefined;
  const first = slot.latest.text.split("\n").map((line) => line.replace(/^[#>*\-\s]+|[*_`]/gu, "").trim()).find((line) => line !== "") ?? "";
  const cards = slot.latest.cards.map((card) => `${card.name}${card.reversed ? "（逆位）" : ""}`).join("、");
  return { summary: first, cards };
});
const fortuneKnown = computed(() => store.fortune !== undefined);
const today0 = computed(() => forecast.value?.days[0]);
</script>

<template>
  <section v-if="visible" class="morning" aria-label="早安小卡">
    <header>
      <b>{{ greeting }}，主人</b>
      <span class="muted small">{{ dateText }}</span>
      <button class="close link" title="今天不再顯示" aria-label="今天不再顯示" @click="close">×</button>
    </header>

    <div class="rows">
      <div class="row">
        <span class="icon" aria-hidden="true">{{ forecast?.current.icon ?? "🌡️" }}</span>
        <div v-if="location !== null && forecast !== null && today0" class="text">
          <p>
            <b>{{ location.name }}</b> 現在 {{ Math.round(forecast.current.temperature) }}° {{ forecast.current.label }}，
            今天 {{ Math.round(today0.min) }}～{{ Math.round(today0.max) }}°<template v-if="today0.rainChance !== null">、降雨 {{ today0.rainChance }}%</template>
          </p>
          <p v-if="forecast.advice.length > 0" class="muted small">{{ forecast.advice.slice(0, 2).join("；") }}</p>
        </div>
        <p v-else-if="weatherLoaded && location === null" class="text muted small">還沒設定天氣地點。<button class="link small" @click="emit('open', 'weather')">去設定</button></p>
        <p v-else-if="weatherLoaded" class="text muted small">天氣暫時讀不到。<button class="link small" @click="emit('open', 'weather')">看天氣分頁</button></p>
        <p v-else class="text muted small">讀取天氣中…</p>
      </div>

      <div v-if="garbage && garbage.entries.length > 0" class="row">
        <span class="icon" aria-hidden="true">🚛</span>
        <p class="text" :class="{ 'muted small': garbageToday === '' }">
          <template v-if="garbageToday">今天垃圾車：{{ garbageToday }}</template>
          <template v-else>今天沒有垃圾車。</template>
          <button class="link small" @click="emit('open', 'garbage')">看這週</button>
        </p>
      </div>

      <div class="row">
        <span class="icon" aria-hidden="true">🔮</span>
        <div v-if="fortune" class="text">
          <p>{{ fortune.summary }}</p>
          <p class="muted small">今日牌：{{ fortune.cards }}・<button class="link small" @click="emit('open', 'fortune')">看完整解讀</button></p>
        </div>
        <p v-else-if="fortuneKnown" class="text muted small">今天還沒占卜。<button class="link small" @click="emit('open', 'fortune')">抽今日運勢</button></p>
        <p v-else class="text muted small">讀取運勢中…</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.morning { margin: 10px 20px 0; padding: 10px 14px; border: var(--bw) solid var(--border); border-radius: var(--radius-lg); background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 10%, var(--panel)), var(--panel)); box-shadow: var(--card-shadow); }
header { display: flex; align-items: baseline; gap: 8px; }
header .close { margin-left: auto; font-size: 1.2em; line-height: 1; padding: 0 4px; text-decoration: none; }
.rows { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.row { display: grid; grid-template-columns: 1.6em minmax(0, 1fr); gap: 8px; align-items: start; }
.icon { font-size: 1.3em; line-height: 1.3; text-align: center; }
.text p { margin: 0; overflow-wrap: anywhere; }
.text p + p { margin-top: 2px; }
</style>
