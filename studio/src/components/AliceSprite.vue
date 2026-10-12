<script setup lang="ts">
// §49／§53～§56 像素艾莉絲（素材由「ALICE Pixel Art」session 製作，見 src/assets/alice-pixel/manifest.json）。
// 站在聊天輸入框上緣：
// - 待命：大多正面待機（15～30 秒），偶爾隨意走一小段（2～4 秒）再停下來（主人：走路少、待機長）。
// - 對話中（回覆中）、工作中：坐在桌前打字（45 度場景，只有一個角度）；每隔 8～15 秒，打字回到第 0 格時
//   插播一次喝咖啡，喝完接回打字第 0 格（兩段的第 0 格是同一張，畫面不會跳）。
// - 睡著：站著睡＋素材附的 zzz 特效層。
// 換狀態時留在原地。每幀時間不等長（durations_ms），所以用 setTimeout 逐幀排程；系統「減少動態」時只顯示第一格。
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import manifest from "../assets/alice-pixel/manifest.json";
import drinkSheet from "../assets/alice-pixel/drink_noshadow.png";
import idleSheet from "../assets/alice-pixel/idle_noshadow.png";
import sleepFxSheet from "../assets/alice-pixel/sleep_fx.png";
import sleepSheet from "../assets/alice-pixel/sleep_noshadow.png";
import typingSheet from "../assets/alice-pixel/typing_noshadow.png";
import walkSheet from "../assets/alice-pixel/walk_noshadow.png";

type Clip = "idle" | "walk" | "sleep" | "typing" | "drink";
type Spec = { frames: number; durations_ms: number[]; rows: Record<string, number> };

const props = withDefaults(defineProps<{ activity?: string; scale?: number }>(), { activity: "idle", scale: 2 });

const SHEETS: Record<Clip, string> = { idle: idleSheet, walk: walkSheet, sleep: sleepSheet, typing: typingSheet, drink: drinkSheet };
const FRAME_W = manifest.frame_width;
const FRAME_H = manifest.frame_height;
/** 走路時每一步移動的像素（1 倍尺寸）。 */
const STEP_PX = 2;
const IDLE_MS: [number, number] = [15000, 30000];
const WALK_MS: [number, number] = [2000, 4000];
const DRINK_EVERY_MS: [number, number] = [8000, 15000];

const stage = ref<HTMLElement>();
const clip = ref<Clip>("idle");
const frame = ref(0);
const facing = ref<"left" | "right">("left");
/** 離舞台右邊的距離（px）；一開始站在最右邊。 */
const offset = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;
/** 待命：這段待機或走路到什麼時候；工作中：什麼時候之後可以喝下一口。 */
let phaseUntil = 0;
const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** 狀態對應的主要動作。 */
const base = computed<Clip>(() => {
  if (props.activity === "talking" || props.activity === "busy") return "typing";
  if (props.activity === "sleeping") return "sleep";
  return "idle";
});
const spec = computed(() => manifest.animations[clip.value] as Spec);
/** 打字、喝咖啡是含桌椅的場景。 */
const inScene = computed(() => clip.value === "typing" || clip.value === "drink");

const between = ([min, max]: [number, number]): number => min + Math.random() * (max - min);

function sheetStyle(image: string) {
  const s = props.scale;
  const rows = spec.value.rows;
  // 走路照面向取列；打字、喝咖啡只有 front_right 一列；待機、睡覺用正面那一列。
  const row = clip.value === "walk" ? rows[facing.value]! : rows.down ?? Object.values(rows)[0] ?? 0;
  return {
    width: `${FRAME_W * s}px`,
    height: `${FRAME_H * s}px`,
    backgroundImage: `url(${image})`,
    backgroundSize: `${spec.value.frames * FRAME_W * s}px ${Object.keys(rows).length * FRAME_H * s}px`,
    backgroundPosition: `${-frame.value * FRAME_W * s}px ${-row * FRAME_H * s}px`,
  };
}

const spriteStyle = computed(() => sheetStyle(SHEETS[clip.value]));
const fxStyle = computed(() => sheetStyle(sleepFxSheet));

/** 能往左走多遠（px）。 */
function maxOffset(): number {
  return Math.max(0, (stage.value?.clientWidth ?? 0) - FRAME_W * props.scale);
}

function play(next: Clip): void {
  clip.value = next;
  frame.value = 0;
}

function startWalk(now: number): void {
  // 隨意選方向，但靠邊時往空間多的那一邊。
  const limit = maxOffset();
  if (offset.value <= limit * 0.2) facing.value = "left";
  else if (offset.value >= limit * 0.8) facing.value = "right";
  else facing.value = Math.random() < 0.5 ? "left" : "right";
  play("walk");
  phaseUntil = now + between(WALK_MS);
}

function tick(): void {
  const now = Date.now();
  const last = frame.value + 1 >= spec.value.frames;
  if (clip.value === "drink" && last) {
    play("typing");
    phaseUntil = now + between(DRINK_EVERY_MS);
  } else {
    frame.value = last ? 0 : frame.value + 1;
  }
  if (clip.value === "typing" && frame.value === 0 && now >= phaseUntil) play("drink");
  if (base.value === "idle" && now >= phaseUntil) {
    if (clip.value === "idle") startWalk(now);
    else {
      play("idle");
      phaseUntil = now + between(IDLE_MS);
    }
  }
  if (clip.value === "walk") {
    // 往左走 offset 變大；走到邊緣就轉身。
    const limit = maxOffset();
    const next = offset.value + (facing.value === "left" ? STEP_PX : -STEP_PX) * props.scale;
    if (next <= 0 || next >= limit) facing.value = facing.value === "left" ? "right" : "left";
    offset.value = Math.min(limit, Math.max(0, next));
  }
  schedule();
}

function schedule(): void {
  clearTimeout(timer);
  if (reducedMotion) return;
  timer = setTimeout(tick, spec.value.durations_ms[frame.value] ?? 160);
}

function start(next: Clip): void {
  play(next);
  phaseUntil = Date.now() + between(next === "idle" ? IDLE_MS : DRINK_EVERY_MS);
  schedule();
}

watch(base, start);

onMounted(() => start(base.value));
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <div ref="stage" class="sprite-stage" :style="{ height: `${FRAME_H * scale}px` }" aria-hidden="true">
    <div class="sprite-wrap" :style="{ right: `${Math.min(offset, maxOffset())}px`, width: `${FRAME_W * scale}px` }">
      <span v-if="!inScene" class="shadow" :style="{ width: `${16 * scale}px`, height: `${5 * scale}px`, left: `${16 * scale}px`, top: `${37 * scale}px` }" />
      <div class="sprite" :style="spriteStyle" />
      <div v-if="clip === 'sleep'" class="sprite fx" :style="fxStyle" />
    </div>
  </div>
</template>

<style scoped>
.sprite-stage { position: relative; pointer-events: none; }
/* 用離右邊的距離定位，拖曳分隔線改變寬度時不會跑出舞台。 */
.sprite-wrap { position: absolute; bottom: 0; transition: right 0.16s linear; }
.sprite { position: relative; image-rendering: pixelated; background-repeat: no-repeat; }
.fx { position: absolute; left: 0; top: 0; }
/* 不透明陰影只適合淺色背景，這裡一律用無陰影素材，自己畫半透明橢圓（素材說明 x 16–31、y 37–41）。打字、喝咖啡是含家具的場景，不另外畫。 */
.shadow { position: absolute; border-radius: 50%; background: rgb(0 0 0 / 16%); }
@media (prefers-reduced-motion: reduce) { .sprite-wrap { transition: none; } }
</style>
