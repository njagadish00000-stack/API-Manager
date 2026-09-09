/**
 * Renderer bridge: talks to the Electron main process when available
 * (window.apiManager injected by preload), otherwise to the hub over
 * same-origin HTTP/WS (web dev preview, headless browser mode).
 */
export interface BridgeEvent { type: string; payload: unknown; timestamp: string }
type EventCb = (ev: BridgeEvent) => void;

declare global { interface Window { apiManager?: { call: (m: string, p?: unknown) => Promise<unknown>; onEvent: (cb: (ev: unknown) => void) => () => void } } }

let listeners = new Set<EventCb>();
let ws: WebSocket | null = null;
let wsReady = false;
let pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let counter = 0;
let appToken = '';

function emitLocal(ev: BridgeEvent): void { listeners.forEach((l) => l(ev)); }

async function httpCall<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch('/api/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${appToken}` },
    body: JSON.stringify({ method, params: params ?? {} }),
  });
  const json = (await res.json()) as { ok?: boolean; result?: unknown; error?: { code: string; message: string } };
  if (json.ok) return json.result as T;
  const e = new Error(json.error?.message ?? `HTTP ${res.status}`) as Error & { code?: string };
  e.code = json.error?.code;
  throw e;
}

function initWs(): void {
  try {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(appToken)}`);
    ws = socket;
    socket.onopen = () => { wsReady = true; socket.send(JSON.stringify({ type: 'subscribe', events: [] })); };
    socket.onmessage = (m) => {
      try {
        const msg = JSON.parse(String(m.data)) as { type: string; id?: string; result?: unknown; error?: { message: string }; event?: BridgeEvent };
        if (msg.type === 'result' && msg.id) {
          const w = pending.get(msg.id);
          if (w) { pending.delete(msg.id); if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result); }
        } else if (msg.type === 'event' && msg.event) emitLocal(msg.event);
      } catch { /* malformed frame */ }
    };
    socket.onclose = () => { wsReady = false; ws = null; setTimeout(initWs, 2000); };
    socket.onerror = () => { /* onclose fires */ };
  } catch { /* no ws support */ }
}

export async function initBridge(): Promise<void> {
  if (window.apiManager) return; // electron mode
  try {
    const res = await fetch('/api/methods', { headers: { Authorization: `Bearer ${appToken}` } });
    // in local-trust hub mode any bearer token is accepted
    if (res.ok) {
      appToken = 'browser';
      initWs();
    }
  } catch {
    appToken = 'browser';
  }
}

export async function call<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (window.apiManager) return window.apiManager.call(method, params ?? {}) as Promise<T>;
  return httpCall<T>(method, params ?? {});
}

export function onEvent(cb: EventCb): () => void {
  listeners.add(cb);
  if (window.apiManager) {
    const off = window.apiManager.onEvent((ev) => cb(ev as BridgeEvent));
    listeners.delete(cb);
    return () => off();
  }
  return () => { listeners.delete(cb); };
}

export function onEventType<T = unknown>(type: string, cb: (payload: T, ev: BridgeEvent) => void): () => void {
  return onEvent((ev) => { if (ev.type === type) cb(ev.payload as T, ev); });
}

export function runtimeInfo(): { mode: 'electron' | 'web'; hasNativeDialogs: boolean } {
  return { mode: window.apiManager ? 'electron' : 'web', hasNativeDialogs: Boolean(window.apiManager) };
}

export const bridge = { call, onEvent, initBridge, runtimeInfo };
export type { EventCb };
