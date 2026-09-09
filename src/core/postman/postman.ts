/**
 * Postman compatibility engine (§82): collection v2.1, environment, globals,
 * data dumps — import AND export. Independently tested (tests/unit/postman).
 */
import type {
  ApiRequest, AuthConfig, BodyType, Collection, Environment, KeyValue, RequestExample, Variable,
} from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { kv } from '../url/urlBuilder';
import { emptyImport, freshCollection, freshFolder, freshRequest, NormalizedImport } from '../importers/model';
import { scanTextForSecrets } from '../secrets/scanner';

// Reuse loose structural types so we can accept real-world Postman files.
/* eslint-disable @typescript-eslint/no-explicit-any */
type P = Record<string, any>;

export const POSTMAN_SCHEMA_210 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

export function detectPostman(parsed: unknown): 'collection' | 'environment' | 'globals' | 'dump' | null {
  const p = parsed as P;
  if (!p || typeof p !== 'object') return null;
  if (p.info?.schema?.includes('getpostman.com') || (p.info?.name && Array.isArray(p.item))) return 'collection';
  if (Array.isArray(p.values) && p.name && p._postman_variable_scope === 'globals') return 'globals';
  if (Array.isArray(p.values) && p.values.every((v: P) => typeof v === 'object' && 'key' in v)) return 'environment';
  if (p.collections && Array.isArray(p.collections)) return 'dump';
  return null;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function importPostmanCollection(json: string, workspaceId: string): NormalizedImport {
  const out = emptyImport('postman-collection');
  let parsed: P;
  try { parsed = JSON.parse(json); } catch (e) {
    out.report.warnings.push(`Invalid JSON: ${e instanceof Error ? e.message : e}`);
    return out;
  }

  const collection = freshCollection(workspaceId, parsed.info?.name ?? 'Imported Collection');
  collection.description = parsed.info?.description?.content ?? parsed.info?.description ?? '';
  if (parsed.info?.schema && !parsed.info.schema.includes('v2.1')) {
    out.report.warnings.push(`Collection schema ${parsed.info.schema} is not v2.1.0; importing in compatibility mode.`);
  }
  collection.variables = (parsed.variable ?? []).map(postmanVar);
  const folders: ReturnType<typeof freshFolder>[] = [];
  const requests: ApiRequest[] = [];
  const examples: RequestExample[] = [];

  const walk = (items: P[], folderId: string | undefined, folderName?: string) => {
    for (const item of items ?? []) {
      if (item.item && Array.isArray(item.item)) {
        const folder = freshFolder(collection.id, item.name ?? 'Folder', folderId);
        folder.description = item.description?.content ?? item.description ?? '';
        folder.auth = importAuth(item.auth, out.report, `folder ${item.name}`);
        folder.scripts = importEvents(item.event);
        folders.push(folder);
        walk(item.item, folder.id, item.name);
      } else if (item.request) {
        const req = importItem(item, collection.id, folderId, workspaceId, out.report);
        requests.push(req);
        for (const ex of postmanExamples(item, req)) examples.push(ex);
        out.report.converted.push({ kind: 'request', name: item.name ?? req.name, note: folderName ? `in folder ${folderName}` : undefined });
      }
    }
  };
  walk(parsed.item ?? [], undefined);
  if (parsed.auth) collection.auth = importAuth(parsed.auth, out.report, 'collection');
  const ev = importEvents(parsed.event);
  if (ev.preRequest) collection.scripts.preRequest = ev.preRequest;
  if (ev.postResponse) collection.scripts.postResponse = ev.postResponse;
  if (ev.preRequest || ev.postResponse) {
    out.report.scriptsRequiringReview.push({ location: `collection ${collection.name}`, reason: 'Collection-level scripts imported; review for Postman cloud API usage.' });
  }

  collection.sortOrder = 0;
  out.collections.push({ collection, folders, requests, examples });
  out.report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  detectSecretsInCollection(parsed, out);
  out.report.finishedAt = now();
  return out;
}

function importItem(item: P, collectionId: string, folderId: string | undefined, workspaceId: string, report: ReturnType<typeof emptyImport>['report']): ApiRequest {
  const pr = item.request;
  const req: ApiRequest = freshRequest(workspaceId, item.name ?? 'Request', collectionId, folderId);
  if (typeof pr === 'string') {
    req.method = 'GET';
    req.url = pr;
    report.warnings.push(`Request "${item.name}": request was a bare URL string; defaulted to GET.`);
    return req;
  }
  req.description = pr.description?.content ?? pr.description ?? item.description?.content ?? item.description ?? '';
  req.method = (pr.method ?? 'GET').toUpperCase();
  // URL
  const url = pr.url;
  if (typeof url === 'string') {
    req.url = url;
  } else if (url && typeof url === 'object') {
    req.url = buildUrlFromPostman(url);
    req.queryParams = (url.query ?? []).map((q: P): KeyValue => ({
      id: uid(), key: q.key ?? '', value: q.value ?? '', enabled: !q.disabled, description: q.description,
    }));
    req.pathParams = (url.variable ?? []).map((q: P): KeyValue => ({
      id: uid(), key: q.key ?? '', value: q.value ?? '', enabled: true, description: q.description,
    }));
  }
  req.headers = (pr.header ?? []).map((h: P): KeyValue => ({
    id: uid(), key: h.key ?? '', value: h.value ?? '', enabled: !h.disabled, description: h.description,
  }));
  req.auth = importAuth(pr.auth, report, item.name);
  req.body = importBody(pr.body, item.name, report, req);
  const ev = importEvents(item.event);
  req.scripts = { preRequest: ev.preRequest, postResponse: ev.postResponse };
  for (const e of item.event ?? []) {
    if (e.listen !== 'prerequest' && e.listen !== 'test') {
      report.unsupported.push({ kind: 'event', name: `${item.name}:${e.listen}`, detail: 'Only prerequest/test events are supported' });
    }
  }
  if (ev.preRequest || ev.postResponse) {
    report.scriptsRequiringReview.push({ location: `request ${item.name}`, reason: 'Scripts imported verbatim; sandboxed pm.* compatibility applied.' });
  }
  if (pr.url?.protocol) {
    // url already kept as raw when possible
  }
  if (pr.description && typeof pr.description === 'object' && pr.description.format === 'markdown') {
    req.documentation = pr.description.content;
  }
  // protocolprofilebehavior
  const ppb = item.protocolProfileBehavior ?? {};
  if (ppb.followRedirects !== undefined) req.settings.followRedirects = !!ppb.followRedirects;
  if (ppb.maxRedirects) req.settings.maxRedirects = Number(ppb.maxRedirects) || 10;
  if (ppb.disableBodyPruning !== undefined || ppb.disableUrlEncoding !== undefined) {
    report.converted.push({ kind: 'setting', name: `${item.name} protocolProfileBehavior`, note: 'partially mapped to request settings' });
  }
  return req;
}

function buildUrlFromPostman(url: P): string {
  if (url.raw) return url.raw;
  let out = '';
  if (url.protocol) out += `${url.protocol}://`;
  else out += '{{baseUrl}}';
  if (!url.protocol && Array.isArray(url.host)) out = '';
  if (Array.isArray(url.host)) out += out ? url.host.join('.') : '{{baseUrl}}';
  if (url.port) out += `:${url.port}`;
  if (Array.isArray(url.path)) out += `/${url.path.join('/')}`;
  else if (typeof url.path === 'string') out += url.path.startsWith('/') ? url.path : `/${url.path}`;
  if (out === '') out = url.raw ?? '';
  return out;
}

function importAuth(auth: P | undefined, report: NormalizedImport['report'], owner?: string): AuthConfig {
  if (!auth || !auth.type) return { type: 'inherit' };
  const get = (arr: P[] | undefined, k: string) => arr?.find((x) => x.key === k)?.value;
  const type = auth.type.toLowerCase();
  switch (type) {
    case 'noauth': return { type: 'none' };
    case 'inherit': return { type: 'inherit' };
    case 'basic': return { type: 'basic', basic: { username: get(auth.basic, 'username') ?? '', password: get(auth.basic, 'password') ?? '' } };
    case 'bearer': return { type: 'bearer', bearer: { token: get(auth.bearer, 'token') ?? '' } };
    case 'apikey': return { type: 'apikey', apikey: { key: get(auth.apikey, 'key') ?? '', value: get(auth.apikey, 'value') ?? '', addTo: get(auth.apikey, 'in') === 'query' ? 'query' : 'header' } };
    case 'digest': return { type: 'digest', digest: { username: get(auth.digest, 'username') ?? '', password: get(auth.digest, 'password') ?? '' } };
    case 'oauth1': return {
      type: 'oauth1',
      oauth1: {
        consumerKey: get(auth.oauth1, 'consumerKey') ?? '', consumerSecret: get(auth.oauth1, 'consumerSecret') ?? '',
        token: get(auth.oauth1, 'token'), tokenSecret: get(auth.oauth1, 'tokenSecret'),
        signatureMethod: (get(auth.oauth1, 'signatureMethod') ?? 'HMAC-SHA1'),
        callback: get(auth.oauth1, 'callback'), verifier: get(auth.oauth1, 'verifier'),
        realm: get(auth.oauth1, 'realm'), timestamp: get(auth.oauth1, 'timestamp'), nonce: get(auth.oauth1, 'nonce'),
        version: get(auth.oauth1, 'version'), addTo: get(auth.oauth1, 'addParamsToHeader') === false ? 'query' : 'header',
      },
    };
    case 'oauth2': {
      // Postman stores tokens under oauth2.accessToken (plus advanced fields)
      return {
        type: 'oauth2',
        oauth2: {
          grantType: 'authorization_code',
          accessToken: auth.oauth2?.accessToken ?? get(auth.oauth2, 'accessToken') ?? '',
          tokenType: 'Bearer', headerPrefix: get(auth.oauth2, 'headerPrefix') ?? 'Bearer',
          addTo: get(auth.oauth2, 'addTokenTo') === 'queryParams' ? 'query' : 'header',
        },
      };
    }
    case 'awsv4': return { type: 'aws4', aws4: { accessKey: get(auth.awsv4, 'accessKey') ?? '', secretKey: get(auth.awsv4, 'secretKey') ?? '', sessionToken: get(auth.awsv4, 'sessionToken'), region: get(auth.awsv4, 'region') ?? '', service: get(auth.awsv4, 'service') ?? '' } };
    case 'hawk': return {
      type: 'hawk',
      hawk: { authId: get(auth.hawk, 'authId') ?? '', authKey: get(auth.hawk, 'authKey') ?? '', algorithm: get(auth.hawk, 'algorithm') ?? 'sha256', nonce: get(auth.hawk, 'nonce'), ext: get(auth.hawk, 'extraData'), app: get(auth.hawk, 'app'), dlg: get(auth.hawk, 'delegation'), timestamp: get(auth.hawk, 'timestamp') },
    };
    case 'ntlm': return { type: 'ntlm', ntlm: { username: get(auth.ntlm, 'username') ?? '', password: get(auth.ntlm, 'password') ?? '', domain: get(auth.ntlm, 'domain'), workstation: get(auth.ntlm, 'workstation') } };
    case 'edgegrid':
      report.unsupported.push({ kind: 'auth', name: `edgegrid${owner ? ` (${owner})` : ''}`, detail: 'Akamai EdgeGrid auth is not supported' });
      return { type: 'none' };
    default:
      report.unsupported.push({ kind: 'auth', name: `${type}${owner ? ` (${owner})` : ''}`, detail: 'Unknown Postman auth type' });
      return { type: 'none' };
  }
}

function importBody(body: P | undefined, name: string, report: NormalizedImport['report'], req: ApiRequest): ApiRequest['body'] {
  if (!body || !body.mode) return { type: 'none' };
  const mode = body.mode;
  if (mode === 'raw') {
    const lang = body.options?.raw?.language ?? '';
    const raw = body.raw ?? '';
    let type: BodyType = 'text';
    if (lang === 'json') type = 'json';
    else if (lang === 'xml') type = 'xml';
    else if (lang === 'html') type = 'html';
    else if (lang === 'javascript') type = 'javascript';
    else if (lang === 'text') type = 'text';
    else if (raw.trimStart().startsWith('{') || raw.trimStart().startsWith('[')) type = 'json';
    return { type, raw };
  }
  if (mode === 'urlencoded') {
    return { type: 'urlencoded', urlencoded: (body.urlencoded ?? []).map((p: P): KeyValue => ({ id: uid(), key: p.key ?? '', value: p.value ?? '', enabled: !p.disabled, description: p.description })) };
  }
  if (mode === 'formdata') {
    return {
      type: 'form-data',
      formData: (body.formdata ?? []).map((p: P) => {
        const field: import('../../shared/types').FormDataField = { id: uid(), key: p.key ?? '', value: p.type === 'file' ? (Array.isArray(p.src) ? p.src[0] ?? '' : p.src ?? '') : p.value ?? '', enabled: !p.disabled, description: p.description, fieldType: (p.type === 'file' ? 'file' : 'text') as 'file' | 'text', mimeType: p.contentType };
        if (p.type === 'file') {
          field.filePath = Array.isArray(p.src) ? p.src[0] : p.src;
          if (Array.isArray(p.src) && p.src.length > 1) field.filePaths = p.src;
        }
        return field;
      }),
    };
  }
  if (mode === 'file') {
    return { type: 'binary', binaryFilePath: body.file?.src ?? '' };
  }
  if (mode === 'graphql') {
    req.protocol = 'graphql';
    return { type: 'graphql', graphql: { query: body.graphql?.query ?? '', variables: typeof body.graphql?.variables === 'string' ? body.graphql.variables : JSON.stringify(body.graphql?.variables ?? {}) } };
  }
  report.unsupported.push({ kind: 'body', name: `${name}:${mode}`, detail: `Body mode "${mode}" is not supported` });
  return { type: 'none' };
}

function importEvents(events: P[] | undefined): { preRequest: string; postResponse: string } {
  const out = { preRequest: '', postResponse: '' };
  for (const e of events ?? []) {
    const code = Array.isArray(e.script?.exec) ? e.script.exec.join('\n') : typeof e.script?.exec === 'string' ? e.script.exec : '';
    if (e.listen === 'prerequest') out.preRequest = code;
    if (e.listen === 'test') out.postResponse = code;
  }
  return out;
}

function postmanExamples(item: P, req: ApiRequest): RequestExample[] {
  const out: RequestExample[] = [];
  for (const r of item.response ?? []) {
    out.push({
      id: uid(), requestId: req.id, name: r.name ?? `${item.name} example`,
      description: '',
      request: { ...req },
      response: {
        id: uid(), status: r.code ?? 200, statusText: r.status ?? r.code?.toString() ?? 'OK',
        httpVersion: 'HTTP/1.1',
        headers: (r.header ?? []).map((h: P) => kv(h.key ?? '', h.value ?? '')),
        cookies: (r.cookie ?? []).map((c: P) => ({ name: c.name ?? '', value: c.value ?? '', domain: c.domain ?? '', path: c.path ?? '/', secure: false, httpOnly: !!c.httpOnly })),
        bodyText: r.body ?? '', bodyIsBinary: false, bodySize: (r.body ?? '').length,
        timing: { totalMs: 0 }, redirects: [], retryAttempts: [], timestamp: now(),
        contentType: (r.header ?? []).find((h: P) => h.key?.toLowerCase() === 'content-type')?.value,
      },
      createdAt: now(), updatedAt: now(),
    });
  }
  return out;
}

function postmanVar(v: P): Variable {
  return { id: uid(), key: v.key ?? '', value: v.value ?? '', initialValue: v.value, type: v.type === 'secret' ? 'secret' : 'default', enabled: !v.disabled, description: v.description };
}

function detectSecretsInCollection(parsed: P, out: NormalizedImport): void {
  const text = JSON.stringify(parsed.info ?? {}) + JSON.stringify(parsed.variable ?? []);
  const findings = scanTextForSecrets(text, `collection ${parsed.info?.name ?? ''}`);
  for (const f of findings) out.report.secretsDetected.push({ location: f.location, masked: f.snippet ?? '' });
}

export function importPostmanEnvironment(json: string, workspaceId: string): NormalizedImport {
  const out = emptyImport('postman-environment');
  let parsed: P;
  try { parsed = JSON.parse(json); } catch (e) {
    out.report.warnings.push(`Invalid JSON: ${e instanceof Error ? e.message : e}`);
    return out;
  }
  const env: Environment = {
    id: uid(), workspaceId, name: parsed.name ?? 'Imported Environment',
    variables: (parsed.values ?? []).map((v: P) => postmanVar(v) as Variable),
    sortOrder: 0, createdAt: now(), updatedAt: now(),
  };
  out.environments.push(env);
  out.report.imported.push({ kind: 'environment', name: env.name, id: env.id });
  out.report.finishedAt = now();
  return out;
}

export function importPostmanGlobals(json: string): NormalizedImport {
  const out = emptyImport('postman-globals');
  let parsed: P;
  try { parsed = JSON.parse(json); } catch (e) {
    out.report.warnings.push(`Invalid JSON: ${e instanceof Error ? e.message : e}`);
    return out;
  }
  out.globals = (parsed.values ?? []).map((v: P) => postmanVar(v) as Variable);
  out.report.imported.push({ kind: 'globals', name: 'Globals', id: 'globals' });
  out.report.finishedAt = now();
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportPostmanCollection(
  collection: Collection,
  folders: { id: string; name: string; parentFolderId?: string; collectionId: string; description?: string }[],
  requests: ApiRequest[],
  examples: RequestExample[],
): string {
  const items = buildItems(collection.id, folders, requests, examples, undefined);
  const base: P = {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      description: collection.description ?? '',
      schema: POSTMAN_SCHEMA_210,
    },
    item: items,
  };
  if (collection.variables.length > 0) {
    base.variable = collection.variables.map(exportVar);
  }
  if (collection.auth && collection.auth.type !== 'none') base.auth = exportAuth(collection.auth);
  const event = exportEvents(collection.scripts);
  if (event.length > 0) base.event = event;
  return JSON.stringify(base, null, 2);
}

function buildItems(
  collectionId: string,
  folders: { id: string; name: string; parentFolderId?: string; collectionId: string; description?: string }[],
  requests: ApiRequest[],
  examples: RequestExample[],
  parentFolderId: string | undefined,
): P[] {
  const items: P[] = [];
  const myFolders = folders.filter((f) => f.collectionId === collectionId && (f.parentFolderId ?? undefined) === parentFolderId);
  const myRequests = requests.filter((r) => r.collectionId === collectionId && (r.folderId ?? undefined) === parentFolderId);
  for (const f of [...myFolders].sort((a, b) => (a.name > b.name ? 1 : -1))) {
    items.push({
      name: f.name,
      description: f.description,
      item: buildItems(collectionId, folders, requests, examples, f.id),
    });
  }
  for (const r of myRequests.sort((a, b) => a.sortOrder - b.sortOrder)) {
    items.push(exportItem(r, examples.filter((e) => e.requestId === r.id)));
  }
  return items;
}

function exportItem(req: ApiRequest, examples: RequestExample[]): P {
  const item: P = {
    id: req.id,
    name: req.name,
    request: {
      method: req.method,
      header: req.headers.map((h) => ({ key: h.key, value: h.value, ...(h.enabled ? {} : { disabled: true }), ...(h.description ? { description: h.description } : {}) })),
      url: exportUrl(req),
      description: req.description,
    },
    response: examples.map(exportExample),
  };
  if (req.auth && req.auth.type !== 'none' && req.auth.type !== 'inherit') item.request.auth = exportAuth(req.auth);
  const body = exportBody(req.body);
  if (body) item.request.body = body;
  const event = exportEvents(req.scripts);
  if (event.length > 0) item.event = event;
  return item;
}

function exportUrl(req: ApiRequest): string | P {
  if (req.queryParams.length === 0 && req.pathParams.length === 0) return req.url;
  const u: P = { raw: req.url };
  try {
    const parsed = new URL(req.url.replace(/\{\{[^}]+\}\}/g, 'placeholder'));
    if (!req.url.includes('{{')) {
      u.protocol = parsed.protocol.replace(':', '');
      u.host = parsed.hostname.split('.');
      if (parsed.port) u.port = parsed.port;
      u.path = parsed.pathname.split('/').filter(Boolean);
    }
  } catch { /* keep raw only */ }
  if (req.queryParams.length > 0) {
    u.query = req.queryParams.map((q) => ({ key: q.key, value: q.value, ...(q.enabled ? {} : { disabled: true }) }));
  }
  if (req.pathParams.length > 0) u.variable = req.pathParams.map((q) => ({ key: q.key, value: q.value }));
  return u;
}

function exportBody(body: ApiRequest['body']): P | undefined {
  switch (body.type) {
    case 'none': return undefined;
    case 'json': return { mode: 'raw', raw: body.raw ?? '', options: { raw: { language: 'json' } } };
    case 'xml': return { mode: 'raw', raw: body.raw ?? '', options: { raw: { language: 'xml' } } };
    case 'html': return { mode: 'raw', raw: body.raw ?? '', options: { raw: { language: 'html' } } };
    case 'javascript': return { mode: 'raw', raw: body.raw ?? '', options: { raw: { language: 'javascript' } } };
    case 'text': return { mode: 'raw', raw: body.raw ?? '', options: { raw: { language: 'text' } } };
    case 'urlencoded': return { mode: 'urlencoded', urlencoded: body.urlencoded?.map((p) => ({ key: p.key, value: p.value, ...(p.enabled ? {} : { disabled: true }) })) ?? [] };
    case 'form-data': return { mode: 'formdata', formdata: body.formData?.map((p) => (p.fieldType === 'file' ? { key: p.key, type: 'file', src: p.filePath ?? p.value, contentType: p.mimeType, ...(p.enabled ? {} : { disabled: true }) } : { key: p.key, value: p.value, type: 'text', ...(p.enabled ? {} : { disabled: true }) })) ?? [] };
    case 'binary': case 'file': return { mode: 'file', file: { src: body.binaryFilePath ?? '' } };
    case 'graphql': return { mode: 'graphql', graphql: { query: body.graphql?.query ?? '', variables: safeJson(body.graphql?.variables) } };
    default: return undefined;
  }
}

function exportEvents(scripts: { preRequest: string; postResponse: string }): P[] {
  const out: P[] = [];
  if (scripts.preRequest?.trim()) out.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: scripts.preRequest.split('\n') } });
  if (scripts.postResponse?.trim()) out.push({ listen: 'test', script: { type: 'text/javascript', exec: scripts.postResponse.split('\n') } });
  return out;
}

function exportAuth(auth: AuthConfig): P {
  const kv2 = (values: Record<string, string | undefined>) => Object.entries(values).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value, type: 'string' }));
  switch (auth.type) {
    case 'basic': return { type: 'basic', basic: kv2({ username: auth.basic?.username, password: auth.basic?.password }) };
    case 'bearer': return { type: 'bearer', bearer: kv2({ token: auth.bearer?.token }) };
    case 'apikey': return { type: 'apikey', apikey: kv2({ key: auth.apikey?.key, value: auth.apikey?.value, in: auth.apikey?.addTo }) };
    case 'digest': return { type: 'digest', digest: kv2({ username: auth.digest?.username, password: auth.digest?.password }) };
    case 'aws4': return { type: 'awsv4', awsv4: kv2({ accessKey: auth.aws4?.accessKey, secretKey: auth.aws4?.secretKey, region: auth.aws4?.region, service: auth.aws4?.service, sessionToken: auth.aws4?.sessionToken }) };
    case 'hawk': return { type: 'hawk', hawk: kv2({ authId: auth.hawk?.authId, authKey: auth.hawk?.authKey, algorithm: auth.hawk?.algorithm }) };
    default: return { type: auth.type };
  }
}

function exportVar(v: Variable): P {
  return { key: v.key, value: v.value, ...(v.type === 'secret' ? { type: 'secret' } : { type: 'default' }), ...(v.enabled ? {} : { disabled: true }) };
}

function exportExample(ex: RequestExample): P {
  return {
    id: ex.id,
    name: ex.name,
    originalRequest: ex.request,
    response: ex.response
      ? {
          name: ex.name,
          originalRequest: ex.request,
          status: ex.response.statusText,
          code: ex.response.status,
          _postman_previewlanguage: 'json',
          header: ex.response.headers.map((h) => ({ key: h.key, value: h.value })),
          cookie: ex.response.cookies,
          body: ex.response.bodyText ?? '',
        }
      : undefined,
    status: 'OK',
    code: 200,
  };
}

function safeJson(s?: string): unknown { try { return JSON.parse(s ?? '{}'); } catch { return {}; } }

export function exportPostmanEnvironment(env: Environment): string {
  return JSON.stringify({
    id: env.id, name: env.name, values: env.variables.map(exportVar),
    _postman_variable_scope: 'environment', _postman_exported_at: now(), _postman_exported_using: 'API Manager 1.0.0',
  }, null, 2);
}

export function exportPostmanGlobals(vars: Variable[]): string {
  return JSON.stringify({
    id: uid(), name: 'API Manager Globals', values: vars.map(exportVar),
    _postman_variable_scope: 'globals', _postman_exported_at: now(), _postman_exported_using: 'API Manager 1.0.0',
  }, null, 2);
}
