import type WebSocket from "ws";

export type EventEnvelope<T = unknown> = {
  v: 1;
  type: string;
  seq: number;
  ts: string;
  data: T;
};

export class EventHub {
  readonly #clients = new Set<WebSocket>();
  readonly #listeners = new Set<(type: string, data: unknown) => void>();
  #sequence = 0;

  /** Core 內部監聽事件（例：計畫暫停時排推播，§30）；回傳取消函式。 */
  on(listener: (type: string, data: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 目前連著的 Web Studio 數量（§71：委派時判斷要切換還是開新分頁）。 */
  get clientCount(): number {
    return this.#clients.size;
  }

  add(client: WebSocket): void {
    this.#clients.add(client);
  }

  remove(client: WebSocket): void {
    this.#clients.delete(client);
  }

  send<T>(client: WebSocket, type: string, data: T): void {
    if (client.readyState === client.OPEN) {
      try {
        client.send(JSON.stringify(this.#envelope(type, data)));
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  broadcast<T>(type: string, data: T): void {
    for (const listener of this.#listeners) {
      try {
        listener(type, data);
      } catch (error) {
        console.warn(`事件監聽失敗（${type}）：`, error instanceof Error ? error.message : error);
      }
    }
    const payload = JSON.stringify(this.#envelope(type, data));
    for (const client of this.#clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(payload);
        } catch {
          this.#clients.delete(client);
        }
      }
    }
  }

  closeAll(): void {
    for (const client of this.#clients) {
      client.close(1001, "Core shutting down");
    }
    this.#clients.clear();
  }

  #envelope<T>(type: string, data: T): EventEnvelope<T> {
    return {
      v: 1,
      type,
      seq: ++this.#sequence,
      ts: new Date().toISOString(),
      data,
    };
  }
}
