import { createApp } from "vue";

import App from "./App.vue";
import { takeTokenFromUrl } from "./api";
import "@fontsource-variable/quicksand";
import "@fontsource-variable/rubik";
import "@fontsource-variable/rubik/wght-italic.css";
import "./style.css";
import "./themes.css";
import "./themes-deco.css";
import "./frozen-themes.css";
import { applyTheme } from "./theme";

// 先把網址 # 後面的 token 收起來並清掉網址（W-2），再啟動畫面。
takeTokenFromUrl();
applyTheme();
createApp(App).mount("#app");
