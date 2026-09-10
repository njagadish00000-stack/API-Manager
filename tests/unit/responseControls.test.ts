import { describe, it, expect } from 'vitest';
import {
  clampZoom, zoomIn, zoomOut, zoomPct, ZOOM_MIN, ZOOM_MAX,
  copyBundles, downloadBundles, rawResponseText, suggestExtension,
  prettyBody, headersToText,
} from '../../src/core/response/responseFormat';
import {
  buildSearchRegExp, countMatches, markSearch, escapeTextHtml,
  fullResponseJson, bodyExport,
} from '../../src/renderer/responseExport';
import type { ApiResponse } from '../../src/shared/types';

const resp = (overrides: Partial<ApiResponse> = {}): ApiResponse => ({
  id: 'x', requestId: 'r', status: 201, statusText: 'Created', httpVersion: '1.1',
  headers: [
    { key: 'Content-Type', value: 'application/json; charset=utf-8' },
    { key: 'X-Request-Id', value: 'abc-123' },
  ],
  cookies: [{ name: 'sid', value: 'zzz', domain: 'api.x.test', path: '/' }],
  bodyText: '{"name":"ada","items":[1,2,3]}',
  bodySize: 30,
  timing: { totalMs: 42, dnsMs: 1, connectMs: 2, tlsMs: 3, uploadMs: 4, serverMs: 30, downloadMs: 2 },
  redirects: [], timestamp: '2026-01-01T00:00:00Z',
  requestSnapshot: { method: 'POST', url: 'https://api.x.test/items' },
  ...overrides,
} as unknown as ApiResponse);

describe('response viewer zoom controls (§12: Ctrl +/-/0)', () => {
  it('zooms in and out in 10% steps', () => {
    expect(zoomIn(1)).toBeCloseTo(1.1);
    expect(zoomOut(1)).toBeCloseTo(0.9);
  });
  it('clamps to the supported range and resets non-finite values', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(NaN)).toBe(1);
    expect(zoomPct(1.25)).toBe('125%');
  });
});

describe('response copy actions — exactly four bundles (§12)', () => {
  it('provides body / headers / headers+body / status+headers+body', () => {
    const b = copyBundles(resp());
    expect(Object.keys(b).sort()).toEqual(['body', 'headers', 'headersBody', 'statusHeadersBody']);
    expect(b.body.mime).toContain('json');
    expect(JSON.parse(b.body.content).name).toBe('ada'); // pretty body parses
    expect(b.headers.content).toContain('X-Request-Id: abc-123');
    expect(b.headersBody.content).toContain('X-Request-Id');
    expect(b.headersBody.content).toContain('"name": "ada"');
    expect(b.statusHeadersBody.content.startsWith('HTTP/1.1 201 Created')).toBe(true);
    expect(b.statusHeadersBody.content).toContain('X-Request-Id');
    expect(b.statusHeadersBody.content).toContain('"name": "ada"');
  });
});

describe('response download actions — exactly four bundles with extensions (§12)', () => {
  it('provides body / headers / headers+body / raw .http', () => {
    const b = downloadBundles(resp());
    expect(Object.keys(b).sort()).toEqual(['body', 'headers', 'headersBody', 'raw']);
    expect(b.body.name).toBe('response-api.x.test-201.json');
    expect(b.headers.name).toBe('response-api.x.test-201.headers.txt');
    expect(b.headersBody.name).toBe('response-api.x.test-201.headers+body.txt');
    expect(b.raw.name).toBe('response-api.x.test-201.http');
    expect(b.raw.mime).toBe('message/rfc822');
    expect(b.raw.content.startsWith('HTTP/1.1 201 Created')).toBe(true);
    expect(b.raw.content).toContain(headersToText(resp().headers));
  });

  it('suggests correct extensions by content type', () => {
    expect(suggestExtension('application/json')).toBe('json');
    expect(suggestExtension('application/hal+json')).toBe('json');
    expect(suggestExtension('text/xml; charset=utf-8')).toBe('xml');
    expect(suggestExtension('application/soap+xml')).toBe('xml');
    expect(suggestExtension('text/html')).toBe('html');
    expect(suggestExtension('image/png')).toBe('png');
    expect(suggestExtension('application/vnd.custom+json')).toBe('json');
    expect(suggestExtension('application/weird+xml')).toBe('xml');
    expect(suggestExtension('application/pdf')).toBe('pdf');
  });

  it('peeks at the body when content type is unknown', () => {
    const r = resp({ headers: [{ key: 'Content-Type', value: 'application/x-weird', id: 'h', enabled: true }] }) as ApiResponse;
    r.bodyText = '{"x":1}';
    expect(suggestExtension(r)).toBe('json');
    const r2 = resp({ headers: [{ key: 'Content-Type', value: 'application/x-weird', id: 'h', enabled: true }] }) as ApiResponse;
    r2.bodyText = '<doc/>';
    expect(suggestExtension(r2)).toBe('xml');
  });
});

describe('raw response reconstruction', () => {
  it('rebuilds status line + headers + blank line + body', () => {
    const raw = rawResponseText(resp());
    const lines = raw.split('\r\n');
    expect(lines[0]).toBe('HTTP/1.1 201 Created');
    expect(lines).toContain('Content-Type: application/json; charset=utf-8');
    expect(raw).toContain('\r\n\r\n{"name":"ada"');
  });
  it('pretty-prints JSON bodies', () => {
    expect(prettyBody(resp())).toBe('{\n  "name": "ada",\n  "items": [\n    1,\n    2,\n    3\n  ]\n}');
  });
});

describe('response search (§12 find with options)', () => {
  const text = 'The quick brown fox\nQuick QUICK quick';

  it('returns null for empty or invalid regex', () => {
    expect(buildSearchRegExp('')).toBeNull();
    expect(buildSearchRegExp('[', { regex: true })).toBeNull();
  });

  it('counts case-insensitive matches by default and exact matches when case-sensitive', () => {
    expect(countMatches(text, 'quick')).toBe(4);
    expect(countMatches(text, 'quick', { caseSensitive: true })).toBe(2);
  });

  it('supports whole-word matching', () => {
    // plain substring search matches inside "quickly" too (3), whole-word only 2
    expect(countMatches('quick quickly quick', 'quick')).toBe(3);
    expect(countMatches('quick quickly quick', 'quick', { wholeWord: true })).toBe(2);
    expect(countMatches('quickly quick', 'quick', { wholeWord: true })).toBe(1);
  });

  it('supports regex mode', () => {
    expect(countMatches('a1 b2 c3', '[abc][0-9]', { regex: true })).toBe(3);
    expect(countMatches('a1 b2', 'x', { regex: true })).toBe(0);
  });

  it('highlights matches with sequential mark ids, inserting the matched text', () => {
    const html = escapeTextHtml('foo bar foo');
    const marked = markSearch(html, 'foo');
    expect(marked).toBe('<mark id="resp-hit-0" class="resp-hit">foo</mark> bar <mark id="resp-hit-1" class="resp-hit">foo</mark>');
  });

  it('highlights whole words only when requested', () => {
    const marked = markSearch(escapeTextHtml('quickly quick'), 'quick', { wholeWord: true });
    expect(marked).toBe('quickly <mark id="resp-hit-0" class="resp-hit">quick</mark>');
  });
});

describe('renderer response serialization helpers', () => {
  it('fullResponseJson includes status, headers, cookies, timing and body', () => {
    const j = JSON.parse(fullResponseJson(resp()));
    expect(j.status).toBe(201);
    expect(j.headers).toHaveLength(2);
    expect(j.cookies[0].name).toBe('sid');
    expect(j.timing.totalMs).toBe(42);
    expect(j.bodyText).toContain('ada');
  });

  it('bodyExport pretty prints and derives a filename from the request URL', () => {
    const e = bodyExport(resp());
    expect(e.name).toBe('response-api-x-test-201.json');
    expect(e.mime).toBe('application/json');
    expect(JSON.parse(e.content).items).toEqual([1, 2, 3]);
  });
});
