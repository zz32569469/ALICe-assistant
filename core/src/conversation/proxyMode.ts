// §64 代理人模式：開啟時，艾莉絲可以把主人在對話裡明確交代的指示直接傳給同事 session。
// 主人在 Web Studio 手動開關，沒有時間上限；狀態存在 data/proxy-mode.json，Core 重啟後維持。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EventHub } from "../protocol/eventHub.js";

export type ProxyModeState = { enabled: boolean; changedAt: string | null };

export class ProxyMode {
  readonly #path: string;
  readonly #events: EventHub | undefined;
  #state: ProxyModeState;

  constructor(options: { path: string; events?: EventHub }) {
    this.#path = options.path;
    this.#events = options.events;
    this.#state = ProxyMode.#load(options.path);
  }

  static #load(path: string): ProxyModeState {
    if (!existsSync(path)) return { enabled: false, changedAt: null };
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ProxyModeState>;
      return { enabled: raw.enabled === true, changedAt: typeof raw.changedAt === "string" ? raw.changedAt : null };
    } catch {
      // 檔案壞掉時當成關閉（安全的那一邊）。
      return { enabled: false, changedAt: null };
    }
  }

  get(): ProxyModeState {
    return { ...this.#state };
  }

  get enabled(): boolean {
    return this.#state.enabled;
  }

  set(enabled: boolean, now = new Date()): ProxyModeState {
    if (enabled === this.#state.enabled) return this.get();
    this.#state = { enabled, changedAt: now.toISOString() };
    mkdirSync(dirname(this.#path), { recursive: true });
    writeFileSync(this.#path, JSON.stringify(this.#state, null, 2), "utf8");
    this.#events?.broadcast("proxy.changed", this.get());
    return this.get();
  }
}
