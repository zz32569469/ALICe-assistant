<script setup lang="ts">
// §83 對話裡的截圖縮圖：圖片要帶 token 才拿得到，所以用 fetch 取回後轉成 blob 網址；點一下在新分頁看原圖。
import { onMounted, ref } from "vue";

import { api } from "../api";

const props = defineProps<{ name: string }>();
const url = ref("");
const failed = ref(false);

onMounted(async () => {
  try {
    url.value = await api.uploadUrl(props.name);
  } catch {
    failed.value = true;
  }
});
</script>

<template>
  <a v-if="url" class="shot" :href="url" target="_blank" rel="noopener" title="在新分頁看原圖"><img :src="url" alt="截圖" /></a>
  <span v-else class="shot missing small muted">{{ failed ? "圖片讀不到" : "載入中…" }}</span>
</template>

<style scoped>
.shot { display: inline-block; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); background: var(--sunken); line-height: 0; }
.shot img { display: block; max-width: 220px; max-height: 160px; object-fit: contain; }
.missing { padding: 10px 14px; line-height: 1.4; }
</style>
