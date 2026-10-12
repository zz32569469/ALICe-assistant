<script setup lang="ts">
import { ref, watch } from "vue";

import { api } from "../api";
import { store } from "../store";
import type { ReportEntry } from "../types";
import MarkdownText from "./MarkdownText";

const props = defineProps<{ requested?: string }>();

const reports = ref<ReportEntry[]>([]);
const selected = ref<ReportEntry>();
const text = ref("");
const error = ref("");

async function refresh(): Promise<void> {
  try {
    reports.value = (await api.reports()).reports;
    error.value = "";
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function open(entry: ReportEntry): Promise<void> {
  selected.value = entry;
  text.value = "載入中…";
  try {
    text.value = (await api.report(entry.kind, entry.name)).text;
  } catch (caught) {
    text.value = "";
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

watch(() => store.reportsVersion, () => void refresh(), { immediate: true });
watch(() => [props.requested, reports.value.length] as const, ([name]) => {
  if (name === undefined) return;
  const entry = reports.value.find((candidate) => candidate.kind === "report" && candidate.name === name);
  if (entry !== undefined && selected.value?.name !== name) void open(entry);
}, { immediate: true });
</script>

<template>
  <div class="reports">
    <div class="toolbar">
      <button @click="refresh">重新整理</button>
      <span class="muted small">報告在計畫完成、暫停、取消時更新；回寫候選由工程師直接送知識庫管理員。</span>
    </div>
    <ul class="list pick-list">
      <li v-if="reports.length === 0" class="muted">還沒有報告。</li>
      <li v-for="entry in reports" :key="entry.kind + entry.name">
        <button class="row pick-row" :class="{ active: selected?.kind === entry.kind && selected?.name === entry.name }" @click="open(entry)">
          <span class="badge" :class="entry.kind">{{ entry.kind === "report" ? "報告" : "回寫候選" }}</span>
          <span>{{ entry.name }}</span>
          <span class="muted small">{{ new Date(entry.modifiedAt).toLocaleString() }}</span>
        </button>
      </li>
    </ul>
    <section v-if="selected" class="content pick-detail">
      <p v-if="error" class="error">{{ error }}</p>
      <MarkdownText :text="text" />
    </section>
    <p v-else-if="error" class="error hint">{{ error }}</p>
  </div>
</template>

<style scoped>
.reports { display: grid; grid-template-rows: auto minmax(100px, 30%) 1fr; height: 100%; min-height: 0; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.hint { padding: 8px 14px; }
</style>
