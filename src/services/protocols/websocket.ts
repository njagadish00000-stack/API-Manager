/**
 * WebSocket + GraphQL-WS session manager (§12, §13).
 * Sessions push events via the emitter; everything is kept in memory.
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { KeyValueInput } from '../../shared/types';
import type { WsMessageEvent } from '../../shared/events';
import { now } from '../../shared/types';

export interface WsSession {
  id: string;
  url: string;
  socket: WebSocket;
  kind: 'raw' | 'graphql-ws' | 'socketio';
  connectedAt: string;
  messages: WsMessageEvent[];
  heartbeat?: ReturnType<typeof setInterval>;
}

export type SessionEmitter = (type: 'ws.message' | 'sse.frame' | 'mqtt.message' | 'grpc.stream', payload: unknown) => void;

const sessions = new Map<string, WsSession>();

export interface WsConnectOptions {
  url: string;
  headers?: KeyValueInput[];
  subprotocols?: string[];
  sessionId?: string;
  kind?: WsSession['kind'];
  heartbeatMs?: number;
}

export function wsConnect(opts: WsConnectOptions, emit: SessionEmitter): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId || randomUUID();
  if (sessions.has(sessionId)) throw new Error(`Session ${sessionId} already exists`);
  const headers: Record<string, string> = {};
  for (const h of opts.headers ?? []) if (h.enabled !== false && h.key) headers[h.key] = h.value;

  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.url, opts.subprotocols ?? [], {
        headers,
        handshakeTimeout: 15000,
        followRedirects: true,
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const session: WsSession = { id: sessionId, url: opts.url, socket, kind: opts.kind ?? 'raw', connectedAt: now(), messages: [] };
    sessions.set(sessionId, session);

    const push = (direction: 'in' | 'out' | 'sys', data: string, binary: boolean) => {
      const ev: WsMessageEvent = { sessionId, direction, data, binary, ts: now() };
      session.messages.push(ev);
      if (session.messages.length > 1000) session.messages.splice(0, session.messages.length - 1000);
      emit('ws.message', ev);
    };

    socket.on('open', () => {
      push('sys', `connected to ${opts.url}${opts.subprotocols?.length ? ` (protocol: ${socket.protocol})` : ''}`, false);
      resolve({ sessionId });
      if (opts.heartbeatMs && opts.heartbeatMs > 0) {
        session.heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, opts.heartbeatMs);
      }
    });
    socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      const text = isBinary ? Buffer.from(data as Buffer).toString('base64') : Buffer.from(data as Buffer).toString('utf8');
      push('in', text, isBinary);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      if (session.heartbeat) clearInterval(session.heartbeat);
      push('sys', `closed (${code}) ${reason.toString()}`, false);
      sessions.delete(sessionId);
    });
    socket.on('error', (err: Error) => {
      push('sys', `error: ${err.message}`, false);
      if (socket.readyState !== WebSocket.OPEN) {
        reject(err);
        sessions.delete(sessionId);
      }
    });
    socket.on('pong', () => push('sys', 'pong', false));
  });
}

export function wsSend(sessionId: string, data: string, binary: boolean, emit: SessionEmitter): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session ${sessionId}`);
  const payload = binary ? Buffer.from(data, 'base64') : data;
  session.socket.send(payload);
  const ev: WsMessageEvent = { sessionId, direction: 'out', data, binary, ts: now() };
  session.messages.push(ev);
  emit('ws.message', ev);
}

export function wsPing(sessionId: string): void {
  sessions.get(sessionId)?.socket.ping();
}

export function wsClose(sessionId: string, code = 1000, reason = 'closed by user'): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.heartbeat) clearInterval(session.heartbeat);
  try { session.socket.close(code, reason); } catch { /* ignore */ }
  sessions.delete(sessionId);
}

export function wsHistory(sessionId: string): WsMessageEvent[] {
  return sessions.get(sessionId)?.messages ?? [];
}

export function closeAllWs(): void {
  for (const id of [...sessions.keys()]) wsClose(id);
}

// ---------------------------------------------------------------------------
// GraphQL over WebSocket (graphql-ws protocol, §12)
// ---------------------------------------------------------------------------

export interface GqlWsSubscription {
  sessionId: string;
  operationId: string;
  stop: () => void;
}

const gqlSubs = new Map<string, GqlWsSubscription[]>();

/** Start a GraphQL subscription using the `graphql-transport-ws` subprotocol. */
export async function graphqlWsSubscribe(
  args: { url: string; headers?: KeyValueInput[]; query: string; variables?: Record<string, unknown>; operationName?: string; authPayload?: Record<string, unknown> },
  emit: SessionEmitter,
  onResult: (data: unknown, errors?: unknown) => void,
): Promise<{ sessionId: string; operationId: string }> {
  const { sessionId } = await wsConnect({ url: args.url, headers: args.headers, subprotocols: ['graphql-transport-ws'], kind: 'graphql-ws' }, emit);
  const operationId = randomUUID();
  const session = sessions.get(sessionId);
  if (!session) throw new Error('failed to create session');

  // intercept frames for this operation
  const listener = (data: WebSocket.RawData) => {
    try {
      const msg = JSON.parse(Buffer.from(data as Buffer).toString('utf8')) as { type: string; id?: string; payload?: unknown };
      if (msg.id === operationId && (msg.type === 'next')) onResult(msg.payload, (msg.payload as { errors?: unknown })?.errors);
      if (msg.id === operationId && msg.type === 'error') onResult(undefined, msg.payload);
      if (msg.id === operationId && msg.type === 'complete') { /* done */ }
    } catch { /* ignore */ }
  };
  session.socket.on('message', listener);

  wsSend(sessionId, JSON.stringify({ type: 'connection_init', payload: args.authPayload ?? {} }), false, emit);
  // brief ack window
  await new Promise((r) => setTimeout(r, 150));
  wsSend(sessionId, JSON.stringify({
    id: operationId, type: 'subscribe',
    payload: { query: args.query, variables: args.variables ?? {}, operationName: args.operationName },
  }), false, emit);

  const sub: GqlWsSubscription = {
    sessionId, operationId,
    stop: () => {
      wsSend(sessionId, JSON.stringify({ id: operationId, type: 'complete' }), false, emit);
      session.socket.off('message', listener);
    },
  };
  gqlSubs.set(operationId, [sub]);
  return { sessionId, operationId };
}

export function graphqlWsUnsubscribe(operationId: string): void {
  for (const sub of gqlSubs.get(operationId) ?? []) sub.stop();
  gqlSubs.delete(operationId);
}

// ---------------------------------------------------------------------------
// Socket.IO (§12) — via socket.io-client
// ---------------------------------------------------------------------------

import { io, Socket } from 'socket.io-client';

const socketIoSessions = new Map<string, Socket>();

export async function socketIoConnect(args: { url: string; headers?: Record<string, string>; path?: string; sessionId?: string }, emit: SessionEmitter): Promise<{ sessionId: string }> {
  const sessionId = args.sessionId ?? randomUUID();
  const socket = io(args.url, {
    path: args.path ?? '/socket.io',
    extraHeaders: args.headers,
    transports: ['websocket', 'polling'],
    reconnection: true,
  });
  socketIoSessions.set(sessionId, socket);
  socket.onAny((event: string, ...data: unknown[]) => {
    emit('ws.message', { sessionId, direction: 'in', data: JSON.stringify({ event, data }), binary: false, ts: now() } satisfies WsMessageEvent);
  });
  socket.on('connect', () => emit('ws.message', { sessionId, direction: 'sys', data: `socket.io connected (${socket.id})`, binary: false, ts: now() } satisfies WsMessageEvent));
  socket.on('disconnect', (reason) => emit('ws.message', { sessionId, direction: 'sys', data: `disconnected: ${reason}`, binary: false, ts: now() } satisfies WsMessageEvent));
  socket.on('connect_error', (err) => emit('ws.message', { sessionId, direction: 'sys', data: `connect_error: ${err.message}`, binary: false, ts: now() } satisfies WsMessageEvent));
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const okResolve = () => { if (!settled) { settled = true; resolve(); } };
    const badify = (err: Error) => { if (!settled) { settled = true; reject(err); } };
    socket.once('connect', okResolve);
    socket.once('connect_error', badify);
    socket.once('disconnect', (reason) => badify(new Error(`socket.io closed before connect: ${reason}`)));
    setTimeout(() => badify(new Error('socket.io connect timeout')), 15000);
  });
  return { sessionId };
}

export function socketIoEmit(sessionId: string, event: string, data: unknown): void {
  const socket = socketIoSessions.get(sessionId);
  if (!socket) throw new Error(`Unknown socket.io session ${sessionId}`);
  socket.emit(event, data);
}

export function socketIoClose(sessionId: string): void {
  socketIoSessions.get(sessionId)?.disconnect();
  socketIoSessions.delete(sessionId);
}
