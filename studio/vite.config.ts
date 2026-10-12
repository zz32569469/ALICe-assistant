import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// 開發時（npm run dev）把 API 與 WebSocket 轉給本機 Alice Core；正式使用由 Core 直接提供 dist。
export default defineConfig({
  plugins: [vue()],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:7788",
      "/ws": { target: "ws://127.0.0.1:7788", ws: true },
    },
  },
});
