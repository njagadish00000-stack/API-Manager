/**
 * Mock servers (§17): local HTTP servers on 127.0.0.1 with path-pattern
 * routes ({param} and * wildcards), conditional routing scripts, response
 * sequences, dynamic variables in bodies ({{$...}}), latency simulation,
 * collection-example routing and request logging.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { ApiRequest, MockRequestLog, MockRoute, MockServer } from '../../shared/types';
import { now } from '../../shared/types';
import { renderDatasetTemplate } from '../datasets/dataFiles';
import { runTransformScript } from '../scripts/sandbox';

export interface MockRuntimeDeps {
  getExamples: (requestId: string) => { request: Partial<ApiRequest>; response?: { status: number; bodyText?: string; headers: { key: string; value: string }[] }; name: string }[];
  listRequestsForCollection: (collectionId: string) => ApiRequest[];
  logRequest: (entry: MockRequestLog) => void;
  emitEvent: (type: 'mock.log', payload: MockRequestLog) => void;
}

interface RunningMock {
  mock: MockServer;
  server: http.Server;
  requestCount: number;
  sequenceCounters: Map<string, number>;
}

const running = new Map<string, RunningMock>();

function renderDynamic(body: string, seq: number, req: { method: string; path: string; params: Record<string, string>; query: URLSearchParams }): string {
  const vars: Record<string, string> = {
    '$timestamp': new Date().toISOString(),
    '$isoTimestamp': new Date().toISOString(),
    '$randomUUID': randomUUID(),
    '$guid': randomUUID(),
    '$request.method': req.method,
    '$request.path': req.path,
    '$seq': String(seq),
  };
  for (const [k, v] of Object.entries(req.params)) vars[`$param.${k}`] = v;
  req.query.forEach((v, k) => { vars[`$query.${k}`] = v; });
  let out = body.replace(/\{\{\s*(\$[\w.:-]+)\s*\}\}/g, (_m, name: string) => vars[name] ?? '');
  if (/\{\{\s*\$[\w:]/.test(out)) out = renderDatasetTemplate(out, seq);
  return out;
}

interface MatchedRoute { route: MockRoute; params: Record<string, string>; exampleServed?: boolean }

function matchPath(pattern: string, path: string): { params: Record<string, string> } | null {
  const paramNames: string[] = [];
  const rxStr = pattern.split('/').map((seg) => {
    if (seg.startsWith('{') && seg.endsWith('}')) { paramNames.push(seg.slice(1, -1)); return '([^/]+)'; }
    if (seg === '*') { paramNames.push('*'); return '(.*)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  const rx = new RegExp(`^${rxStr}$`);
  const m = rx.exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
  return { params };
}

async function chooseRoute(mock: MockRuntime, incoming: { method: string; path: string; query: URLSearchParams; body: string; headers: http.IncomingHttpHeaders }): Promise<MatchedRoute | null> {
  for (const route of mock.mock.routes) {
    if (!route.enabled) continue;
    if (route.method !== '*' && route.method.toUpperCase() !== incoming.method.toUpperCase()) continue;
    const match = matchPath(route.pathPattern, incoming.path);
    if (!match) continue;
    if (route.conditionScript?.trim()) {
      const vars: Record<string, string> = {
        method: incoming.method, path: incoming.path, body: incoming.body.slice(0, 4000),
        ...Object.fromEntries(incoming.query.entries()),
      };
      try {
        const evalSrc = `(${route.conditionScript})`;
        const fn: unknown = new (Object.getPrototypeOf(async function () {}).constructor)('vars', `with(vars){ return ${evalSrc}; }`);
        const result = await (fn as (v: Record<string, string>) => unknown)(vars);
        if (!result) continue;
      } catch { continue; }
    }
    return { route, params: match.params };
  }
  return null;
}

interface MockRuntime { mock: MockServer; server?: http.Server; sequenceCounters: Map<string, number> }

async function respondWithRoute(runtime: MockRuntime, matched: MatchedRoute, seq: number, ctx: { method: string; path: string; query: URLSearchParams }, deps: MockRuntimeDeps, res: http.ServerResponse): Promise<void> {
  const { route } = matched;
  let status = route.status || 200;
  let body = route.body ?? '';
  let headers = route.headers ?? [];
  if (route.exampleId) {
    for (const request of deps.listRequestsForCollection(runtime.mock.collectionId ?? '')) {
      for (const example of deps.getExamples(request.id)) {
        if ((example as unknown as { id?: string }).id === route.exampleId) {
          const ex = example as unknown as { response?: { status: number; bodyText?: string; headers: { key: string; value: string }[] } };
          if (ex.response) {
            status = ex.response.status;
            body = ex.response.bodyText ?? '';
            headers = ex.response.headers.map((h) => ({ key: h.key, value: h.value, id: '', enabled: true }));
          }
        }
      }
    }
  }
  if (matched.route.sequence?.length) {
    const ctr = (runtime.sequenceCounters.get(route.id) ?? 0);
    const step = matched.route.sequence[ctr % matched.route.sequence.length];
    runtime.sequenceCounters.set(route.id, ctr + 1);
    if (step.status) status = step.status;
    if (step.body) body = step.body;
  }
  const renderedBody = runtime.mock.dynamicVars ? renderDynamic(body, seq, { method: ctx.method, path: ctx.path, params: matched.params, query: ctx.query }) : body;
  if (runtime.mock.latencyMs && runtime.mock.latencyMs > 0) await new Promise((r) => setTimeout(r, runtime.mock.latencyMs));
  res.writeHead(status, Object.fromEntries(headers.filter((h) => h.enabled).map((h) => [h.key, h.value])) as Record<string, string>);
  res.end(renderedBody);
}

export async function startMock(mockId: string, getMock: (id: string) => MockServer | undefined, deps: MockRuntimeDeps): Promise<{ url: string; port: number }> {
  if (running.has(mockId)) throw new Error(`Mock ${mockId} already running`);
  const mock = getMock(mockId);
  if (!mock) throw new Error(`Mock not found: ${mockId}`);
  const runtime: RunningMock = { mock, server: undefined as unknown as http.Server, requestCount: 0, sequenceCounters: new Map() };
  const server = http.createServer(async (req, res) => {
    runtime.requestCount++;
    const seq = runtime.requestCount;
    const u = new URL(req.url ?? '/', `http://localhost:${mock.port}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    const method = (req.method ?? 'GET').toUpperCase();
    const path = u.pathname;
    try {
      const matched = await chooseRoute(runtime as MockRuntime, { method, path, query: u.searchParams, body, headers: req.headers });
      if (!matched) {
        // fall back to collection examples: match by method+path on linked collection requests
        if (mock.collectionId) {
          for (const request of deps.listRequestsForCollection(mock.collectionId)) {
            const reqPath = pathOfUrl(request.url);
            if (reqPath === path && (request.method === '*' || request.method === method)) {
              const examples = deps.getExamples(request.id);
              const example = examples[0] as unknown as { response?: { status: number; bodyText?: string; headers: { key: string; value: string }[] } } | undefined;
              if (example?.response) {
                const response = example.response;
                res.writeHead(response.status, Object.fromEntries((response.headers ?? []).map((h) => [h.key, h.value])));
                res.end(response.bodyText ?? '');
                logHit(deps, mock.id, seq, method, path, response.status);
                return;
              }
            }
          }
        }
        // default route generated from linkedOpenApiSpec is handled upstream when building mock.routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching mock route', method, path }));
        logHit(deps, mock.id, seq, method, path, 404);
        return;
      }
      await respondWithRoute(runtime, matched, seq, { method, path, query: u.searchParams }, deps, res);
      logHit(deps, mock.id, seq, method, path, matched.route.status || 200);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  runtime.server = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e) => reject(new Error(`Mock port ${mock.port} unavailable: ${e.message}`)));
    server.listen(mock.port, '127.0.0.1', () => resolve());
  });
  running.set(mockId, runtime);
  return { url: `http://127.0.0.1:${mock.port}`, port: mock.port };
}

function logHit(deps: MockRuntimeDeps, mockId: string, seq: number, method: string, path: string, status: number): void {
  void seq;
  const entry: MockRequestLog = { id: randomUUID(), mockId, timestamp: now(), method, path, status };
  deps.logRequest(entry);
  deps.emitEvent('mock.log', entry);
}

export function stopMock(mockId: string): void {
  const rt = running.get(mockId);
  if (rt) { try { rt.server.close(); } catch { /* ignore */ } running.delete(mockId); }
}

export function isMockRunning(mockId: string): boolean { return running.has(mockId); }

export function stopAllMocks(): void {
  for (const id of [...running.keys()]) stopMock(id);
}

function pathOfUrl(raw: string): string {
  try {
    const u = new URL(raw.includes('://') ? raw : `http://x${raw.startsWith('/') ? '' : '/'}${raw}`);
    return u.pathname.replace(/\{[^}]+\}/g, '*');
  } catch { return raw; }
}
