/**
 * cURL generator (§48) — produces robust, shell-safe commands including
 * multipart, auth, SOAP, GraphQL bodies.
 */
import type { ApiRequest, KeyValue } from '../../shared/types';
import { buildUrl } from '../url/urlBuilder';

function shq(s: string): string {
  // single-quote escaping for POSIX shells; on Windows users use git-bash/WSL
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface CurlGenOptions {
  request: ApiRequest;
  finalHeaders?: KeyValue[];
  finalUrl?: string;
  /** body already materialized (file fields can't be inlined, referenced instead) */
  pretty?: boolean;
}

export function generateCurl(opts: CurlGenOptions): string {
  const { request } = opts;
  const url = opts.finalUrl ?? buildUrl(request.url, request.queryParams ?? []);
  const headers = opts.finalHeaders ?? (request.headers ?? []).filter((h) => h.enabled);
  const parts: string[] = [`curl -X ${request.method.toUpperCase()} ${shq(url)}`];
  const sep = opts.pretty ? ' \\\n  ' : ' ';

  const body = request.body ?? { type: 'none' };
  let bodyHandled = false;

  for (const h of headers) {
    if (!h.key) continue;
    parts.push(`-H ${shq(`${h.key}: ${h.value}`)}`);
  }

  const auth = request.auth;
  if (auth?.type === 'basic' && auth.basic) {
    parts.push(`-u ${shq(`${auth.basic.username}:${auth.basic.password}`)}`);
  } else if (auth?.type === 'bearer' && auth.bearer?.token) {
    parts.push(`-H ${shq(`Authorization: ${auth.bearer.prefix ?? 'Bearer'} ${auth.bearer.token}`)}`);
  } else if (auth?.type === 'digest') {
    parts.push('--digest');
    if (auth.digest) parts.push(`-u ${shq(`${auth.digest.username}:${auth.digest.password}`)}`);
  }

  switch (body.type) {
    case 'json': case 'xml': case 'html': case 'javascript': case 'text': {
      if (body.raw) { parts.push(`-d ${shq(body.raw)}`); bodyHandled = true; }
      break;
    }
    case 'graphql': {
      const payload = JSON.stringify({ query: body.graphql?.query ?? '', variables: tryParse(body.graphql?.variables ?? '') ?? undefined });
      parts.push(`-H ${shq('Content-Type: application/json')}`);
      parts.push(`-d ${shq(payload)}`);
      bodyHandled = true;
      break;
    }
    case 'urlencoded': {
      const data = (body.urlencoded ?? []).filter((p) => p.enabled && p.key)
        .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
      if (data) { parts.push(`-d ${shq(data)}`); bodyHandled = true; }
      break;
    }
    case 'form-data': {
      for (const f of body.formData ?? []) {
        if (!f.enabled || !f.key) continue;
        if (f.fieldType === 'file' && (f.filePath || f.value)) {
          let spec = `${f.key}=@${f.filePath ?? f.value}`;
          if (f.mimeType) spec += `;type=${f.mimeType}`;
          if (f.fileName) spec += `;filename=${f.fileName}`;
          parts.push(`-F ${shq(spec)}`);
        } else {
          parts.push(`-F ${shq(`${f.key}=${f.value}`)}`);
        }
      }
      bodyHandled = true;
      break;
    }
    case 'binary': case 'file': {
      if (body.binaryFilePath) { parts.push(`--data-binary ${shq('@' + body.binaryFilePath)}`); bodyHandled = true; }
      break;
    }
    default: break;
  }
  void bodyHandled;

  const s = request.settings;
  if (s) {
    if (s.followRedirects) parts.push('-L');
    if (s.verifyTls === false) parts.push('-k');
    if (s.timeoutMs && s.timeoutMs !== 30000) parts.push(`-m ${Math.ceil(s.timeoutMs / 1000)}`);
    if (s.httpVersion === 'http2') parts.push('--http2');
    if (s.httpVersion === 'http1') parts.push('--http1.1');
  }
  if (request.protocol === 'soap' && request.protocolData?.soap?.action) {
    parts.push(`-H ${shq(`SOAPAction: ${request.protocolData.soap.action}`)}`);
  }
  return parts.join(sep);
}

function tryParse(t: string): unknown {
  try { return JSON.parse(t); } catch { return undefined; }
}
