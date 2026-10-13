<script setup lang="ts">
// §65／§66 Codex 任務看板：版面照原版看板（~/.claude/scripts/codex-board/index.html）移植，
// 資料由 Core 轉接本機看板伺服器（手機透過 Studio 也看得到）。顏色用 Studio 的主題變數，切主題時一致。
// 清單每 3 秒更新；選到的任務每 1.5 秒更新（原版用 SSE，這裡用輪詢）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { api } from "../api";
import { store } from "../store";
import type { CodexJobDetail, CodexJobSummary, CodexQuota } from "../types";
import MarkdownText from "./MarkdownText";

type Job = CodexJobSummary;
type Filter = "all" | "running" | "completed" | "failed";
type Tab = "timeline" | "final" | "prompt" | "diff";

const FAILED = new Set(["failed", "error", "cancelled"]);
const STATUS_TEXT: Record<string, string> = { completed: "完成", failed: "失敗", error: "錯誤", cancelled: "已取消", running: "執行中", queued: "排隊中" };
const PHASE_TEXT: Record<string, string> = { starting: "啟動中", running: "執行中", editing: "修改檔案", verifying: "驗證中", done: "結束", failed: "失敗" };
const ICON: Record<string, string> = { msg: "💬", cmd: "▶", "cmd-ok": "✔", "cmd-fail": "✖", edit: "📝", "edit-done": "📝", error: "⛔", done: "🏁", final: "📄", info: "•" };
const STALL_MIN = 4;

const jobs = ref<Job[]>([]);
const quota = ref<CodexQuota | null>(null);
const connected = ref(false);
const lastUpdate = ref<Date>();
const filter = ref<Filter>("all");
const query = ref("");
const selectedId = ref<string>();
const detail = ref<CodexJobDetail>();
const tab = ref<Tab>("timeline");
const showCmds = ref(true);
const followTail = ref(true);
const diffText = ref("");
const diffBusy = ref(false);
const copied = ref(false);
const error = ref("");
const now = ref(Date.now());
const detailEl = ref<HTMLElement>();
const timers: Array<ReturnType<typeof setInterval>> = [];

const isRunning = (job: Job): boolean => !["completed", "failed", "error", "cancelled"].includes(job.rawStatus ?? job.status);
const bucket = (job: Job): Exclude<Filter, "all"> => (isRunning(job) ? "running" : FAILED.has(job.status) ? "failed" : "completed");
const cardClass = (job: Job): string => (isRunning(job) ? "running" : job.status);
const short = (job: Job): string => (job.label.startsWith(`${job.repo}：`) ? job.label.slice(job.repo.length + 1) : job.label);
const roleName = (job: Job): string => (job.by ? job.by.role || "未對應角色" : "");
const roleTip = (job: Job): string => (job.by ? `委派 session：${job.by.session || "（未命名）"}\n目錄：${job.by.cwd ?? ""}` : "");
const badgeText = (job: Job): string => (isRunning(job) ? PHASE_TEXT[job.phase ?? ""] || STATUS_TEXT.running! : STATUS_TEXT[job.status] || job.status);
const badgeClass = (job: Job): string => (isRunning(job) ? "running" : job.status);
const stalledMin = (job: Job): number =>
  isRunning(job) && job.lastEventAt ? Math.floor((now.value - new Date(job.lastEventAt).getTime()) / 60000) : 0;

function fmtTime(value?: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-TW", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
const hms = (value?: string | Date): string => (value ? new Date(value).toLocaleTimeString("zh-TW", { hour12: false }) : "");
function elapsed(job: Job): string {
  const end = job.completedAt ? new Date(job.completedAt).getTime() : now.value;
  const seconds = Math.max(0, Math.round((end - new Date(job.startedAt ?? end).getTime()) / 1000));
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function ago(value?: string | null): string {
  if (!value) return "";
  const s = Math.round((now.value - new Date(value).getTime()) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  return `${Math.floor(s / 3600)} 小時前`;
}
const fmtTok = (n?: number | null): string =>
  n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
const tokTip = (t: NonNullable<Job["tokens"]>): string => `輸入 ${t.input.toLocaleString()}（未快取 ${t.uncached.toLocaleString()}）｜輸出 ${t.output.toLocaleString()}`;
const quotaDelta = (p?: [number | null, number | null]): number | null => (p && p[0] != null && p[1] != null ? p[1] - p[0] : null);

const counts = computed(() => {
  const result = { running: 0, completed: 0, failed: 0 };
  for (const job of jobs.value) result[bucket(job)] += 1;
  return result;
});
const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return jobs.value.filter((job) => (filter.value === "all" || bucket(job) === filter.value)
    && (!q || `${job.label} ${job.repo} ${job.id} ${roleName(job)} ${job.by?.session ?? ""}`.toLowerCase().includes(q)));
});

/** 額度：跟「用量」分頁一樣顯示已用百分比（85% 以上變紅）與重置時間；過了重置時間視為 0%。 */
type QuotaWindow = NonNullable<CodexQuota["primary"]>;
function quotaChip(window?: QuotaWindow) {
  if (window === undefined) return undefined;
  const reset = Number(window.resets_at) || 0;
  const expired = reset > 0 && reset * 1000 <= now.value;
  const used = expired ? 0 : Math.min(100, Math.max(0, Math.round(Number(window.used_percent || 0))));
  const when = (sec: number) => new Date(sec * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return {
    name: (window.window_minutes ?? 0) >= 1440 ? "每週" : "短期",
    used,
    level: used >= 85 ? "high" : "",
    tip: expired ? "已過重置時間（尚無新資料，視為 0%）" : `已用 ${window.used_percent}%，${when(reset)} 重置`,
    reset: reset > 0 && !expired ? `重置 ${when(reset)}` : "",
  };
}
const quotaChips = computed(() => [quotaChip(quota.value?.primary), quotaChip(quota.value?.secondary)].filter((chip) => chip !== undefined));

/** 階段：建立 → 執行 → 修改檔案 → 驗證 → 完成／失敗。 */
const steps = computed(() => {
  const d = detail.value;
  if (d === undefined) return [];
  const order = ["start", "running", "editing", "verifying", "done"] as const;
  const names = { start: "建立", running: "執行", editing: "修改檔案", verifying: "驗證", done: "結束" };
  const current = isRunning(d) ? ({ starting: "start", running: "running", editing: "editing", verifying: "verifying" } as Record<string, string>)[d.phase ?? ""] ?? "running" : "done";
  const index = order.indexOf(current as typeof order[number]);
  const bad = !isRunning(d) && d.status !== "completed";
  return order.map((step, i) => ({
    label: step === "done" && !isRunning(d) ? (bad ? "失敗" : "完成") : names[step],
    cls: i < index ? "done" : i === index ? (current === "done" ? (bad ? "bad" : "done") : "now") : "",
  }));
});
const events = computed(() => (detail.value?.events ?? []).filter((event) => showCmds.value || !["cmd", "cmd-ok"].includes(event.kind)));
const ctxPercent = computed(() => {
  const t = detail.value?.tokens;
  return t?.ctxWindow ? Math.round((t.ctx / t.ctxWindow) * 100) : null;
});

async function refresh(): Promise<void> {
  try {
    const result = await api.codexJobs();
    jobs.value = result.jobs;
    quota.value = result.quota;
    connected.value = true;
    lastUpdate.value = new Date();
    error.value = "";
    if (selectedId.value === undefined && jobs.value.length > 0) void select((jobs.value.find(isRunning) ?? jobs.value[0]!).id);
  } catch (caught) {
    connected.value = false;
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function loadDetail(): Promise<void> {
  const id = selectedId.value;
  if (id === undefined) return;
  try {
    const next = await api.codexJob(id);
    if (selectedId.value !== id) return;
    const old = detail.value;
    const changed = old === undefined || old.id !== next.id || old.events.length !== next.events.length
      || old.rawStatus !== next.rawStatus || old.phase !== next.phase || old.finalOutput.length !== next.finalOutput.length;
    if (!changed) return;
    detail.value = next;
    if (tab.value === "timeline" && followTail.value && isRunning(next)) {
      await nextTick();
      if (detailEl.value) detailEl.value.scrollTop = detailEl.value.scrollHeight;
    }
  } catch {
    // 下一輪再試。
  }
}

async function select(id: string): Promise<void> {
  if (selectedId.value === id) return;
  selectedId.value = id;
  detail.value = undefined;
  diffText.value = "";
  tab.value = "timeline";
  await loadDetail();
}

async function runDiff(): Promise<void> {
  if (selectedId.value === undefined) return;
  diffBusy.value = true;
  diffText.value = "比對中…";
  try {
    diffText.value = (await api.codexDiff(selectedId.value)).text;
  } catch (caught) {
    diffText.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    diffBusy.value = false;
  }
}

async function openOnPc(target: "watch" | "log" | "repo"): Promise<void> {
  if (selectedId.value === undefined) return;
  try {
    await api.codexOpen(selectedId.value, target);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  }
}

async function copyId(): Promise<void> {
  if (selectedId.value === undefined) return;
  try {
    await navigator.clipboard?.writeText(selectedId.value);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1200);
  } catch {
    // 不允許剪貼簿時略過。
  }
}

// §71：委派或 /board 要看的任務。
watch(() => store.codexFocus.n, () => {
  if (store.codexFocus.id !== "") void select(store.codexFocus.id);
}, { immediate: true });

onMounted(() => {
  void refresh();
  timers.push(setInterval(() => void refresh(), 3000));
  timers.push(setInterval(() => { if (detail.value === undefined || isRunning(detail.value)) void loadDetail(); }, 1500));
  timers.push(setInterval(() => { now.value = Date.now(); }, 1000));
});
onBeforeUnmount(() => timers.forEach(clearInterval));
</script>

<template>
  <div class="cb">
    <header class="cb-head">
      <h1><span class="conn" :class="{ on: connected }" title="與看板伺服器的連線" />Codex 任務看板</h1>
      <div class="stats">
        <span class="stat">⏳ 執行中 <b>{{ counts.running }}</b></span>
        <span class="stat">✅ 完成 <b>{{ counts.completed }}</b></span>
        <span class="stat">❌ 失敗 <b>{{ counts.failed }}</b></span>
      </div>
      <div class="spacer" />
      <div class="cb-quota" aria-label="Codex 額度已用">
        <span v-if="quotaChips.length === 0" class="q"><small>Codex 額度：尚無資料</small></span>
        <span v-for="chip in quotaChips" :key="chip!.name" class="q" :class="chip!.level" :title="chip!.tip">
          {{ chip!.name }} <span class="bar"><i :style="{ width: `${chip!.used}%` }" /></span><b>{{ chip!.used }}%</b><small v-if="chip!.reset">{{ chip!.reset }}</small>
        </span>
      </div>
      <span class="updated">{{ lastUpdate ? `更新於 ${hms(lastUpdate)}` : "" }}</span>
    </header>

    <div class="cb-toolbar" role="toolbar">
      <button data-cb v-for="[key, name] in ([['all', '全部'], ['running', '執行中'], ['completed', '完成'], ['failed', '失敗']] as const)" :key="key"
        class="chip" :aria-pressed="filter === key" @click="filter = key">{{ name }}</button>
      <input v-model="query" class="search" type="search" placeholder="搜尋任務名稱、repo、jobId">
    </div>
    <p v-if="error && jobs.length === 0" class="cb-error">讀不到 Codex 看板：{{ error }}</p>

    <main class="cb-main">
      <section class="list" aria-label="任務清單">
        <div v-if="shown.length === 0" class="empty">沒有符合的任務</div>
        <button data-cb v-for="job in shown" :key="job.id" class="cb-card" :class="cardClass(job)" :aria-selected="job.id === selectedId" @click="select(job.id)">
          <div class="top"><span class="label" :title="job.label">{{ short(job) }}</span><span class="cb-badge" :class="badgeClass(job)">{{ badgeText(job) }}</span></div>
          <div class="cb-meta">
            <span v-if="job.by" class="cb-badge role" :title="roleTip(job)">👤 {{ roleName(job) }}</span>
            <span>{{ job.repo }}</span><span>{{ fmtTime(job.startedAt) }}</span>
            <span class="mono">⏱ {{ elapsed(job) }}</span>
            <span v-if="job.tokens" class="mono" :title="tokTip(job.tokens)">🪙 {{ fmtTok(job.tokens.input) }}</span>
            <span v-if="job.write === false" class="cb-badge ro">唯讀</span>
            <span v-if="stalledMin(job) > STALL_MIN" class="cb-badge warn">{{ stalledMin(job) }} 分鐘無動作</span>
          </div>
          <div class="last">{{ job.failReason ? `⛔ ${job.failReason}` : job.lastEvent ? `${ICON[job.lastEvent.kind] || "•"} ${job.lastEvent.text}` : "" }}</div>
        </button>
      </section>

      <section ref="detailEl" class="detail" aria-live="polite">
        <div v-if="detail === undefined" class="empty">{{ selectedId ? "載入中…" : "從左側選一個任務" }}</div>
        <template v-else>
          <div class="d-head">
            <h2>{{ short(detail) }} <span class="cb-badge" :class="badgeClass(detail)">{{ badgeText(detail) }}</span> <span v-if="detail.write === false" class="cb-badge ro">唯讀</span></h2>
            <div class="d-meta">
              <span v-if="detail.by" :title="detail.by.cwd">委派：<b>{{ roleName(detail) }}</b>{{ detail.by.session ? `（${detail.by.session}）` : "" }}</span>
              <span>repo：{{ detail.repo }}</span><span>開始：{{ fmtTime(detail.startedAt) }}</span>
              <span>結束：{{ detail.completedAt ? fmtTime(detail.completedAt) : "—" }}</span>
              <span class="mono">⏱ {{ elapsed(detail) }}</span>
              <span class="mono">{{ detail.id }}</span>
            </div>
            <div class="stepper"><div v-for="step in steps" :key="step.label" class="step" :class="step.cls">{{ step.label }}</div></div>
            <div class="d-actions">
              <button data-cb class="btn" title="在這台電腦開" @click="openOnPc('watch')">開 cmd 進度視窗</button>
              <button data-cb class="btn" title="在這台電腦開" @click="openOnPc('log')">開啟 log</button>
              <button data-cb class="btn" title="在這台電腦開" @click="openOnPc('repo')">開啟 repo 資料夾</button>
              <button data-cb class="btn" @click="copyId">{{ copied ? "已複製" : "複製 jobId" }}</button>
            </div>
          </div>
          <div v-if="detail.failReason" class="alert fail">⛔ {{ detail.failReason }}</div>
          <div v-if="stalledMin(detail) > STALL_MIN" class="alert warn">已 {{ stalledMin(detail) }} 分鐘沒有新動作（最後：{{ ago(detail.lastEventAt) }}），可能在跑長指令或卡住。</div>
          <div class="kpis">
            <div class="kpi"><div class="v">{{ elapsed(detail) }}</div><div class="k">經過時間</div></div>
            <div class="kpi"><div class="v">{{ detail.counts?.cmd ?? 0 }}</div><div class="k">執行指令</div></div>
            <div class="kpi"><div class="v" :class="{ fail: (detail.counts?.cmdFail ?? 0) > 0 }">{{ detail.counts?.cmdFail ?? 0 }}</div><div class="k">指令失敗</div></div>
            <div class="kpi"><div class="v">{{ detail.counts?.edits ?? 0 }}</div><div class="k">修改檔案次數</div></div>
            <div class="kpi"><div class="v">{{ detail.counts?.msgs ?? 0 }}</div><div class="k">Codex 說明</div></div>
            <div class="kpi"><div class="v small">{{ ago(detail.lastEventAt) || "—" }}</div><div class="k">最後動作</div></div>
          </div>
          <div v-if="!detail.tokens" class="kpis tok"><div class="k muted">token：找不到這個任務的 Codex 對話紀錄（任務尚未開始或不是本機 Codex 執行）</div></div>
          <div v-else class="kpis tok">
            <div class="kpi" title="每一步都會重送整段對話，所以輸入遠大於輸出；多數是快取"><div class="v">{{ fmtTok(detail.tokens.input) }}</div><div class="k">輸入 token（含快取）</div></div>
            <div class="kpi" title="這次新送出、沒命中快取的部分"><div class="v">{{ fmtTok(detail.tokens.uncached) }}</div><div class="k">未快取</div></div>
            <div class="kpi" :title="`含推理 ${detail.tokens.reasoning.toLocaleString()}`"><div class="v">{{ fmtTok(detail.tokens.output) }}</div><div class="k">輸出 token</div></div>
            <div class="kpi" title="最後一步送出的對話長度 / 模型上限；越長，之後每一步越貴"><div class="v">{{ fmtTok(detail.tokens.ctx) }}<small v-if="ctxPercent !== null" class="muted"> {{ ctxPercent }}%</small></div><div class="k">對話長度</div></div>
            <template v-for="[name, p] in ([['5 小時', detail.tokens.primary], ['每週', detail.tokens.weekly]] as const)" :key="name">
              <div v-if="quotaDelta(p) !== null" class="kpi" :title="`${name}額度已用 ${p![0]}% → ${p![1]}%；同時段其他 Codex 對話的用量也會算進來`">
                <div class="v" :class="{ warn: quotaDelta(p)! >= 10 }">+{{ quotaDelta(p) }}%</div><div class="k">{{ name }}額度（{{ p![0] }}→{{ p![1] }}%）</div>
              </div>
            </template>
            <div v-if="detail.tokens.resumed" class="k muted full">接續既有對話（--resume）：只計這次任務的回合，但對話長度包含先前內容。</div>
          </div>
          <div class="d-tabs" role="tablist">
            <button data-cb v-for="[key, name] in ([['timeline', '時間軸'], ['final', '最終回報'], ['prompt', '任務說明'], ['diff', '工作區比對']] as const)" :key="key"
              class="d-tab" role="tab" :aria-selected="tab === key" @click="tab = key">{{ name }}</button>
          </div>
          <div class="pane">
            <template v-if="tab === 'timeline'">
              <div class="tl-opts">
                <label><input v-model="showCmds" type="checkbox"> 顯示指令</label>
                <label><input v-model="followTail" type="checkbox"> 自動捲到最新</label>
                <span>{{ detail.events.length }} 個事件</span>
              </div>
              <ul class="tl">
                <li v-for="(event, index) in events" :key="index" :class="event.kind">
                  <span class="time">{{ hms(event.t) }}</span><span class="ico">{{ ICON[event.kind] || "•" }}</span>
                  <span class="txt">
                    <MarkdownText v-if="event.kind === 'msg'" :text="event.text" />
                    <template v-else>{{ event.text }}<span v-if="event.exit !== undefined && event.kind !== 'cmd-ok'" class="muted"> (exit {{ event.exit }})</span></template>
                  </span>
                </li>
              </ul>
              <p v-if="isRunning(detail)" class="muted">⏳ 執行中，畫面會自動更新…</p>
            </template>
            <template v-else-if="tab === 'final'">
              <MarkdownText v-if="detail.finalOutput" :text="detail.finalOutput" />
              <p v-else class="muted">Codex 尚未輸出最終回報。</p>
            </template>
            <MarkdownText v-else-if="tab === 'prompt'" :text="detail.prompt || '（沒有任務說明）'" />
            <template v-else>
              <p><button data-cb class="btn" :disabled="!detail.hasSnapshot || diffBusy" @click="runDiff">{{ detail.hasSnapshot ? "比對工作區（以委派前快照為準）" : "沒有快照" }}</button></p>
              <pre class="plain">{{ diffText || "尚未比對" }}</pre>
            </template>
          </div>
        </template>
      </section>
    </main>
  </div>
</template>

<style scoped>
/* 原版看板的色票對應到 Studio 的主題變數；執行中用藍色（原版 --run）。 */
.cb {
  --cb-line: var(--border); --cb-panel: var(--panel); --cb-panel-2: var(--sunken);
  --cb-ok-bg: color-mix(in srgb, var(--ok) 14%, transparent); --cb-fail: var(--danger); --cb-fail-bg: var(--danger-bg);
  --cb-run: #4f8ff7; --cb-run-bg: color-mix(in srgb, #4f8ff7 16%, transparent); --cb-code: var(--sunken);
  height: 100%; min-height: 0; display: flex; flex-direction: column; container-type: inline-size; font-size: 14px; line-height: 1.55;
}
.mono, code, pre { font-family: "Cascadia Code", Consolas, "Courier New", monospace; }
button { font: inherit; }

.cb-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 10px 14px; border-bottom: 1px solid var(--cb-line); }
.cb-head h1 { font-size: 16px; margin: 0; display: flex; align-items: center; gap: 8px; }
.conn { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); }
.conn.on { background: var(--ok); box-shadow: 0 0 0 3px var(--cb-ok-bg); }
.stats { display: flex; gap: 8px; flex-wrap: wrap; }
.stat { padding: 3px 10px; border-radius: 999px; background: var(--cb-panel-2); border: 1px solid var(--cb-line); font-size: 13px; }
.stat b, .cb-quota b { font-variant-numeric: tabular-nums; }
.spacer { flex: 1; }
.updated { color: var(--muted); font-size: 12px; }
.cb-quota { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 13px; }
.cb-quota .q { display: flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: var(--cb-panel-2); border: 1px solid var(--cb-line); }
.cb-quota .bar { width: 60px; height: 6px; border-radius: 3px; background: var(--cb-line); overflow: hidden; }
.cb-quota .bar i { display: block; height: 100%; background: var(--ok); }
.cb-quota .q.high .bar i { background: var(--danger); }
.cb-quota .q.high b { color: var(--danger); }
.cb-quota small { color: var(--muted); }

.cb-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 14px 0; }
.chip { border: 1px solid var(--cb-line); background: var(--cb-panel); padding: 4px 12px; border-radius: 999px; cursor: pointer; color: var(--text); }
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent, #fff); }
.search { flex: 1 1 200px; max-width: 320px; padding: 6px 10px; border: 1px solid var(--cb-line); border-radius: 8px; background: var(--cb-panel); color: var(--text); }
.cb-error { margin: 8px 14px 0; color: var(--cb-fail); font-size: 13px; }

/* 工作區夠寬時左右兩欄（同原版），窄時上下排。 */
.cb-main { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr; grid-template-rows: minmax(140px, 40%) 1fr; gap: 12px; padding: 10px 14px 14px; }
@container (min-width: 760px) {
  .cb-main { grid-template-columns: minmax(260px, 360px) 1fr; grid-template-rows: 1fr; }
}
.cb-main > section { min-width: 0; min-height: 0; }

.list { overflow: auto; display: flex; flex-direction: column; gap: 8px; padding-right: 4px; }
.cb-card { position: relative; background: var(--cb-panel); border: 1px solid var(--cb-line); border-radius: 10px; padding: 10px 12px 10px 16px; cursor: pointer; box-shadow: var(--shadow); text-align: left; width: 100%; color: var(--text); }
.cb-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 5px; border-radius: 10px 0 0 10px; background: var(--muted); }
.cb-card.completed::before { background: var(--ok); }
.cb-card.failed::before, .cb-card.error::before, .cb-card.cancelled::before { background: var(--cb-fail); }
.cb-card.running::before { background: var(--cb-run); animation: pulse 1.4s ease-in-out infinite; }
.cb-card[aria-selected="true"] { border-color: var(--accent); outline: 2px solid var(--accent); outline-offset: -1px; }
@keyframes pulse { 50% { opacity: 0.35; } }
.cb-card .top { display: flex; align-items: center; gap: 8px; }
.cb-card .label { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cb-card .cb-meta { color: var(--muted); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; margin-top: 2px; align-items: center; }
.cb-card .last { margin-top: 6px; font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cb-badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; white-space: nowrap; font-weight: 600; }
.cb-badge::before { display: none; }
.cb-badge.completed { background: var(--cb-ok-bg); color: var(--ok); }
.cb-badge.failed, .cb-badge.error, .cb-badge.cancelled { background: var(--cb-fail-bg); color: var(--cb-fail); }
.cb-badge.running { background: var(--cb-run-bg); color: var(--cb-run); }
.cb-badge.warn { background: var(--warn-bg); color: var(--warn); }
.cb-badge.ro { background: var(--cb-panel-2); color: var(--muted); border: 1px solid var(--cb-line); font-weight: 500; }
.cb-badge.role { background: var(--cb-panel-2); color: var(--accent); border: 1px solid var(--cb-line); }

.detail { overflow: auto; background: var(--cb-panel); border: 1px solid var(--cb-line); border-radius: 12px; box-shadow: var(--shadow); }
.empty { color: var(--muted); padding: 40px; text-align: center; }
.d-head { padding: 14px 18px 12px; border-bottom: 1px solid var(--cb-line); }
.d-head h2 { margin: 0 0 6px; font-size: 17px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.d-meta { color: var(--muted); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
.d-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.btn { border: 1px solid var(--cb-line); background: var(--cb-panel-2); padding: 4px 12px; border-radius: 8px; cursor: pointer; color: var(--text); }
.btn:hover:not(:disabled) { border-color: var(--accent); }

.stepper { display: flex; margin: 14px 0 4px; }
.step { flex: 1; text-align: center; font-size: 12px; color: var(--muted); position: relative; padding-top: 18px; }
.step::before { content: ""; position: absolute; top: 5px; left: 50%; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: var(--cb-line); z-index: 1; }
.step::after { content: ""; position: absolute; top: 10px; left: -50%; width: 100%; height: 2px; background: var(--cb-line); }
.step:first-child::after { display: none; }
.step.done { color: var(--text); }
.step.done::before, .step.done::after { background: var(--ok); }
.step.now { color: var(--cb-run); font-weight: 600; }
.step.now::before { background: var(--cb-run); box-shadow: 0 0 0 4px var(--cb-run-bg); animation: pulse 1.4s infinite; }
.step.now::after { background: var(--ok); }
.step.bad { color: var(--cb-fail); font-weight: 600; }
.step.bad::before { background: var(--cb-fail); }

.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; padding: 12px 18px; border-bottom: 1px solid var(--cb-line); }
.kpi { background: var(--cb-panel-2); border: 1px solid var(--cb-line); border-radius: 10px; padding: 8px 12px; }
.kpi .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.kpi .v.small { font-size: 14px; }
.kpi .v.fail { color: var(--cb-fail); }
.kpi .v.warn { color: var(--warn); }
.kpi .v small { font-size: 12px; }
.kpi .k, .kpis .k { font-size: 12px; color: var(--muted); }
.kpis.tok { padding-top: 0; }
.kpis .full { grid-column: 1 / -1; }

.alert { margin: 12px 18px 0; padding: 10px 12px; border-radius: 8px; }
.alert.fail { background: var(--cb-fail-bg); color: var(--cb-fail); }
.alert.warn { background: var(--warn-bg); color: var(--warn); }

.d-tabs { display: flex; gap: 4px; padding: 10px 18px 0; border-bottom: 1px solid var(--cb-line); flex-wrap: wrap; }
.d-tab { border: 0; background: none; padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; border-radius: 0; color: var(--muted); }
.d-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.pane { padding: 14px 18px 24px; }

.tl-opts { display: flex; gap: 14px; align-items: center; color: var(--muted); font-size: 12.5px; margin-bottom: 8px; flex-wrap: wrap; }
.tl { list-style: none; margin: 0; padding: 0; }
.tl > li { display: grid; grid-template-columns: 64px 22px 1fr; gap: 8px; padding: 5px 0; border-bottom: 1px dashed var(--cb-line); align-items: start; }
.tl .time { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; padding-top: 1px; }
.tl .ico { text-align: center; }
.tl .txt { min-width: 0; overflow-wrap: anywhere; }
.tl > li.cmd .txt, .tl > li.cmd-ok .txt, .tl > li.cmd-fail .txt { font-family: "Cascadia Code", Consolas, monospace; font-size: 12.5px; color: var(--muted); }
.tl > li.cmd-fail .txt { color: var(--cb-fail); }
.tl > li.error .txt { color: var(--cb-fail); font-weight: 600; }
.tl > li.edit .txt { color: var(--warn); font-weight: 600; }
.tl > li.msg .txt { background: var(--cb-panel-2); border: 1px solid var(--cb-line); border-radius: 8px; padding: 8px 10px; }
pre.plain { white-space: pre-wrap; background: var(--cb-code); padding: 12px; border-radius: 8px; font-size: 12.5px; margin: 0; }
.muted { color: var(--muted); }
</style>
