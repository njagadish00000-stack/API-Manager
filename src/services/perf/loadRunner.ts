/**
 * Performance test engine (§18): bounded-concurrency load runner with
 * rate limiting, ramp-up/down windows, per-second timeline stats, latency
 * histograms, thresholds, baseline comparison, HTML report and stop control.
 */
import type { ApiRequest, PerfConfig, PerfMetrics, PerfRun } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { executeRequest, PipelineDeps } from '../http/sendPipeline';
import type { PerfTickEvent } from '../../shared/events';
import { percentile, histogramBuckets, computePerfSummary, PerfRequestSample } from '../../core/perf/perf';

export interface PerfDeps extends PipelineDeps {
  getRequest: (id: string) => ApiRequest | undefined;
  listRequests: (collectionId?: string, folderId?: string) => ApiRequest[];
  saveRun: (run: PerfRun) => void;
  thresholds?: { avgMs?: number; p95Ms?: number; p99Ms?: number; errorRatePct?: number };
}

interface ActivePerfRun {
  run: PerfRun;
  samples: PerfRequestSample[];
  stopRequested: boolean;
  startedMs: number;
}

const activeRuns = new Map<string, ActivePerfRun>();

export function stopPerfRun(runId: string): void {
  const r = activeRuns.get(runId);
  if (r) r.stopRequested = true;
}

function currentConcurrency(config: PerfConfig, elapsedSec: number): number {
  if (config.rampUpSec > 0 && elapsedSec < config.rampUpSec) {
    return Math.max(1, Math.ceil((elapsedSec / config.rampUpSec) * config.concurrency));
  }
  const remaining = config.durationSec - elapsedSec;
  if (config.rampDownSec > 0 && remaining < config.rampDownSec) {
    return Math.max(1, Math.ceil((remaining / config.rampDownSec) * config.concurrency));
  }
  return config.concurrency;
}

export function startPerfRun(config: PerfConfig, deps: PerfDeps, emit: (ev: PerfTickEvent) => void): { runId: string } {
  const run: PerfRun = {
    id: uid(),
    workspaceId: resolveWorkspaceId(config, deps),
    config,
    status: 'running',
    startedAt: now(),
  };
  const active: ActivePerfRun = { run, samples: [], stopRequested: false, startedMs: Date.now() };
  activeRuns.set(run.id, active);
  deps.saveRun({ ...run });

  void (async () => {
    try {
      await perfLoop(active, config, deps, emit);
    } catch {
      run.status = 'failed';
    } finally {
      run.finishedAt = now();
      const metrics = buildMetrics(active);
      run.metrics = metrics;
      if (run.status === 'running') run.status = active.stopRequested ? 'stopped' : 'completed';
      deps.saveRun({ ...run });
      activeRuns.delete(run.id);
    }
  })();
  return { runId: run.id };
}

async function perfLoop(active: ActivePerfRun, config: PerfConfig, deps: PerfDeps, emit: (ev: PerfTickEvent) => void): Promise<void> {
  const durationMs = config.durationSec * 1000;
  const maxIterations = config.iterations ?? Number.MAX_SAFE_INTEGER;
  const rate = config.ratePerSecond;
  let iterationsDone = 0;
  let lastTick = Date.now();
  let tickSamples: PerfRequestSample[] = [];
  let cursor = 0;

  const targets = resolveTargets(config, deps);
  if (targets.length === 0) throw new Error('perf target has no requests');

  const workersRunning = new Set<Promise<void>>();
  const stopAll = () => { active.stopRequested = true; };

  const executionWindow = async (): Promise<void> => {
    while (Date.now() - active.startedMs < durationMs && !active.stopRequested && iterationsDone < maxIterations) {
      const elapsedSec = (Date.now() - active.startedMs) / 1000;
      const conc = currentConcurrency(config, elapsedSec);
      while (workersRunning.size >= conc && !active.stopRequested) {
        await Promise.race([...workersRunning]);
      }
      if (active.stopRequested) break;
      if (iterationsDone >= maxIterations) break;
      if (rate > 0) {
        const elapsed = (Date.now() - active.startedMs) / 1000;
        const allowed = Math.floor(elapsed * rate);
        if (iterationsDone >= allowed) { await new Promise((r) => setTimeout(r, 5)); continue; }
      }
      iterationsDone++;
      const request = targets[cursor++ % targets.length];
      const p = executeOnceSafely(request, config, deps, active).catch(() => undefined);
      workersRunning.add(p);
      p.finally(() => workersRunning.delete(p));

      const nowMs = Date.now();
      if (nowMs - lastTick >= 1000) {
        emitTick(active, config, tickSamples, elapsedSec, conc, emit);
        tickSamples = [];
        lastTick = nowMs;
      }
    }
  };

  await executionWindow();
  await Promise.allSettled([...workersRunning]);
}

async function executeOnceSafely(request: ApiRequest, config: PerfConfig, deps: PerfDeps, active: ActivePerfRun): Promise<void> {
  const t0 = performance.now();
  let status = 0; let error: string | undefined; let bytes = 0;
  try {
    const res = await executeRequest(
      { request, environmentId: config.environmentId, disableScripts: true },
      { ...deps, dataRow: undefined },
    );
    status = res.response?.status ?? 0;
    error = res.error;
    bytes = res.response?.bodySize ?? 0;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const latencyMs = performance.now() - t0;
  const sample: PerfRequestSample = {
    t: Date.now() - active.startedMs,
    latencyMs: error ? 0 : latencyMs,
    status,
    error: error ?? (status >= 400 ? `HTTP ${status}` : undefined),
    bytes,
  };
  active.samples.push(sample);
}

function emitTick(active: ActivePerfRun, config: PerfConfig, samples: PerfRequestSample[], t: number, concurrency: number, emit: (ev: PerfTickEvent) => void): void {
  const errors = samples.filter((s) => s.error || s.status >= 400).length;
  const successes = samples.filter((s) => !s.error && s.status < 400);
  const latencies = successes.map((s) => s.latencyMs);
  emit({
    runId: active.run.id, t,
    concurrency,
    rps: samples.length,
    avgMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    errors,
    total: active.samples.length,
    p50: percentile(latencies, 50), p90: percentile(latencies, 90), p99: percentile(latencies, 99),
  });
  void config;
}

function buildMetrics(active: ActivePerfRun): PerfMetrics {
  const summary = computePerfSummary(active.samples, active.run.config.durationSec * 1000 || 1);
  const timeline = active.samples.reduce((acc, s) => {
    const bucket = Math.floor(s.t / 1000);
    const row = acc.get(bucket) ?? { n: 0, sum: 0, err: 0 };
    row.n++; row.sum += s.latencyMs; if (s.error || s.status >= 400) row.err++;
    acc.set(bucket, row);
    return acc;
  }, new Map<number, { n: number; sum: number; err: number }>());
  const timelineArr = [...timeline.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({
    t, concurrency: currentConcurrency(active.run.config, t), rps: v.n, avgMs: v.n ? v.sum / v.n : 0, errors: v.err,
  }));
  return {
    totalRequests: active.samples.length,
    successCount: summary.successCount,
    errorCount: summary.errorCount,
    errorRate: summary.errorRate,
    throughputPerSec: summary.throughputPerSec,
    avgMs: summary.avgMs, minMs: summary.minMs, maxMs: summary.maxMs,
    p50: summary.p50, p75: summary.p75, p90: summary.p90, p95: summary.p95, p99: summary.p99,
    totalBytes: summary.totalBytes, avgBytes: summary.avgBytes,
    samples: active.samples.slice(0, 50_000).map((s) => ({ t: s.t, latencyMs: s.latencyMs, status: s.status, error: s.error })),
    timeline: timelineArr,
  };
}

function resolveTargets(config: PerfConfig, deps: PerfDeps): ApiRequest[] {
  if (config.target.kind === 'request') {
    const req = deps.getRequest(config.target.id);
    return req ? [req] : [];
  }
  return deps.listRequests(config.target.id, undefined);
}

function resolveWorkspaceId(config: PerfConfig, deps: PerfDeps): string {
  const first = resolveTargets(config, deps)[0];
  return first?.workspaceId ?? '';
}

export function perfThresholdsBreached(metrics: PerfMetrics, thresholds?: PerfDeps['thresholds']): string[] {
  const breach: string[] = [];
  if (!thresholds) return breach;
  if (thresholds.avgMs !== undefined && metrics.avgMs > thresholds.avgMs) breach.push(`avg latency ${metrics.avgMs.toFixed(1)}ms > ${thresholds.avgMs}ms`);
  if (thresholds.p95Ms !== undefined && metrics.p95 > thresholds.p95Ms) breach.push(`p95 ${metrics.p95.toFixed(1)}ms > ${thresholds.p95Ms}ms`);
  if (thresholds.p99Ms !== undefined && metrics.p99 > thresholds.p99Ms) breach.push(`p99 ${metrics.p99.toFixed(1)}ms > ${thresholds.p99Ms}ms`);
  if (thresholds.errorRatePct !== undefined && metrics.errorRate * 100 > thresholds.errorRatePct) breach.push(`error rate ${(metrics.errorRate * 100).toFixed(2)}% > ${thresholds.errorRatePct}%`);
  return breach;
}

export function compareBaselines(a: PerfMetrics, b: PerfMetrics): { latencyDeltaPct: number; throughputDeltaPct: number; errorDeltaPct: number } {
  const pct = (base: number, next: number) => (base === 0 ? (next === 0 ? 0 : 100) : ((next - base) / base) * 100);
  return {
    latencyDeltaPct: pct(b.avgMs, a.avgMs),
    throughputDeltaPct: pct(b.throughputPerSec, a.throughputPerSec),
    errorDeltaPct: pct(b.errorRate * 100, a.errorRate * 100),
  };
}

export function perfRunToHtml(run: PerfRun): string {
  const m = run.metrics;
  if (!m) return `<p>No metrics recorded</p>`;
  const rows = [
    ['Requests', String(m.totalRequests)],
    ['Success', String(m.successCount)],
    ['Errors', `${m.errorCount} (${(m.errorRate * 100).toFixed(2)}%)`],
    ['Throughput', `${m.throughputPerSec.toFixed(2)}/s`],
    ['Latency avg/min/max', `${m.avgMs.toFixed(1)} / ${m.minMs.toFixed(1)} / ${m.maxMs.toFixed(1)} ms`],
    ['p50 / p75 / p90 / p95 / p99', `${m.p50.toFixed(1)} / ${m.p75.toFixed(1)} / ${m.p90.toFixed(1)} / ${m.p95.toFixed(1)} / ${m.p99.toFixed(1)} ms`],
    ['Bytes', `${(m.totalBytes / (1024 * 1024)).toFixed(2)} MB total, ${m.avgBytes.toFixed(0)} B avg`],
  ].map(([k, v]) => `<tr><th style="text-align:left;padding:4px 12px;border-bottom:1px solid #ddd">${k}</th><td style="padding:4px 12px;border-bottom:1px solid #ddd">${v}</td></tr>`).join('');
  const bucketData = histogramBuckets(m.samples.map((s) => s.latencyMs), 12, m.minMs, m.maxMs);
  const barWidth = 480;
  const items = bucketData.length > 0 ? bucketData.map((b, i) => {
    const w = Math.max(2, (b / m.totalRequests) * barWidth);
    return `<div><span style="display:inline-block;width:110px;font-size:11px;font-family:monospace">bucket ${i + 1}</span><span style="display:inline-block;height:14px;background:#3b82f6;width:${w}px;border-radius:2px"></span> <span style="font-size:11px;color:#666">${b}</span></div>`;
  }).join('') : '<p>No samples</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Perf run ${run.id}</title><style>body{font-family:system-ui;margin:2rem;color:#222}h1{font-size:1.4rem}table{border-collapse:collapse}</style></head><body>
<h1>Performance run — ${run.startedAt}</h1>
<p>Target: ${run.config.target.kind} ${run.config.target.id} · concurrency ${run.config.concurrency} · ${run.config.durationSec}s · ${run.config.ratePerSecond || 'unlimited'} rps</p>
<table>${rows}</table>
<h2>Latency histogram</h2>${items}
<p style="color:#888;font-size:12px">Status: ${run.status}</p>
</body></html>`;
}
