/**
 * Traffic capture (§36): a local HTTP/HTTPS forward proxy on 127.0.0.1 that
 * records plain-HTTP exchanges verbatim and tunnels CONNECT (HTTPS)
 * passthrough, logging the CONNECT metadata only.
 */
import http from 'node:http';
import net from 'node:net';
import { request } from 'undici';
import type { CapturedExchange } from '../../shared/types';
import { randomUUID } from 'node:crypto';
import { now } from '../../shared/types';
import { uid } from '../../shared/ids';

export interface CaptureDeps {
  saveExchange: (ex: CapturedExchange) => void;
  emit: (type: 'capture.exchange', payload: CapturedExchange) => void;
}

interface CaptureState {
  server?: http.Server;
  port: number;
  running: boolean;
}

const state: CaptureState = { port: 0, running: false };

export function captureStatus(): { running: boolean; port?: number } {
  return { running: state.running, port: state.running ? state.port : undefined };
}

export async function startCapture(port: number, deps: CaptureDeps): Promise<{ port: number; proxyUrl: string }> {
  if (state.running) throw new Error('Capture already running');
  const server = http.createServer(async (req, res) => {
    const t0 = performance.now();
    const id = randomUUID();
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024 * 1024) { req.destroy(); } });
    await new Promise<void>((resolve) => req.on('end', resolve));
    const ex: CapturedExchange = {
      id, timestamp: now(), client: req.socket.remoteAddress ?? 'unknown',
      method: req.method ?? 'GET', url: req.url ?? '/',
      requestHeaders: Object.entries(req.headers).map(([key, value]) => ({ id: uid(), key, value: Array.isArray(value) ? value.join(', ') : String(value ?? ''), enabled: true })),
      requestBody: body || undefined,
    };
    const target = req.url ?? '';
    try {
      const fwdHeaders: Record<string, string> = {};
      for (const h of ex.requestHeaders) {
        if (h.key.toLowerCase() === 'proxy-connection') continue;
        if (h.key.toLowerCase() === 'host') continue;
        fwdHeaders[h.key] = h.value;
      }
      const headersHost = req.headers.host ?? new URL(target).host;
      fwdHeaders['host'] = headersHost;
      const upstream = await request(target, {
        method: (req.method ?? 'GET') as never,
        headers: fwdHeaders,
        body: body || undefined,
        maxRedirections: 5,
      });
      ex.status = upstream.statusCode;
      ex.responseHeaders = Object.entries(upstream.headers).map(([key, value]) => ({ id: uid(), key, value: Array.isArray(value) ? value.join(', ') : String(value ?? ''), enabled: true }));
      const respBody = Buffer.from(await upstream.body.arrayBuffer());
      ex.responseBody = respBody.length <= 256 * 1024 ? respBody.toString('utf8') : `[binary ${respBody.length} bytes]`;
      const hdrs: Record<string, string> = {};
      for (const h of ex.responseHeaders) hdrs[h.key] = h.value;
      res.writeHead(upstream.statusCode, hdrs);
      res.end(respBody);
    } catch (e) {
      ex.responseBody = e instanceof Error ? e.message : String(e);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    ex.durationMs = performance.now() - t0;
    deps.saveExchange(ex);
    deps.emit('capture.exchange', ex);
  });

  server.on('connect', (req, socket: net.Socket, head) => {
    const u = new URL(`http://${req.url}`);
    const hostPort = u.host.split(':');
    const targetPort = Number(hostPort[1] ?? 443);
    const proxySocket = net.connect(targetPort, hostPort[0], () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
    const ex: CapturedExchange = {
      id: randomUUID(), timestamp: now(), client: socket.remoteAddress ?? 'unknown',
      method: 'CONNECT', url: req.url ?? '',
      requestHeaders: [], status: 200,
      responseBody: 'TLS tunnel (payload not inspected)',
    };
    deps.saveExchange(ex);
    deps.emit('capture.exchange', ex);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  state.server = server;
  state.port = port;
  state.running = true;
  return { port, proxyUrl: `http://127.0.0.1:${port}` };
}

export function stopCapture(): void {
  if (state.server) { try { state.server.close(); } catch { /* ignore */ } }
  state.server = undefined;
  state.running = false;
  state.port = 0;
}
