import type { ServerEvent } from "@/types";

const WS_BASE = (import.meta.env.VITE_WS_URL as string) || "ws://127.0.0.1:8787/ws";

export type WsStatus = "connecting" | "connected" | "disconnected";

export type WsHandler = (event: ServerEvent, payload: unknown) => void;
export type WsStatusListener = (status: WsStatus) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<WsHandler>();
  private statusListeners = new Set<WsStatusListener>();
  private status: WsStatus = "disconnected";
  private reconnectAttempts = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private explicitlyClosed = false;

  connect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.explicitlyClosed = false;
    this.setStatus("connecting");

    try {
      this.ws = new WebSocket(WS_BASE);
    } catch (err) {
      console.error("WS connect error", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      this.startPing();
    };

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.event === "ping") {
          this.ws?.send(JSON.stringify({ type: "ping", payload: msg.payload }));
          return;
        }
        if (msg.event && this.handlers.size > 0) {
          for (const h of this.handlers) h(msg.event as ServerEvent, msg.payload);
        }
      } catch (err) {
        console.error("WS parse error", err);
      }
    };

    this.ws.onerror = () => {};

    this.ws.onclose = () => {
      this.stopPing();
      this.setStatus("disconnected");
      if (!this.explicitlyClosed) this.scheduleReconnect();
    };
  }

  disconnect() {
    this.explicitlyClosed = true;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  on(handler: WsHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onStatus(listener: WsStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): WsStatus {
    return this.status;
  }

  private setStatus(s: WsStatus) {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "ping" }));
      } catch {}
    }, 25_000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.explicitlyClosed) return;
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    setTimeout(() => {
      if (!this.explicitlyClosed) this.connect();
    }, delay);
  }
}

export const ws = new WSClient();