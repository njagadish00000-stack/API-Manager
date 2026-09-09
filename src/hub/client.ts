/**
 * Hub client for the renderer AND the CLI: HTTP calls + WS event subscription.
 * Works in both browser (fetch/WebSocket) and Node (undici-like fetch + ws polyfill).
 */
import type { RendererEvent } from '../shared/api';

export interface HubClientOptions {
  baseUrl: string;          // e.g. http://127.0.0.1:7654
  token: string;
  onEvent?: (ev: RendererEvent) => void;
  /** injected fetch (defaults to global fetch) */
  fetchImpl?: typeof fetch;
  /** injected WebSocket constructor (defaults to global WebSocket) */
  wsImpl?: typeof WebSocket;
  reconnect?: boolean;
}

export class HubClient {
  private opts: HubClientOptions;
  private ws: WebSocket | null = null;
  private wsReady = false;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private counter = 0;
  private reconnectTimer: unknown = null;
  closing = false;

  constructor(opts: HubClientOptions) {
    this.opts = opts;
  }

  get baseUrl(): string { return this.opts.baseUrl; }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const ws = this.ws;
    if (ws && this.wsReady && ws.readyState === 1) {
      return this.callWs<T>(method, params);
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.opts.baseUrl}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` },
      body: JSON.stringify({ method, params: params ?? {} }),
    });
    const json = await res.json() as { ok?: boolean; result?: unknown; error?: { code: string; message: string } };
    if (json.ok) return json.result as T;
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { code?: string };
    err.code = json.error?.code;
    throw err;
  }

  private callWs<T>(method: string, params: unknown): Promise<T> {
    const id = `c${++this.counter}`;
    const ws = this.ws!;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ type: 'call', id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('call timeout')); }
      }, 120_000);
    });
  }

  connect(events?: string[]): void {
    const WsImpl = this.opts.wsImpl ?? (globalThis.WebSocket ?? null);
    if (!WsImpl) return; // no websocket in this runtime; events unavailable
    const url = this.opts.baseUrl.replace(/^http/, 'ws') + `/ws?token=${encodeURIComponent(this.opts.token)}`;
    const ws = new WsImpl(url) as WebSocket;
    this.ws = ws;
    ws.onopen = () => {
      this.wsReady = true;
      ws.send(JSON.stringify({ type: 'subscribe', events: events ?? [] }));
    };
    ws.onmessage = (m) => {
      let msg: { type?: string; id?: string; result?: unknown; error?: { code: string; message: string }; event?: RendererEvent };
      try { msg = JSON.parse(String(typeof m.data === 'string' ? m.data : m.data)); } catch { return; }
      if (msg.type === 'result' && msg.id) {
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if (msg.error) {
            const err = new Error(msg.error.message) as Error & { code?: string };
            err.code = msg.error.code;
            waiter.reject(err);
          } else waiter.resolve(msg.result);
        }
      } else if (msg.type === 'event' && msg.event) {
        this.opts.onEvent?.(msg.event);
      }
    };
    ws.onclose = () => {
      this.wsReady = false;
      this.ws = null;
      if (!this.closing && (this.opts.reconnect ?? true)) {
        clearTimeout(this.reconnectTimer as number);
        this.reconnectTimer = setTimeout(() => this.connect(events), 1000);
      }
    };
    ws.onerror = () => { /* onclose handles reconnect */ };
  }

  close(): void {
    this.closing = true;
    clearTimeout(this.reconnectTimer as number);
    this.ws?.close();
  }
}
