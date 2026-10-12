// WebSocket 連線：自動重連（Core 重啟後不用重新整理，完成標準 7），收到 ping 回 pong。

import { getToken } from "./api";
import type { EventEnvelope } from "./types";

export type ConnectionStatus = "connecting" | "open" | "closed" | "unauthorized";

export class CoreSocket {
  #socket: WebSocket | undefined;
  #retryMs = 1_000;
  #timer: number | undefined;
  #stopped = false;
  readonly #onEvent: (event: EventEnvelope) => void;
  readonly #onStatus: (status: ConnectionStatus) => void;

  constructor(onEvent: (event: EventEnvelope) => void, onStatus: (status: ConnectionStatus) => void) {
    this.#onEvent = onEvent;
    this.#onStatus = onStatus;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#socket?.close();
  }

  #connect(): void {
    const token = getToken();
    if (token === undefined) {
      this.#onStatus("unauthorized");
      return;
    }
    this.#onStatus("connecting");
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
    this.#socket = socket;
    let opened = false;
    socket.addEventListener("open", () => {
      opened = true;
      this.#retryMs = 1_000;
      this.#onStatus("open");
    });
    socket.addEventListener("message", (message) => {
      let event: EventEnvelope;
      try {
        event = JSON.parse(String(message.data)) as EventEnvelope;
      } catch {
        return;
      }
      if (event.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      this.#onEvent(event);
    });
    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = undefined;
      if (this.#stopped) return;
      // 還沒連上就被關：可能是 token 錯（401）或 Core 沒開；先查 health 再決定。
      this.#onStatus("closed");
      if (!opened) void this.#checkUnauthorized();
      this.#timer = window.setTimeout(() => this.#connect(), this.#retryMs);
      this.#retryMs = Math.min(this.#retryMs * 2, 10_000);
    });
  }

  async #checkUnauthorized(): Promise<void> {
    try {
      const response = await fetch("/api/state", { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
      if (response.status === 401) {
        this.stop();
        this.#onStatus("unauthorized");
      }
    } catch {
      // Core 沒開：繼續重試。
    }
  }
}
