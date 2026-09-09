/**
 * cURL command parser (§47). Handles line continuations, quoting, env-style
 * line breaks, all common flags including multipart, auth, TLS, proxy,
 * compressed, custom methods, and SOAP detection.
 */
import type { ApiRequest, FormDataField, KeyValue } from '../../shared/types';
import { kv } from '../url/urlBuilder';
import { uid } from '../../shared/ids';

export interface ParsedCurl {
  request: Partial<ApiRequest>;
  warnings: string[];
}

interface CurlFlags {
  method?: string;
  url?: string;
  headers: KeyValue[];
  dataParts: { value: string; kind: 'raw' | 'binary' | 'ascii' | 'urlencode' }[];
  form: { spec: string }[];
  user?: string;
  cookie?: string;
  userAgent?: string;
  referer?: string;
  insecure?: boolean;
  compressed?: boolean;
  location?: boolean;
  maxTime?: number;
  proxy?: string;
  proxyUser?: string;
  cert?: string;
  key?: string;
  cacert?: string;
  http2?: boolean;
  http3?: boolean;
  requestTarget?: string;
  warnings: string[];
}

/** Tokenize a shell command string honoring quotes, escapes, line continuations. */
export function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  const text = input.replace(/\r\n/g, '\n');
  let cur = '';
  let started = false;
  let inSingle = false, inDouble = false, escaped = false;
  const push = () => { if (started || cur.length > 0) { tokens.push(cur); cur = ''; started = false; } };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escaped) { cur += c; started = true; escaped = false; continue; }
    if (c === '\\' && !inSingle) {
      const next = text[i + 1] ?? '';
      if (next === '\n') { i++; continue; } // line continuation (removed entirely)
      if (!inDouble || next === '"' || next === '\\') { escaped = true; continue; }
      cur += c; started = true; continue;
    }
    if (c === "'" && !inDouble) { inSingle = !inSingle; started = true; continue; }
    if (c === '"' && !inSingle) { inDouble = !inDouble; started = true; continue; }
    if ((c === ' ' || c === '\t') && !inSingle && !inDouble) { push(); continue; }
    if (c === '\n' && !inSingle && !inDouble) { push(); continue; }
    cur += c; started = true;
  }
  push();
  return tokens;
}

const VALUE_FLAGS = new Set([
  '--request', '-X', '--header', '-H', '--data', '-d', '--data-raw', '--data-binary', '--data-ascii',
  '--data-urlencode', '--form', '-F', '--form-string', '--user', '-u', '--cookie', '-b', '--cookie-jar', '-c',
  '--user-agent', '-A', '--referer', '-e', '--max-time', '-m', '--connect-timeout', '--proxy', '-x',
  '--proxy-user', '-U', '--cert', '-E', '--key', '--cacert', '--capath', '--resolve', '--header@',
  '--request-target', '--oauth2-bearer', '--aws-sigv4', '--retry', '--retry-delay', '--limit-rate',
  '--output', '-o', '--upload-file', '-T', '--user-pass', '--digest-user', '--negotiate-user', '--ntlm-user',
  '--url', '--proto-redir', '--ciphers', '--tls-max', '--curves', '--expect100-timeout', '--happy-eyeballs-timeout-ms',
]);

const BOOL_FLAGS = new Set([
  '--include', '-i', '--verbose', '-v', '--silent', '-s', '--show-error', '-S', '--head', '-I',
  '--compressed', '-k', '--insecure', '--location', '-L', '--location-trusted', '--ipv4', '-4', '--ipv6', '-6',
  '--http1.0', '--http1.1', '--http2', '--http2-prior-knowledge', '--http3', '--http3-only', '--fail', '-f',
  '--digest', '--negotiate', '--ntlm', '--anyauth', '--basic', '--globoff', '-g', '--get', '-G',
  '--junk-session-cookies', '-j', '--keepalive', '--no-buffer', '-N', '--path-as-is', '--raw', '--remote-time', '-R',
  '--ssl', '--ssl-reqd', '--tcp-fastopen', '--tcp-nodelay', '--tr-encoding', '--use-ascii', '-B',
]);

/** Long-flag aliases */
const ALIASES: Record<string, string> = {
  '-X': '--request', '-H': '--header', '-d': '--data', '-F': '--form', '-u': '--user',
  '-b': '--cookie', '-A': '--user-agent', '-e': '--referer', '-m': '--max-time',
  '-x': '--proxy', '-U': '--proxy-user', '-E': '--cert', '-o': '--output', '-T': '--upload-file',
  '-k': '--insecure', '-L': '--location', '-I': '--head', '-G': '--get', '--form-string': '--form',
};

export function parseCurl(command: string): ParsedCurl {
  const warnings: string[] = [];
  let tokens = tokenizeShell(command.replace(/\r\n/g, '\n'));
  // Drop everything before "curl" if pasted with a prefix
  const curlIdx = tokens.findIndex((t) => /(^|\/)curl(\.exe)?$/.test(t));
  if (curlIdx > 0) tokens = tokens.slice(curlIdx);
  else if (curlIdx === -1 && tokens.length > 0 && !tokens[0].startsWith('-')) {
    warnings.push('Input does not start with a curl command; attempting best-effort parse.');
  } else if (curlIdx === 0) {
    tokens = tokens.slice(1);
  }

  const flags: CurlFlags = { headers: [], dataParts: [], form: [], warnings };
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i];
    // --flag=value form
    let inlineValue: string | undefined;
    const eqIdx = tok.indexOf('=');
    if (tok.startsWith('--') && eqIdx !== -1) {
      inlineValue = tok.slice(eqIdx + 1);
      tok = tok.slice(0, eqIdx);
    }
    tok = ALIASES[tok] ?? tok;
    const takeValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      if (i + 1 < tokens.length) return tokens[++i];
      warnings.push(`Flag ${tok} is missing a value.`);
      return undefined;
    };
    if (!VALUE_FLAGS.has(tok) && !BOOL_FLAGS.has(tok) && !tok.startsWith('-')) {
      positional.push(tok);
      continue;
    }
    switch (tok) {
      case '--request': flags.method = takeValue()?.toUpperCase(); break;
      case '--url': flags.url = takeValue(); break;
      case '--request-target': flags.requestTarget = takeValue(); break;
      case '--header': {
        const v = takeValue();
        if (v !== undefined) {
          const idx = v.indexOf(':');
          if (idx === -1) flags.headers.push(kv(v.trim(), ''));
          else {
            const key = v.slice(0, idx).trim();
            let value = v.slice(idx + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            flags.headers.push(kv(key, value));
          }
        }
        break;
      }
      case '--data': case '--data-raw': flags.dataParts.push({ value: takeValue() ?? '', kind: 'raw' }); break;
      case '--data-binary': flags.dataParts.push({ value: takeValue() ?? '', kind: 'binary' }); break;
      case '--data-ascii': flags.dataParts.push({ value: takeValue() ?? '', kind: 'ascii' }); break;
      case '--data-urlencode': flags.dataParts.push({ value: takeValue() ?? '', kind: 'urlencode' }); break;
      case '--form': { const v = takeValue(); if (v !== undefined) flags.form.push({ spec: v }); break; }
      case '--user': flags.user = takeValue(); break;
      case '--cookie': flags.cookie = takeValue(); break;
      case '--user-agent': flags.userAgent = takeValue(); break;
      case '--referer': flags.referer = takeValue(); break;
      case '--insecure': flags.insecure = true; break;
      case '--compressed': flags.compressed = true; break;
      case '--location': case '--location-trusted': flags.location = true; break;
      case '--http2': flags.http2 = true; break;
      case '--http3': case '--http3-only': flags.http3 = true; warnings.push('HTTP/3 requested; engine will negotiate best available version.'); break;
      case '--head': flags.method = 'HEAD'; break;
      case '--get': warnings.push('cURL -G (GET with data) not fully supported; data treated as body.'); flags.method = flags.method ?? 'GET'; break;
      case '--max-time': case '--connect-timeout': { const v = takeValue(); if (v) flags.maxTime = parseFloat(v); break; }
      case '--proxy': flags.proxy = takeValue(); break;
      case '--proxy-user': flags.proxyUser = takeValue(); break;
      case '--cert': flags.cert = takeValue(); break;
      case '--key': flags.key = takeValue(); break;
      case '--cacert': flags.cacert = takeValue(); break;
      case '--resolve': case '--ciphers': case '--tls-max': case '--curves': case '--retry': case '--retry-delay':
      case '--limit-rate': case '--output': case '--expect100-timeout': case '--happy-eyeballs-timeout-ms':
      case '--user-pass': case '--digest-user': case '--negotiate-user': case '--ntlm-user':
      case '--proto-redir': case '--capath': case '--cookie-jar': {
        takeValue();
        warnings.push(`Flag ${tok} parsed but not applied by API Manager.`);
        break;
      }
      case '--oauth2-bearer': {
        const v = takeValue();
        if (v) flags.headers.push(kv('Authorization', `Bearer ${v}`));
        break;
      }
      case '--aws-sigv4': {
        const v = takeValue();
        warnings.push(`cURL --aws-sigv4 (${v ?? 'default'}) detected; configure AWS SigV4 auth manually.`);
        break;
      }
      case '--digest': warnings.push('Digest auth flag parsed; configure Digest Auth in the Auth tab.'); break;
      case '--ntlm': warnings.push('NTLM flag parsed; configure NTLM auth in the Auth tab.'); break;
      case '--negotiate': warnings.push('Negotiate auth is not supported; flag ignored.'); break;
      case '--basic': break;
      default: {
        if (BOOL_FLAGS.has(tok)) break;
        if (tok.startsWith('-')) warnings.push(`Unknown flag ${tok} ignored.`);
      }
    }
  }

  // URL: last positional (curl takes the URL as the final bare argument; --url wins)
  const url = flags.url ?? positional.pop() ?? '';
  if (!url) warnings.push('No URL found in cURL command.');
  if (positional.length > 0) warnings.push(`Ignored extra arguments: ${positional.join(' ')}`);

  // Merge headers: cookie/UA/referer become headers if not already set
  const headers = [...flags.headers];
  const hasHeader = (name: string) => headers.some((h) => h.key.toLowerCase() === name.toLowerCase());
  if (flags.cookie && !hasHeader('Cookie')) headers.push(kv('Cookie', flags.cookie));
  if (flags.userAgent && !hasHeader('User-Agent')) headers.push(kv('User-Agent', flags.userAgent));
  if (flags.referer && !hasHeader('Referer')) headers.push(kv('Referer', flags.referer));
  if (flags.compressed && !hasHeader('Accept-Encoding')) headers.push(kv('Accept-Encoding', 'gzip, deflate, br'));

  // Body
  let body: ApiRequest['body'] | undefined;
  const contentTypeHeader = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  if (flags.form.length > 0) {
    const formData: FormDataField[] = [];
    for (const { spec } of flags.form) {
      const idx = spec.indexOf('=');
      if (idx === -1) { formData.push({ ...kv(spec, ''), fieldType: 'text' }); continue; }
      const name = spec.slice(0, idx);
      let value = spec.slice(idx + 1);
      const field: FormDataField = { ...kv(name, ''), fieldType: 'text' };
      // curl supports ;type= and ;filename=
      const semi = value.indexOf(';');
      if (semi !== -1) {
        const extras = value.slice(semi + 1);
        value = value.slice(0, semi);
        for (const part of extras.split(';')) {
          const [k, v] = part.split('=');
          if (k?.trim() === 'type') field.mimeType = v;
          if (k?.trim() === 'filename') field.fileName = v;
        }
      }
      if (value.startsWith('@')) {
        field.fieldType = 'file';
        field.filePath = value.slice(1);
        field.value = value.slice(1);
      } else if (value.startsWith('<')) {
        field.fieldType = 'file';
        field.filePath = value.slice(1);
        field.value = value.slice(1);
        warnings.push(`Form field "${name}" uses <file (inline file content); imported as file reference.`);
      } else {
        field.value = value;
      }
      formData.push(field);
    }
    body = { type: 'form-data', formData };
  } else if (flags.dataParts.length > 0) {
    const combined = flags.dataParts.map((p) => p.value).join('&');
    // urlencoded?
    const allUrlEncode = flags.dataParts.every((p) => p.kind === 'urlencode');
    const ct = contentTypeHeader.toLowerCase();
    if (allUrlEncode || ct.includes('application/x-www-form-urlencoded') || (!ct && flags.dataParts.every((p) => /^[^=&]*=[^&]*$/.test(p.value)))) {
      const urlencoded = combined.split('&').filter(Boolean).map((pair) => {
        const idx = pair.indexOf('=');
        return idx === -1 ? kv(pair, '') : kv(pair.slice(0, idx), pair.slice(idx + 1));
      });
      body = { type: 'urlencoded', urlencoded };
    } else {
      const lower = combined.trimStart();
      let type: 'json' | 'xml' | 'javascript' | 'html' | 'text' = 'text';
      if (ct.includes('json') || lower.startsWith('{') || lower.startsWith('[')) type = 'json';
      else if (ct.includes('xml') || ct.includes('soap') || lower.startsWith('<')) type = 'xml';
      else if (ct.includes('html')) type = 'html';
      else if (ct.includes('javascript')) type = 'javascript';
      // @file means binary upload
      if (combined.startsWith('@')) {
        body = { type: 'binary', binaryFilePath: combined.slice(1) };
      } else {
        body = { type, raw: combined };
      }
    }
  }

  // Method inference
  let method = flags.method;
  if (!method) {
    if (flags.dataParts.length > 0 || flags.form.length > 0) method = 'POST';
    else method = 'GET';
  }

  // Auth
  let auth: ApiRequest['auth'] | undefined;
  if (flags.user) {
    const idx = flags.user.indexOf(':');
    auth = {
      type: 'basic',
      basic: { username: idx === -1 ? flags.user : flags.user.slice(0, idx), password: idx === -1 ? '' : flags.user.slice(idx + 1) },
    };
  }

  // SOAP detection (§47): content-type soap+xml / text/xml + envelope
  const rawBodyText = body?.raw ?? '';
  const looksSoap =
    /text\/xml|application\/soap\+xml/.test(contentTypeHeader.toLowerCase()) ||
    (rawBodyText.includes('Envelope') && /soap(env)?:/.test(rawBodyText)) ||
    headers.some((h) => h.key.toLowerCase() === 'soapaction');
  const protocol = looksSoap ? 'soap' : contentTypeHeader.toLowerCase().includes('graphql') || rawBodyText.trimStart().startsWith('query ') || rawBodyText.includes('"query"') && rawBodyText.includes('{') ? 'graphql' : 'http';
  if (looksSoap) warnings.push('SOAP-style request detected; protocol set to SOAP.');

  // Settings
  const settings: Partial<ApiRequest['settings']> = {};
  if (flags.insecure) settings.verifyTls = false;
  if (flags.location !== undefined) settings.followRedirects = flags.location;
  if (flags.maxTime) settings.timeoutMs = flags.maxTime * 1000;
  if (flags.http2) settings.httpVersion = 'http2';

  const request: Partial<ApiRequest> = {
    id: uid(),
    name: deriveName(url, method),
    method,
    url,
    headers,
    body: body ?? { type: 'none' },
    auth: auth ?? { type: 'none' },
    protocol: protocol as ApiRequest['protocol'],
    settings: settings as ApiRequest['settings'],
    protocolData: looksSoap ? { soap: { version: contentTypeHeader.includes('soap+xml') ? '1.2' : '1.1' } } : undefined,
  };

  return { request, warnings };
}

function deriveName(url: string, method: string): string {
  try {
    const u = new URL(url);
    return `${method} ${u.pathname === '/' ? u.host : u.pathname}`;
  } catch {
    return `${method} ${url || 'request'}`;
  }
}

/** Detect whether a pasted string is probably a cURL command. */
export function looksLikeCurl(text: string): boolean {
  const t = text.trim();
  return /(^|\s)curl(\.exe)?\s/.test(t) || t.startsWith('curl ');
}
