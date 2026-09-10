/**
 * Response viewer actions as pure functions (§12 custom response controls).
 *
 * Used by the renderer response toolbar (Copy ▾ / Download ▾) and by unit
 * tests so clipboard/file payload behaviour is verified outside the UI.
 */

export interface HeaderLike { key: string; value: string; enabled?: boolean }
export interface ResponseLike {
  status: number;
  statusText?: string;
  httpVersion?: string;
  headers: HeaderLike[];
  cookies?: { name: string; value: string; domain?: string; path?: string }[];
  bodyText?: string | null;
  bodyBase64?: string | null;
  bodySize?: number;
  timing?: { totalMs?: number };
  requestSnapshot?: { method?: string; url?: string } | null;
}

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}
export function zoomIn(z: number): number { return clampZoom(z + ZOOM_STEP); }
export function zoomOut(z: number): number { return clampZoom(z - ZOOM_STEP); }
export function zoomPct(z: number): string { return `${Math.round(clampZoom(z) * 100)}%`; }

/** Pretty-print JSON bodies; leave everything else untouched. */
export function prettyBody(resp: ResponseLike): string {
  const text = resp.bodyText ?? '';
  const ct = contentType(resp);
  if (ct.includes('json') || /^\s*[[{]/.test(text)) {
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { /* raw */ }
  }
  return text;
}

export function contentType(resp: ResponseLike): string {
  return (resp.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '').toLowerCase();
}

export function headersToText(headers: HeaderLike[]): string {
  return headers.map((h) => `${h.key}: ${h.value}`).join('\r\n');
}

export function cookiesToText(cookies: ResponseLike['cookies']): string {
  return (cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** Full raw HTTP response: status line, headers, blank line, body. */
export function rawResponseText(resp: ResponseLike): string {
  const version = resp.httpVersion ? `HTTP/${resp.httpVersion.replace(/^HTTP\//i, '')}` : 'HTTP/1.1';
  const statusLine = `${version} ${resp.status} ${resp.statusText ?? ''}`.trimEnd();
  const head = [statusLine, headersToText(resp.headers)].filter(Boolean).join('\r\n');
  return `${head}\r\n\r\n${resp.bodyText ?? ''}`;
}

export interface TextBundle { label: string; content: string; mime: string }

/** The four mandated Copy actions. */
export function copyBundles(resp: ResponseLike): {
  body: TextBundle;
  headers: TextBundle;
  headersBody: TextBundle;
  statusHeadersBody: TextBundle;
} {
  const body = prettyBody(resp);
  const headers = headersToText(resp.headers);
  const statusLine = `HTTP/${(resp.httpVersion ?? '1.1').replace(/^HTTP\//i, '')} ${resp.status} ${resp.statusText ?? ''}`.trim();
  const headersBody = `${headers}\r\n\r\n${body}`;
  const statusHeadersBody = `${statusLine}\r\n${headersBody}`;
  return {
    body: { label: 'Body', content: body, mime: contentType(resp) || 'text/plain' },
    headers: { label: 'Headers', content: headers, mime: 'text/plain' },
    headersBody: { label: 'Headers + Body', content: headersBody, mime: 'text/plain' },
    statusHeadersBody: { label: 'Status + Headers + Body', content: statusHeadersBody, mime: 'text/plain' },
  };
}

/** Content-Type → file extension suggestion used by Downloads (§12). */
export function suggestExtension(respOrCt: ResponseLike | string): string {
  const ct = typeof respOrCt === 'string' ? respOrCt.toLowerCase() : contentType(respOrCt);
  const bare = ct.split(';')[0].trim();
  const map: Record<string, string> = {
    'application/json': 'json',
    'application/hal+json': 'json',
    'application/problem+json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'application/soap+xml': 'xml',
    'text/html': 'html',
    'application/xhtml+xml': 'html',
    'text/css': 'css',
    'text/csv': 'csv',
    'text/plain': 'txt',
    'text/event-stream': 'txt',
    'application/javascript': 'js',
    'text/javascript': 'js',
    'application/x-www-form-urlencoded': 'txt',
    'multipart/form-data': 'txt',
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/x-icon': 'ico',
    'application/zip': 'zip',
    'application/gzip': 'gz',
    'application/x-gzip': 'gz',
    'application/x-tar': 'tar',
    'application/octet-stream': 'bin',
    'application/graphql-response+json': 'json',
    'application/yaml': 'yaml',
    'application/x-yaml': 'yaml',
  };
  if (map[bare]) return map[bare];
  if (bare.endsWith('+json')) return 'json';
  if (bare.endsWith('+xml')) return 'xml';
  if (bare.startsWith('image/')) return (bare.split('/')[1] ?? 'img').replace(/[^a-z0-9]/g, '');
  if (bare.startsWith('text/')) return 'txt';
  // fall back to peeking at the body
  if (typeof respOrCt !== 'string') {
    const t = (respOrCt.bodyText ?? '').trimStart();
    if (t.startsWith('{') || t.startsWith('[')) return 'json';
    if (t.startsWith('<')) return 'xml';
  }
  return 'txt';
}

function safeHost(resp: ResponseLike): string {
  try {
    const u = new URL(resp.requestSnapshot?.url ?? 'http://localhost/');
    return u.hostname.replace(/[^a-z0-9.-]+/gi, '-') || 'localhost';
  } catch { return 'localhost'; }
}

export interface FileBundle extends TextBundle { name: string }

/** The four mandated Download actions, with content-type-aware extensions. */
export function downloadBundles(resp: ResponseLike): {
  body: FileBundle;
  headers: FileBundle;
  headersBody: FileBundle;
  raw: FileBundle;
} {
  const ext = suggestExtension(resp);
  const host = safeHost(resp);
  const stamp = `${host}-${resp.status}`;
  const bodyContent = prettyBody(resp);
  const headers = headersToText(resp.headers);
  const bodyMime = contentType(resp) || 'text/plain';
  return {
    body: { label: 'Body', name: `response-${stamp}.${ext}`, mime: bodyMime, content: bodyContent },
    headers: { label: 'Headers', name: `response-${stamp}.headers.txt`, mime: 'text/plain', content: headers },
    headersBody: { label: 'Headers + Body', name: `response-${stamp}.headers+body.txt`, mime: 'text/plain', content: `${headers}\r\n\r\n${bodyContent}` },
    raw: { label: 'Raw response', name: `response-${stamp}.http`, mime: 'message/rfc822', content: rawResponseText(resp) },
  };
}
