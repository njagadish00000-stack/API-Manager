/**
 * Webhook receivers (§20): local endpoints per receiver configuration that
 * capture requests (headers/body/query), verify optional HMAC signatures,
 * reply with a configurable canned response, and store capped event logs.
 */
import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookEvent, WebhookReceiver } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';

export interface WebhookDeps {
  saveEvent: (ev: WebhookEvent) => void;
  emitEvent: (type: 'webhook.event', payload: WebhookEvent) => void;
  /** optional — persists bound ephemeral port + running state so the list reflects reality */
  saveReceiver?: (wh: WebhookReceiver) => void;
}

const servers = new Map<string, http.Server>();

export function verifyHmacSignature(secret: string, rawBody: string, headerValue: string | undefined, algorithm: 'sha1' | 'sha256' | 'sha512'): boolean {
  if (!secret || !headerValue) return false;
  const expected = createHmac(algorithm, secret).update(rawBody, 'utf8').digest('hex');
  const candidates = [expected, `${algorithm}=${expected}`, `sha256=${expected}`];
  return candidates.some((cand) => {
    const a = Buffer.from(headerValue.trim());
    const b = Buffer.from(cand);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export async function startWebhookReceiver(id: string, getWebhook: (id: string) => WebhookReceiver | undefined, deps: WebhookDeps): Promise<{ url: string }> {
  if (servers.has(id)) throw new Error('Webhook receiver already running');
  const wh = getWebhook(id);
  if (!wh) throw new Error(`Webhook not found: ${id}`);
  const server = http.createServer(async (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', `http://localhost:${wh.port}`);
      const signatureHeader = wh.hmacHeader ? req.headers[wh.hmacHeader.toLowerCase()] : undefined;
      const signatureValid = wh.secret && wh.hmacHeader
        ? verifyHmacSignature(wh.secret, body, Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader, wh.hmacAlgorithm ?? 'sha256')
        : undefined;
      const ev: WebhookEvent = {
        id: uid(), webhookId: wh.id, timestamp: now(),
        method: req.method ?? 'GET', path: url.pathname, query: url.search ? url.search.slice(1) : '',
        headers: Object.entries(req.headers).map(([k, v]) => ({ id: uid(), key: k, value: Array.isArray(v) ? v.join(', ') : String(v ?? ''), enabled: true })),
        body: body.slice(0, 256 * 1024),
        signatureValid,
      };
      deps.saveEvent(ev);
      deps.emitEvent('webhook.event', ev);
      const headers: Record<string, string> = {};
      for (const h of wh.responseHeaders ?? []) if (h.enabled && h.key) headers[h.key] = h.value;
      res.writeHead(wh.responseStatus || 200, headers);
      res.end(wh.responseBody ?? 'OK');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e) => reject(new Error(`Webhook port ${wh.port} unavailable: ${e.message}`)));
    server.listen(wh.port, '127.0.0.1', () => resolve());
  });
  servers.set(id, server);
  // port 0 = OS-assigned ephemeral — resolve to the real bound port
  const bound = server.address();
  const boundPort = typeof bound === 'object' && bound ? bound.port : wh.port;
  if (boundPort !== wh.port) {
    try { deps.saveReceiver?.({ ...wh, port: boundPort, running: true }); } catch { /* non-fatal */ }
  }
  return { url: `http://127.0.0.1:${boundPort}${wh.path.startsWith('/') ? wh.path : `/${wh.path}`}` };
}

export function stopWebhookReceiver(id: string): void {
  const s = servers.get(id);
  if (s) { try { s.close(); } catch { /* ignore */ } servers.delete(id); }
}

export function isWebhookRunning(id: string): boolean { return servers.has(id); }
export function stopAllWebhooks(): void { for (const id of [...servers.keys()]) stopWebhookReceiver(id); }
