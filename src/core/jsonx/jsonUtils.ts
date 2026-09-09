/** JSON utilities: format, minify, validate, query, structural diff (§26/§27). */

export interface JsonValidation { ok: boolean; error?: string; line?: number; column?: number; value?: unknown; }

export function parseJson(text: string): JsonValidation {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const posMatch = msg.match(/position (\d+)/);
    let line: number | undefined, column: number | undefined;
    if (posMatch) {
      const pos = parseInt(posMatch[1], 10);
      const upto = text.slice(0, pos);
      line = upto.split('\n').length;
      column = pos - upto.lastIndexOf('\n');
    }
    return { ok: false, error: msg, line, column };
  }
}

export function formatJson(text: string, indent = 2): { ok: boolean; result: string; error?: string } {
  const p = parseJson(text);
  if (!p.ok) return { ok: false, result: text, error: p.error };
  return { ok: true, result: JSON.stringify(p.value, null, indent) };
}

export function minifyJson(text: string): { ok: boolean; result: string; error?: string } {
  const p = parseJson(text);
  if (!p.ok) return { ok: false, result: text, error: p.error };
  return { ok: true, result: JSON.stringify(p.value) };
}

/** Get a value from a parsed object via a simple dot/bracket path ("a.b[0].c"). */
export function getByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter((p) => p.length > 0);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

export interface JsonDiffEntry {
  kind: 'added' | 'removed' | 'modified';
  path: string;
  a?: unknown;
  b?: unknown;
}

/** Structural JSON diff (§27). */
export function diffJson(a: unknown, b: unknown, basePath = ''): JsonDiffEntry[] {
  const out: JsonDiffEntry[] = [];
  const ta = typeOf(a), tb = typeOf(b);
  if (ta !== tb) {
    out.push({ kind: 'modified', path: basePath || '$', a, b });
    return out;
  }
  if (ta === 'object') {
    const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
    for (const k of Object.keys(ao)) {
      const p = `${basePath}.${k}`;
      if (!(k in bo)) out.push({ kind: 'removed', path: p, a: ao[k] });
      else out.push(...diffJson(ao[k], bo[k], p));
    }
    for (const k of Object.keys(bo)) {
      if (!(k in ao)) out.push({ kind: 'added', path: `${basePath}.${k}`, b: bo[k] });
    }
  } else if (ta === 'array') {
    const aa = a as unknown[], ba = b as unknown[];
    const max = Math.max(aa.length, ba.length);
    for (let i = 0; i < max; i++) {
      const p = `${basePath}[${i}]`;
      if (i >= aa.length) out.push({ kind: 'added', path: p, b: ba[i] });
      else if (i >= ba.length) out.push({ kind: 'removed', path: p, a: aa[i] });
      else out.push(...diffJson(aa[i], ba[i], p));
    }
  } else if (a !== b) {
    out.push({ kind: 'modified', path: basePath || '$', a, b });
  }
  return out;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Remove keys at given JSON paths (used by snapshot ignore-lists). */
export function prunePaths(value: unknown, ignorePaths: string[]): unknown {
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  for (const path of ignorePaths) {
    const parts = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
    if (parts.length === 0) continue;
    let cur: unknown = clone;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur !== 'object' || cur === null) { cur = undefined; break; }
      cur = (cur as Record<string, unknown>)[parts[i]];
    }
    if (typeof cur === 'object' && cur !== null) delete (cur as Record<string, unknown>)[parts[parts.length - 1]];
  }
  return clone;
}

/** Deep equal ignoring listed paths. */
export function equalIgnoring(a: unknown, b: unknown, ignorePaths: string[]): boolean {
  const pa = JSON.stringify(prunePaths(a, ignorePaths));
  const pb = JSON.stringify(prunePaths(b, ignorePaths));
  return pa === pb;
}

export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}
