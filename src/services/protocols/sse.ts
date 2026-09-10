/**
 * Server-Sent Events sessions (§13): plain HTTP GET with
 * Accept: text/event-stream, incremental frame parsing, auto-reconnect
 * honoring `retry:` fields, last-event-id resume, event bus.
 */
import { request } from 'undici';
import { randomUUID } from 'node:crypto';
import type { KeyValueInput } from '../../shared/types';
import type { SessionEmitter } from './websocket';
import type { SseFrameEvent } from '../../shared/events';

interface SseSession {
  id: string;
  url: string;
  headers?: KeyValueInput[];
  abort: AbortController;
  closed: boolean;
  lastEventId?: string;
  retryMs: number;
}

const sessions = new Map<string, SseSession>();

/**
 * Incremental Server-Sent Events parser (§28). Feed arbitrary text chunks —
 * including frames split across chunks — and receive complete events.
 * Pure/stateful so it can be unit tested without a network connection.
 */
export interface SseParsedFrame { event?: string; data: string; id?: string }
export interface SseParser {
  feed(text: string): void;
  /** Emit any buffered, unterminated frame (used at stream end). */
  flush(): void;
}
export function createSseParser(onFrame: (f: SseParsedFrame) => void, onRetry?: (retryMs: number) => void): SseParser {
  let buffer = '';
  let dataBuf = '';
  let evName: string | undefined;
  let evId: string | undefined;

  const dispatch = (): void => {
    if (dataBuf !== '') {
      onFrame({ event: evName, data: dataBuf.replace(/\n$/, ''), id: evId });
    }
    dataBuf = ''; evName = undefined; evId = undefined;
  };

  const handleLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') { dispatch(); return; }
    if (line.startsWith(':')) return; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data': dataBuf += value + '\n'; break;
      case 'event': evName = value; break;
      case 'id': if (!value.includes('\u0000')) evId = value; break;
      case 'retry': {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) onRetry?.(Math.round(n));
        break;
      }
      default: break; // unknown fields ignored per spec
    }
  };

  return {
    feed(text: string): void {
      buffer += text;
      let idx: number;
      // SSE frames are separated by LF; CRLF handled per-line.
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleLine(rawLine);
      }
    },
    flush(): void {
      if (buffer) handleLine(buffer);
      // A stream ending without a blank line still delivers the pending frame.
      if (dataBuf !== '') dispatch();
      buffer = '';
    },
  };
}

export function sseList(): string[] { return [...sessions.keys()]; }
export function sseClose(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (s) { s.closed = true; s.abort.abort(); sessions.delete(sessionId); }
}

export async function sseConnect(opts: { url: string; headers?: KeyValueInput[]; lastEventId?: string; sessionId?: string }, emit: SessionEmitter): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? randomUUID();
  if (sessions.has(sessionId)) throw new Error(`Session ${sessionId} already exists`);
  const session: SseSession = { id: sessionId, url: opts.url, headers: opts.headers, abort: new AbortController(), closed: false, lastEventId: opts.lastEventId, retryMs: 3000 };
  sessions.set(sessionId, session);
  void pump(session, emit);
  // surface immediate connect errors synchronously-ish
  await new Promise((r) => setTimeout(r, 250));
  return { sessionId };
}

async function pump(session: SseSession, emit: SessionEmitter): Promise<void> {
  while (!session.closed) {
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
      for (const h of session.headers ?? []) if (h.enabled !== false && h.key) headers[h.key] = h.value;
      if (session.lastEventId) headers['Last-Event-ID'] = session.lastEventId;
      const res = await request(session.url, {
        method: 'GET', headers,
        signal: session.abort.signal,
        maxRedirections: 5,
      });
      if (res.statusCode >= 400) throw new Error(`SSE connect failed: HTTP ${res.statusCode}`);
      const parser = createSseParser((ev) => {
        emit('sse.frame', { sessionId: session.id, ...ev });
        if (ev.id !== undefined) session.lastEventId = ev.id;
      }, (retryMs) => { session.retryMs = retryMs; });
      for await (const chunk of res.body) {
        if (session.closed) break;
        const text = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        parser.feed(text);
      }
      parser.flush();
      if (session.closed) break;
      emit('sse.frame', { sessionId: session.id, event: 'sys', data: `stream ended; reconnecting in ${session.retryMs}ms` });
    } catch (e) {
      if (session.closed) break;
      emit('sse.frame', { sessionId: session.id, event: 'error', data: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, session.retryMs));
  }
  sessions.delete(session.id);
}
