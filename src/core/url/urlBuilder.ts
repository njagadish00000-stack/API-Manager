/**
 * URL builder utilities: parse/build, query/path params, encoding, bulk edit,
 * duplicate detection (§9).
 */
import type { KeyValue } from '../../shared/types';
import { uid } from '../../shared/ids';

export function kv(key = '', value = '', enabled = true, description?: string): KeyValue {
  return { id: uid(), key, value, enabled, description };
}

export function encodeQueryComponent(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, '%20');
}

export function decodeQueryComponent(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Split raw URL into origin-ish base and query string params. */
export function parseQueryParams(url: string): { base: string; params: KeyValue[] } {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return { base: url, params: [] };
  const base = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  const hashIdx = query.indexOf('#');
  const rawQuery = hashIdx === -1 ? query : query.slice(0, hashIdx);
  const params: KeyValue[] = [];
  if (rawQuery.length > 0) {
    for (const pair of rawQuery.split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      if (eq === -1) params.push(kv(decodeQueryComponent(pair), ''));
      else params.push(kv(decodeQueryComponent(pair.slice(0, eq)), decodeQueryComponent(pair.slice(eq + 1))));
    }
  }
  return { base, params };
}

/** Build final URL from base + params (enabled only), honoring encodeUrl. */
export function buildUrl(base: string, params: KeyValue[], encode = true): string {
  const enc = (s: string) => (encode ? encodeQueryComponent(s) : s);
  const enabled = params.filter((p) => p.enabled && p.key.length > 0);
  if (enabled.length === 0) return base;
  const hasQuery = base.includes('?');
  const sep = hasQuery ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return base + sep + enabled.map((p) => `${enc(p.key)}=${enc(p.value)}`).join('&');
}

/** Substitute :pathParam segments in a URL path. */
export function applyPathParams(url: string, pathParams: KeyValue[], encode = true): string {
  let out = url;
  for (const p of pathParams) {
    if (!p.enabled || !p.key) continue;
    const value = encode ? encodeURIComponent(p.value) : p.value;
    out = out.replace(new RegExp(`:${escapeRe(p.key)}(?=/|$|\\?|&)`, 'g'), value);
  }
  return out;
}

/** Extract :param names from a URL. */
export function extractPathParams(url: string): string[] {
  const out: string[] = [];
  const re = /:([A-Za-z_][A-Za-z0-9_-]*)/g;
  let m: RegExpExecArray | null;
  // Skip the scheme (://) part to avoid matching ports
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  while ((m = re.exec(withoutScheme)) !== null) {
    // avoid matching port component
    const before = withoutScheme.slice(0, m.index);
    if (!before.includes('/') && /^\d*$/.test(withoutScheme.slice(m.index + m[0].length).split('/')[0])) continue;
    out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Bulk-edit serialization: one `key: value` per line (Postman style). */
export function paramsToBulkText(params: KeyValue[]): string {
  return params.map((p) => `${p.enabled ? '' : '// '}${p.key}: ${p.value}`).join('\n');
}

export function bulkTextToParams(text: string): KeyValue[] {
  return text.split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const disabled = line.trimStart().startsWith('// ');
      const clean = disabled ? line.trimStart().slice(3) : line;
      const idx = clean.indexOf(':');
      if (idx === -1) return kv(clean.trim(), '', !disabled);
      return kv(clean.slice(0, idx).trim(), clean.slice(idx + 1).trim(), !disabled);
    });
}

export function detectDuplicates(params: KeyValue[]): string[] {
  const seen = new Map<string, number>();
  const dups: string[] = [];
  for (const p of params) {
    if (!p.enabled || !p.key) continue;
    const count = (seen.get(p.key) ?? 0) + 1;
    seen.set(p.key, count);
    if (count === 2) dups.push(p.key);
  }
  return dups;
}

export interface ParsedUrl {
  protocol: string; host: string; port?: number; path: string;
  query: KeyValue[]; hash?: string; auth?: string;
}

export function parseUrl(url: string): ParsedUrl | null {
  try {
    const u = new URL(url.startsWith('http') ? url : `http://${url}`);
    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : undefined,
      path: u.pathname,
      query: parseQueryParams(u.search ? u.search.slice(0) : '?').params.length
        ? Array.from(u.searchParams.entries()).map(([key, value]) => kv(key, value))
        : [],
      hash: u.hash ? u.hash.slice(1) : undefined,
      auth: u.username ? `${decodeURIComponent(u.username)}${u.password ? ':***' : ''}` : undefined,
    };
  } catch {
    return null;
  }
}

export function isValidUrl(url: string): boolean {
  return parseUrl(url) !== null;
}

export function suggestUrlScheme(url: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) return url;
  return `https://${url}`;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
