<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";

import { api, clearToken, getCore, getToken, HOSTED, setCore, setToken } from "./api";
import { connect, store, meetingEnd } from "./store";
import avatarImage from "./assets/alice-pixel/avatar_24.png";
import ChatPanel from "./components/ChatPanel.vue";
import CodexTab from "./components/CodexTab.vue";
import MeetingsTab from "./components/MeetingsTab.vue";
import FortuneTab from "./components/FortuneTab.vue";
import WeatherTab from "./components/WeatherTab.vue";
import MorningCard from "./components/MorningCard.vue";
import GarbageTab from "./components/GarbageTab.vue";
import GamesTab from "./components/GamesTab.vue";
import ThemePicker from "./components/ThemePicker.vue";
import UsageTab from "./components/UsageTab.vue";

// §51：拿掉「計畫」分頁（專案改由艾莉絲追蹤任務；Core 的計畫功能保留，核准卡片仍在聊天區）。
// §92：右方功能列表依左側分頁分開：工作看專案、會議、Codex、用量；聊天看占卜、天氣（§95）。
type WorkTab = "games" | "meetings" | "codex" | "usage";
type ChatTab = "fortune" | "weather" | "garbage";

const workTab = ref<WorkTab>("games");
const chatTab = ref<ChatTab>("fortune");
/** §96 早安小卡的連結：切到聊天側的天氣或占卜（窄視窗時切到右邊）。 */
function openChatTab(tab: ChatTab): void {
  chatTab.value = tab;
  narrowView.value = "work";
}

// §78：左側「工作／聊天」分頁，各自一份紀錄；切過去就清掉那邊的新回覆標記。
function selectThread(thread: "work" | "chat"): void {
  store.thread = thread;
  store.unread[thread] = false;
}

// §73：今天還沒結束的會議數（分頁上的數字），每分鐘重算。
const clock = ref(Date.now());
window.setInterval(() => { clock.value = Date.now(); }, 60_000);
const meetingsToday = computed(() => {
  const today = new Date(clock.value);
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return store.meetings.filter((meeting) => meeting.date === key && meetingEnd(meeting) > clock.value).length;
});

/** 窄視窗時只顯示一邊（W-3）。 */
const narrowView = ref<"chat" | "work">("chat");
// §71：委派或 /board 開 Studio 時帶 ?codex=<任務 id>，或 Studio 已開著時收到 codex.focus：切到 Codex 分頁。
const initialCodex = new URLSearchParams(window.location.search).get("codex");
if (initialCodex !== null && /^task-[a-z0-9-]+$/u.test(initialCodex)) {
  workTab.value = "codex";
  store.codexFocus = { id: initialCodex, n: store.codexFocus.n + 1 };
  history.replaceState(null, "", window.location.pathname + window.location.hash);
}
watch(() => store.codexFocus.n, () => {
  if (store.codexFocus.id === "") return;
  selectThread("work");
  workTab.value = "codex";
  narrowView.value = "work";
});
const pastedToken = ref("");

const ACTIVITY: Record<string, string> = { idle: "待命", talking: "對話中", busy: "工作中", sleeping: "睡著了" };
const ENERGY: Record<string, string> = { low: "有點累", normal: "普通", high: "精神很好" };
const SLEEP: Record<string, string> = { idle_timeout: "太久沒說話", night: "夜深了", reasoning_unavailable: "推理引擎連不上" };

const statusText = computed(() => {
  const character = store.character;
  if (character === undefined) return "";
  const sleep = character.sleepReason === undefined ? "" : `（${SLEEP[character.sleepReason] ?? character.sleepReason}）`;
  return `${ACTIVITY[character.activity] ?? character.activity}${sleep}・${ENERGY[character.energy] ?? character.energy}`;
});

const connectionText = computed(() => ({
  connecting: "連線中…", open: "已連線", closed: "連線中斷，重試中…", unauthorized: "需要登入",
}[store.connection]));

const pendingCount = computed(() => store.confirmations.length);

/** §51「更新進度」：請艾莉絲依各專案卡的任務清單核對進度；專案卡在她改任務時自動更新（games.updated）。 */
const refreshReplyId = ref<string>();
const refreshError = ref("");
const refreshing = computed(() => refreshReplyId.value !== undefined && !store.endedReplies.includes(refreshReplyId.value));

/** §64 代理人模式：開啟前先確認；開著時頂端一直顯示。 */
const proxyError = ref("");
async function toggleProxy(): Promise<void> {
  const next = !store.proxy;
  if (next && !window.confirm("開啟代理人模式？\n\nALICe 可以把你在對話裡明確交代的指示，直接傳給同事 session（不用再貼卡片）。\n上傳、刪除、寫知識庫這類事，對方仍會先回報、等你本人確認。\n不會自動關閉，用完請按頂端的「關閉」。")) return;
  proxyError.value = "";
  try {
    store.proxy = (await api.setProxy(next)).enabled;
  } catch (error) {
    proxyError.value = error instanceof Error ? error.message : String(error);
  }
}

async function refreshProgress(): Promise<void> {
  refreshError.value = "";
  workTab.value = "games";
  try {
    refreshReplyId.value = (await api.refreshProgress()).replyId;
  } catch (error) {
    refreshError.value = error instanceof Error ? error.message : String(error);
  }
}

/** 點「等你核准」：切到聊天，捲到第一張核准卡片。 */
function showConfirmations(): void {
  narrowView.value = "chat";
  requestAnimationFrame(() => document.querySelector(".confirm")?.scrollIntoView({ behavior: "smooth", block: "center" }));
}

/** §91：放在其他網址的 Studio 要填 Core 網址。 */
const coreUrl = ref(getCore() ?? "");
const pageOrigin = window.location.origin;
const loginError = ref("");

function usePastedToken(): void {
  const token = pastedToken.value.trim();
  loginError.value = "";
  if (HOSTED && !setCore(coreUrl.value)) {
    loginError.value = "Core 網址要像 https://電腦名.xxx.ts.net 或 http://127.0.0.1:7788";
    return;
  }
  if (!/^[0-9a-fA-F]{16,}$/u.test(token)) {
    if (HOSTED && getToken() !== undefined && token === "") {
      connect();
      return;
    }
    loginError.value = "token 格式不對";
    return;
  }
  setToken(token);
  pastedToken.value = "";
  connect();
}

/** 聊天區占畫面寬度的百分比，拖曳中間的分隔線調整，存在這個瀏覽器（§38）。 */
const SPLIT_KEY = "alice.split";
const SPLIT_DEFAULT = 56.5;
const chatPercent = ref(readSplit());
const layoutStyle = computed(() => ({ "--chat-w": `${chatPercent.value}%` }));

function readSplit(): number {
  try {
    const value = Number(window.localStorage.getItem(SPLIT_KEY));
    return value >= 15 && value <= 85 ? value : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}

function saveSplit(): void {
  try {
    window.localStorage.setItem(SPLIT_KEY, chatPercent.value.toFixed(1));
  } catch {
    // 瀏覽器不讓存就只在這次有效。
  }
}

function setSplit(percent: number): void {
  chatPercent.value = Math.min(85, Math.max(15, percent));
}

function startDrag(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement;
  const layout = handle.parentElement;
  if (layout === null) return;
  event.preventDefault();
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add("dragging-split");
  const move = (moveEvent: PointerEvent): void => {
    const box = layout.getBoundingClientRect();
    // 跟 CSS 一樣夾在「聊天 ≥ 320px、右方 ≥ 360px」，拖過頭再拖回來不會有一段沒反應。
    const x = Math.min(box.width - 360, Math.max(320, moveEvent.clientX - box.left));
    setSplit((x / box.width) * 100);
  };
  const stop = (): void => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    document.body.classList.remove("dragging-split");
    saveSplit();
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
}

function splitKey(event: KeyboardEvent): void {
  const step = event.shiftKey ? 10 : 2;
  if (event.key === "ArrowLeft") setSplit(chatPercent.value - step);
  else if (event.key === "ArrowRight") setSplit(chatPercent.value + step);
  else if (event.key === "Home") setSplit(SPLIT_DEFAULT);
  else return;
  event.preventDefault();
  saveSplit();
}

function resetSplit(): void {
  setSplit(SPLIT_DEFAULT);
  saveSplit();
}

function logout(): void {
  clearToken();
  window.location.reload();
}

onMounted(() => connect());
</script>

<template>
  <div class="app" :class="`narrow-${narrowView}`">
    <header class="topbar">
      <div class="identity">
        <span class="avatar" :class="store.character?.activity" aria-hidden="true"><img :src="avatarImage" alt="" width="48" height="48"></span>
        <div>
          <strong class="name">ALICe</strong>
          <span class="muted small status">{{ statusText }}</span>
        </div>
      </div>
      <button v-if="pendingCount > 0" class="pending-chip" title="有計畫、任務或進度等你確認，在聊天區最下面" @click="showConfirmations">
        {{ pendingCount }} 件等你核准
      </button>
      <button v-if="store.proxy" class="pending-chip proxy-chip" title="ALICe 可以把你交代的指示直接傳給同事 session；按一下關閉" @click="toggleProxy">
        代理人模式開啟中・關閉
      </button>
      <nav class="narrow-switch" aria-label="切換畫面">
        <button :class="{ active: narrowView === 'chat' }" @click="narrowView = 'chat'">對話<span v-if="pendingCount > 0" class="dot">{{ pendingCount }}</span></button>
        <button :class="{ active: narrowView === 'work' }" @click="narrowView = 'work'">工作</button>
      </nav>
      <div class="connection" :class="store.connection">
        <span class="light" :title="connectionText" /><span class="label">{{ connectionText }}</span>
        <ThemePicker />
        <button v-if="store.connection === 'open' && !store.proxy" class="link small" title="開啟後，ALICe 可以把你交代的指示直接傳給同事 session" @click="toggleProxy">代理人模式</button>
        <span v-if="proxyError" class="error small" :title="proxyError">代理人模式切換失敗</span>
        <button v-if="store.connection === 'open'" class="link small" title="清除這個瀏覽器存的 token" @click="logout">登出</button>
        <button v-else-if="HOSTED && store.connection === 'closed'" class="link small" title="清除這個瀏覽器存的 Core 網址與 token，重新填" @click="logout">連線設定</button>
      </div>
    </header>

    <main v-if="store.connection === 'unauthorized'" class="login">
      <h2>需要登入</h2>
      <template v-if="HOSTED">
        <p>這個網頁只是介面，ALICe 本身在你的電腦上（Core）。填入 Core 的網址和 token 連過去；Core 的 <code>alice.local.json</code> 要把這個網頁的網址（<code>{{ pageOrigin }}</code>）加進 <code>remoteOrigins</code>。</p>
        <p class="muted small">在 Core 那台電腦上用：<code>http://127.0.0.1:7788</code>；手機或其他電腦：Tailscale 的 <code>https://電腦名.xxx.ts.net</code>。</p>
      </template>
      <template v-else>
        <p>請在 Alice Core 的 <code>core</code> 資料夾執行 <code>npm run studio</code>，會自動用正確的網址開啟 Web Studio。</p>
        <p class="muted small">或貼上 token（在 <code>%APPDATA%\alice\token</code>）：</p>
      </template>
      <form class="token-form" :class="{ hosted: HOSTED }" @submit.prevent="usePastedToken">
        <input v-if="HOSTED" v-model="coreUrl" type="url" autocomplete="url" placeholder="Core 網址" />
        <input v-model="pastedToken" type="password" autocomplete="off" placeholder="token（在 %APPDATA%\alice\token）" />
        <button class="primary" type="submit">連線</button>
      </form>
      <p v-if="loginError" class="error small">{{ loginError }}</p>
    </main>

    <main v-else class="layout" :style="layoutStyle">
      <section class="chat-column">
        <p v-if="store.loadError" class="error banner">載入失敗：{{ store.loadError }}</p>
        <div v-if="store.setupWarnings.length > 0" class="warn banner setup">
          <b>設定未完成（部分功能停用）</b>
          <ul><li v-for="warning in store.setupWarnings" :key="warning">{{ warning }}</li></ul>
        </div>
        <nav class="threads" role="tablist" aria-label="對話分頁">
          <button v-for="key in (['work', 'chat'] as const)" :key="key" role="tab" :aria-selected="store.thread === key" :class="{ active: store.thread === key }" @click="selectThread(key)">
            {{ key === "work" ? "工作" : "聊天" }}<span v-if="store.unread[key]" class="unread-dot" title="有新回覆" />
          </button>
        </nav>
        <MorningCard v-if="store.thread === 'chat'" @open="openChatTab" />
        <ChatPanel :key="store.thread" :thread="store.thread" />
      </section>
      <div
        class="splitter" role="separator" aria-orientation="vertical" aria-label="調整聊天區寬度"
        :aria-valuenow="Math.round(chatPercent)" aria-valuemin="15" aria-valuemax="85" tabindex="0"
        title="拖曳調整寬度；按兩下恢復預設" @pointerdown="startDrag" @dblclick="resetSplit" @keydown="splitKey"
      />
      <section class="work-column">
        <div class="tabbar">
        <nav v-if="store.thread === 'chat'" class="tabs" role="tablist">
          <button role="tab" :aria-selected="chatTab === 'fortune'" :class="{ active: chatTab === 'fortune' }" @click="chatTab = 'fortune'">占卜</button>
          <button role="tab" :aria-selected="chatTab === 'weather'" :class="{ active: chatTab === 'weather' }" @click="chatTab = 'weather'">天氣</button>
          <button role="tab" :aria-selected="chatTab === 'garbage'" :class="{ active: chatTab === 'garbage' }" @click="chatTab = 'garbage'">垃圾車</button>
        </nav>
        <nav v-else class="tabs" role="tablist" style="padding-right: 150px">
          <button role="tab" :aria-selected="workTab === 'games'" :class="{ active: workTab === 'games' }" @click="workTab = 'games'">專案</button>
          <button role="tab" :aria-selected="workTab === 'meetings'" :class="{ active: workTab === 'meetings' }" :title="meetingsToday > 0 ? `今天還有 ${meetingsToday} 個會議` : undefined" @click="workTab = 'meetings'">會議<span v-if="meetingsToday > 0" class="tab-badge">{{ meetingsToday }}</span></button>
          <button role="tab" :aria-selected="workTab === 'codex'" :class="{ active: workTab === 'codex' }" @click="workTab = 'codex'">Codex</button>
          <button role="tab" :aria-selected="workTab === 'usage'" :class="{ active: workTab === 'usage' }" @click="workTab = 'usage'">用量</button>
        </nav>
        <span v-if="store.thread === 'work'" class="tab-actions">
          <span v-if="refreshError" class="error small" :title="refreshError">{{ refreshError }}</span>
          <button
            class="primary small" :disabled="refreshing || store.connection !== 'open'"
            title="請 ALICe 依專案卡的任務清單核對各專案進度，有變化會直接更新卡片" @click="refreshProgress"
          >{{ refreshing ? "更新中…" : "更新進度" }}</button>
        </span>
        </div>
        <div class="tab-body">
          <FortuneTab v-if="store.thread === 'chat' && chatTab === 'fortune'" />
          <WeatherTab v-else-if="store.thread === 'chat' && chatTab === 'weather'" />
          <GarbageTab v-else-if="store.thread === 'chat'" />
          <GamesTab v-else-if="workTab === 'games'" />
          <MeetingsTab v-else-if="workTab === 'meetings'" />
          <CodexTab v-else-if="workTab === 'codex'" />
          <UsageTab v-else />
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.app { height: 100dvh; display: flex; flex-direction: column; }
.topbar { display: flex; align-items: center; gap: 14px; padding: 10px 20px; border-bottom: var(--bw) solid var(--border); background: var(--topbar-bg, var(--panel)); }
.identity { display: flex; align-items: center; gap: 11px; min-width: 0; }
.identity .name { letter-spacing: 0.04em; font-size: 1.02em; }
.identity .status { display: block; line-height: 1.3; }
/* 頭像外圈表示狀態：工作中、對話中是玫瑰色，待命是綠色，睡著是灰色。 */
/* §49 頭像：像素艾莉絲的臉部特寫 avatar_24，放大 2 倍（整數倍才清楚）成 48px；框是圓角方形。 */
.avatar {
  width: 48px; height: 48px; border-radius: 11px; flex: none; overflow: hidden;
  background: var(--sunken); color: #fff; display: grid; place-items: center;
  font-weight: 700; letter-spacing: 0.02em;
  box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--ok);
}
.avatar.talking, .avatar.busy { box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--accent); }
.avatar.sleeping { box-shadow: 0 0 0 2px var(--panel), 0 0 0 4px var(--faint); filter: saturate(0.4); }
.avatar img { width: 48px; height: 48px; display: block; image-rendering: pixelated; }
.pending-chip {
  border: none; background: var(--warn-bg); color: var(--warn); font-weight: 600;
  padding: 3px 12px; border-radius: 999px; font-size: 0.86em;
}
.pending-chip:hover:not(:disabled) { color: var(--warn); box-shadow: inset 0 0 0 1px var(--warn); }
/* 代理人模式開啟中：用主色，和「等你核准」區分。 */
.proxy-chip { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
.proxy-chip:hover:not(:disabled) { color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.connection { margin-left: auto; display: flex; align-items: center; gap: 7px; font-size: 0.84em; color: var(--muted); white-space: nowrap; }
.light { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
.connection.open .light { background: var(--ok); }
.connection.closed .light, .connection.unauthorized .light { background: var(--danger); }
.narrow-switch { display: none; gap: 2px; padding: 3px; background: var(--sunken); border-radius: var(--radius-lg); }
.narrow-switch button { border: none; background: none; padding: 3px 12px; border-radius: var(--radius); font-size: 0.92em; }
.narrow-switch button.active { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }
/* 聊天區至少 320px、右方至少 360px，中間是寬度 0 的分隔線欄。 */
.layout { flex: 1; min-height: 0; display: grid; grid-template-columns: clamp(320px, var(--chat-w, 56.5%), calc(100% - 360px)) 0 minmax(0, 1fr); }
.splitter { position: relative; z-index: 5; touch-action: none; outline: none; }
.splitter::before {
  content: ""; position: absolute; top: 0; bottom: 0; left: -5px; width: 10px; cursor: col-resize;
}
.splitter::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: -2px; width: 3px; border-radius: 2px;
  background: var(--accent); opacity: 0; transition: opacity 0.15s; pointer-events: none;
}
.splitter:hover::after, .splitter:focus-visible::after, :global(body.dragging-split) .splitter::after { opacity: 0.7; }
:global(body.dragging-split) { cursor: col-resize; user-select: none; }
.chat-column { min-height: 0; display: flex; flex-direction: column; border-right: var(--bw) solid var(--border); background: var(--chat-bg, var(--panel)); }
.chat-column > :last-child { flex: 1; min-height: 0; }
.threads { display: flex; gap: 4px; padding: 8px 20px 0; border-bottom: var(--bw) solid var(--border); }
.threads button { border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 6px 12px; color: var(--muted); }
.threads button.active { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.unread-dot { display: inline-block; width: 7px; height: 7px; margin-left: 5px; border-radius: 50%; background: var(--accent); vertical-align: middle; }
.work-column { min-height: 0; display: flex; flex-direction: column; background: var(--work-bg, var(--bg)); }
.tab-badge { display: inline-block; min-width: 1.4em; margin-left: 5px; padding: 0 5px; border-radius: 999px; background: var(--accent); color: var(--on-accent, #fff); font-size: 0.75em; line-height: 1.5; text-align: center; }
.tabs { display: flex; gap: 4px; padding: 10px 14px 0; border-bottom: var(--bw) solid var(--border); overflow-x: auto; }
.tabs button {
  border: none; border-bottom: 2px solid transparent; border-radius: 0; background: none;
  padding: 6px 10px 8px; color: var(--muted); white-space: nowrap;
}
.tabs button:hover:not(:disabled) { color: var(--text); }
.tabs button.active { border-bottom-color: var(--accent); color: var(--text); font-weight: 600; }
.tabbar { position: relative; }
.tab-actions { position: absolute; right: 14px; top: 0; bottom: 0; display: flex; align-items: center; gap: 8px; max-width: 60%; }
.tab-actions .error { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab-actions button { white-space: nowrap; }
.tab-body { flex: 1; min-height: 0; }
.dot {
  display: inline-block; min-width: 1.5em; margin-left: 5px; padding: 0 5px; border-radius: 999px;
  background: var(--accent); color: #fff; font-size: 0.72em; line-height: 1.6; text-align: center; font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.banner { margin: 10px 20px 0; }
.setup ul { margin: 4px 0 0; padding-left: 18px; font-size: 0.9em; }
.login { max-width: 520px; margin: 12vh auto 0; padding: 28px; background: var(--panel); border: var(--bw) solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow); }
.login h2 { margin-top: 0; }
.token-form { display: flex; gap: 8px; }
.token-form input { flex: 1; min-width: 0; }
.token-form.hosted { flex-wrap: wrap; }
.token-form.hosted input { flex-basis: 100%; }

@media (max-width: 820px) {
  .topbar { padding: 8px 12px; gap: 10px; }
  .narrow-switch { display: flex; }
  .identity .status, .connection .label { display: none; }
  .layout { grid-template-columns: minmax(0, 1fr); }
  .chat-column { border-right: none; }
  .splitter { display: none; }
  .narrow-chat .work-column, .narrow-work .chat-column { display: none; }
  /* 手機上「聊天」分頁的數字就是待核准提醒，不再另外顯示。 */
  .pending-chip { display: none; }
  .narrow-switch button { display: inline-flex; align-items: center; white-space: nowrap; }
  .identity .name { font-size: 0.95em; }
  .banner { margin: 8px 12px 0; }
}
</style>
