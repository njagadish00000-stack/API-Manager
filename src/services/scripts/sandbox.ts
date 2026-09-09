/**
 * JavaScript scripting sandbox (§32) — Node vm with a frozen global surface,
 * execution timeouts, console capture, pm.* API, pending-promise draining, and
 * an instrumented statement-level debugger with breakpoints/step/watches (§34).
 */
import vm from 'node:vm';
import type { ApiRequest, ApiResponse, TestResult } from '../../shared/types';
import { createPmApi, collectLegacyTests, ScriptOutcome, ScopeStore, SendRequestFn } from '../../core/scripting/pmApi';

export interface SandboxConsole { level: string; args: unknown[] } 

export interface ScriptStores {
  environment: ScopeStore;
  globals: ScopeStore;
  collectionVariables: ScopeStore;
  localVariables: ScopeStore;
  iterationData?: ScopeStore;
  variablesResolver?: (name: string) => string | undefined;
  iteration?: number;
  iterationCount?: number;
}

export interface RunScriptOptions {
  code: string;
  eventName: 'prerequest' | 'test';
  request: ApiRequest;
  response?: ApiResponse;
  stores: ScriptStores;
  sendRequest?: SendRequestFn;
  timeoutMs?: number;
  /** shared console collector (script name prefixed) */
  consoleTarget?: (entry: { level: string; args: unknown[]; script: string }) => void;
  scriptLabel?: string;
}

export interface RunScriptOutcome {
  outcome: ScriptOutcome;
  error?: string;
  errorStack?: string;
  durationMs: number;
}

function serializeArg(a: unknown): unknown {
  if (a === undefined) return 'undefined';
  if (a === null) return null;
  if (typeof a === 'string') return a;
  if (typeof a === 'number' || typeof a === 'boolean') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try { return JSON.stringify(a, null, 0)?.slice(0, 2000) ?? String(a); } catch { return String(a); }
}

export async function runScript(opts: RunScriptOptions): Promise<RunScriptOutcome> {
  const t0 = performance.now();
  const outcome = createPmApi({
    eventName: opts.eventName,
    request: opts.request,
    response: opts.response,
    environment: opts.stores.environment,
    globals: opts.stores.globals,
    collectionVariables: opts.stores.collectionVariables,
    localVariables: opts.stores.localVariables,
    iterationData: opts.stores.iterationData,
    variablesResolver: opts.stores.variablesResolver,
    iteration: opts.stores.iteration,
    iterationCount: opts.stores.iterationCount,
    sendRequest: opts.sendRequest,
  });

  const logs = outcome.logs;
  const label = opts.scriptLabel ?? opts.eventName;
  const pushLog = (level: string, args: unknown[]) => {
    const entry = { level, args: args.map(serializeArg), script: label };
    logs.push({ level, args: entry.args });
    opts.consoleTarget?.(entry);
  };
  const consoleProxy = {
    log: (...args: unknown[]) => pushLog('log', args),
    info: (...args: unknown[]) => pushLog('log', args),
    warn: (...args: unknown[]) => pushLog('warn', args),
    error: (...args: unknown[]) => pushLog('error', args),
    debug: (...args: unknown[]) => pushLog('debug', args),
    trace: (...args: unknown[]) => pushLog('debug', args),
    assert: (cond: unknown, ...args: unknown[]) => { if (!cond) pushLog('error', ['Assertion failed', ...args]); },
    clear: () => undefined,
  };

  const sandbox: Record<string, unknown> = {
    pm: outcome.pm,
    postman: outcome.postman,
    console: consoleProxy,
    __legacy: outcome.legacy,
    setTimeout: undefined, setInterval: undefined, setImmediate: undefined,
    clearTimeout: () => undefined, clearInterval: () => undefined,
    process: undefined, require: undefined, globalThis: undefined,
    Buffer: undefined,
  };
  // spread legacy globals (request, responseBody, tests, …)
  Object.assign(sandbox, outcome.legacy);

  let error: string | undefined;
  let errorStack: string | undefined;
  try {
    const context = vm.createContext(sandbox, { name: `api-manager-script` });
    const wrapped = `'use strict';\n(async () => {\n${opts.code}\n})();`;
    const script = new vm.Script(wrapped, { filename: `${label}.js`, produceCachedData: false });
    const result = script.runInContext(context, { timeout: opts.timeoutMs ?? 5000, displayErrors: true }) as Promise<unknown> | undefined;
    if (result && typeof result.then === 'function') {
      await timeoutRace(result, opts.timeoutMs ?? 5000);
    }
    // drain pending pm.sendRequest promises
    if (outcome.pendingPromises.length > 0) {
      const drain = Promise.allSettled(outcome.pendingPromises);
      await Promise.race([drain, sleep(opts.timeoutMs ?? 5000)]);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    errorStack = e instanceof Error ? e.stack : undefined;
    pushLog('error', [error]);
  }
  // legacy tests object
  const legacyTests = (outcome.legacy as { tests: Record<string, unknown> }).tests;
  collectLegacyTests(outcome, legacyTests);
  outcome.errors.forEach((e) => outcome.tests.push({ name: 'script error', passed: false, error: e, source: 'script' }));
  if (error && outcome.tests.length === 0) {
    // surface as console error only (scripts that throw in pre-request don't create tests)
  }
  return { outcome, error, errorStack, durationMs: performance.now() - t0 };
}

function timeoutRace<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, sleep(ms).then(() => undefined)]);
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Debugger (instrumented source transformation)
// ---------------------------------------------------------------------------

export interface DebugPauseInfo {
  line: number;
  depth: number;
  variables: Record<string, unknown>;
  watches: Record<string, unknown>;
  callStack: string[];
}

interface DebugSession {
  id: string;
  paused: boolean;
  done: boolean;
  error?: string;
  line: number;
  depth: number;
  watches: string[];
  lastVars: Record<string, unknown>;
  waiters: { resume: (action: 'continue' | 'step' | 'stop' | 'pause') => void }[];
  onPause?: (info: DebugPauseInfo) => void;
  onDone?: () => void;
  stepping: boolean;
  breakpoints: Set<number>;
  pmOutcome?: ScriptOutcome;
  tests: TestResult[];
  logs: { level: string; args: unknown[] }[];
}

const debugSessions = new Map<string, DebugSession>();

/**
 * Instrument source: insert `await __bp(LINE);` before each statement-level
 * line. Conservative: one breakpoint hook per non-empty line start.
 */
export function instrumentSource(code: string): { code: string; lines: number } {
  const lines = code.split('\n');
  let count = 0;
  const out = lines.map((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed === '{' || trimmed === '}') return line;
    count++;
    const depth = (line.match(/^\s*/) ?? [''])[0];
    return `${depth}await __bp(${idx + 1});${line.slice(depth.length)}`;
  });
  return { code: out.join('\n'), lines: count };
}

export async function startDebugSession(opts: RunScriptOptions & { breakpoints: number[]; watches?: string[]; sessionId: string; onPause?: (info: DebugPauseInfo) => void; onDone?: () => void }): Promise<void> {
  const { code: instrumented } = instrumentSource(opts.code);
  const session: DebugSession = {
    id: opts.sessionId, paused: false, done: false, line: 0, depth: 0,
    watches: opts.watches ?? [], lastVars: {}, waiters: [],
    onPause: opts.onPause, onDone: opts.onDone, stepping: false,
    breakpoints: new Set(opts.breakpoints), tests: [], logs: [],
  };
  debugSessions.set(opts.sessionId, session);

  queueMicrotask(async () => {
    let contextObj: Record<string, unknown> = {};
    const bp = async (line: number) => {
      if (session.done) return;
      session.depth = 1;
      const hit = session.breakpoints.has(line) || session.stepping;
      if (!hit || session.paused) return;
      session.paused = true;
      session.line = line;
      session.lastVars = captureVisible(contextObj);
      const watches: Record<string, unknown> = {};
      for (const w of session.watches) {
        try { watches[w] = vm.runInContext(`(${w})`, contextObj as vm.Context, { timeout: 1000 }); } catch (e) { watches[w] = `<${(e as Error).message}>`; }
      }
      try { session.onPause?.({ line, depth: session.depth, variables: session.lastVars, watches, callStack: [`${opts.scriptLabel ?? 'script'}.js:${line}`] }); } catch { /* ignore */ }
      session.stepping = false;
      await new Promise<void>((resolve) => {
        session.waiters.push({
          resume: (action) => {
            session.paused = false;
            if (action === 'step') session.stepping = true;
            if (action === 'stop') session.done = true;
            if (action === 'pause') { session.paused = true; return; }
            resolve();
          },
        });
      });
    };

    const outcome = createPmApi({
      eventName: opts.eventName,
      request: opts.request,
      response: opts.response,
      environment: opts.stores.environment,
      globals: opts.stores.globals,
      collectionVariables: opts.stores.collectionVariables,
      localVariables: opts.stores.localVariables,
      iterationData: opts.stores.iterationData,
      variablesResolver: opts.stores.variablesResolver,
      iteration: opts.stores.iteration,
      iterationCount: opts.stores.iterationCount,
      sendRequest: opts.sendRequest,
    });
    session.pmOutcome = outcome;

    const consoleProxy = {
      log: (...args: unknown[]) => session.logs.push({ level: 'log', args: args.map(serializeArg) }),
      info: (...args: unknown[]) => session.logs.push({ level: 'log', args: args.map(serializeArg) }),
      warn: (...args: unknown[]) => session.logs.push({ level: 'warn', args: args.map(serializeArg) }),
      error: (...args: unknown[]) => session.logs.push({ level: 'error', args: args.map(serializeArg) }),
      debug: (...args: unknown[]) => session.logs.push({ level: 'debug', args: args.map(serializeArg) }),
      assert: (cond: unknown, ...args: unknown[]) => { if (!cond) session.logs.push({ level: 'error', args: ['Assertion failed', ...args.map(serializeArg)] }); },
      clear: () => undefined,
    };

    contextObj = {
      pm: outcome.pm, postman: outcome.postman, console: consoleProxy,
      __legacy: outcome.legacy, __bp: bp,
      setTimeout: undefined, setInterval: undefined, process: undefined, require: undefined,
    };
    Object.assign(contextObj, outcome.legacy);

    try {
      const context = vm.createContext(contextObj, { name: 'api-manager-debug' });
      const wrapped = `'use strict';\n(async () => {\n${instrumented}\n})();`;
      const script = new vm.Script(wrapped, { filename: `${opts.scriptLabel ?? 'debug'}.js` });
      const result = script.runInContext(context, { timeout: 600_000 }) as Promise<unknown> | undefined;
      if (result?.then) await result;
    } catch (e) {
      session.error = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    }
    const legacyTests = (outcome.legacy as { tests: Record<string, unknown> }).tests;
    collectLegacyTests(outcome, legacyTests);
    session.tests = outcome.tests;
    session.done = true;
    // resume any waiters so nothing hangs
    for (const w of session.waiters.splice(0)) w.resume('continue');
    session.onDone?.();
  });
}

export function debugAction(sessionId: string, action: 'continue' | 'step' | 'stop' | 'pause' | 'step-into' | 'step-out'): void {
  const s = debugSessions.get(sessionId);
  if (!s) return;
  const mapped = action === 'step-into' || action === 'step-out' ? 'step' : action;
  const waiter = s.waiters.shift();
  if (waiter) waiter.resume(mapped);
  else if (mapped === 'pause') s.stepping = true;
}

export function setDebugWatches(sessionId: string, watches: string[]): void {
  const s = debugSessions.get(sessionId);
  if (s) s.watches = watches;
}

export function getDebugSession(sessionId: string): { done: boolean; error?: string; tests: TestResult[]; logs: { level: string; args: unknown[] }[]; line: number } | undefined {
  const s = debugSessions.get(sessionId);
  if (!s) return undefined;
  return { done: s.done, error: s.error, tests: s.tests, logs: s.logs, line: s.line };
}

export function endDebugSession(sessionId: string): void {
  const s = debugSessions.get(sessionId);
  if (s) { s.done = true; for (const w of s.waiters.splice(0)) w.resume('continue'); }
  debugSessions.delete(sessionId);
}

function captureVisible(contextObj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(contextObj)) {
    if (k === '__bp' || typeof v === 'function') continue;
    if (k === 'console' || k === 'pm' || k === 'postman' || k === '__legacy') { out[k] = '<object>'; continue; }
    out[k] = serializeArg(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Standalone variable-transform runner (used by flows)
// ---------------------------------------------------------------------------

export async function runTransformScript(code: string, vars: Record<string, string>, timeoutMs = 5000): Promise<{ variables: Record<string, string>; logs: string[] }> {
  const logs: string[] = [];
  const varsProxy = { ...vars };
  const sandbox = {
    vars: varsProxy,
    console: {
      log: (...args: unknown[]) => logs.push(args.map((a) => String(serializeArg(a))).join(' ')),
      warn: (...args: unknown[]) => logs.push(`[warn] ${args.map((a) => String(serializeArg(a))).join(' ')}`),
      error: (...args: unknown[]) => logs.push(`[error] ${args.map((a) => String(serializeArg(a))).join(' ')}`),
    },
    setTimeout: undefined, setInterval: undefined, process: undefined, require: undefined,
  };
  try {
    const context = vm.createContext(sandbox, { name: 'api-manager-transform' });
    const script = new vm.Script(`'use strict';\n(async () => {\n${code}\n})();`, { filename: 'transform.js' });
    const result = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown> | undefined;
    if (result?.then) await timeoutRace(result, timeoutMs);
  } catch (e) {
    logs.push(`[error] ${e instanceof Error ? e.message : e}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(varsProxy)) out[k] = typeof v === 'string' ? v : String(v);
  return { variables: out, logs };
}

export function makeMemoryStore(initial: Record<string, string> = {}): ScopeStore {
  const data = { ...initial };
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    has: (k) => k in data,
    unset: (k) => { delete data[k]; },
    toObject: () => ({ ...data }),
  };
}

export function wrapStore(store: ScopeStore, onChange: (key: string, value: string | undefined) => void): ScopeStore {
  return {
    get: (k) => store.get(k),
    set: (k, v) => { store.set(k, v); onChange(k, v); },
    has: (k) => store.has(k),
    unset: (k) => { store.unset(k); onChange(k, undefined); },
    toObject: () => store.toObject(),
  };
}
