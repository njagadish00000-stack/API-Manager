/**
 * Postman-compatible `pm` scripting API (§32/§82). Pure TypeScript — the Node
 * side executes scripts inside a vm sandbox; this module defines the object
 * graph the script interacts with and collects all mutations/output.
 */
import type { ApiRequest, ApiResponse, KeyValue, TestResult } from '../../shared/types';
import { getByPath, parseJson } from '../jsonx/jsonUtils';

/**
 * Realm-safe RegExp check. Scripts run inside a Node `vm` context, so a regex
 * literal in user code is an instance of the *vm realm's* RegExp and fails a
 * host-side `instanceof RegExp`. toString tagging works across realms.
 */
function isRegExp(v: unknown): v is RegExp {
  return Object.prototype.toString.call(v) === '[object RegExp]';
}

export type SendRequestFn = (
  req: string | { url: string; method?: string; header?: Record<string, string> | KeyValue[]; body?: string | { raw?: string; mode?: string } },
) => Promise<ApiResponse>;

export interface ScopeStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  has(key: string): boolean;
  unset(key: string): void;
  toObject(): Record<string, string>;
}

export interface PmContext {
  eventName: 'prerequest' | 'test';
  request: ApiRequest;
  response?: ApiResponse;
  environment: ScopeStore;
  globals: ScopeStore;
  collectionVariables: ScopeStore;
  localVariables: ScopeStore;
  iterationData?: ScopeStore;
  variablesResolver?: (name: string) => string | undefined;
  iteration?: number;
  iterationCount?: number;
  sendRequest?: SendRequestFn;
  requestName?: string;
}

export interface ScriptOutcome {
  pm: Record<string, unknown>;
  postman: Record<string, unknown>;
  legacy: Record<string, unknown>;
  /** tests recorded by pm.test + legacy tests[] */
  tests: TestResult[];
  logs: { level: string; args: unknown[] }[];
  pendingPromises: Promise<unknown>[];
  nextRequest: string | null;
  skipRequested: boolean;
  runRequests: string[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// chai-like expect
// ---------------------------------------------------------------------------

class ExpectChain {
  private negate = false;
  constructor(private actual: unknown) {}
  private assert(ok: boolean, message: string): void {
    if (this.negate ? ok : !ok) throw new Error(`expected ${fmt(this.actual)} ${this.negate ? 'not ' : ''}${message}`);
  }
  get to(): this { return this; }
  get be(): this { return this; }
  get been(): this { return this; }
  get is(): this { return this; }
  get that(): this { return this; }
  get which(): this { return this; }
  get and(): this { return this; }
  get has(): this { return this; }
  get have(): this { return this; }
  get with(): this { return this; }
  get at(): this { return this; }
  get of(): this { return this; }
  get own(): this { return this; }
  get not(): this { const c = new ExpectChain(this.actual); c.negate = !this.negate; return c as this; }
  get deep(): this { return this; }

  get ok(): this { this.assert(!!this.actual, `to be truthy`); return this; }
  get true(): this { this.assert(this.actual === true, `to be true`); return this; }
  get false(): this { this.assert(this.actual === false, `to be false`); return this; }
  get null(): this { this.assert(this.actual === null, `to be null`); return this; }
  get undefined(): this { this.assert(this.actual === undefined, `to be undefined`); return this; }
  get NaN(): this { this.assert(Number.isNaN(this.actual), `to be NaN`); return this; }
  get exist(): this { this.assert(this.actual !== undefined && this.actual !== null, `to exist`); return this; }
  get empty(): this {
    const v = this.actual;
    const empty = v == null || (typeof v === 'object' && Object.keys(v as object).length === 0) || (typeof v === 'string' && v.length === 0) || (Array.isArray(v) && v.length === 0);
    this.assert(empty, `to be empty`);
    return this;
  }

  equal(expected: unknown): this { this.assert(this.actual === expected, `to equal ${fmt(expected)}`); return this; }
  equals(expected: unknown): this { return this.equal(expected); }
  eq(expected: unknown): this { return this.eql(expected); }
  eql(expected: unknown): this { this.assert(deepEqual(this.actual, expected), `to deeply equal ${fmt(expected)}`); return this; }
  eqls(expected: unknown): this { return this.eql(expected); }
  include(item: unknown): this {
    const v = this.actual;
    const ok = typeof v === 'string' ? v.includes(String(item))
      : Array.isArray(v) ? v.some((x) => deepEqual(x, item) || x === item)
      : v && typeof v === 'object' && typeof item === 'object' && Object.entries(item as object).every(([k, val]) => deepEqual((v as Record<string, unknown>)[k], val));
    this.assert(!!ok, `to include ${fmt(item)}`);
    return this;
  }
  includes(item: unknown): this { return this.include(item); }
  contain(item: unknown): this { return this.include(item); }
  contains(item: unknown): this { return this.include(item); }
  a(type: string): this { return this.an(type); }
  an(type: string): this {
    const v = this.actual;
    const ok = type === 'array' ? Array.isArray(v) : type === 'null' ? v === null : type === 'integer' ? Number.isInteger(v) : typeof v === type;
    this.assert(ok, `to be a ${type}`);
    return this;
  }
  above(n: number): this { this.assert(Number(this.actual) > n, `to be above ${n}`); return this; }
  gt(n: number): this { return this.above(n); }
  greaterThan(n: number): this { return this.above(n); }
  least(n: number): this { this.assert(Number(this.actual) >= n, `to be at least ${n}`); return this; }
  gte(n: number): this { return this.least(n); }
  below(n: number): this { this.assert(Number(this.actual) < n, `to be below ${n}`); return this; }
  lt(n: number): this { return this.below(n); }
  lessThan(n: number): this { return this.below(n); }
  most(n: number): this { this.assert(Number(this.actual) <= n, `to be at most ${n}`); return this; }
  lte(n: number): this { return this.most(n); }
  within(min: number, max: number): this { this.assert(Number(this.actual) >= min && Number(this.actual) <= max, `to be within ${min}..${max}`); return this; }
  property(name: string, value?: unknown): this {
    const v = getByPath(this.actual, name);
    this.assert(v !== undefined, `to have property "${name}"`);
    if (arguments.length > 1) this.assert(deepEqual(v, value), `property "${name}" to equal ${fmt(value)}`);
    return this;
  }
  lengthOf(n: number): this {
    const len = (this.actual as { length?: number })?.length;
    this.assert(len === n, `to have length ${n} (got ${len})`);
    return this;
  }
  length(n: number): this { return this.lengthOf(n); }
  match(re: RegExp): this { this.assert(re.test(String(this.actual)), `to match ${re}`); return this; }
  string(sub: string): this { this.assert(String(this.actual).includes(sub), `to contain "${sub}"`); return this; }
  keys(...names: string[]): this {
    const v = this.actual as Record<string, unknown>;
    const flat = names.flat();
    this.assert(flat.every((k) => v && Object.prototype.hasOwnProperty.call(v, k)), `to have keys [${flat.join(', ')}]`);
    return this;
  }
  status(code: number): this { return this.equal(code); }
  header(_name: string): this { return this; }
  jsonBody(_path?: string): this { return this; }
  body(_expected?: string): this { return this; }

  // ---- Jest/Postman-style aliases (pm.expect(...).toBe(...) etc.) ----
  toBe(expected: unknown): this { this.assert(this.actual === expected, `to be ${fmt(expected)}`); return this; }
  toEqual(expected: unknown): this { this.assert(deepEqual(this.actual, expected), `to equal ${fmt(expected)}`); return this; }
  toStrictEqual(expected: unknown): this { return this.toEqual(expected); }
  toBeNull(): this { this.assert(this.actual === null, `to be null`); return this; }
  toBeUndefined(): this { this.assert(this.actual === undefined, `to be undefined`); return this; }
  toBeDefined(): this { this.assert(this.actual !== undefined, `to be defined`); return this; }
  toBeTruthy(): this { this.assert(!!this.actual, `to be truthy`); return this; }
  toBeFalsy(): this { this.assert(!this.actual, `to be falsy`); return this; }
  toBeNaN(): this { this.assert(Number.isNaN(this.actual), `to be NaN`); return this; }
  toContain(item: unknown): this { return this.include(item); }
  toContainEqual(item: unknown): this {
    const v = this.actual;
    this.assert(Array.isArray(v) && v.some((x) => deepEqual(x, item)), `to contain ${fmt(item)}`);
    return this;
  }
  toMatch(reOrStr: RegExp | string): this {
    const re = isRegExp(reOrStr) ? reOrStr : new RegExp(String(reOrStr).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'));
    this.assert(re.test(String(this.actual)), `to match ${re}`); return this;
  }
  toThrow(errOrMsg?: RegExp | string | (new (...a: unknown[]) => Error)): this {
    if (typeof this.actual !== 'function') throw new Error('pm.expect(...).toThrow requires a function as actual');
    let thrown: unknown;
    try { (this.actual as () => void)(); } catch (e) { thrown = e; }
    this.assert(thrown !== undefined, `to throw an error`);
    if (thrown !== undefined && errOrMsg !== undefined) {
      // cross-realm (vm) errors aren't host `instanceof Error`; duck-type .message
      const msg = thrown && typeof thrown === 'object' && 'message' in (thrown as object)
        ? String((thrown as { message: unknown }).message)
        : String(thrown);
      const ok = typeof errOrMsg === 'string' ? msg.includes(errOrMsg)
        : isRegExp(errOrMsg) ? errOrMsg.test(msg)
        : (() => { try { return thrown instanceof (errOrMsg as new (...a: unknown[]) => Error); } catch { return false; } })();
      this.assert(ok, `to throw matching ${String(errOrMsg)} (got "${msg}")`);
    }
    return this;
  }
  toBeInstanceOf(ctor: new (...a: unknown[]) => unknown): this {
    this.assert(this.actual instanceof ctor, `to be instance of ${ctor.name}`); return this;
  }
  toHaveProperty(name: string, value?: unknown): this {
    if (arguments.length > 1) return this.property(name, value);
    return this.property(name);
  }
  toHaveLength(n: number): this { return this.lengthOf(n); }
  toBeGreaterThan(n: number): this { return this.above(n); }
  toBeGreaterThanOrEqual(n: number): this { return this.least(n); }
  toBeLessThan(n: number): this { return this.below(n); }
  toBeLessThanOrEqual(n: number): this { return this.most(n); }
  toBeCloseTo(n: number, precision = 2): this {
    this.assert(Math.abs(Number(this.actual) - n) < 0.5 * 10 ** -precision, `to be close to ${n} (±${precision} digits)`); return this;
  }
  toMatchObject(fragment: Record<string, unknown>): this {
    const v = this.actual as Record<string, unknown> | null;
    const ok = !!v && typeof v === 'object' && Object.entries(fragment).every(([k, val]) => deepEqual(v[k], val));
    this.assert(ok, `to match object ${fmt(fragment)}`); return this;
  }
}

function fmt(v: unknown): string {
  if (typeof v === 'string') return v.length > 60 ? `"${v.slice(0, 60)}…"` : `"${v}"`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a === 'object') {
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

function expectFn(actual: unknown): ExpectChain { return new ExpectChain(actual); }

// ---------------------------------------------------------------------------
// Response wrapper
// ---------------------------------------------------------------------------

class HeaderList {
  constructor(private headers: KeyValue[]) {}
  get(name: string): string | undefined { return this.headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value; }
  has(name: string): boolean { return this.get(name) !== undefined; }
  toObject(): Record<string, string> { return Object.fromEntries(this.headers.map((h) => [h.key, h.value])); }
  all(): KeyValue[] { return [...this.headers]; }
  count(): number { return this.headers.length; }
  each(cb: (h: KeyValue) => void): void { this.headers.forEach((h) => cb({ ...h })); }
  [Symbol.iterator]() { return this.headers[Symbol.iterator](); }
}

function makeResponseApi(res: ApiResponse | undefined, pending: Promise<unknown>[]) {
  const body = res?.bodyText ?? '';
  let parsedJson: unknown;
  let parsed = false;
  const json = () => {
    if (!parsed) { parsed = true; parsedJson = body ? JSON.parse(body) : undefined; }
    return parsedJson;
  };
  const headers = new HeaderList(res?.headers ?? []);
  const codeStatus = res?.status ?? 0;
  const api = {
    get code() { return codeStatus; },
    get status() { return res?.statusText ?? ''; },
    get responseTime() { return res?.timing.totalMs ?? 0; },
    get responseSize() { return res?.bodySize ?? 0; },
    get headers() { return headers; },
    json,
    text: () => body,
    body,
    reason: () => res?.statusText ?? '',
    to: {
      have: {
        status: (code: number) => { if (codeStatus !== code) throw new Error(`expected response code to be ${code} but got ${codeStatus}`); return true; },
        header: (name: string) => { if (!headers.has(name)) throw new Error(`expected response to have header "${name}"`); return true; },
        body: (expected?: string) => {
          if (expected === undefined) { if (!body) throw new Error('expected response to have a body'); return true; }
          if (!body.includes(expected)) throw new Error(`expected response body to contain "${expected}"`);
          return true;
        },
        jsonBody: (pathOrSchema?: string | object) => {
          json();
          if (typeof pathOrSchema === 'string') {
            const p = parseJson(body);
            if (!p.ok) throw new Error(`response is not valid JSON`);
            if (getByPath(p.value, pathOrSchema) === undefined) throw new Error(`expected jsonBody path "${pathOrSchema}" to exist`);
          }
          return true;
        },
      },
      be: {
        get ok() { if (codeStatus >= 200 && codeStatus < 300) return true; throw new Error(`expected 2xx but got ${codeStatus}`); },
        get success() { return this.ok; },
        get error() { if (codeStatus >= 500 && codeStatus < 600) return true; throw new Error(`expected 5xx but got ${codeStatus}`); },
        get clientError() { if (codeStatus >= 400 && codeStatus < 500) return true; throw new Error(`expected 4xx but got ${codeStatus}`); },
        get notFound() { if (codeStatus === 404) return true; throw new Error(`expected 404 but got ${codeStatus}`); }, 
        get informational() { if (codeStatus >= 100 && codeStatus < 200) return true; throw new Error(`expected 1xx but got ${codeStatus}`); },
        get redirection() { if (codeStatus >= 300 && codeStatus < 400) return true; throw new Error(`expected 3xx but got ${codeStatus}`); },
        get forbidden() { if (codeStatus === 403) return true; throw new Error(`expected 403 but got ${codeStatus}`); },
        get rateLimited() { if (codeStatus === 429) return true; throw new Error(`expected 429 but got ${codeStatus}`); },
        get accepted() { if (codeStatus === 202) return true; throw new Error(`expected 202 but got ${codeStatus}`); },
        get unauthorized() { if (codeStatus === 401) return true; throw new Error(`expected 401 but got ${codeStatus}`); },
      },
    },
  };
  void pending;
  return api;
}

// ---------------------------------------------------------------------------
// pm object
// ---------------------------------------------------------------------------

export function createPmApi(ctx: PmContext): ScriptOutcome {
  const tests: TestResult[] = [];
  const logs: { level: string; args: unknown[] }[] = [];
  const pending: Promise<unknown>[] = [];
  const errors: string[] = [];
  const control = { nextRequest: null as string | null, skipRequested: false, runRequests: [] as string[] };

  const responseApi = makeResponseApi(ctx.response, pending);

  const scopeApi = (store: ScopeStore) => ({
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, String(v)),
    has: (k: string) => store.has(k),
    unset: (k: string) => store.unset(k),
    clear: () => { for (const k of Object.keys(store.toObject())) store.unset(k); },
    toObject: () => store.toObject(),
    replaceIn: (template: string) => {
      let out = template;
      const re = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
      out = out.replace(re, (m, name) => {
        const local = store.get(String(name).trim());
        if (local !== undefined) return local;
        return ctx.variablesResolver ? ctx.variablesResolver(String(name).trim()) ?? m : m;
      });
      return out;
    },
  });

  const cookieApi = {
    get: (name: string) => ctx.response?.cookies?.find((c) => c.name === name)?.value,
    has: (name: string) => !!ctx.response?.cookies?.some((c) => c.name === name),
    toObject: () => Object.fromEntries((ctx.response?.cookies ?? []).map((c) => [c.name, c.value])),
  };

  const requestApi = {
    get url() {
      const u = ctx.request.url;
      return {
        toString: () => u,
        getQuery: (name: string) => ctx.request.queryParams.find((q) => q.key === name)?.value,
      };
    },
    get method() { return ctx.request.method; },
    get headers() { return new HeaderList(ctx.request.headers); },
    get body() {
      const b = ctx.request.body;
      return {
        get raw() { return b.raw ?? ''; },
        get mode() { return b.type; },
        get urlencoded() { return b.urlencoded ?? []; },
        get formdata() { return b.formData ?? []; },
        toJSON: () => { try { return JSON.parse(b.raw ?? ''); } catch { return undefined; } },
      };
    },
  };

  const pm: Record<string, unknown> = {
    test: (name: string, fn: () => void) => {
      const start = performance.now();
      try {
        fn();
        tests.push({ name, passed: true, durationMs: performance.now() - start, source: 'script' });
      } catch (e) {
        tests.push({ name, passed: false, error: e instanceof Error ? e.message : String(e), durationMs: performance.now() - start, source: 'script' });
      }
    },
    expect: expectFn,
    response: responseApi,
    request: requestApi,
    environment: scopeApi(ctx.environment),
    globals: scopeApi(ctx.globals),
    collectionVariables: scopeApi(ctx.collectionVariables),
    variables: {
      get: (k: string) => {
        const local = ctx.localVariables.get(k);
        if (local !== undefined) return local;
        return ctx.variablesResolver ? ctx.variablesResolver(k) : ctx.environment.get(k) ?? ctx.globals.get(k);
      },
      set: (k: string, v: unknown) => ctx.localVariables.set(k, String(v)),
      replaceIn: (template: string) => {
        const re = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;
        return template.replace(re, (m, name) => {
          const v = (pm.variables as { get: (x: string) => string | undefined }).get(String(name).trim());
          return v ?? m;
        });
      },
    },
    iterationData: ctx.iterationData ? scopeApi(ctx.iterationData) : undefined,
    cookies: cookieApi,
    info: {
      requestName: ctx.requestName ?? ctx.request.name,
      requestId: ctx.request.id,
      iteration: ctx.iteration ?? 0,
      iterationCount: ctx.iterationCount ?? 1,
      eventName: ctx.eventName,
    },
    sendRequest: ctx.sendRequest
      ? (req: unknown, cb?: (err: unknown, res: unknown) => void) => {
          const p = ctx.sendRequest!(req as never).then((res) => {
            const resApi = makeResponseApi(res, pending);
            if (cb) cb(null, resApi);
            return resApi;
          }).catch((err) => {
            if (cb) cb(err, undefined);
            else errors.push(`pm.sendRequest failed: ${err instanceof Error ? err.message : err}`);
          });
          pending.push(p);
          return p;
        }
      : () => { throw new Error('pm.sendRequest is not available in this context'); },
    execution: {
      setNextRequest: (id: string | null) => { control.nextRequest = id; },
      skipRequest: () => { control.skipRequested = true; },
      runRequest: (id: string) => { control.runRequests.push(id); },
    },
    vault: undefined,
    visualizer: undefined,
  };

  // Legacy `postman` object
  const postman: Record<string, unknown> = {
    setNextRequest: (id: string | null) => { control.nextRequest = id; },
    setEnvironmentVariable: (k: string, v: unknown) => ctx.environment.set(k, String(v)),
    getEnvironmentVariable: (k: string) => ctx.environment.get(k),
    clearEnvironmentVariable: (k: string) => ctx.environment.unset(k),
    setGlobalVariable: (k: string, v: unknown) => ctx.globals.set(k, String(v)),
    getGlobalVariable: (k: string) => ctx.globals.get(k),
    clearGlobalVariable: (k: string) => ctx.globals.unset(k),
    setCollectionVariable: (k: string, v: unknown) => ctx.collectionVariables.set(k, String(v)),
    getCollectionVariable: (k: string) => ctx.collectionVariables.get(k),
    clearCollectionVariable: (k: string) => ctx.collectionVariables.unset(k),
  };

  // Legacy globals injected into test scripts
  const legacy: Record<string, unknown> = {
    request: ctx.request,
    responseBody: ctx.response?.bodyText ?? '',
    responseCode: { code: ctx.response?.status ?? 0, name: ctx.response?.statusText ?? '', detail: '' },
    responseTime: ctx.response?.timing.totalMs ?? 0,
    responseHeaders: Object.fromEntries((ctx.response?.headers ?? []).map((h) => [h.key, h.value])),
    responseCookies: Object.fromEntries((ctx.response?.cookies ?? []).map((c) => [c.name, c.value])),
    environment: ctx.environment.toObject(),
    globals: ctx.globals.toObject(),
    data: ctx.iterationData?.toObject() ?? {},
    iteration: ctx.iteration ?? 0,
    tests: {},   // legacy: tests["name"] = condition   (collected post-run)
  };

  const outcome: ScriptOutcome = {
    pm, postman, legacy, tests, logs, pendingPromises: pending, errors,
    get nextRequest() { return control.nextRequest; },
    set nextRequest(v: string | null) { control.nextRequest = v; },
    get skipRequested() { return control.skipRequested; },
    runRequests: control.runRequests,
  };
  return outcome;
}

/** After script execution, fold legacy `tests{}` object into results. */
export function collectLegacyTests(outcome: ScriptOutcome, legacyTestsObj: Record<string, unknown>): void {
  for (const [name, val] of Object.entries(legacyTestsObj)) {
    const passed = val === true || (val !== false && val !== undefined && val !== null && val !== 0);
    outcome.tests.push({ name, passed, error: passed ? undefined : String(val), source: 'script' });
  }
}
