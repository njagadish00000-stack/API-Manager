/**
 * Response-viewer utilities (§response viewer actions): search match
 * counting/highlighting, and copy/save-export payload builders.
 * Plain .ts (no JSX) so hub-side tooling and unit tests can import it.
 */

/** Escape a literal string for safe inclusion in a RegExp. */
export const rxEscape = (s: string): string => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

/** Count case-insensitive literal matches of `query` inside `text` (0 when query empty). */
export function countMatches(text: string, query: string): number {
  if (!query) return 0;
  try { return (text.match(new RegExp(rxEscape(query), 'gi')) ?? []).length; } catch { return 0; }
}

/** Wrap case-insensitive literal matches with <mark id="resp-hit-N" class="resp-hit">. Input must already be HTML-escaped. */
export function markSearch(html: string, query: string): string {
  if (!query) return html;
  const re = new RegExp(rxEscape(query), 'gi');
  let i = 0;
  return html.replace(re, (m) => `<mark id="resp-hit-${i++}" class="resp-hit">${m}</mark>`);
}

/** Minimal HTML-entity escaping for response-body search highlighting (NOT a sanitizer). */
export const escapeTextHtml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface TimingLike {
  totalMs?: number; dnsMs?: number; connectMs?: number; tlsMs?: number;
  uploadMs?: number; serverMs?: number; downloadMs?: number;
}
export interface HeaderLike { key: string; value: string; enabled?: boolean }
export interface CookieLike { name: string; value: string; domain?: string; path?: string }

/** Full response serialized WITH headers (and meta): status, headers, cookies, timing, body. */
export function fullResponseJson(r: {
  status: number; statusText: string; httpVersion?: string;
  headers: HeaderLike[]; cookies?: CookieLike[]; timing?: TimingLike;
  redirects?: unknown[]; bodyText?: string | null; bodySize?: number;
}): string {
  return JSON.stringify({
    status: r.status, statusText: r.statusText, httpVersion: r.httpVersion,
    headers: r.headers, cookies: r.cookies ?? [], timing: r.timing,
    redirects: r.redirects ?? [], bodyText: r.bodyText ?? null, bodySize: r.bodySize ?? 0,
  }, null, 2);
}

/** Body-only export: pretty-prints when JSON, sensible filename/mime otherwise. */
export function bodyExport(r: {
  status: number; headers: HeaderLike[]; bodyText?: string | null;
  requestSnapshot?: { url?: string };
}): { name: string; mime: string; content: string } {
  const ct = (r.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '').toLowerCase();
  const text = r.bodyText ?? '';
  const isJson = ct.includes('json') || /^\s*[[{]/.test(text);
  let content = text;
  if (isJson) { try { content = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ } }
  let host = 'local';
  try { host = new URL(r.requestSnapshot?.url ?? 'http://local').hostname.replace(/[^a-z0-9]+/gi, '-') || 'local'; } catch { /* relative URL */ }
  return { name: `response-${host}-${r.status}${isJson ? '.json' : '.txt'}`, mime: isJson ? 'application/json' : 'text/plain', content };
}
