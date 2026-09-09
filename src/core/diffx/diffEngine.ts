/**
 * Diff utilities (§response compare): deep JSON structural diff and
 * simple key/value header diff. Independent of external libs.
 */

export interface JsonDiffEntry { kind: 'added' | 'removed' | 'modified'; path: string; a?: string; b?: string }

export function diffJsonValues(a: unknown, b: unknown, basePath = '$', acc: JsonDiffEntry[] = []): JsonDiffEntry[] {
  walk(a, b, basePath, acc);
  return acc.sort((x, y) => x.path.localeCompare(y.path)).slice(0, 500);
}

function walk(a: unknown, b: unknown, path: string, acc: JsonDiffEntry[]): void {
  if (acc.length >= 500) return;
  if (a === b) return;
  if (a === undefined) { acc.push({ kind: 'added', path, b: stringify(b) }); return; }
  if (b === undefined) { acc.push({ kind: 'removed', path, a: stringify(a) }); return; }
  const aIsObj = a !== null && typeof a === 'object';
  const bIsObj = b !== null && typeof b === 'object';
  if (!aIsObj || !bIsObj) {
    if (a !== b) acc.push({ kind: 'modified', path, a: stringify(a), b: stringify(b) });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      walk(a[i], b[i], `${path}[${i}]`, acc);
      if (acc.length >= 500) return;
    }
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    acc.push({ kind: 'modified', path, a: stringify(a), b: stringify(b) });
    return;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const key of keys) {
    walk(aObj[key], bObj[key], `${path}.${key}`, acc);
    if (acc.length >= 500) return;
  }
}

function stringify(v: unknown): string {
  if (v === undefined) return 'undefined';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

export interface HeaderDiffEntry { kind: string; name: string }

export function diffKeyValues(a: Record<string, string>, b: Record<string, string>): HeaderDiffEntry[] {
  const out: HeaderDiffEntry[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const av = a[key]; const bv = b[key];
    if (av === undefined) out.push({ kind: 'added', name: key });
    else if (bv === undefined) out.push({ kind: 'removed', name: key });
    else if (av !== bv) out.push({ kind: 'modified', name: key });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
