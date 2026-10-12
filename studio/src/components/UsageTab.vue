<script setup lang="ts">
import { onMounted, ref } from "vue";

import { api } from "../api";
import type { QuotaResult, QuotaWindow, UsageSummary } from "../types";

const quotas = ref<{ max: QuotaResult; codex: QuotaResult }>();
const work = ref<UsageSummary[]>([]);
const loading = ref(false);
const error = ref("");

const KIND: Record<string, string> = { alice: "ALICe", worker: "部下／Claude", codex: "Codex" };

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await api.usage();
    quotas.value = result.quotas;
    work.value = result.work;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void refresh());

function windows(result: QuotaResult | undefined): Array<{ label: string; window: QuotaWindow }> {
  if (result === undefined || result.status !== "ok") return [];
  const entries: Array<{ label: string; window: QuotaWindow | undefined }> = [
    { label: "目前時段", window: result.currentSession },
    { label: "本週", window: result.currentWeek },
    { label: "短期", window: result.primary },
    { label: "每週", window: result.secondary },
  ];
  return entries.filter((entry): entry is { label: string; window: QuotaWindow } => entry.window !== undefined);
}

function resets(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function tokens(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}K` : String(value);
}
</script>

<template>
  <div class="usage">
    <div class="toolbar">
      <button :disabled="loading" @click="refresh">{{ loading ? "讀取中…" : "重新整理" }}</button>
      <span class="muted small">Max 額度由 Claude Code 的 /usage 讀取，可能要幾秒。</span>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <section v-if="quotas" class="quotas">
      <div v-for="[name, result] in [['Claude Max', quotas.max], ['Codex', quotas.codex]] as const" :key="name" class="quota">
        <h4>{{ name }}</h4>
        <p v-if="result.status !== 'ok'" class="muted small">{{ result.message }}：{{ result.reason }}</p>
        <div v-for="entry in windows(result)" :key="entry.label" class="bar-row">
          <span class="small">{{ entry.label }}</span>
          <div class="bar"><div :class="{ high: entry.window.usedPercent >= 85 }" :style="{ width: `${Math.min(100, entry.window.usedPercent)}%` }" /></div>
          <span class="small">{{ entry.window.usedPercent }}%</span>
          <span class="muted small">重置 {{ resets(entry.window.resets) }}</span>
        </div>
      </div>
    </section>
    <h4 class="section">最近的工作用量</h4>
    <div class="table">
      <table>
        <thead><tr><th>類型</th><th>工作</th><th>token（輸入＋輸出）</th><th>快取讀取</th><th>耗時</th><th>時間</th></tr></thead>
        <tbody>
          <tr v-for="row in work" :key="row.kind + row.refId">
            <td>{{ KIND[row.kind] ?? row.kind }}</td>
            <td class="title">{{ row.title }}</td>
            <td>{{ tokens(row.inputTokens + row.outputTokens) }}</td>
            <td>{{ tokens(row.cacheReadInputTokens) }}</td>
            <td>{{ Math.round(row.durationMs / 1000) }} 秒</td>
            <td>{{ new Date(row.time).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.usage { height: 100%; overflow-y: auto; padding: 0 14px 14px; }
.quotas { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; margin: 8px 0; }
.quota { border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 12px 14px; background: var(--panel); box-shadow: var(--card-shadow); }
.quota h4 { margin: 0 0 6px; }
.bar-row { display: grid; grid-template-columns: 4.5em 1fr 3em; gap: 6px; align-items: center; margin: 4px 0; }
.bar-row .muted { grid-column: 2 / 4; }
.bar { height: 8px; background: var(--sunken); border-radius: 4px; overflow: hidden; }
.bar > div { height: 100%; background: var(--ok); }
.bar > div.high { background: var(--danger); }
.section { margin: 12px 0 6px; }
.table { overflow-x: auto; background: var(--panel); border: var(--bw) solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--card-shadow); }
table { border-collapse: collapse; width: 100%; font-size: 0.88em; }
th, td { border-bottom: 1px solid var(--border); padding: 7px 10px; text-align: left; white-space: nowrap; font-variant-numeric: tabular-nums; }
th { color: var(--muted); font-weight: 600; background: var(--sunken); }
tr:last-child td { border-bottom: none; }
td.title { white-space: normal; min-width: 12em; }
</style>
