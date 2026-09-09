/** API / Workspace health score (§86). */
import type { ApiRequest, Collection, Specification } from '../../shared/types';

export interface HealthBreakdown { total: number; breakdown: Record<string, number> }

export function computeHealthScore(ctx: {
  collections: Collection[];
  requests: ApiRequest[];
  specs: Specification[];
  historyStats?: { totalSends: number; avgMs: number; errorRate: number };
}): HealthBreakdown {
  const { requests, collections, specs } = ctx;
  const n = Math.max(1, requests.length);
  const withTests = requests.filter((r) => r.scripts.postResponse.trim() || r.assertions.some((a) => a.enabled)).length;
  const withDocs = requests.filter((r) => r.description?.trim() || r.documentation?.trim()).length;
  const withAuth = requests.filter((r) => r.auth.type !== 'none' || r.headers.some((h) => h.key.toLowerCase() === 'authorization')).length;
  const https = requests.filter((r) => !r.url.startsWith('http://') || r.url.includes('localhost') || r.url.includes('127.0.0.1')).length;
  const deprecated = specs.filter((s) => s.lifecycle === 'Deprecated').length;
  const validSpecs = specs.filter((s) => s.format !== 'unknown' as never).length;

  const dim = (score: number, weight: number) => Math.round(score * weight);
  const breakdown: Record<string, number> = {
    'Test coverage': dim(withTests / n, 25),
    'Documentation': dim(withDocs / n, 15),
    'Security (HTTPS+auth)': dim(((https + withAuth) / 2) / n, 20),
    'Specification presence': Math.min(10, validSpecs * 2 + (specs.length > 0 ? 0 : 0)),
    'Collection organization': Math.min(10, collections.filter((c) => c.description?.trim()).length * 2 + (collections.length > 0 ? 2 : 0)),
    'Performance': dim(ctx.historyStats ? clamp01(1 - Math.min(1, ctx.historyStats.avgMs / 5000)) : 0.5, 10),
    'Reliability': dim(ctx.historyStats ? clamp01(1 - ctx.historyStats.errorRate) : 0.5, 10),
  };
  let total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  if (deprecated > 0) total = Math.max(0, total - deprecated * 3);
  return { total: Math.min(100, Math.max(0, total)), breakdown };
}

function clamp01(n: number): number { return Math.min(1, Math.max(0, n)); }
