<script setup lang="ts">
// 頂端列的「外觀」選單（§32）。
import { onBeforeUnmount, onMounted, ref } from "vue";

import { applyTheme, currentTheme, THEMES } from "../theme";

const open = ref(false);
const root = ref<HTMLElement>();

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value !== undefined && !root.value.contains(event.target as Node)) open.value = false;
}
function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div ref="root" class="theme-picker">
    <button class="link small" :aria-expanded="open" aria-haspopup="menu" @click="open = !open">外觀</button>
    <ul v-if="open" class="menu" role="menu">
      <li v-for="theme in THEMES" :key="theme.id">
        <button role="menuitemradio" :aria-checked="currentTheme === theme.id" :class="{ current: currentTheme === theme.id }" @click="applyTheme(theme.id); open = false">
          <span class="swatch" aria-hidden="true">
            <i v-for="color in theme.swatch" :key="color" :style="{ background: color }" />
          </span>
          <span class="text">
            <b>{{ theme.name }}</b>
            <span class="muted small">{{ theme.note }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.theme-picker { position: relative; }
.menu {
  position: absolute; right: 0; top: calc(100% + 8px); z-index: 20; width: 300px; max-width: calc(100vw - 24px);
  list-style: none; margin: 0; padding: 6px; background: var(--panel); color: var(--text);
  border: var(--bw) solid var(--border-strong); border-radius: var(--radius-lg); box-shadow: var(--shadow);
  backdrop-filter: blur(18px);
}
.menu button {
  width: 100%; display: flex; gap: 10px; align-items: center; text-align: left;
  border: none; background: none; border-radius: 8px; padding: 7px 8px; color: var(--text); transform: none;
}
.menu button:hover:not(:disabled) { background: var(--sunken); color: var(--text); }
.menu button.current { background: var(--accent-soft); }
.swatch { display: flex; flex: none; border-radius: 6px; overflow: hidden; box-shadow: 0 0 0 1px rgb(0 0 0 / 15%); }
.swatch i { width: 12px; height: 26px; }
.text { display: flex; flex-direction: column; line-height: 1.35; }
.text b { font-size: 0.92em; }
</style>
