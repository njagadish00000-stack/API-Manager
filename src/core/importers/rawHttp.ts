/** Raw HTTP message parser (§46): "raw HTTP" text → request. */
import { emptyImport, freshRequest, NormalizedImport } from './model';

export function looksLikeRawHttp(text: string): boolean {
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+\S+\s+HTTP\/\d/i.test(text.trimStart());
}

export function importRawHttp(text: string, workspaceId: string): NormalizedImport {
  const out = emptyImport('raw-http');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const m = /^(\S+)\s+(\S+)(?:\s+HTTP\/([\d.]+))?/i.exec(firstLine);
  if (!m) { out.report.warnings.push('Not a raw HTTP request'); return out; }
  const [, methodPhys, target, version] = m;
  const headers: { key: string; value: string }[] = [];
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') { i++; break; }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    headers.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  const body = lines.slice(i).join('\n').trim();
  const host = headers.find((h) => h.key.toLowerCase() === 'host')?.value ?? 'localhost';
  const url = target.startsWith('http') ? target : `http://${host}${target.startsWith('/') ? '' : '/'}${target}`;
  const req = freshRequest(workspaceId, `${methodPhys} ${target}`, undefined, undefined);
  req.workspaceId = workspaceId;
  req.method = methodPhys.toUpperCase();
  req.url = url;
  req.headers = headers.filter((h) => h.key.toLowerCase() !== 'host' && h.key.toLowerCase() !== 'content-length')
    .map((h) => ({ id: crypto.randomUUID(), key: h.key, value: h.value, enabled: true }));
  const ct = req.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  if (body) {
    req.body = {
      type: ct.includes('json') ? 'json' : ct.includes('xml') || ct.includes('soap') ? 'xml' : ct.includes('x-www-form-urlencoded') ? 'urlencoded' : 'text',
      raw: body,
    };
    if (req.body.type === 'urlencoded') {
      req.body.urlencoded = body.split('&').map((pair) => {
        const idx = pair.indexOf('=');
        return { id: crypto.randomUUID(), key: idx === -1 ? pair : pair.slice(0, idx), value: idx === -1 ? '' : decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' ')), enabled: true };
      });
      delete req.body.raw;
    }
  }
  if (version === '2' || version === '2.0') req.settings.httpVersion = 'http2';
  out.requests.push(req);
  out.report.imported.push({ kind: 'request', name: req.name, id: req.id });
  return out;
}
