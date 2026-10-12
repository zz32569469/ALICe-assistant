// 外觀主題（§32）：選擇存在這個瀏覽器（每台各自記），啟動時先套用，避免閃一下預設外觀。

import { ref } from "vue";

export type ThemeId = "notebook" | "tea" | "arcade" | "pixel" | "terminal" | "spring" | "summer" | "autumn" | "winter";

export const THEMES: Array<{ id: ThemeId; name: string; note: string; swatch: [string, string, string] }> = [
  { id: "notebook", name: "參謀手帳", note: "冷灰紙底、墨色字、玫瑰色；跟著系統亮暗", swatch: ["#f3f4f6", "#262c38", "#a6416a"] },
  { id: "tea", name: "女僕茶會", note: "薰衣草與玫瑰、圓潤、緞帶點綴", swatch: ["#f4eff9", "#9a6fd0", "#e7739b"] },
  { id: "arcade", name: "遊戲選單", note: "賽璐珞粗描邊、硬陰影、桃紅與金", swatch: ["#241345", "#ff3d8b", "#ffd23f"] },
  { id: "pixel", name: "像素冒險", note: "JRPG 對話框、像素字與 ALICe 頭像、金色角飾", swatch: ["#1a1c2c", "#ffcd75", "#73eff7"] },
  { id: "terminal", name: "終端機駭客", note: "像素字＋綠色磷光、CRT 掃描線、命令列語彙", swatch: ["#030703", "#45ff86", "#ffbf3f"] },
  { id: "spring", name: "春・櫻", note: "櫻花枝與遠山，花瓣飄落", swatch: ["#fde6ee", "#d4517b", "#9cc7a6"] },
  { id: "summer", name: "夏・海", note: "晴空、太陽與海平線，海浪流動", swatch: ["#7fd0fb", "#0b8fb0", "#ffcf4a"] },
  { id: "autumn", name: "秋・楓", note: "夕陽與紅橙山巒，楓葉飄落", swatch: ["#ffcf99", "#c0432b", "#5a2c1c"] },
  { id: "winter", name: "冬・雪", note: "月夜、雪丘與松林，雪花紛飛", swatch: ["#0d1730", "#8fd3ff", "#eef4fb"] },
];

const KEY = "alice.theme";

function stored(): ThemeId {
  try {
    const value = window.localStorage.getItem(KEY);
    return THEMES.some((theme) => theme.id === value) ? value as ThemeId : "notebook";
  } catch {
    return "notebook";
  }
}

export const currentTheme = ref<ThemeId>(stored());

export function applyTheme(id: ThemeId = currentTheme.value): void {
  currentTheme.value = id;
  if (id === "notebook") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = id;
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // 瀏覽器不允許儲存時，這次仍然套用。
  }
}
