/**
 * Shared performance-metric math used by both UI and engine (§18).
 */

export interface PerfRequestSample {
  /** ms since run start */
  t: number;
  latencyMs: number;
  status: number;
  error?: string;
  bytes?: number;
}

export function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const sorted = [...sortedValues].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function histogramBuckets(values: number[], buckets: number, min?: number, max?: number): number[] {
  if (values.length === 0) return [];
  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  if (hi === lo) return [values.length];
  const out = new Array<number>(buckets).fill(0);
  for (const v of values) {
    let idx = Math.floor(((v - lo) / (hi - lo)) * buckets);
    if (idx >= buckets) idx = buckets - 1;
    if (idx < 0) idx = 0;
    out[idx]++;
  }
  return out;
}

export interface PerfComputedSummary {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  throughputPerSec: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50: number;
  p75: number;
  p90: number;
  p95: number;
  p99: number;
  totalBytes: number;
  avgBytes: number;
}

export function computePerfSummary(samples: PerfRequestSample[], durationMs: number): PerfComputedSummary {
  const successes = samples.filter((s) => !s.error && s.status < 400);
  const errors = samples.length - successes.length;
  const latencies = successes.map((s) => s.latencyMs);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const bytes = samples.reduce((a, s) => a + (s.bytes ?? 0), 0);
  return {
    totalRequests: samples.length,
    successCount: successes.length,
    errorCount: errors,
    errorRate: samples.length > 0 ? errors / samples.length : 0,
    throughputPerSec: durationMs > 0 ? samples.length / (durationMs / 1000) : 0,
    avgMs: latencies.length > 0 ? sum / latencies.length : 0,
    minMs: latencies.length > 0 ? Math.min(...latencies) : 0,
    maxMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    p50: percentile(latencies, 50),
    p75: percentile(latencies, 75),
    p90: percentile(latencies, 90),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    totalBytes: bytes,
    avgBytes: samples.length > 0 ? bytes / samples.length : 0,
  };
}
