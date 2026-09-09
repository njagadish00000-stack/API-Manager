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
      let dataBuf = '';
      let evName: string | undefined;
      let evId: string | undefined;
      for await (const chunk of res.body) {
        if (session.closed) break;
        const text = (typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        for (const rawLine of text.split('\n')) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (line === '') {
            if (dataBuf !== '') {
              const ev: SseFrameEvent = { sessionId: session.id, event: evName, data: dataBuf.replace(/\n$/, ''), id: evId };
              emit('sse.frame', ev);
              if (evId !== undefined) session.lastEventId = evId;
            }
            dataBuf = ''; evName = undefined; evId = undefined;
            continue;
          }
          if (line.startsWith(':')) continue; // comment/keepalive
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          let value = colon === -1 ? '' : line.slice(colon + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          switch (field) {
            case 'data': dataBuf += value + '\n'; break;
            case 'event': evName = value; break;
            case 'id': evId = value; break;
            case 'retry': {
              const n = Number(value);
              if (Number.isFinite(n) && n >= 0) session.retryMs = n;
              break;
            }
          }
        }
      }
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
