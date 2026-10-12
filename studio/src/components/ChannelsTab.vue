<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { loadChannel, store } from "../store";
import MarkdownText from "./MarkdownText";

const STATUS: Record<string, string> = { open: "進行中", running: "部下回覆中", closed: "已結束", failed: "失敗" };
const AUTHOR: Record<string, string> = { alice: "ALICe", worker: "部下", owner: "主人", system: "系統" };

const selectedId = computed({
  get: () => store.selectedChannelId,
  set: (id: string | undefined) => { store.selectedChannelId = id; },
});
const loadError = ref("");
const box = ref<HTMLElement>();

const channel = computed(() => store.channels.find((candidate) => candidate.id === selectedId.value));
const messages = computed(() => (selectedId.value === undefined ? [] : store.channelMessages[selectedId.value] ?? []));
const live = computed(() => (selectedId.value === undefined ? "" : store.channelLive[selectedId.value] ?? ""));
const sorted = computed(() => [...store.channels].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));

watch(selectedId, async (id) => {
  loadError.value = "";
  if (id === undefined) return;
  try {
    await loadChannel(id);
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error);
  }
}, { immediate: true });

watch(() => [messages.value.length, live.value.length], async () => {
  await nextTick();
  if (box.value !== undefined) box.value.scrollTop = box.value.scrollHeight;
});

function when(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="channels">
    <ul class="list pick-list">
      <li v-if="store.channels.length === 0" class="muted">還沒有工作頻道。</li>
      <li v-for="entry in sorted" :key="entry.id">
        <button class="row pick-row" :class="{ active: entry.id === selectedId }" @click="selectedId = entry.id">
          <span class="badge" :class="entry.status">{{ STATUS[entry.status] ?? entry.status }}</span>
          <span class="title">{{ entry.title }}</span>
          <span class="muted small">{{ entry.role }}・{{ entry.project }}・{{ entry.rounds }} 輪・{{ when(entry.updatedAt) }}</span>
        </button>
      </li>
    </ul>
    <section v-if="channel" ref="box" class="thread pick-detail">
      <h3>{{ channel.title }}</h3>
      <p v-if="loadError" class="error">{{ loadError }}</p>
      <article v-for="message in messages" :key="message.id" class="entry" :class="message.author">
        <header><b>{{ AUTHOR[message.author] ?? message.author }}</b><template v-if="message.author === 'worker'">（{{ channel.role }}）</template> <time class="muted small">{{ when(message.createdAt) }}</time></header>
        <MarkdownText :text="message.text" />
      </article>
      <article v-if="live !== ''" class="entry worker streaming">
        <header><b>部下</b>（{{ channel.role }}）<span class="muted small">回覆中…</span></header>
        <MarkdownText :text="live" />
      </article>
    </section>
    <p v-else-if="store.channels.length > 0" class="pick-hint">選一個頻道看部下的對話全文。</p>
  </div>
</template>

<style scoped>
.channels { display: grid; grid-template-rows: minmax(120px, 34%) 1fr; height: 100%; min-height: 0; }
.row { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; }
.row .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .small { grid-column: 2; }
.thread h3 { margin: 4px 0 8px; }
.entry { border-left: 3px solid var(--border); padding: 4px 12px; margin: 12px 0; overflow-wrap: anywhere; }
.entry.alice { border-color: var(--accent); }
.entry.worker { border-color: var(--ok); }
.entry.system { border-color: var(--faint); font-size: 0.9em; color: var(--muted); }
.entry.streaming { opacity: 0.85; }
</style>
