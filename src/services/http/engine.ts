/**
 * HTTP engine (§20-§21): undici-based HTTP/1.1 (with granular DNS/connect/TLS
 * timing via custom connectors), node-http2 for HTTP/2, proxies (HTTP/HTTPS/
 * SOCKS), custom TLS certs, manual redirect handling, digest/NTLM handshakes,
 * retries with backoff, streaming download progress, cancellation, size caps.
 */
import { Agent, request as undiciRequest, ProxyAgent } from 'undici';
import { connect as netConnect, Socket } from 'node:net';
import { connect as tlsConnect, TLSSocket } from 'node:tls';
import { lookup as dnsLookup } from 'node:dns';
import http2, { ClientHttp2Session } from 'node:http2';
import { SocksClient } from 'socks';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type {
  ApiResponse, AuthConfig, KeyValue, RedirectHop, RequestSettings, RetryAttempt, TimingBreakdown,
} from '../../shared/types';
import { uid } from '../../shared/ids';
import { applyAuth, computeDigestAuthorization, ntlmType1, ntlmType3, ntlmParseType2, ntlmDecodeHeader, parseDigestChallenge } from '../auth/signers';
import { isProbablyBinary, bytesToUtf8 } from '../../core/misc/codec';
import type { RequestProgressEvent } from '../../shared/events';

export interface TlsMaterial { ca?: Buffer; cert?: Buffer; key?: Buffer; pfx?: Buffer; passphrase?: string; }

export interface ProxyConfig { url: string; noProxy?: string[] }

export interface EngineRequest {
  method: string;
  url: string;
  headers: KeyValue[];
  body?: Buffer | null;
  settings: RequestSettings;
  auth?: AuthConfig;
  tls?: TlsMaterial;
  proxy?: ProxyConfig | null;
  cookieHeader?: string;
  maxBodyBytes?: number;
}

export interface EngineResult {
  response: Omit<ApiResponse, 'id'>;
  setCookies: { name: string; value: string; domain: string; path: string; raw: string }[];
}

interface TimingBucket extends TimingBreakdown { _t0: number; }

interface Phase {
  onProgress?: (ev: RequestProgressEvent) => void;
  opId?: string;
}

const pendingOps = new Map<string, { abort: AbortController; h2session?: ClientHttp2Session }>();

export function cancelOp(opId: string): boolean {
  const op = pendingOps.get(opId);
  if (!op) return false;
  try { op.h2session?.close(); } catch { /* ignore */ }
  op.abort.abort();
  return true;
}

export function abortError(): Error { return new Error('Request cancelled'); }

function headersToObject(headers: KeyValue[], cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    if (!h.enabled || !h.key) continue;
    out[h.key.toLowerCase()] = h.value;
  }
  if (cookieHeader && !out['cookie']) out['cookie'] = cookieHeader;
  return out;
}

function kvList(obj: Record<string, string | string[] | undefined>, setCookiesDedup = true): KeyValue[] {
  const out: KeyValue[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) out.push({ id: uid(), key: k, value: item, enabled: true });
    else out.push({ id: uid(), key: k, value: v, enabled: true });
  }
  void setCookiesDedup;
  return out;
}

function shouldBypassProxy(url: string, noProxy: string[]): boolean {
  if (!noProxy?.length) return false;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return noProxy.some((rule) => {
    const r = rule.trim().toLowerCase();
    if (!r) return false;
    if (r === '*') return true;
    if (r.startsWith('.')) return host.endsWith(r) || host === r.slice(1);
    return host === r || host.endsWith(`.${r}`);
  });
}

// ---------------------------------------------------------------------------
// Connectors with precise timing
// ---------------------------------------------------------------------------

interface TimedSocket { socket: Socket | TLSSocket; timing: Partial<TimingBreakdown> }

type LookupSingleCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;
type LookupMultiCallback = (err: NodeJS.ErrnoException | null, addresses: { address: string; family: number }[]) => void;
function timedLookup(timing: Partial<TimingBreakdown>): (hostname: string, options: unknown, callback: unknown) => void {
  return (hostname, options, callback) => {
    const start = performance.now();
    dnsLookup(hostname, options as never, ((err: NodeJS.ErrnoException | null, address: unknown, family?: number) => {
      if (timing.dnsMs === undefined) timing.dnsMs = performance.now() - start;
      if (Array.isArray(address)) (callback as LookupMultiCallback)(err, address as { address: string; family: number }[]);
      else (callback as LookupSingleCallback)(err, address as string, family ?? 4);
    }) as never);
  };
}

async function connectTimed(opts: {
  host: string; port: number; tls: boolean; tlsOpts?: TlsMaterial; verifyTls: boolean; timing: Partial<TimingBreakdown>; proxy?: { url: string };
}): Promise<Socket | TLSSocket> {
  const { timing } = opts;
  const start = performance.now();

  if (opts.proxy && opts.proxy.url.startsWith('socks')) {
    const proxyUrl = new URL(opts.proxy.url);
    const type = proxyUrl.protocol === 'socks4:' || proxyUrl.protocol === 'socks4a:' ? 4 : 5;
    const info = await SocksClient.createConnection({
      proxy: {
        host: proxyUrl.hostname,
        port: parseInt(proxyUrl.port || '1080', 10),
        type,
        userId: decodeURIComponent(proxyUrl.username || '') || undefined,
        password: decodeURIComponent(proxyUrl.password || '') || undefined,
      },
      command: 'connect',
      destination: { host: opts.host, port: opts.port },
    });
    timing.connectMs = performance.now() - start;
    if (opts.tls) {
      const tlsStart = performance.now();
      const socket = tlsConnect({
        socket: info.socket, servername: opts.host,
        ca: opts.tlsOpts?.ca, cert: opts.tlsOpts?.cert, key: opts.tlsOpts?.key, pfx: opts.tlsOpts?.pfx,
        passphrase: opts.tlsOpts?.passphrase, rejectUnauthorized: opts.verifyTls, ALPNProtocols: ['http/1.1'],
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('secureConnect', () => resolve());
        socket.once('error', reject);
      });
      timing.tlsMs = performance.now() - tlsStart;
      return socket;
    }
    return info.socket;
  }

  if (opts.tls) {
    const tlsStart = performance.now();
    const socket = tlsConnect({
      host: opts.host, port: opts.port, servername: opts.host,
      ca: opts.tlsOpts?.ca, cert: opts.tlsOpts?.cert, key: opts.tlsOpts?.key, pfx: opts.tlsOpts?.pfx,
      passphrase: opts.tlsOpts?.passphrase, rejectUnauthorized: opts.verifyTls,
      ALPNProtocols: ['http/1.1'], lookup: timedLookup(timing) as never,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', () => {
        const total = performance.now() - start;
        timing.tlsMs = performance.now() - tlsStart;
        timing.connectMs = Math.max(0, total - timing.tlsMs - (timing.dnsMs ?? 0));
        resolve();
      });
      socket.once('error', reject);
    });
    return socket;
  }

  const socket = netConnect({ host: opts.host, port: opts.port, lookup: timedLookup(timing) as never });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => { timing.connectMs = performance.now() - start - (timing.dnsMs ?? 0); resolve(); });
    socket.once('error', reject);
  });
  return socket;
}

function buildAgent(opts: { timing: Partial<TimingBreakdown>; tls?: TlsMaterial; verifyTls: boolean; proxy?: ProxyConfig | null; url: string }): { dispatcher: Agent | ProxyAgent; usesProxyAgent: boolean } {
  const { timing, tls, verifyTls, proxy, url } = opts;
  const proxyUrl = proxy && !shouldBypassProxy(url, proxy.noProxy ?? []) ? proxy.url : undefined;

  if (proxyUrl && (proxyUrl.startsWith('http://') || proxyUrl.startsWith('https://'))) {
    const agent = new ProxyAgent({ uri: proxyUrl, connect: { rejectUnauthorized: verifyTls, ca: tls?.ca, cert: tls?.cert, key: tls?.key, pfx: tls?.pfx, passphrase: tls?.passphrase as never } });
    return { dispatcher: agent, usesProxyAgent: true };
  }

  const connectFn = async (connectOpts: { host: string; port: number | string; protocol: string; hostname?: string; servername?: string }, callback: (err: Error | null, socket: Socket | TLSSocket | null) => void) => {
    try {
      const host = connectOpts.hostname ?? connectOpts.host;
      const isTls = connectOpts.protocol === 'https:';
      const portRaw = connectOpts.port;
      const portParsed = typeof portRaw === 'number' ? portRaw : Number.parseInt(String(portRaw || ''), 10) || (isTls ? 443 : 80);
      const socket = await connectTimed({
        host, port: portParsed, tls: isTls,
        tlsOpts: tls, verifyTls, timing,
        proxy: proxyUrl?.startsWith('socks') ? { url: proxyUrl } : undefined,
      });
      callback(null, socket);
    } catch (e) {
      callback(e as Error, null);
    }
  };
  const agent = new Agent({ connect: connectFn as never, keepAliveTimeout: 10_000, keepAliveMaxTimeout: 10_000 });
  return { dispatcher: agent, usesProxyAgent: false };
}

// ---------------------------------------------------------------------------
// Timing-instrumented body
// ---------------------------------------------------------------------------

function timedBody(body: Buffer | null | undefined, timing: Partial<TimingBreakdown>): { body?: Readable | Buffer; onUploaded: () => void } {
  if (!body || body.length === 0) return { body: body ?? undefined, onUploaded: () => undefined };
  const uploadStart = performance.now();
  const stream = Readable.from(body);
  stream.once('end', () => {
    timing.uploadMs = performance.now() - uploadStart;
  });
  return { body: stream, onUploaded: () => undefined };
}

// ---------------------------------------------------------------------------
// Single-hop request (HTTP/1.1 via undici)
// ---------------------------------------------------------------------------

interface HopResult {
  status: number;
  statusText: string;
  httpVersion: string;
  headers: KeyValue[];
  body: Buffer;
  timing: Partial<TimingBreakdown>;
  remoteAddress?: string;
}

const STATUS_TEXT: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a Teapot", 421: 'Misdirected Request', 422: 'Unprocessable Content', 423: 'Locked', 424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected', 510: 'Not Extended', 511: 'Network Authentication Required',
};

async function hop(req: EngineRequest, url: string, phase: Phase, preLimits?: { deadline: number }): Promise<HopResult> {
  const u = new URL(url);
  const timing: Partial<TimingBreakdown> = {};
  const abort = new AbortController();
  if (phase.opId) pendingOps.set(phase.opId, { abort });
  const remainingMs = Math.max(1, preLimits ? preLimits.deadline - Date.now() : req.settings.timeoutMs);
  const timeout = setTimeout(() => abort.abort(), remainingMs);
  try {
    const wantHttp2 = req.settings.httpVersion === 'http2' || (req.settings.httpVersion === 'auto' && false);
    if (wantHttp2 && u.protocol === 'https:') {
      return await hopHttp2(req, url, timing, abort, phase);
    }
    const { dispatcher } = buildAgent({ timing, tls: req.tls, verifyTls: req.settings.verifyTls !== false, proxy: req.proxy ?? null, url });
    phase.onProgress?.({ opId: phase.opId ?? '', phase: 'connect' });
    const { body: timedBodyStream } = timedBody(req.body, timing);
    const headers = headersToObject(req.headers, req.cookieHeader);
    const uploadEnd0 = performance.now();
    const res = await undiciRequest(url, {
      method: req.method as never,
      headers,
      body: timedBodyStream ?? undefined,
      dispatcher,
      signal: abort.signal,
      maxRedirections: 0,
      headersTimeout: remainingMs,
      bodyTimeout: remainingMs,
    });
    const headersReceivedAt = performance.now();
    timing.serverMs = Math.max(0, headersReceivedAt - uploadEnd0 - (timing.uploadMs ?? 0));
    phase.onProgress?.({ opId: phase.opId ?? '', phase: 'download', detail: `${res.statusCode}` });
    // read body with size cap + progress
    const chunks: Buffer[] = [];
    let received = 0;
    const max = req.maxBodyBytes ?? 100 * 1024 * 1024;
    const dlStart = performance.now();
    if (res.body) {
      for await (const chunk of res.body as AsyncIterable<Buffer>) {
        if (abort.signal.aborted) throw abortError();
        chunks.push(chunk);
        received += chunk.length;
        phase.onProgress?.({ opId: phase.opId ?? '', phase: 'download', bytesReceived: received });
        if (received > max) {
          abort.abort();
          throw new Error(`Response body exceeded limit of ${formatBytes(max)}`);
        }
      }
    }
    timing.downloadMs = performance.now() - dlStart;
    const body = Buffer.concat(chunks);
    return {
      status: res.statusCode,
      statusText: STATUS_TEXT[res.statusCode] ?? '',
      httpVersion: 'HTTP/1.1',
      headers: kvList(res.headers as Record<string, string | string[] | undefined>),
      body,
      timing,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function hopHttp2(req: EngineRequest, url: string, timing: Partial<TimingBreakdown>, abort: AbortController, phase: Phase): Promise<HopResult> {
  const u = new URL(url);
  const start = performance.now();
  const session = http2.connect(u.origin, {
    createConnection: () => {
      const socket = tlsConnect({
        host: u.hostname, port: parseInt(u.port || '443', 10), servername: u.hostname,
        ca: req.tls?.ca, cert: req.tls?.cert, key: req.tls?.key, pfx: req.tls?.pfx, passphrase: req.tls?.passphrase,
        rejectUnauthorized: req.settings.verifyTls !== false, ALPNProtocols: ['h2'], lookup: timedLookup(timing) as never,
      });
      socket.once('secureConnect', () => {
        timing.connectMs = performance.now() - start;
        timing.tlsMs = performance.now() - start - (timing.dnsMs ?? 0);
      });
      return socket;
    },
  });
  if (phase.opId) pendingOps.set(phase.opId, { abort, h2session: session });
  try {
    await new Promise<void>((resolve, reject) => {
      session.once('connect', () => resolve());
      session.once('error', (err) => reject(err));
      abort.signal.addEventListener('abort', () => { session.destroy(); reject(abortError()); }, { once: true });
    });
    const headers: Record<string, string> = {
      ':method': req.method,
      ':path': `${u.pathname}${u.search}`,
      ':authority': u.host,
      'user-agent': 'api-manager/1.0',
      ...headersToObject(req.headers, req.cookieHeader),
    };
    const result = await new Promise<HopResult>((resolve, reject) => {
      const stream = session.request(headers);
      const respHeaders: Record<string, string | string[]> = {};
      const chunks: Buffer[] = [];
      let status = 0;
      stream.on('response', (hdrs) => {
        Object.assign(respHeaders, hdrs as never);
        status = Number((hdrs as Record<string, unknown>)[':status'] ?? 0);
        timing.serverMs = performance.now() - start - (timing.connectMs ?? 0) - (timing.uploadMs ?? 0);
      });
      const dlStartHolder = { v: 0 };
      stream.on('data', (chunk: Buffer) => {
        if (!dlStartHolder.v) dlStartHolder.v = performance.now();
        chunks.push(chunk);
        phase.onProgress?.({ opId: phase.opId ?? '', phase: 'download', bytesReceived: chunks.reduce((s, c) => s + c.length, 0) });
      });
      stream.on('end', () => {
        if (dlStartHolder.v) timing.downloadMs = performance.now() - dlStartHolder.v;
        resolve({
          status, statusText: STATUS_TEXT[status] ?? '', httpVersion: 'HTTP/2',
          headers: kvList(Object.fromEntries(Object.entries(respHeaders).filter(([k]) => !k.startsWith(':')))),
          body: Buffer.concat(chunks), timing,
        });
      });
      stream.on('error', reject);
      if (req.body && req.body.length > 0) {
        const uploadStart = performance.now();
        stream.end(req.body, () => { timing.uploadMs = performance.now() - uploadStart; });
      } else stream.end();
    });
    return result;
  } finally {
    session.close();
  }
}

// ---------------------------------------------------------------------------
// Redirect handling
// ---------------------------------------------------------------------------

const SENSITIVE_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);

function isRedirect(status: number): boolean { return [301, 302, 303, 307, 308].includes(status); }

function sameOrigin(a: string, b: string): boolean {
  try { const ua = new URL(a), ub = new URL(b); return ua.origin === ub.origin; } catch { return false; }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function sendHttp(req: EngineRequest, phase: Phase = {}): Promise<EngineResult> {
  const op = phase.opId ?? '';
  const redirects: RedirectHop[] = [];
  const retryAttempts: RetryAttempt[] = [];
  const retry = req.settings.retry;
  const maxAttempts = retry?.enabled ? 1 + Math.max(0, retry.maxRetries) : 1;
  const idempotent = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE'].includes(req.method.toUpperCase());
  if (retry?.enabled && retry.onlyIdempotent && !idempotent) throw new Error(`Retry refused: method ${req.method} is not idempotent (enable "retry all methods" explicitly).`);

  const deadline = Date.now() + Math.max(retry?.enabled ? (req.settings.timeoutMs * maxAttempts + (retry.delayMs * maxAttempts * 2)) : req.settings.timeoutMs, 1000);
  let attempt = 0;
  let lastError: Error | undefined;

  while (attempt < maxAttempts) {
    attempt++;
    const attemptStart = Date.now();
    try {
      const result = await sendOnce(req, redirects, attempt, phase, deadline);
      const retryableStatus = retry?.enabled && retry.retryStatusCodes.includes(result.response.status);
      if (retryableStatus && attempt < maxAttempts) {
        retryAttempts.push({ attempt, status: result.response.status, durationMs: Date.now() - attemptStart, timestamp: new Date().toISOString() });
        phase.onProgress?.({ opId: op, phase: 'retry', attempt, detail: `status ${result.response.status}` });
        redirects.length = 0;
        await sleep(backoff(retry!.delayMs, attempt, retry!.strategy));
        continue;
      }
      result.response.retryAttempts = retryAttempts;
      return result;
    } catch (e) {
      lastError = e as Error;
      const isAbort = abortLike(e);
      if (isAbort) throw abortError();
      const isTimeout = /timeout|timed out/i.test(String((e as Error).message)) || (e as { code?: string }).code === 'UND_ERR_HEADERS_TIMEOUT';
      const retryable = retry?.enabled && ((isTimeout && retry.retryOnTimeout) || (!isTimeout && retry.retryOnNetworkError));
      retryAttempts.push({ attempt, error: (e as Error).message, durationMs: Date.now() - attemptStart, timestamp: new Date().toISOString() });
      phase.onProgress?.({ opId: op, phase: 'retry', attempt, detail: (e as Error).message });
      if (retryable && attempt < maxAttempts) {
        await sleep(backoff(retry!.delayMs, attempt, retry!.strategy));
        continue;
      }
      throw lastError;
    } finally {
      if (phase.opId) pendingOps.delete(phase.opId);
    }
  }
  throw lastError ?? new Error('Request failed');
}

function abortLike(e: unknown): boolean {
  const err = e as { name?: string; message?: string; code?: string };
  return err?.name === 'AbortError' || err?.message === 'Request cancelled' || err?.code === 'UND_ERR_ABORTED' || err?.code === 20 as never;
}

function backoff(base: number, attempt: number, strategy: 'fixed' | 'exponential'): number {
  return strategy === 'exponential' ? base * Math.pow(2, attempt - 1) : base;
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function sendOnce(req: EngineRequest, redirects: RedirectHop[], _attempt: number, phase: Phase, deadline: number): Promise<EngineResult> {
  let url = req.url;
  let currentMethod = req.method.toUpperCase();
  let currentHeaders = req.headers.map((h) => ({ ...h }));
  let currentBody = req.body ?? null;
  let totalTiming: TimingBreakdown = { totalMs: 0 };
  const t0 = performance.now();

  // Digest/NTLM handshakes: send preliminary request without Authorization
  let digest: { cfg: AuthConfig['digest']; challenge?: Record<string, string> } | undefined;
  if (req.auth?.type === 'digest' && req.auth.digest) digest = { cfg: req.auth.digest };
  let ntlmState: { type1Sent: boolean; type2?: ReturnType<typeof ntlmParseType2> } | undefined;
  if (req.auth?.type === 'ntlm' && req.auth.ntlm) {
    ntlmState = { type1Sent: false };
    const type1 = ntlmType1(req.auth.ntlm);
    replaceHeader(currentHeaders, 'Authorization', `NTLM ${type1.toString('base64')}`);
    ntlmState.type1Sent = true;
  }

  const maxHops = Math.max(1, req.settings.followRedirects ? req.settings.maxRedirects : 1);
  for (let hopIdx = 0; hopIdx < maxHops; hopIdx++) {
    const hopReq: EngineRequest = { ...req, method: currentMethod, url, headers: currentHeaders, body: currentBody };
    const hopStart = performance.now();
    let result: HopResult;
    try {
      result = await hop(hopReq, url, phase, { deadline });
    } catch (e) {
      totalTiming.totalMs = performance.now() - t0;
      throw e;
    }
    mergeTiming(totalTiming, result.timing, hopIdx);

    // NTLM negotiation
    if (result.status === 401 && result.headers.some((h) => h.key.toLowerCase() === 'www-authenticate' && h.value.toLowerCase().startsWith('ntlm'))) {
      if (req.auth?.type === 'ntlm' && req.auth.ntlm) {
        if (!ntlmState?.type2) {
          const wwwAuth = result.headers.find((h) => h.key.toLowerCase() === 'www-authenticate')!;
          const type2Raw = ntlmDecodeHeader(wwwAuth.value);
          if (type2Raw) {
            const type2 = ntlmParseType2(type2Raw);
            const type3 = ntlmType3(req.auth.ntlm, type2);
            replaceHeader(currentHeaders, 'Authorization', `NTLM ${type3.toString('base64')}`);
            ntlmState!.type2 = type2;
            continue;
          }
        }
      }
    }

    // Digest negotiation
    if (result.status === 401 && digest?.cfg) {
      const wwwAuth = result.headers.find((h) => h.key.toLowerCase() === 'www-authenticate' && /digest/i.test(h.value));
      if (wwwAuth && !digest.challenge) {
        const challenge = parseDigestChallenge(wwwAuth.value);
        if (challenge.nonce) {
          digest.challenge = challenge;
          const relUri = new URL(url).pathname + new URL(url).search;
          const authHeader = computeDigestAuthorization({ ...digest.cfg, realm: challenge.realm ?? digest.cfg.realm }, challenge, { method: currentMethod, uri: relUri, body: currentBody ?? undefined });
          replaceHeader(currentHeaders, 'Authorization', authHeader);
          continue;
        }
      }
    }

    // Redirect?
    if (isRedirect(result.status) && req.settings.followRedirects && hopIdx < maxHops - 1) {
      const location = result.headers.find((h) => h.key.toLowerCase() === 'location')?.value;
      if (location) {
        const next = new URL(location, url).toString();
        redirects.push({ url, status: result.status, statusText: result.statusText, headers: result.headers, durationMs: performance.now() - hopStart });
        phase.onProgress?.({ opId: phase.opId ?? '', phase: 'redirect', detail: `${result.status} → ${next}` });
        if (!sameOrigin(url, next)) {
          if (req.settings.stripSensitiveHeaders !== false || !req.settings.preserveAuthOnRedirect) {
            currentHeaders = currentHeaders.filter((h) => !SENSITIVE_HEADERS.has(h.key.toLowerCase()));
          }
        }
        if (result.status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
          currentMethod = 'GET';
          currentBody = null;
          currentHeaders = currentHeaders.filter((h) => !['content-type', 'content-length'].includes(h.key.toLowerCase()));
        }
        url = next;
        continue;
      }
    }

    // Final response
    totalTiming.totalMs = performance.now() - t0;
    return buildResult(result, redirects, totalTiming, req, url);
  }

  throw new Error(`Too many redirects (max ${maxHops})`);
}

function buildResult(result: HopResult, redirects: RedirectHop[], timing: TimingBreakdown, req: EngineRequest, url: string): EngineResult {
  const body = result.body;
  const contentType = result.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;
  const isBinary = isProbablyBinary(body) && !/text|json|xml|html|javascript|urlencoded|graphql/i.test(contentType ?? '');
  const setCookies = parseSetCookies(result.headers, url);
  const headerBytes = result.headers.reduce((s, h) => s + h.key.length + h.value.length + 4, 0);
  const requestHeaderBytes = req.headers.reduce((s, h) => s + (h.enabled ? h.key.length + h.value.length + 4 : 0), 0);
  return {
    response: {
      status: result.status,
      statusText: result.statusText,
      httpVersion: result.httpVersion,
      headers: result.headers,
      cookies: [],
      bodyText: isBinary ? undefined : bytesToUtf8(body),
      bodyBase64: isBinary ? body.toString('base64') : undefined,
      bodyIsBinary: isBinary,
      bodySize: body.length,
      requestSize: (req.body?.length ?? 0) + requestHeaderBytes,
      timing: {
        dnsMs: timing.dnsMs, connectMs: timing.connectMs, tlsMs: timing.tlsMs,
        uploadMs: timing.uploadMs, serverMs: timing.serverMs, downloadMs: timing.downloadMs,
        totalMs: timing.totalMs, queueMs: undefined,
      },
      redirects,
      retryAttempts: [],
      remoteAddress: result.remoteAddress,
      contentType,
      timestamp: new Date().toISOString(),
      requestSnapshot: {
        method: req.method, url, headers: req.headers,
        body: req.body && req.body.length < 1_000_000 ? (isProbablyBinary(req.body) ? `<binary ${req.body.length} bytes>` : bytesToUtf8(req.body)) : undefined,
      },
    },
    setCookies,
  };
}

function parseSetCookies(headers: KeyValue[], url: string): { name: string; value: string; domain: string; path: string; raw: string }[] {
  const out: { name: string; value: string; domain: string; path: string; raw: string }[] = [];
  const host = new URL(url).hostname;
  for (const h of headers.filter((x) => x.key.toLowerCase() === 'set-cookie')) {
    const parts = h.value.split(';');
    const first = parts[0] ?? '';
    const idx = first.indexOf('=');
    if (idx === -1) continue;
    let domain = host, path = '/';
    for (const attr of parts.slice(1)) {
      const [k, v] = attr.trim().split('=');
      if (k?.toLowerCase() === 'domain') domain = v ?? domain;
      if (k?.toLowerCase() === 'path') path = v ?? path;
    }
    out.push({ name: first.slice(0, idx).trim(), value: first.slice(idx + 1).trim(), domain, path, raw: h.value });
  }
  return out;
}

function replaceHeader(headers: KeyValue[], name: string, value: string): void {
  const existing = headers.findIndex((h) => h.key.toLowerCase() === name.toLowerCase());
  if (existing >= 0) headers[existing] = { ...headers[existing], value, enabled: true };
  else headers.push({ id: uid(), key: name, value, enabled: true });
}

function mergeTiming(acc: Partial<TimingBreakdown>, add: Partial<TimingBreakdown>, hopIdx: number): void {
  if (hopIdx === 0) {
    acc.dnsMs = add.dnsMs; acc.connectMs = add.connectMs; acc.tlsMs = add.tlsMs;
  } else {
    acc.dnsMs = (acc.dnsMs ?? 0) + (add.dnsMs ?? 0) || acc.dnsMs;
    acc.connectMs = (acc.connectMs ?? 0) + (add.connectMs ?? 0) || acc.connectMs;
    acc.tlsMs = (acc.tlsMs ?? 0) + (add.tlsMs ?? 0) || acc.tlsMs;
  }
  acc.uploadMs = add.uploadMs;
  acc.serverMs = add.serverMs;
  acc.downloadMs = add.downloadMs;
}

function formatBytes(n: number): string {
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n > 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export { applyAuth, createHmac, createHash, randomBytes };
