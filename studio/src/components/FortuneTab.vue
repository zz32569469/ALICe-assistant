<script setup lang="ts">
// §77 塔羅占卜：今日運勢（1 張，每天一次）、本週運勢（3 張，每週一次）。CD 沒到就停在上一次的結果。
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { api } from "../api";
import { store } from "../store";
import type { FortuneKind, FortuneSlot } from "../types";
import { tarotGlyph } from "../tarotGlyph";
import MarkdownText from "./MarkdownText";

const kind = ref<FortuneKind>("short");
const error = ref("");
const now = ref(Date.now());
let timer: number | undefined;

onMounted(() => {
  void api.fortune().then((result) => { store.fortune = result.slots; }).catch(() => undefined);
  timer = window.setInterval(() => { now.value = Date.now(); }, 30_000);
});
onBeforeUnmount(() => window.clearInterval(timer));

const LABEL: Record<FortuneKind, { title: string; hint: string }> = {
  short: { title: "今日運勢", hint: "抽 1 張牌，每天 0 點後可以再占" },
  long: { title: "本週運勢", hint: "抽 3 張牌（過去／現在／未來），每週一 0 點後可以再占" },
};

const slot = computed<FortuneSlot | undefined>(() => store.fortune?.[kind.value]);
/** 每張牌的圖示（tarotGlyph）。 */
const shownCards = computed(() => (slot.value?.latest?.cards ?? []).map((card) => ({ ...card, glyph: tarotGlyph(card.name) })));
/** CD：這一期占過、而且還沒到下一期。 */
const coolingDown = computed(() => slot.value?.done === true && new Date(slot.value.nextAt).getTime() > now.value);

function remaining(iso: string): string {
  const minutes = Math.max(0, Math.ceil((new Date(iso).getTime() - now.value) / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小時`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;
  return `${minutes} 分`;
}

function when(iso: string): string {
  const date = new Date(iso);
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function draw(): Promise<void> {
  error.value = "";
  try {
    const result = await api.drawFortune(kind.value);
    store.fortune = result.slots;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    void api.fortune().then((result) => { store.fortune = result.slots; }).catch(() => undefined);
  }
}
</script>

<template>
  <div class="fortune">
    <nav class="kinds" role="tablist">
      <button v-for="key in (['short', 'long'] as const)" :key="key" role="tab" :aria-selected="kind === key" :class="{ active: kind === key }" @click="kind = key">
        {{ LABEL[key].title }}
      </button>
    </nav>

    <section class="action">
      <button class="primary" :disabled="coolingDown || slot?.generating === true || store.connection !== 'open'" @click="draw">
        {{ slot?.generating ? "ALICe 正在洗牌、解讀…" : coolingDown ? "這一期已經占過了" : `占卜${LABEL[kind].title}` }}
      </button>
      <span class="muted small">
        <template v-if="coolingDown && slot">還要 {{ remaining(slot.nextAt) }} 才能再占（{{ when(slot.nextAt) }}）</template>
        <template v-else>{{ LABEL[kind].hint }}</template>
      </span>
      <p v-if="error" class="error small">{{ error }}</p>
    </section>

    <article v-if="slot?.latest" class="result">
      <p class="muted small">{{ slot.done ? "這一期的結果" : "上一次的結果" }}・{{ when(slot.latest.createdAt) }}</p>
      <ul class="cards">
        <li v-for="card in shownCards" :key="card.position + card.name" class="card tarot" :class="{ reversed: card.reversed }">
          <span class="position small">{{ card.position }}</span>
          <span class="glyph" :class="card.glyph.kind" aria-hidden="true">
            <template v-if="card.glyph.kind === 'major'"><small class="numeral">{{ card.glyph.numeral }}</small>{{ card.glyph.symbol }}</template>
            <template v-else-if="card.glyph.kind === 'ace'">{{ card.glyph.suit }}</template>
            <template v-else-if="card.glyph.kind === 'pips'"><i v-for="n in card.glyph.count" :key="n">{{ card.glyph.suit }}</i></template>
            <template v-else-if="card.glyph.kind === 'court'">{{ card.glyph.piece }}<small class="court-suit">{{ card.glyph.suit }}</small></template>
            <template v-else>{{ card.glyph.symbol }}</template>
          </span>
          <b class="name">{{ card.name }}</b>
          <span class="orientation small">{{ card.reversed ? "逆位" : "正位" }}</span>
        </li>
      </ul>
      <div class="reading"><MarkdownText :text="slot.latest.text" /></div>
    </article>
    <p v-else class="empty muted">還沒有占卜過。按上面的按鈕，請 ALICe 幫你抽牌。</p>
    <p class="muted small note">占卜僅供娛樂：牌由程式隨機抽，ALICe 負責解讀。</p>
  </div>
</template>

<style scoped>
.fortune { height: 100%; display: flex; flex-direction: column; gap: 12px; padding: 14px; overflow-y: auto; }
.kinds { display: flex; gap: 6px; }
.kinds button { border-radius: 999px; padding: 4px 14px; }
.kinds button.active { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); font-weight: 600; }
.action { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.action .error { flex-basis: 100%; margin: 0; }
.result { border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 14px 16px; background: var(--panel); box-shadow: var(--card-shadow); }
.result > p { margin: 0 0 10px; }
.cards { list-style: none; margin: 0 0 12px; padding: 0; display: flex; gap: 10px; flex-wrap: wrap; }
.card { width: 92px; min-height: 132px; border-radius: 10px; border: 2px solid color-mix(in srgb, var(--accent) 55%, var(--border)); background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 16%, var(--panel)), var(--panel)); display: flex; flex-direction: column; align-items: center; justify-content: space-between; padding: 8px 6px; text-align: center; }
.card .glyph { font-size: 1.8em; color: var(--accent); line-height: 1; display: flex; flex-direction: column; align-items: center; font-family: "Segoe UI Symbol", "Noto Sans Symbols 2", "Noto Sans Symbols", "Apple Symbols", sans-serif; }
.card .glyph .numeral { font-size: 0.42em; letter-spacing: 0.08em; opacity: 0.8; margin-bottom: 2px; font-family: Georgia, "Times New Roman", serif; }
/* 點數：一～十個花色符號排成格子 */
.card .glyph.pips { flex-direction: row; flex-wrap: wrap; justify-content: center; gap: 1px 3px; width: 64px; font-size: 0.95em; }
.card .glyph.pips i { font-style: normal; width: 1em; text-align: center; }
.card .glyph.ace { font-size: 2.2em; }
.card .glyph.court { flex-direction: row; align-items: flex-end; }
.card .glyph .court-suit { font-size: 0.5em; margin-left: 1px; }
.card.reversed .glyph { transform: rotate(180deg); opacity: 0.7; }
.card .name { font-size: 0.95em; line-height: 1.25; }
.position { color: var(--faint); }
.orientation { color: var(--muted); }
.card.reversed .orientation { color: var(--warn); }
.reading :deep(h3) { font-size: 1em; margin: 12px 0 4px; }
.empty { margin: 24px 0; text-align: center; }
.note { margin: 0 2px; }
</style>
