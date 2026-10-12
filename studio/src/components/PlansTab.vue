<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { api, reportNameFor } from "../api";
import { refreshPlan, store } from "../store";
import type { PlanItem, PlanStatus } from "../types";

const emit = defineEmits<{ openReport: [name: string] }>();

const STATUS: Record<PlanStatus, string> = {
  pending_approval: "等待確認", queued: "排隊中", running: "執行中", paused: "暫停", completed: "完成",
  cancelled: "已取消", rejected: "主人拒絕", expired: "確認逾時", failed: "失敗",
};
/** 暫停原因（Core 的代碼 → 白話）。 */
const PAUSE_REASON: Record<string, string> = {
  decision_needed: "等你決定", session_blocked: "同事回報卡住", item_failed: "項目失敗", codex_quota: "Codex 額度不足",
  codex_unavailable: "Codex 不可用", repo_dirty: "repo 有別的未提交改動", dependency_failed: "前一份計畫沒完成",
  forbidden_path: "改到禁改路徑", repo_destructive: "偵測到破壞性的 git 變動", review_failed: "審查沒通過", spec_conflict: "和規格衝突",
  session_send_failed: "派工送不出去", session_verify_failed: "同事回報後驗收沒過", core_restart: "Core 重啟中斷",
};
const ITEM_STATUS: Record<PlanItem["status"], string> = {
  pending: "未開始", running: "執行中", done: "完成", failed: "失敗", cancelled: "已取消",
};

const selectedId = computed({
  get: () => store.selectedPlanId,
  set: (id: string | undefined) => { store.selectedPlanId = id; },
});
const busy = ref(false);
const actionError = ref("");

const selected = computed(() => (selectedId.value === undefined ? undefined : store.planViews[selectedId.value]));
const progress = computed(() => (selectedId.value === undefined ? [] : store.planProgress[selectedId.value] ?? []));

watch(selectedId, (id) => {
  actionError.value = "";
  if (id !== undefined) void refreshPlan(id);
}, { immediate: true });

async function act(action: "resume" | "cancel", executor?: "claude"): Promise<void> {
  const id = selectedId.value;
  if (id === undefined) return;
  if (action === "cancel" && !window.confirm("確定要取消這份計畫嗎？執行中的項目會被中止。")) return;
  busy.value = true;
  actionError.value = "";
  try {
    await api.planAction(id, action, executor);
    await refreshPlan(id);
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

type ItemResult = { summary?: string; text?: string; verdict?: string; verification?: { newFailures: string[]; baselineFailures: number; afterFailures: number } };

function resultLine(item: PlanItem): string {
  const result = (item.result ?? {}) as ItemResult;
  const parts = [
    result.summary ?? result.verdict ?? (result.text === undefined ? "" : result.text.split("\n").find((line) => line.trim() !== "") ?? ""),
    result.verification === undefined ? "" : `Core 驗收：失敗 ${result.verification.baselineFailures} → ${result.verification.afterFailures}（新增 ${result.verification.newFailures.length}）`,
  ].filter((part) => part !== "");
  return parts.join("｜");
}

function when(iso: string): string {
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="plans">
    <ul class="list pick-list">
      <li v-if="store.plans.length === 0" class="muted">還沒有計畫。</li>
      <li v-for="plan in store.plans" :key="plan.id">
        <button class="row pick-row" :class="{ active: plan.id === selectedId }" @click="selectedId = plan.id">
          <span class="badge" :class="plan.status">{{ STATUS[plan.status] }}</span>
          <span class="title">{{ plan.goal }}</span>
          <span class="muted small">{{ plan.id.slice(0, 8) }}・{{ when(plan.createdAt) }}</span>
        </button>
      </li>
    </ul>

    <section v-if="selected" class="detail pick-detail">
      <h3>{{ selected.plan.goal }}</h3>
      <p class="muted small">
        {{ selected.plan.id.slice(0, 8) }}・<span class="badge" :class="selected.plan.status">{{ STATUS[selected.plan.status] }}</span>
        <template v-if="selected.plan.pauseReason">（{{ PAUSE_REASON[selected.plan.pauseReason] ?? selected.plan.pauseReason }}）</template>
      </p>
      <p v-if="selected.plan.pauseDetail" class="warn">{{ selected.plan.pauseDetail }}</p>

      <div class="buttons">
        <template v-if="selected.plan.status === 'paused'">
          <button class="primary" :disabled="busy" @click="act('resume')">繼續</button>
          <button :disabled="busy" title="授權 Codex 不可用或額度不足時改由 Claude 寫程式" @click="act('resume', 'claude')">繼續（授權 Claude 寫）</button>
        </template>
        <button v-if="['paused', 'running', 'queued'].includes(selected.plan.status)" class="danger" :disabled="busy" @click="act('cancel')">取消計畫</button>
        <button v-if="['completed', 'paused', 'cancelled'].includes(selected.plan.status)" @click="emit('openReport', reportNameFor(selected.plan))">看報告</button>
        <span v-if="actionError" class="error">{{ actionError }}</span>
      </div>

      <ol class="items">
        <li v-for="item in selected.items" :key="item.id" :class="item.status">
          <div class="item-head">
            <span class="key">{{ item.key }}</span>
            <span class="badge" :class="item.status">{{ ITEM_STATUS[item.status] }}</span>
            <span>{{ item.title }}</span>
          </div>
          <div class="muted small">
            {{ item.kind }}・{{ item.project }}<template v-if="item.executor">・{{ item.executor }}</template>・嘗試 {{ item.attempts }}
            <template v-if="item.risk === 'high'">・<b class="warn-text">高風險</b></template>
            <template v-if="item.dependsOn.length > 0">・依賴 {{ item.dependsOn.join("、") }}</template>
          </div>
          <div v-if="resultLine(item)" class="result small">{{ resultLine(item) }}</div>
          <div v-if="item.error" class="error small">{{ item.error }}</div>
        </li>
      </ol>

      <details v-if="progress.length > 0" open>
        <summary>進度（這次開啟網頁後）</summary>
        <pre class="progress">{{ progress.join("\n") }}</pre>
      </details>
      <p v-if="selected.plan.risks.length > 0" class="small"><b>風險：</b>{{ selected.plan.risks.join("；") }}</p>
    </section>
    <p v-else-if="store.plans.length > 0" class="pick-hint">選一份計畫看詳情。</p>
  </div>
</template>

<style scoped>
.plans { display: grid; grid-template-rows: minmax(120px, 34%) 1fr; height: 100%; min-height: 0; }
.row { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; }
.row .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row .small { grid-column: 2; }
.buttons { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 6px 0; }
.items { padding-left: 0; list-style: none; }
.items li { border: var(--bw) solid var(--border); border-radius: var(--radius-lg); padding: 8px 12px; margin: 8px 0; background: var(--panel); box-shadow: var(--card-shadow); }
.items li.running { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.items li.failed { border-color: var(--danger); }
.item-head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.key { font-weight: 700; color: var(--accent); }
.result { margin-top: 2px; overflow-wrap: anywhere; }
.progress { white-space: pre-wrap; font-size: 0.82em; max-height: 240px; overflow-y: auto; }
</style>
