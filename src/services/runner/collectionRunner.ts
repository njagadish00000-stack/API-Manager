/**
 * Collection runner (§16): sequential execution of a request tree with
 * iterations, delay, data rows, retry, failure handling (stop-on-failure /
 * continue), branch moves via pm.execution.setNextRequest, pause/resume/stop,
 * live progress events (run.progress), persisted RunResult, JUnit export (§CLI).
 * `run.start` returns immediately; execution proceeds in the background.
 */
import type {
  ApiRequest, Collection, Folder, RunConfig, RunResult, RunRequestResult, TestResult,
} from '../../shared/types';
import { now } from '../../shared/types';
import { uid } from '../../shared/ids';
import { executeRequest, PipelineDeps } from '../http/sendPipeline';
import type { RunProgressEvent } from '../../shared/events';

export interface RunnerRequestNode { request: ApiRequest; folderPath: string[] }

export interface RunnerDeps extends PipelineDeps {
  listFoldersRaw: (collectionId: string) => Folder[];
  listRequests: (collectionId?: string, folderId?: string) => ApiRequest[];
  getRequestByName: (name: string, collectionId?: string) => ApiRequest | undefined;
  getRequest: (id: string) => ApiRequest | undefined;
  saveRun: (run: RunResult) => void;
  getRun: (runId: string) => RunResult | undefined;
}

export interface RunnerExtras {
  dataRows?: Record<string, string>[];
  /** when rerunFailed is used, restrict to these request ids */
  onlyRequestIds?: string[];
}

export interface ActiveRun {
  id: string;
  config: RunConfig;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  executed: number;
  total: number;
  results: RunRequestResult[];
  executionLog: string[];
  stopRequested: boolean;
  pauseAwaiter?: () => void;
  startedAt: string;
  finishedAt?: string;
  iteration: number;
}

const activeRuns = new Map<string, ActiveRun>();
const runEmits = new Map<string, (ev: RunProgressEvent) => void>();

export function pauseRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (!run || run.status !== 'running') return;
  run.status = 'paused';
  emit(run, 'paused');
}

export function resumeRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (!run || run.status !== 'paused') return;
  run.status = 'running';
  run.pauseAwaiter?.();
  emit(run, 'running');
}

export function stopRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.stopRequested = true;
  if (run.status === 'paused') run.pauseAwaiter?.();
  if (run.status === 'running' || run.status === 'paused') {
    run.status = 'stopped';
    emit(run, 'stopped');
  }
}

export function getActiveRun(runId: string): ActiveRun | undefined { return activeRuns.get(runId); }

function emit(run: ActiveRun, status: string): void {
  const cb = runEmits.get(run.id);
  if (!cb) return;
  const failed = run.results.filter((r) => !r.passed && !r.skipped).length;
  cb({
    runId: run.id,
    executed: run.executed,
    total: run.total,
    passed: run.results.filter((r) => r.passed).length,
    failed,
    currentRequest: run.results[run.results.length - 1]?.requestName,
    iteration: run.iteration,
    status,
  });
}

/** Start a run in the background; returns immediately with the run id. */
export function startRun(config: RunConfig, deps: RunnerDeps, extras: RunnerExtras, emitCb: (ev: RunProgressEvent) => void): { runId: string } {
  const runId = uid();
  const run: ActiveRun = {
    id: runId, config, status: 'running', executed: 0, total: 0,
    results: [], executionLog: [], stopRequested: false,
    startedAt: now(), iteration: 1,
  };
  activeRuns.set(runId, run);
  runEmits.set(runId, emitCb);
  // fire and forget; errors captured in run status
  void (async () => {
    try {
      await runLoop(run, deps, extras);
      run.status = run.stopRequested ? 'stopped' : 'completed';
    } catch (e) {
      run.status = 'failed';
      run.executionLog.push(`run error: ${e instanceof Error ? e.message : e}`);
    }
    run.finishedAt = now();
    emit(run, run.status);
    finalize(run, deps);
    runEmits.delete(runId);
  })();
  return { runId };
}

function finalize(run: ActiveRun, deps: RunnerDeps): void {
  const totalTests = run.results.reduce((a, r) => a + r.tests.length, 0);
  const failedTests = run.results.reduce((a, r) => a + r.tests.filter((t) => !t.passed).length, 0);
  const result: RunResult = {
    id: run.id,
    config: run.config,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    totalRequests: run.total,
    executedRequests: run.executed,
    passedRequests: run.results.filter((r) => r.passed && !r.skipped).length,
    failedRequests: run.results.filter((r) => !r.passed && !r.skipped).length,
    totalTests, passedTests: totalTests - failedTests, failedTests,
    durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : undefined,
    results: run.results,
    executionLog: run.executionLog,
  };
  deps.saveRun(result);
  activeRuns.delete(run.id);
}

async function runLoop(run: ActiveRun, deps: RunnerDeps, extras: RunnerExtras): Promise<void> {
  const { config } = run;
  const requests = selectRequests(config, deps, extras);
  run.total = requests.length * config.iterations;
  const rows = extras.dataRows ?? [];
  emit(run, 'running');

  for (let iter = 0; iter < config.iterations && !run.stopRequested; iter++) {
    run.iteration = iter + 1;
    const dataRow = rows.length > 0 ? rows[Math.min(iter, rows.length - 1)] : undefined;
    run.executionLog.push(`--- iteration ${iter + 1}/${config.iterations} ---`);
    let idx = 0;
    let guard = requests.length; // infinite loop guard for setNextRequest cycles
    while (idx < requests.length && !run.stopRequested) {
      if (run.status === 'paused') {
        await new Promise<void>((resolve) => { run.pauseAwaiter = resolve; });
        if (run.stopRequested) break;
      }
      if (guard-- <= 0) {
        run.executionLog.push('aborting: pm.execution.setNextRequest loop detected');
        break;
      }
      const node = requests[idx];
      run.executionLog.push(`→ ${node.request.name}`);
      const result = await executeOne(node.request, config, deps, iter, dataRow, run);
      run.results.push(result);
      run.executed++;
      emit(run, 'running');
      if (result.unboundNextRow) {
        run.executionLog.push(`stop: pm.execution.setNextRequest(null) at "${node.request.name}"`);
        break;
      }
      if (result.nextName) {
        const targetIdx = requests.findIndex((n, i) => i > -1 && n.request.name === result.nextName);
        if (targetIdx === -1) {
          run.executionLog.push(`setNextRequest target not found: "${result.nextName}"; stopping iteration`);
          break;
        }
        idx = targetIdx;
        continue;
      }
      if (result.error && config.stopOnFailure) { run.stopRequested = true; break; }
      if (!result.passed && config.stopOnFailure) { run.stopRequested = true; break; }
      idx++;
      if (idx < requests.length && config.delayMs > 0) await sleepControlled(run, config.delayMs);
    }
    if (iter + 1 < config.iterations && config.delayMs > 0) await sleepControlled(run, config.delayMs);
  }
}

function selectRequests(config: RunConfig, deps: RunnerDeps, extras: RunnerExtras): RunnerRequestNode[] {
  const folders = config.collectionId ? deps.listFoldersRaw(config.collectionId) : [];
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const folderPath = (folderId?: string): string[] => {
    const path: string[] = [];
    let cur = folderId ? folderById.get(folderId) : undefined;
    let guard = 50;
    while (cur && guard-- > 0) { path.unshift(cur.name); cur = cur.parentFolderId ? folderById.get(cur.parentFolderId) : undefined; }
    return path;
  };
  let all: ApiRequest[];
  if (config.requestIds?.length) {
    all = config.requestIds.map((id) => deps.getRequest(id)).filter((r): r is ApiRequest => !!r);
  } else if (config.folderId) {
    all = deps.listRequests(undefined, config.folderId);
  } else if (config.collectionId) {
    // tree order: root requests, then folders in sort order depth-first
    const ordered: ApiRequest[] = [];
    const walk = (folderId?: string) => {
      ordered.push(...deps.listRequests(config.collectionId, folderId));
      for (const f of folders.filter((x) => x.parentFolderId === folderId).sort((a, b) => a.sortOrder - b.sortOrder)) walk(f.id);
    };
    walk(undefined);
    all = ordered;
  } else {
    all = [];
  }
  if (extras.onlyRequestIds?.length) {
    const only = new Set(extras.onlyRequestIds);
    all = all.filter((r) => only.has(r.id));
  }
  return all.map((request) => ({ request, folderPath: folderPath(request.folderId) }));
}

interface OneResult extends RunRequestResult {
  nextName?: string;
  unboundNextRow?: boolean;
}

async function executeOne(request: ApiRequest, config: RunConfig, deps: RunnerDeps, iteration: number, dataRow: Record<string, string> | undefined, run: ActiveRun): Promise<OneResult> {
  const retries = 0; // request-level retry already handled by engine retry settings
  void retries;
  try {
    const res = await executeRequest(
      { request, environmentId: config.environmentId, overrides: config.variableOverrides },
      { ...deps, dataRow },
    );
    const tests: TestResult[] = [...res.postTestResults, ...res.assertionResults];
    const failedTests = tests.filter((t) => !t.passed).length;
    const passed = !res.error && failedTests === 0 && !res.skippedByScript;
    let nextName: string | undefined;
    let unboundNextRow = false;
    if (res.nextRequestId !== undefined) {
      if (res.nextRequestId === null) unboundNextRow = true;
      else {
        const byId = deps.getRequest(res.nextRequestId);
        const byName = byId ?? deps.getRequestByName(res.nextRequestId, config.collectionId);
        if (byName) nextName = byName.name;
        else unboundNextRow = true;
      }
    }
    return {
      requestId: request.id, requestName: request.name, iteration,
      status: res.response?.status, durationMs: res.response?.timing.totalMs,
      passed, failedTests, passedTests: tests.length - failedTests, tests,
      error: res.error, response: res.response,
      skipped: res.skippedByScript, skipReason: res.skippedByScript ? 'pm.execution.skipRequest' : undefined,
      nextName, unboundNextRow,
    };
  } catch (e) {
    return {
      requestId: request.id, requestName: request.name, iteration,
      passed: false, failedTests: 0, passedTests: 0, tests: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function sleepControlled(run: ActiveRun, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (run.stopRequested) return;
    if (run.status === 'paused') await new Promise<void>((resolve) => { run.pauseAwaiter = resolve; });
    else await new Promise((r) => setTimeout(r, 20));
  }
}

/** JUnit XML export for CI (§CLI / 'run.exportJUnit'). */
export function runToJunitXml(run: RunResult): string {
  const failures = run.results.filter((r) => !r.passed && !r.skipped).length;
  const skipped = run.results.filter((r) => r.skipped).length;
  const cases = run.results.map((r) => {
    const children: string[] = [];
    for (const t of r.tests) {
      if (!t.passed) children.push(`<failure message="${esc(t.name)}">${esc(t.error ?? '')}</failure>`);
    }
    if (r.error) children.push(`<error message="${esc(r.error)}"/>`);
    if (r.skipped) children.push(`<skipped${r.skipReason ? ` message="${esc(r.skipReason)}"` : ''}/>`);
    return `<testcase name="${esc(r.requestName)}" classname="iteration-${r.iteration + 1}" time="${((r.durationMs ?? 0) / 1000).toFixed(3)}">${children.join('')}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="API Manager run ${esc(run.id)}" tests="${run.results.length}" failures="${failures}" skipped="${skipped}" time="${((run.durationMs ?? 0) / 1000).toFixed(3)}">\n${cases}\n</testsuite>\n`;
}

/** Plain-text summary used by the CLI. */
export function runToText(run: RunResult): string {
  const lines = [
    `Run ${run.id} — ${run.status}`,
    `Started ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ''}`,
    `Requests: ${run.executedRequests}/${run.totalRequests} executed, ${run.passedRequests} passed, ${run.failedRequests} failed`,
    `Tests: ${run.totalTests} total, ${run.passedTests} passed, ${run.failedTests} failed`,
  ];
  for (const r of run.results) {
    const head = `${r.passed ? 'PASS' : r.skipped ? 'SKIP' : 'FAIL'} [${r.iteration + 1}] ${r.requestName}${r.status ? ` — HTTP ${r.status}` : ''}${typeof r.durationMs === 'number' ? ` (${r.durationMs.toFixed(0)}ms)` : ''}`;
    lines.push(head);
    for (const t of r.tests.filter((x) => !x.passed)) lines.push(`   ✗ ${t.name}${t.error ? `: ${t.error}` : ''}`);
    if (r.error) lines.push(`   ✗ ${r.error}`);
  }
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] ?? c));
}
