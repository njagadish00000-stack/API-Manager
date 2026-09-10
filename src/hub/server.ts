/**
 * Hub server — single in-process bridge that owns the AppContainer and exposes
 * the full ApiSurface to any number of clients (CLI, web dev preview, tests,
 * VS Code extension host, etc.). Electron embeds the container directly instead.
 *
 * Endpoints:
 *   GET  /health                     → status + method count
 *   GET  /api/methods                → list of method names
 *   POST /api/call {method, params}  → typed call, result or {error:{code,message}}
 *   WS   /ws                         → multiplexed {type:'call',id,method,params} /
 *                                      {type:'subscribe',events?} + event stream
 *   GET  /*                          → serves the built renderer (static + SPA fallback)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { AppContainer } from '../runtime/container';

const BAD_REQUEST = 'BAD_REQUEST';
const INTERNAL = 'INTERNAL';
const UNAUTHORIZED = 'UNAUTHORIZED';

interface RegistryLike { call(method: string, params: unknown): Promise<unknown>; methods: string[] }
type EventFilter = (ev: unknown) => boolean;

export interface HubOptions {
  container: AppContainer;
  registry: RegistryLike;
  staticDir?: string;
  port?: number;
  host?: string;
  /** if set, clients must pass this token (`Authorization: Bearer`, or ?token= for WS) */
  authToken?: string;
  log?: (msg: string) => void;
}

export interface HubHandle { port: number; url: string; token: string; close: () => Promise<void> }

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: unknown, ctype = 'application/json'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': ctype,
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

interface WsClient { sendJson(obj: unknown): void; sendRaw(b: Buffer): void; close(): void; socket: Socket }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function startHub(opts: HubOptions): Promise<HubHandle> {
  const { container, registry } = opts;
  const token = opts.authToken ?? randomBytes(24).toString('base64url');
  const log = opts.log ?? ((): void => undefined);
  // capture opts before closures
  const staticDir = opts.staticDir;

  const subscriptions = new Map<WsClient, EventFilter>();
  container.setEmit((type: string, payload: unknown): void => {
    const ev = { type, payload, timestamp: new Date().toISOString() };
    for (const [client, filter] of subscriptions) {
      try { if (filter(ev)) client.sendJson({ type: 'event', event: ev }); } catch { /* dropped socket */ }
    }
  });

  const checkAuth = (req: IncomingMessage): boolean => {
    if (opts.authToken === undefined) return true; // local trust mode
    const h = req.headers.authorization ?? '';
    return h === `Bearer ${token}`;
  };

  type CallOutcome = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };
  const doCall = async (method: string, params: unknown): Promise<CallOutcome> => {
    try {
      const result = await registry.call(method, params);
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: { code: msg.startsWith('Unknown method') ? BAD_REQUEST : INTERNAL, message: msg } };
    }
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'OPTIONS') { send(res, 204, ''); return; }

      if (pathname === '/health') {
        send(res, 200, {
          status: 'ok', app: 'API Manager', version: '1.0.0', pid: process.pid,
          methods: registry.methods.length, dataDir: container.dataDir,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      if (pathname === '/api/methods') {
        if (!checkAuth(req)) { send(res, 401, { error: { code: UNAUTHORIZED, message: 'Unauthorized' } }); return; }
        send(res, 200, { methods: registry.methods });
        return;
      }
      if (pathname === '/api/call' && req.method === 'POST') {
        if (!checkAuth(req)) { send(res, 401, { error: { code: UNAUTHORIZED, message: 'Unauthorized' } }); return; }
        const body = await readBody(req);
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>; } catch {
          send(res, 400, { error: { code: BAD_REQUEST, message: 'Invalid JSON' } }); return;
        }
        const method = parsed.method;
        if (typeof method !== 'string' || !method) {
          send(res, 400, { error: { code: BAD_REQUEST, message: 'Missing method' } }); return;
        }
        const t0 = Date.now();
        const out = await doCall(method, parsed.params ?? {});
        log(`[hub] ${method} ${out.ok ? 'ok' : 'ERR'} ${Date.now() - t0}ms`);
        send(res, out.ok ? 200 : 400, out.ok ? { ok: true, result: out.result } : out);
        return;
      }

      if (staticDir && req.method === 'GET') {
        let rel = pathname === '/' ? '/index.html' : pathname;
        rel = normalize(rel).replace(/^([/\\])+/, '');
        const full = join(staticDir, rel);
        if (!full.startsWith(normalize(staticDir))) { send(res, 403, 'forbidden', 'text/plain'); return; }
        let file = full;
        if (!existsSync(file) || !statSync(file).isFile()) {
          const idx = join(staticDir, 'index.html');
          if (existsSync(idx)) file = idx; else { send(res, 404, 'not found', 'text/plain'); return; }
        }
        try {
          const content = readFileSync(file);
          const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
          const cacheControl = /assets[\\/]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-store';
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': cacheControl });
          res.end(content);
          return;
        } catch { send(res, 404, 'not found', 'text/plain'); return; }
      }
      send(res, 404, { error: { code: BAD_REQUEST, message: `No route ${req.method} ${pathname}` } });
    } catch (e) {
      send(res, 500, { error: { code: INTERNAL, message: e instanceof Error ? e.message : String(e) } });
    }
  });

  // ---- minimal WebSocket implementation (RFC6455, text frames; no `ws` needed) ----
  const wsClients = new Set<WsClient>();

  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    if (!checkAuth(req) && url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
    let closed = false;
    const client: WsClient = {
      socket,
      sendRaw(data: Buffer): void {
        if (closed) return;
        let header: Buffer;
        if (data.length < 126) header = Buffer.from([0x81, data.length]);
        else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
        else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
        socket.write(Buffer.concat([header, data]));
      },
      sendJson(obj: unknown): void { this.sendRaw(Buffer.from(JSON.stringify(obj), 'utf8')); },
      close(): void { closed = true; try { socket.destroy(); } catch { /* noop */ } },
    };
    wsClients.add(client);
    client.sendJson({ type: 'hello', methods: registry.methods.length, version: '1.0.0' });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        let frame: { opcode: number; payload: Buffer; consumed: number } | null = null;
        try { frame = decodeWsFrame(buffer); } catch { client.close(); return; }
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) { client.close(); return; }
        if (frame.opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload])); continue; }
        if (frame.opcode !== 1) continue;
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>; } catch { continue; }
        if (msg.type === 'call') {
          const id = msg.id; const method = msg.method;
          if (typeof id === 'string' && typeof method === 'string' && method) {
            void doCall(method, msg.params ?? {}).then((out) => {
              client.sendJson(out.ok ? { type: 'result', id, result: out.result } : { type: 'result', id, error: out.error });
            });
          } else if (typeof id === 'string') {
            client.sendJson({ type: 'result', id, error: { code: BAD_REQUEST, message: 'Missing method' } });
          }
        } else if (msg.type === 'subscribe') {
          const events = new Set(Array.isArray(msg.events) ? msg.events as string[] : []);
          const filter: EventFilter = (ev) => events.size === 0 || (isRecord(ev) && typeof ev.type === 'string' && events.has(ev.type));
          subscriptions.set(client, filter);
          client.sendJson({ type: 'subscribed', count: events.size });
        } else if (msg.type === 'unsubscribe') {
          subscriptions.delete(client);
          client.sendJson({ type: 'subscribed', count: 0 });
        }
      }
    });
    socket.on('close', () => { closed = true; wsClients.delete(client); subscriptions.delete(client); });
    socket.on('error', () => { closed = true; wsClients.delete(client); subscriptions.delete(client); });
  });

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 7654;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: actualPort,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`,
    token,
    close: async () => {
      try { opts.container.session.markCleanExit(); } catch { /* session marker never blocks shutdown */ }
      for (const c of wsClients) c.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await opts.container.flush();
    },
  };
}

function decodeWsFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) {
    if (buf.length < 10) return null;
    const l = buf.readBigUInt64BE(2);
    if (l > BigInt(64 * 1024 * 1024)) throw new Error('frame too large');
    len = Number(l); offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const mask = buf.subarray(maskOffset, maskOffset + 4);
    const un = Buffer.alloc(len);
    for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4];
    payload = un;
  }
  return { opcode, payload, consumed: offset + len };
}
