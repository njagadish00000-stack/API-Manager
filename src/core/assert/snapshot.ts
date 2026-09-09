/** Snapshot / golden-response comparison (§36). */
import type { ApiResponse } from '../../shared/types';
import { parseJson, diffJson, prunePaths } from '../jsonx/jsonUtils';

export interface SnapshotCompareResult {
  match: boolean;
  statusMatch: boolean;
  headersMatch: boolean;
  bodyMatch: boolean;
  differences: { path: string; expected: string; actual: string; kind: 'added' | 'removed' | 'modified' }[];
}

export function compareToSnapshot(snapshot: ApiResponse, current: ApiResponse, ignorePaths: string[] = []): SnapshotCompareResult {
  const differences: SnapshotCompareResult['differences'] = [];
  const statusMatch = snapshot.status === current.status;
  if (!statusMatch) {
    differences.push({ path: 'status', expected: String(snapshot.status), actual: String(current.status), kind: 'modified' });
  }
  // headers: compare only headers present in both (date etc. excluded)
  const volatile = new Set(['date', 'server', 'set-cookie', 'request-id', 'x-request-id', 'expires']);
  const snapHeaders = new Map(snapshot.headers.filter((h) => !volatile.has(h.key.toLowerCase())).map((h) => [h.key.toLowerCase(), h.value]));
  const curHeaders = new Map(current.headers.filter((h) => !volatile.has(h.key.toLowerCase())).map((h) => [h.key.toLowerCase(), h.value]));
  let headersMatch = true;
  for (const [k, v] of snapHeaders) {
    if (!curHeaders.has(k)) { differences.push({ path: `header.${k}`, expected: v, actual: '(missing)', kind: 'removed' }); headersMatch = false; }
    else if (curHeaders.get(k) !== v) { differences.push({ path: `header.${k}`, expected: v, actual: curHeaders.get(k)!, kind: 'modified' }); headersMatch = false; }
  }
  // body
  let bodyMatch = true;
  const a = parseJson(snapshot.bodyText ?? '');
  const b = parseJson(current.bodyText ?? '');
  if (a.ok && b.ok) {
    const diffs = diffJson(prunePaths(a.value, ignorePaths), prunePaths(b.value, ignorePaths));
    for (const d of diffs) {
      differences.push({ path: d.path, expected: fmt(d.a), actual: fmt(d.b), kind: d.kind });
    }
    bodyMatch = diffs.length === 0;
  } else {
    const ta = snapshot.bodyText ?? '';
    const tb = current.bodyText ?? '';
    bodyMatch = ta === tb;
    if (!bodyMatch) differences.push({ path: 'body', expected: trunc(ta), actual: trunc(tb), kind: 'modified' });
  }
  return { match: statusMatch && headersMatch && bodyMatch, statusMatch, headersMatch, bodyMatch, differences };
}

function fmt(v: unknown): string {
  if (v === undefined) return '(missing)';
  try { const s = JSON.stringify(v); return s.length > 120 ? `${s.slice(0, 120)}…` : s; } catch { return String(v); }
}
function trunc(s: string, n = 200): string { return s.length > n ? `${s.slice(0, n)}…` : s; }
