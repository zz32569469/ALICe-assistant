<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";

import { api, type Thread } from "../api";
import { loadOlderMessages, store } from "../store";
import miniAvatar from "../assets/alice-pixel/avatar_24.png";
import AliceSprite from "./AliceSprite.vue";
import ConfirmCard from "./ConfirmCard.vue";
import MarkdownText from "./MarkdownText";
import UploadImage from "./UploadImage.vue";
import { showName } from "../displayName";

const props = withDefaults(defineProps<{ thread?: Thread }>(), { thread: "work" });
const isChat = computed(() => props.thread === "chat");
/** §78：這個分頁的訊息與串流中的回覆。 */
const messages = computed(() => (isChat.value ? store.chatMessages : store.messages));
const hasOlder = computed(() => (isChat.value ? store.chatHasOlder : store.hasOlder));

const PLAN_SUFFIX = "\n\n（主人要求把這件事做成計畫，請提出計畫草案。）";

const draft = ref("");
/** §83 待送出的截圖：上傳完成的有 name；preview 是本機預覽網址。 */
type Attachment = { key: number; preview: string; name?: string; error?: string };
const attachments = ref<Attachment[]>([]);
const MAX_IMAGES = 6;
let attachmentKey = 0;
const uploading = computed(() => attachments.value.some((entry) => entry.name === undefined && entry.error === undefined));
const readyImages = computed(() => attachments.value.filter((entry) => entry.name !== undefined).map((entry) => entry.name!));
const canSend = computed(() => !sending.value && !uploading.value && (draft.value.trim() !== "" || readyImages.value.length > 0) && store.connection === "open");

async function addImages(files: File[]): Promise<void> {
  for (const file of files.filter((entry) => entry.type.startsWith("image/"))) {
    if (attachments.value.length >= MAX_IMAGES) {
      sendError.value = `一次最多附 ${MAX_IMAGES} 張截圖`;
      return;
    }
    const entry: Attachment = { key: (attachmentKey += 1), preview: URL.createObjectURL(file) };
    attachments.value.push(entry);
    try {
      const { name } = await api.uploadImage(file);
      const found = attachments.value.find((candidate) => candidate.key === entry.key);
      if (found !== undefined) found.name = name;
    } catch (error) {
      const found = attachments.value.find((candidate) => candidate.key === entry.key);
      if (found !== undefined) found.error = error instanceof Error ? error.message : String(error);
    }
  }
}

function removeAttachment(key: number): void {
  const found = attachments.value.find((entry) => entry.key === key);
  if (found !== undefined) URL.revokeObjectURL(found.preview);
  attachments.value = attachments.value.filter((entry) => entry.key !== key);
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
  if (files.length === 0) return;
  event.preventDefault();
  void addImages(files);
}

const dragging = ref(false);
function onDrop(event: DragEvent): void {
  dragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.some((file) => file.type.startsWith("image/"))) void addImages(files);
}
const deep = ref(false);
const sending = ref(false);
const sendError = ref("");
const list = ref<HTMLElement>();
const loadingOlder = ref(false);
/** 輸入框隨內容長高（2～10 行）。 */
const rows = computed(() => Math.min(10, Math.max(2, draft.value.split("\n").length)));

const streamingEntries = computed(() => Object.entries(store.streaming).filter(([replyId]) => (store.chatReplies[replyId] === true) === isChat.value));

function nearBottom(): boolean {
  const element = list.value;
  return element === undefined || element.scrollHeight - element.scrollTop - element.clientHeight < 160;
}

async function scrollToBottom(force = false): Promise<void> {
  if (!force && !nearBottom()) return;
  await nextTick();
  const element = list.value;
  if (element !== undefined) element.scrollTop = element.scrollHeight;
}

watch(() => [messages.value.length, JSON.stringify(store.streaming), store.confirmations.length], () => void scrollToBottom());
onMounted(() => void scrollToBottom(true));

async function send(asPlan = false): Promise<void> {
  const text = draft.value.trim();
  if (!canSend.value) return;
  const images = readyImages.value;
  sending.value = true;
  sendError.value = "";
  try {
    // 「做成計畫」與命令列的 /計畫 相同：附上要求並用深想。
    await api.send(asPlan ? `${text}${PLAN_SUFFIX}` : text, asPlan || deep.value, props.thread, images);
    draft.value = "";
    for (const entry of attachments.value) URL.revokeObjectURL(entry.preview);
    attachments.value = [];
    deep.value = false;
    await scrollToBottom(true);
  } catch (error) {
    sendError.value = error instanceof Error ? error.message : String(error);
  } finally {
    sending.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
}

async function older(): Promise<void> {
  const element = list.value;
  const before = element?.scrollHeight ?? 0;
  loadingOlder.value = true;
  try {
    await loadOlderMessages(props.thread);
    await nextTick();
    if (element !== undefined) element.scrollTop += element.scrollHeight - before;
  } finally {
    loadingOlder.value = false;
  }
}

function time(iso: string): string {
  const date = new Date(iso);
  const today = new Date().toDateString() === date.toDateString();
  return today ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 同事 session 透過轉接傳來的訊息（S-1）：開頭「［來自 session〈名稱〉］」。 */
function peerOf(text: string): { name: string; body: string } | undefined {
  const match = /^［來自 session〈([^〉\r\n]{1,40})〉］[ \t]*\r?\n?/u.exec(text);
  return match === null ? undefined : { name: match[1]!, body: text.slice(match[0].length) };
}

function displayText(text: string): string {
  return text.endsWith(PLAN_SUFFIX) ? `${text.slice(0, -PLAN_SUFFIX.length)}\n（做成計畫）` : text;
}
</script>

<template>
  <div class="chat">
    <div ref="list" class="messages" aria-live="polite">
      <button v-if="hasOlder && messages.length > 0" class="older link" :disabled="loadingOlder" @click="older">
        {{ loadingOlder ? "載入中…" : "載入更早的訊息" }}
      </button>
      <p v-if="messages.length === 0 && streamingEntries.length === 0" class="empty">
        {{ isChat ? "想聊什麼都可以，ALICe 陪你聊聊。這裡的紀錄和工作分開。" : "跟 ALICe 說要做什麼，或問「各專案現在怎樣」。" }}
      </p>
      <template v-for="message in messages" :key="message.id">
        <div v-if="message.role === 'system'" class="system">
          <span>{{ showName(message.text) }}</span>
          <time>{{ time(message.createdAt) }}</time>
        </div>
        <div v-else-if="message.role === 'user' && peerOf(message.text)" class="bubble peer">
          <div class="peer-label">來自同事 session〈{{ peerOf(message.text)!.name }}〉</div>
          <div class="plain">{{ showName(peerOf(message.text)!.body) }}</div>
          <time>{{ time(message.createdAt) }}</time>
        </div>
        <article v-else-if="message.role === 'alice'" class="note">
          <span class="mini-avatar" aria-hidden="true"><img :src="miniAvatar" alt="" width="48" height="48"></span>
          <div class="note-body">
            <header><b>ALICe</b><time>{{ time(message.createdAt) }}</time></header>
            <MarkdownText :text="message.text" />
          </div>
        </article>
        <div v-else class="bubble user">
          <div v-if="message.text" class="plain">{{ showName(displayText(message.text)) }}</div>
          <div v-if="message.images?.length" class="shots"><UploadImage v-for="name in message.images" :key="name" :name="name" /></div>
          <time>{{ time(message.createdAt) }}</time>
        </div>
      </template>
      <article v-for="[replyId, text] in streamingEntries" :key="replyId" class="note streaming">
        <span class="mini-avatar" aria-hidden="true"><img :src="miniAvatar" alt="" width="48" height="48"></span>
        <div class="note-body">
          <header><b>ALICe</b><span class="muted small">{{ text === "" ? "正在想…" : "回覆中…" }}</span></header>
          <MarkdownText v-if="text !== ''" :text="text" />
        </div>
      </article>
      <div v-for="error in store.replyErrors.filter((entry) => (store.chatReplies[entry.replyId] === true) === isChat).slice(-3)" :key="error.replyId + error.at" class="system error-line">
        回覆失敗：{{ error.message }}（訊息已保留，可以再送一次）
      </div>
      <ConfirmCard v-for="confirmation in (isChat ? [] : store.confirmations)" :key="confirmation.kind + confirmation.id" :confirmation="confirmation" />
    </div>

    <form class="composer" @submit.prevent="send()">
      <!-- §49 像素艾莉絲站在輸入框上緣，依狀態待機或走動。 -->
      <AliceSprite class="composer-sprite" :activity="store.character?.activity" />
      <div class="composer-box" :class="{ disabled: store.connection !== 'open', dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
        <ul v-if="attachments.length > 0" class="attachments">
          <li v-for="entry in attachments" :key="entry.key" :class="{ failed: entry.error }" :title="entry.error ?? (entry.name ? '已上傳' : '上傳中…')">
            <img :src="entry.preview" alt="待送出的截圖" />
            <span v-if="!entry.name && !entry.error" class="state small">上傳中</span>
            <span v-if="entry.error" class="state small">失敗</span>
            <button type="button" class="remove" aria-label="拿掉這張截圖" @click="removeAttachment(entry.key)">×</button>
          </li>
        </ul>
        <textarea
          v-model="draft"
          :rows="rows"
          :placeholder="isChat ? '跟 ALICe 聊聊…' : '跟 ALICe 說…'"
          aria-label="訊息"
          :disabled="store.connection !== 'open'"
          @keydown="onKeydown"
          @paste="onPaste"
        />
        <div class="actions">
          <label class="deep" :class="{ on: deep }" title="用較高的 effort 深入思考（同命令列 /深想）">
            <input v-model="deep" type="checkbox" />深想
          </label>
          <span class="hint muted small">Enter 送出，Shift+Enter 換行；Ctrl+V 或拖曳可附截圖</span>
          <button v-if="!isChat" type="button" :disabled="!canSend || draft.trim() === ''" title="請 ALICe 把這件事做成計畫（同命令列 /計畫）" @click="send(true)">做成計畫</button>
          <button type="submit" class="primary" :disabled="!canSend">送出</button>
        </div>
      </div>
      <p v-if="sendError" class="error small">{{ sendError }}</p>
    </form>
  </div>
</template>

<style scoped>
/* §83 截圖。 */
.shots { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.attachments { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.attachments li { position: relative; width: 72px; height: 72px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); background: var(--sunken); }
.attachments li.failed { border-color: var(--danger); }
.attachments img { width: 100%; height: 100%; object-fit: cover; display: block; }
.attachments .state { position: absolute; left: 0; right: 0; bottom: 0; text-align: center; background: rgb(0 0 0 / 55%); color: #fff; }
.attachments .remove { position: absolute; top: 2px; right: 2px; width: 20px; height: 20px; padding: 0; border-radius: 50%; line-height: 1; background: rgb(0 0 0 / 60%); color: #fff; border: none; }
.composer-box.dragging { outline: 2px dashed var(--accent); outline-offset: 2px; }
.chat { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.messages { flex: 1; overflow-y: auto; padding: 20px 24px 12px; display: flex; flex-direction: column; gap: 14px; }
.older { align-self: center; font-size: 0.85em; }
.empty { margin: auto; color: var(--muted); text-align: center; }

/* ALICE：文件排版，適合讀長篇總覽。 */
.note { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 12px; align-items: start; max-width: 50em; }
/* §49 小頭像：像素艾莉絲的臉（avatar_24 放大 2 倍成 48px，與左上角頭像一致），框是圓角方形。 */
.mini-avatar {
  width: 48px; height: 48px; border-radius: 11px; background: var(--sunken); color: #fff; overflow: hidden;
  display: grid; place-items: center; font-size: 0.8em; font-weight: 700; margin-top: 1px;
}
.mini-avatar img { width: 48px; height: 48px; display: block; image-rendering: pixelated; }
.note-body { min-width: 0; }
.note-body header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 2px; }
.note-body header b { font-size: 0.9em; letter-spacing: 0.03em; }
.note-body header time { font-size: 0.75em; color: var(--faint); }
/* 全頁唯一的動態：ALICE 思考時頭像的呼吸光圈。 */
.note.streaming .mini-avatar { animation: breathe 1.6s ease-in-out infinite; }
@keyframes breathe {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 45%, transparent); }
  50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent); }
}

/* 主人：深墨色泡泡，一眼分得出是自己說的。 */
.bubble { max-width: min(36em, 85%); padding: 9px 14px; border-radius: var(--radius-bubble); overflow-wrap: anywhere; align-self: flex-end; }
.bubble.user { background: var(--owner-bg); color: var(--owner-text); }
.bubble.user time { color: color-mix(in srgb, var(--owner-text) 55%, transparent); }
.bubble.peer { background: var(--warn-bg); border: 1px dashed color-mix(in srgb, var(--warn) 45%, transparent); }
.peer-label { font-size: 0.78em; font-weight: 600; color: var(--warn); margin-bottom: 2px; }
.plain { white-space: pre-wrap; line-height: 1.65; }
.bubble time { display: block; font-size: 0.72em; margin-top: 3px; text-align: right; color: var(--faint); }

.system {
  align-self: center; max-width: 92%; padding: 3px 12px; border-radius: 999px;
  background: var(--sunken); font-size: 0.8em; color: var(--muted); text-align: center; overflow-wrap: anywhere;
}
.system time { margin-left: 8px; color: var(--faint); }
.error-line { color: var(--danger); background: var(--danger-bg); }

.composer { padding: 10px 20px 16px; }
.composer-sprite { margin: -6px 12px -2px; }
.composer-box {
  border: var(--bw) solid var(--border-strong); border-radius: var(--radius-lg); background: var(--panel); box-shadow: var(--card-shadow);
  padding: 8px 10px 8px 14px; transition: border-color 0.15s, box-shadow 0.15s;
}
.composer-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.composer-box.disabled { opacity: 0.6; }
.composer-box textarea {
  width: 100%; border: none; padding: 4px 0; resize: none; background: transparent;
  max-height: 40vh; line-height: 1.6;
}
.composer-box textarea:focus-visible { outline: none; }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.actions .hint { margin-right: auto; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.actions button, .deep { flex: none; white-space: nowrap; }
/* 聊天區被拖窄時（§38）收掉提示字，按鈕靠右。 */
.chat { container-type: inline-size; }
@container (max-width: 480px) {
  .actions .hint { display: none; }
  .actions button:first-of-type { margin-left: auto; }
}
.deep {
  position: relative; display: inline-flex; align-items: center; cursor: pointer; user-select: none;
  padding: 3px 11px; border-radius: 999px; font-size: 0.85em; color: var(--muted); background: var(--sunken);
}
.deep input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.deep.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.deep:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }

@media (max-width: 820px) {
  .messages { padding: 14px 12px 8px; }
  .composer { padding: 8px 10px 10px; }
  .actions .hint { display: none; }
  .actions button:first-of-type { margin-left: auto; }
  .bubble { max-width: 90%; }
}
</style>
