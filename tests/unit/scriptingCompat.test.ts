import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runScript, makeMemoryStore } from '../../src/services/scripts/sandbox';
import { executeRequest, PipelineDeps } from '../../src/services/http/sendPipeline';
import type { ApiRequest, ApiResponse } from '../../src/shared/types';

const FULL_SETTINGS = {
  timeoutMs: 15_000, maxRedirects: 10, followRedirects: true, keepAlive: true,
  requestCompression: 'none', httpVersion: 'auto', strictSsl: true, encodeUrl: true,
  multipartMode: 'form-data', retryCount: 0, retryDelayMs: 0, http2PriorKnowledge: false,
} as unknown as ApiRequest['settings'];

const reqStub = (): ApiRequest => ({
  id: 'r1', workspaceId: 'w1', name: 'R', method: 'GET', url: 'http://127.0.0.1:9/x',
  pathParams: [], queryParams: [], headers: [], body: { type: 'none' },
  auth: { type: 'none' }, assertions: [], scripts: {}, protocol: 'http',
  tags: [], favorite: false, sortOrder: 0, settings: FULL_SETTINGS, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
} as unknown as ApiRequest);

const resStub = (): ApiResponse => ({
  id: 'resp1', requestId: 'r1', status: 200, statusText: 'OK', httpVersion: '1.1',
  headers: [{ key: 'content-type', value: 'application/json' }], bodyText: '{"ok":true,"url":"http://127.0.0.1/x"}',
  bodySize: 20, cookies: [], timing: { totalMs: 1, dnsMs: 0, connectMs: 0, tlsMs: 0, uploadMs: 0, serverMs: 0, downloadMs: 0 },
  redirects: [], timestamp: '2026-01-01T00:00:00Z',
} as unknown as ApiResponse);

const stores = () => ({
  environment: makeMemoryStore({}),
  globals: makeMemoryStore({}),
  collectionVariables: makeMemoryStore({}),
  localVariables: makeMemoryStore({}),
});

describe('pm.expect Postman-style matchers', () => {
  it('supports toBe/toEqual/toContain/toMatch/toThrow and negation', async () => {
    const s = stores();
    const out = await runScript({
      code: `
        pm.expect(2).toBe(2);
        pm.expect('abcdef').toContain('bcd');
        pm.expect({ a: { b: 1 } }).toEqual({ a: { b: 1 } });
        pm.expect('hello world').toMatch(/^hello/);
        pm.expect(() => { throw new Error('boom'); }).toThrow('boom');
        pm.expect(5).not.toBe(6);
        pm.expect(null).toBeNull();
        pm.expect(undefined).toBeUndefined();
        pm.expect([1, 2, 3]).toHaveLength(3);
        pm.expect({ x: 9 }).toHaveProperty('x', 9);
        pm.expect(7).toBeGreaterThan(3);
        pm.test('jestish containment', () => { pm.expect(['a', 'b']).toContain('b'); });
        pm.test('negated container', () => { pm.expect('hello').not.toContain('zzz'); });
      `,
      eventName: 'test', request: reqStub(), response: resStub(), stores: s,
      timeoutMs: 5000, consoleTarget: () => undefined, scriptLabel: 'spec',
    });
    expect(out.outcome.error).toBeUndefined();
    expect(out.outcome.tests.every((t) => t.passed)).toBe(true);
  });

  it('records failing assertions instead of swallowing them', async () => {
    const out = await runScript({
      code: `pm.test('must fail', () => { pm.expect(1).toBe(2); });`,
      eventName: 'test', request: reqStub(), response: resStub(), stores: stores(),
      timeoutMs: 5000, consoleTarget: () => undefined, scriptLabel: 'spec',
    });
    expect(out.outcome.tests.length).toBe(1);
    expect(out.outcome.tests[0].passed).toBe(false);
    expect(out.outcome.tests[0].error).toContain('expected 1');
  });
});

describe('script scope stores capture mutations', () => {
  it('pm.environment.set + pm.globals.set + pm.collectionVariables.set throw no error and mutate stores', async () => {
    const s = stores();
    const out = await runScript({
      code: `
        pm.environment.set('ENV_K', 'V1');
        pm.globals.set('GLOB_K', 'V2');
        pm.collectionVariables.set('COLL_K', 'V3');
        pm.test('scopes visible back', () => {
          pm.expect(pm.environment.get('ENV_K')).toBe('V1');
          pm.expect(pm.variables.get('ENV_K')).toBe('V1');
        });
      `,
      eventName: 'test', request: reqStub(), response: resStub(), stores: s,
      timeoutMs: 5000, consoleTarget: () => undefined, scriptLabel: 'spec',
    });
    expect(out.outcome.error).toBeUndefined();
    expect(out.outcome.tests.every((t) => t.passed)).toBe(true);
    expect(s.environment.get('ENV_K')).toBe('V1');
    expect(s.globals.get('GLOB_K')).toBe('V2');
    expect(s.collectionVariables.get('COLL_K')).toBe('V3');
  });
});

describe('sendPipeline persists script variable mutations', () => {
  let srv: Server;
  let base = '';
  beforeAll(() => new Promise<void>((resolve) => {
    srv = createServer((_q, s2) => { s2.setHeader('content-type', 'application/json'); s2.end('{"ok":true}'); });
    srv.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`; resolve(); });
  }));
  afterAll(() => new Promise<void>((resolve) => { srv.close(() => resolve()); }));

  it('flushes pm.environment.set / pm.globals.set / pm.collectionVariables.set via applyVariableChanges', async () => {
    const apply = vi.fn();
    const deps = {
      getEnvironment: (id?: string) => id === 'e1' ? {
        id: 'e1', workspaceId: 'w1', name: 'Env', variables: [], sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      } : undefined,
      getActiveEnvironmentId: () => 'e1',
      getCollection: (id?: string) => id === 'c1' ? {
        id: 'c1', workspaceId: 'w1', name: 'Coll', variables: [], sortOrder: 0, scripts: { preRequest: '', postResponse: '' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
      } : undefined,
      getFolderChain: () => [],
      getGlobalVars: () => [],
      getWorkspaceVars: () => [],
      getCollectionParents: () => ({}),
      resolveSecretRef: (v: string) => v,
      getCookieHeader: () => '',
      storeCookies: () => undefined,
      loadCertificate: () => undefined,
      resolveProxy: () => null,
      onConsole: () => undefined,
      persistHistory: () => undefined,
      persistResponse: () => undefined,
      audit: () => undefined,
      applyVariableChanges: apply as PipelineDeps['applyVariableChanges'],
      maxBodyBytes: 10 * 1024 * 1024,
    } as unknown as PipelineDeps;

    const request = {
      ...reqStub(), url: `${base}/x`, collectionId: 'c1',
      scripts: {
        preRequest: `pm.globals.set('G_PRE', 'pre');`,
        postResponse: `
          pm.environment.set('ENV_K', 'V1');
          pm.globals.set('G_POST', 'post');
          pm.collectionVariables.set('COLL_K', 'coll');
          pm.test('status code number', () => { pm.expect(pm.response.code).toBe(200); });
          pm.test('status text (Postman parity)', () => { pm.expect(pm.response.status).toBe('OK'); });
          pm.test('body json', () => { pm.expect(pm.response.json().ok).toBe(true); });
        `,
      },
    } as unknown as ApiRequest;

    const result = await executeRequest({ request, environmentId: 'e1' }, deps)
      .catch((e) => ({ error: String(e), postTestResults: [] as { name: string; passed: boolean }[] }));

    expect(result.error).toBeUndefined();
    expect(apply).toHaveBeenCalledTimes(1);
    const arg = (apply.mock.calls[0]?.[0] ?? {}) as NonNullable<Parameters<NonNullable<PipelineDeps['applyVariableChanges']>>[0]>;
    expect(arg.environment?.vars['ENV_K']).toBe('V1');
    expect(arg.globals?.['G_PRE']).toBe('pre');
    expect(arg.globals?.['G_POST']).toBe('post');
    expect(arg.collection?.vars['COLL_K']).toBe('coll');
    expect(result.postTestResults?.[0]?.passed).toBe(true);
    expect(result.postTestResults?.[1]?.passed).toBe(true);
    expect(result.postTestResults?.[2]?.passed).toBe(true);
  });
});
