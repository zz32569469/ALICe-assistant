<script setup lang="ts">
import { computed, ref } from "vue";

import { api } from "../api";
import type { Confirmation } from "../types";

const props = defineProps<{ confirmation: Confirmation }>();
const busy = ref(false);
const error = ref("");

const expires = computed(() => {
  const at = props.confirmation.expiresAt;
  return at === undefined ? "" : new Date(at).toLocaleTimeString();
});

async function act(action: "approve" | "reject"): Promise<void> {
  busy.value = true;
  error.value = "";
  try {
    if (props.confirmation.kind === "task") await api.taskAction(props.confirmation.id, action);
    else if (props.confirmation.kind === "game") await api.gameConfirmationAction(props.confirmation.id, action);
    else await api.planAction(props.confirmation.id, action);
    // 卡片由 permission.resolved 事件收回（命令列確認時也一樣）。
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}

function who(kind: string, role: string | null, executor: string | null): string {
  if (kind === "session") return "同事 session";
  return kind === "read" || kind === "review" ? `${role ?? "部下"}（唯讀）` : executor ?? "Codex／Claude";
}
</script>

<template>
  <section class="confirm" :class="confirmation.kind">
    <header>
      <strong>{{ confirmation.kind === "task" ? "任務等你核准" : confirmation.kind === "game" ? "進度等你確認" : "計畫等你核准" }}</strong>
      <span v-if="expires" class="muted">期限 {{ expires }}</span>
    </header>

    <template v-if="confirmation.kind === 'task'">
      <p class="goal">{{ confirmation.goal }}</p>
      <p class="muted">repo：{{ confirmation.repo }}（{{ confirmation.repoPath }}）<template v-if="confirmation.estimateMin !== null">・預估 {{ confirmation.estimateMin }} 分鐘</template></p>
      <ul class="acceptance">
        <li v-for="criterion in confirmation.acceptance" :key="criterion">{{ criterion }}</li>
      </ul>
      <p v-if="confirmation.dirtyFiles && confirmation.dirtyFiles.length > 0" class="warn">
        ⚠ 這個 repo 有未提交的改動（{{ confirmation.dirtyFiles.length }} 個檔）：{{ confirmation.dirtyFiles.slice(0, 10).join("、") }}{{ confirmation.dirtyFiles.length > 10 ? " 等" : "" }}；核准後會在這些改動之上工作。
      </p>
    </template>

    <template v-else-if="confirmation.kind === 'game'">
      <p class="goal">{{ confirmation.gameName }}</p>
      <ul class="acceptance changes">
        <li v-for="line in confirmation.lines" :key="line">{{ line }}</li>
      </ul>
      <p v-if="confirmation.reason" class="muted">依據：{{ confirmation.reason }}</p>
    </template>

    <template v-else>
      <p class="goal">{{ confirmation.view.plan.goal }}</p>
      <ol class="items">
        <li v-for="item in confirmation.view.items" :key="item.id">
          <span class="key">{{ item.key }}</span>
          {{ item.title }}
          <span class="muted">（{{ item.kind }}・{{ item.project }}・{{ who(item.kind, item.role, item.executor) }}<template v-if="item.risk === 'high'">・<b class="warn-text">高風險</b></template><template v-if="item.dependsOn.length > 0">・依賴 {{ item.dependsOn.join("、") }}</template>）</span>
          <ul class="acceptance">
            <li v-for="criterion in item.acceptance" :key="criterion">{{ criterion }}</li>
          </ul>
        </li>
      </ol>
      <p v-if="confirmation.view.plan.risks.length > 0"><b>風險：</b>{{ confirmation.view.plan.risks.join("；") }}</p>
      <p v-if="confirmation.view.plan.decisions.length > 0"><b>需要主人決定：</b>{{ confirmation.view.plan.decisions.join("；") }}</p>
      <p v-if="confirmation.view.plan.preauthorizeClaudeFallback" class="warn">⚠ 這份計畫預先授權：Codex 不可用或額度不足時改由 Claude 寫程式</p>
    </template>

    <footer>
      <button class="primary" :disabled="busy" @click="act('approve')">{{ confirmation.kind === "game" ? "確認更新" : "核准" }}</button>
      <button :disabled="busy" @click="act('reject')">{{ confirmation.kind === "game" ? "先不要" : "拒絕" }}</button>
      <span v-if="error" class="error">{{ error }}</span>
    </footer>
  </section>
</template>

<style scoped>
.confirm { border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--border)); border-left: 4px solid var(--warn); border-radius: var(--radius-lg); padding: 12px 16px; background: var(--panel); box-shadow: var(--shadow); margin: 4px 0; max-width: 50em; }
.confirm header { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
.confirm header strong { color: var(--warn); font-size: 0.9em; letter-spacing: 0.03em; }
.goal { font-weight: 650; font-size: 1.04em; margin: 6px 0 8px; }
.items { padding-left: 20px; margin: 6px 0; }
.items > li { margin: 4px 0; }
.key { display: inline-block; min-width: 1.4em; font-weight: 700; color: var(--accent); }
.changes { color: var(--text); font-size: 1em; }
.acceptance { margin: 2px 0 4px; padding-left: 18px; font-size: 0.92em; color: var(--muted); }
footer { display: flex; gap: 8px; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); flex-wrap: wrap; }
</style>
