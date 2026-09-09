/**
 * Monitors (§21): interval schedules that run collections via the collection
 * runner, with failure thresholds and webhook notifications (Slack/Discord/
 * generic). All scheduling lives in the background; tick events flow to UI
 * via monitor.result.
 */
import type { Monitor, MonitorResult, RunConfig } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { request } from 'undici';
import { startRun, RunnerDeps, RunnerExtras, getActiveRun } from '../runner/collectionRunner';
import type { RunProgressEvent } from '../../shared/events';

interface ActiveMonitor { monitor: Monitor; timer: ReturnType<typeof setInterval>; running: boolean }
// consecutive-failure streaks keyed off monitor id
const failureStreaks = new Map<string, number>();

function streakOf(id: string): number { return failureStreaks.get(id) ?? 0 }
function bumpStreak(id: string, reset: boolean): number {
  const next = reset ? 0 : streakOf(id) + 1;
  failureStreaks.set(id, next);
  return next;
}

const activeMonitors = new Map<string, ActiveMonitor>();

export interface MonitorDeps {
  getMonitor: (id: string) => Monitor | undefined;
  saveResult: (result: MonitorResult) => void;
  emitEvent: (type: 'monitor.result', payload: MonitorResult) => void;
  runnerDeps: () => RunnerDeps;
  runnerExtras: (monitor: Monitor) => RunnerExtras;
}

async function runMonitorTick(monitor: Monitor, deps: MonitorDeps): Promise<void> {
  const config: RunConfig = {
    collectionId: monitor.collectionId,
    environmentId: monitor.environmentId,
    iterations: 1, delayMs: 0, stopOnFailure: false,
  };
  const started = now();
  let finished = false;
  const finish = (over?: { error?: string }) => {
    if (finished) return;
    finished = true;
    const run = getActiveRun(runId);
    const results = run?.results ?? [];
    const failed = results.filter((r) => !r.passed && !r.skipped).length;
    const passedTests = results.reduce((a, r) => a + r.tests.filter((t) => t.passed).length, 0);
    const failedTests = failed + (over?.error ? 1 : 0);
    const durationMs = Date.now() - Date.parse(started);
    const isDown = failedTests > 0 || !!over?.error;
    const streak = bumpStreak(monitor.id, !isDown);
    const thresholdReached = isDown && streak >= Math.max(1, monitor.failureThreshold);
    const runResult: MonitorResult = {
      id: uid(), monitorId: monitor.id, timestamp: started,
      status: isDown ? (streak === 1 ? 'degraded' : 'down') : 'up',
      passedTests, failedTests, durationMs,
      error: over?.error,
    };
    deps.saveResult(runResult);
    deps.emitEvent('monitor.result', runResult);
    if (thresholdReached) maybeNotify(monitor, runResult, deps).catch(() => undefined);
  };
  const { runId } = startRun(config, deps.runnerDeps(), deps.runnerExtras(monitor), (ev: RunProgressEvent) => {
    if (ev.runId !== runId) return;
    if (ev.status === 'completed' || ev.status === 'failed' || ev.status === 'stopped') finish();
  });
  // safety timeout
  setTimeout(() => finish({ error: 'monitor run timed out' }), 10 * 60 * 1000);
}

async function maybeNotify(monitor: Monitor, result: MonitorResult, deps: MonitorDeps): Promise<void> {
  for (const url of monitor.notifyWebhooks ?? []) {
    try {
      await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `⚠️ API Manager monitor "${monitor.name}" ${result.status.toUpperCase()} at ${result.timestamp} (${result.failedTests} failure${result.failedTests === 1 ? '' : 's'})${result.error ? `: ${result.error}` : ''}`,
          monitor: monitor.name, timestamp: result.timestamp, status: result.status, failures: result.failedTests,
        }),
      });
    } catch { /* notification failure is non-fatal */ }
  }
  void deps;
}

export function enableMonitor(monitorId: string, monitor: Monitor, deps: MonitorDeps): void {
  disableMonitor(monitorId);
  const intervalMs = Math.max(60_000, monitor.intervalMinutes * 60_000);
  const tick = () => {
    const am = activeMonitors.get(monitorId);
    if (!am || am.running) return;
    am.running = true;
    runMonitorTick(monitor, deps).catch(() => undefined).finally(() => {
      const current = activeMonitors.get(monitorId);
      if (current) current.running = false;
    });
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  activeMonitors.set(monitorId, { monitor, timer, running: false });
  // fire immediately on enable? keep initial delay for stability
}

export function disableMonitor(monitorId: string): void {
  const am = activeMonitors.get(monitorId);
  if (am) clearInterval(am.timer);
  activeMonitors.delete(monitorId);
}

export function isMonitorActive(monitorId: string): boolean { return activeMonitors.has(monitorId); }

export function runMonitorNow(monitorId: string, deps: MonitorDeps): void {
  const monitor = deps.getMonitor(monitorId);
  if (!monitor) throw new Error(`Monitor not found: ${monitorId}`);
  void runMonitorTick(monitor, deps).catch(() => undefined);
}

export function refreshMonitorSchedule(monitor: Monitor, deps: MonitorDeps): void {
  if (!monitor.enabled) { disableMonitor(monitor.id); return; }
  if (activeMonitors.has(monitor.id)) enableMonitor(monitor.id, monitor, deps);
}
