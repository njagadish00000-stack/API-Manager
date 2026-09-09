/**
 * OpenAPI 3.x / Swagger 2.x support (§46, §51, §52):
 * parse/validate, import → collection, export ← collection, diff & breaking
 * change detection, spec↔collection sync report, $ref graph, mock generation.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ApiRequest, Collection, KeyValue, MockRoute } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { kv } from '../url/urlBuilder';
import { emptyImport, freshCollection, freshRequest, NormalizedImport } from '../importers/model';
import type { SpecValidation, SpecSyncReport, BreakingChange } from '../../shared/api';

type O = Record<string, unknown>;
const asObj = (v: unknown): O => (v && typeof v === 'object' && !Array.isArray(v) ? v as O : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface ParsedSpec { format: 'openapi3' | 'swagger2'; doc: O; raw: string }

export function parseOpenApi(content: string): ParsedSpec | null {
  let doc: unknown;
  try { doc = JSON.parse(content); } catch { try { doc = parseYaml(content); } catch { return null; } }
  const o = asObj(doc);
  if (typeof o.openapi === 'string' && o.openapi.startsWith('3')) return { format: 'openapi3', doc: o, raw: content };
  if (o.swagger === '2.0') return { format: 'swagger2', doc: o, raw: content };
  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateOpenApi(content: string): SpecValidation {
  const errors: SpecValidation['errors'] = [];
  const parsed = parseOpenApi(content);
  if (!parsed) {
    return { format: 'unknown', ok: false, errors: [{ message: 'Not a valid OpenAPI 3.x / Swagger 2.0 document', severity: 'error' }] };
  }
  const { doc, format } = parsed;
  const info = asObj(doc.info);
  if (!info.title) errors.push({ message: 'Missing info.title', path: 'info.title', severity: 'error' });
  if (!info.version) errors.push({ message: 'Missing info.version', path: 'info.version', severity: 'error' });
  const paths = asObj(doc.paths);
  let ops = 0;
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/')) errors.push({ message: `Path "${path}" must start with /`, path: `paths.${path}`, severity: 'error' });
    for (const method of Object.keys(asObj(item))) {
      if (['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace', 'parameters', 'summary', 'description', '$ref', 'servers'].includes(method)) {
        if (['parameters', 'summary', 'description', '$ref', 'servers'].includes(method)) continue;
        ops++;
        const op = asObj(asObj(item)[method]);
        const responses = asObj(op.responses);
        if (Object.keys(responses).length === 0) errors.push({ message: `Operation ${method.toUpperCase()} ${path} has no responses`, path: `paths.${path}.${method}.responses`, severity: 'error' });
        if (!op.operationId) errors.push({ message: `Operation ${method.toUpperCase()} ${path} has no operationId`, path: `paths.${path}.${method}`, severity: 'warning' });
      } else {
        errors.push({ message: `Unknown method/key "${method}" under path ${path}`, path: `paths.${path}.${method}`, severity: 'warning' });
      }
    }
  }
  if (ops === 0) errors.push({ message: 'Spec defines no operations', severity: 'warning' });
  // check $refs resolve
  for (const ref of collectRefs(doc)) {
    if (ref.startsWith('#/') && !resolveRef(doc, ref)) errors.push({ message: `Unresolved $ref "${ref}"`, severity: 'error' });
  }
  return { format, ok: errors.every((e) => e.severity !== 'error'), errors, stats: { operations: ops, paths: Object.keys(paths).length } };
}

export function collectRefs(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) { for (const x of node) collectRefs(x, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as O)) {
      if (k === '$ref' && typeof v === 'string') acc.push(v);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

export function resolveRef(doc: O, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = doc;
  for (const part of ref.slice(2).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as O)[part];
  }
  return cur;
}

export function refGraph(content: string): { nodes: { id: string }[]; edges: { from: string; to: string }[] } {
  const parsed = parseOpenApi(content);
  if (!parsed) return { nodes: [], edges: [] };
  const refs = [...new Set(collectRefs(parsed.doc))];
  const nodes = new Set<string>(refs.filter((r) => r.startsWith('#/')));
  const edges: { from: string; to: string }[] = [];
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) { node.forEach((x, i) => visit(x, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as O)) {
        const p = path ? `${path}.${k}` : k;
        if (k === '$ref' && typeof v === 'string' && v.startsWith('#/')) edges.push({ from: path || 'root', to: v });
        else visit(v, p);
      }
    }
  };
  visit(parsed.doc, '');
  const defsPaths = new Set(edges.map((e) => e.to));
  for (const d of defsPaths) nodes.add(d);
  return { nodes: [...nodes].map((id) => ({ id })), edges };
}

// ---------------------------------------------------------------------------
// Import → collection
// ---------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

export function openApiToCollection(content: string, workspaceId: string, baseUrlVar = '{{baseUrl}}'): NormalizedImport {
  const out = emptyImport('openapi');
  const parsed = parseOpenApi(content);
  if (!parsed) { out.report.warnings.push('Not an OpenAPI/Swagger document'); return out; }
  const { doc, format } = parsed;
  const info = asObj(doc.info);
  const title = String(info.title ?? 'Imported API');
  const collection = freshCollection(workspaceId, title);
  collection.description = String(info.description ?? '');
  collection.variables = [{ id: uid(), key: 'baseUrl', value: guessBaseUrl(doc, format), type: 'default', enabled: true, description: 'Server base URL' }];
  const collection2 = collection;
  void collection2;

  const requests: ApiRequest[] = [];
  const paths = asObj(doc.paths);
  for (const [path, itemRaw] of Object.entries(paths)) {
    const item = asObj(itemRaw);
    const sharedParams = asArr(item.parameters);
    for (const method of HTTP_METHODS) {
      if (!(method in item)) continue;
      const op = asObj(item[method]);
      const name = String(op.summary ?? op.operationId ?? `${method.toUpperCase()} ${path}`);
      const req = freshRequest(workspaceId, name, collection.id);
      req.method = method.toUpperCase();
      // path params
      const pathParams: KeyValue[] = [];
      const url = path.replace(/\{([^}]+)\}/g, (_, p) => {
        pathParams.push(kv(p, exampleForParam(findParam([...(sharedParams as O[])], [...asArr(op.parameters) as O[]], p, 'path')) ?? `<${p}>`));
        return `:${p}`;
      });
      req.url = `${baseUrlVar}${url}`;
      req.pathParams = pathParams;
      // query params
      const allParams = [...(sharedParams as O[]), ...(asArr(op.parameters) as O[])];
      for (const prm of allParams) {
        const resolved = dereferenceParam(doc, prm);
        const loc = String(resolved.in ?? '');
        if (loc === 'query') req.queryParams.push({ ...kv(String(resolved.name ?? ''), exampleForParam(resolved) ?? ''), description: String(resolved.description ?? '') });
        else if (loc === 'header') req.headers.push({ ...kv(String(resolved.name ?? ''), exampleForParam(resolved) ?? ''), description: String(resolved.description ?? '') });
      }
      // request body
      const body = format === 'swagger2' ? swagger2Body(doc, op) : openApi3Body(doc, op);
      if (body) req.body = body;
      req.description = String(op.description ?? '');
      req.documentation = req.description;
      req.tags = asArr(op.tags).map(String);
      if (op.deprecated) req.tags = [...req.tags, 'deprecated'];
      requests.push(req);
      out.report.converted.push({ kind: 'operation', name });
    }
  }
  // security scheme → collection auth (best effort)
  const securitySchemes = format === 'swagger2' ? asObj(doc.securityDefinitions) : asObj(asObj(doc.components).securitySchemes);
  const firstScheme = Object.values(securitySchemes)[0];
  if (firstScheme) {
    const s = asObj(firstScheme);
    const t = String(s.type ?? '');
    if (t === 'http' && s.scheme === 'basic') collection.auth = { type: 'basic', basic: { username: '{{username}}', password: '{{password}}' } };
    else if (t === 'http' && s.scheme === 'bearer') collection.auth = { type: 'bearer', bearer: { token: '{{token}}' } };
    else if (t === 'apiKey') collection.auth = { type: 'apikey', apikey: { key: String(s.name ?? 'X-API-Key'), value: '{{apiKey}}', addTo: s.in === 'query' ? 'query' : 'header' } };
    else if (t === 'basic') collection.auth = { type: 'basic', basic: { username: '{{username}}', password: '{{password}}' } };
    else if (t === 'oauth2') {
      out.report.converted.push({ kind: 'auth', name: 'oauth2', note: 'Security scheme detected; configure the OAuth2 flow on the collection.' });
    }
    for (const r of requests) r.auth = { type: 'inherit' };
  }
  out.collections.push({ collection, folders: [], requests, examples: [] });
  out.report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  out.report.finishedAt = now();
  return out;
}

function guessBaseUrl(doc: O, format: string): string {
  if (format === 'swagger2') {
    const host = doc.host ? `${asArr(doc.schemes)[0] ?? 'https'}://${doc.host}` : 'https://api.example.com';
    return `${host}${doc.basePath ?? ''}`;
  }
  const servers = asArr(doc.servers);
  if (servers.length > 0) return String(asObj(servers[0]).url ?? 'https://api.example.com');
  return 'https://api.example.com';
}

function dereferenceParam(doc: O, prm: O): O {
  if (typeof prm.$ref === 'string') return asObj(resolveRef(doc, prm.$ref));
  return prm;
}

function findParam(shared: O[], opParams: O[], name: string, loc: string): O | undefined {
  return [...opParams, ...shared].find((p) => asObj(p).name === name && asObj(p).in === loc);
}

function exampleForParam(prm: O | undefined): string | undefined {
  if (!prm) return undefined;
  if (prm.example !== undefined) return String(prm.example);
  const schema = asObj(prm.schema);
  if (schema.default !== undefined) return String(schema.default);
  if (schema.example !== undefined) return String(schema.example);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return String(schema.enum[0]);
  return undefined;
}

function openApi3Body(doc: O, op: O): ApiRequest['body'] | undefined {
  const rb = asObj(op.requestBody);
  if (Object.keys(rb).length === 0) return undefined;
  const content = asObj(rb.content);
  for (const [mime, mediaRaw] of Object.entries(content)) {
    const media = asObj(mediaRaw);
    const schema = asObj(resolveRef(doc, String(media.schema && asObj(media.schema).$ref || '') || '') || media.schema);
    if (mime.includes('json')) return { type: 'json', raw: JSON.stringify(exampleFromSchema(doc, media.schema ?? schema), null, 2) };
    if (mime.includes('xml')) return { type: 'xml', raw: xmlExampleFromSchema(doc, media.schema ?? schema) };
    if (mime.includes('x-www-form-urlencoded')) {
      const props = asObj(schema.properties);
      return { type: 'urlencoded', urlencoded: Object.keys(props).map((k) => kv(k, exampleForProperty(schema, k) ?? '')) };
    }
    if (mime.includes('multipart')) {
      const props = asObj(schema.properties);
      return { type: 'form-data', formData: Object.keys(props).map((k) => ({ ...kv(k, exampleForProperty(schema, k) ?? ''), fieldType: asObj(props[k]).format === 'binary' ? 'file' as const : 'text' as const })) };
    }
    if (mime.startsWith('text/')) return { type: 'text', raw: typeof schema.example === 'string' ? schema.example : '' };
  }
  return undefined;
}

function swagger2Body(doc: O, op: O): ApiRequest['body'] | undefined {
  const params = asArr(op.parameters) as O[];
  const bodyPrm = params.find((p) => asObj(p).in === 'body');
  if (bodyPrm) {
    const schema = asObj(bodyPrm.schema);
    return { type: 'json', raw: JSON.stringify(exampleFromSchema(doc, schema), null, 2) };
  }
  const formParams = params.filter((p) => asObj(p).in === 'formData');
  if (formParams.length > 0) {
    const opConsumes = Array.isArray((op as Record<string, unknown>).consumes) ? (op as Record<string, unknown>).consumes as unknown[] : [];
const consumes = asArr(opConsumes.length ? opConsumes : doc.consumes).map(String);
    if (consumes.some((c) => c.includes('multipart'))) {
      return { type: 'form-data', formData: formParams.map((p) => ({ ...kv(String(p.name ?? ''), exampleForParam(p) ?? ''), fieldType: p.type === 'file' ? 'file' as const : 'text' as const })) };
    }
    return { type: 'urlencoded', urlencoded: formParams.map((p) => kv(String(p.name ?? ''), exampleForParam(p) ?? '')) };
  }
  return undefined;
}

function exampleForProperty(schema: O, key: string): string | undefined {
  const prop = asObj(asObj(schema.properties)[key]);
  if (prop.default !== undefined) return String(prop.default);
  if (prop.example !== undefined) return String(prop.example);
  return undefined;
}

export function exampleFromSchema(doc: O, schemaNode: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  let schema = asObj(schemaNode);
  if (typeof schema.$ref === 'string') schema = asObj(resolveRef(doc, schema.$ref));
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const allOf = asArr(schema.allOf);
  if (allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const s of allOf) {
      const ex = exampleFromSchema(doc, s, depth + 1);
      if (ex && typeof ex === 'object' && !Array.isArray(ex)) Object.assign(merged, ex);
    }
    return merged;
  }
  const type = schema.type ?? (schema.properties ? 'object' : undefined);
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(asObj(schema.properties))) out[k] = exampleFromSchema(doc, v, depth + 1);
      return out;
    }
    case 'array': return [exampleFromSchema(doc, schema.items, depth + 1)];
    case 'string': {
      if (schema.format === 'date-time') return new Date(0).toISOString();
      if (schema.format === 'date') return '2024-01-01';
      if (schema.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
      return 'string';
    }
    case 'integer': return 0;
    case 'number': return 0;
    case 'boolean': return true;
    default: return null;
  }
}

function xmlExampleFromSchema(doc: O, schemaNode: unknown): string {
  const schema = typeof asObj(schemaNode).$ref === 'string' ? asObj(resolveRef(doc, String(asObj(schemaNode).$ref))) : asObj(schemaNode);
  const name = schema.title ?? 'root';
  const props = asObj(schema.properties);
  const children = Object.entries(props).map(([k, v]) => {
    const p = asObj(v);
    const val = exampleFromSchema(doc, v);
    return `  <${k}>${typeof val === 'object' ? JSON.stringify(val) : String(val ?? p.type ?? '')}</${k}>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${name}>\n${children}\n</${name}>`;
}

// ---------------------------------------------------------------------------
// Export ← collection
// ---------------------------------------------------------------------------

export function collectionToOpenApi(collection: Collection, requests: ApiRequest[], opts: { version?: string; format?: 'json' | 'yaml' } = {}): string {
  const doc: O = {
    openapi: '3.0.3',
    info: { title: collection.name, version: opts.version ?? '1.0.0', description: collection.description ?? '' },
    servers: [{ url: '{{baseUrl}}' }],
    paths: {},
  };
  const paths = doc.paths as O;
  for (const req of requests.filter((r) => r.collectionId === collection.id)) {
    const pathOnly = req.url.replace(/^https?:\/\/[^/]+/, '').replace(/^\{\{[^}]+\}\}/, '').split('?')[0] || '/';
    const oasPath = pathOnly.replace(/:([A-Za-z_][A-Za-z0-9_-]*)/g, '{$1}');
    const item = asObj(paths[oasPath]);
    paths[oasPath] = item;
    const op: O = {
      operationId: req.name.replace(/[^A-Za-z0-9_]+/g, '_'),
      summary: req.name,
      description: req.description ?? '',
      responses: { '200': { description: 'Successful response' } },
    };
    const params: O[] = [];
    for (const p of req.pathParams) params.push({ name: p.key, in: 'path', required: true, schema: { type: 'string', example: p.value } });
    for (const p of req.queryParams) params.push({ name: p.key, in: 'query', required: false, schema: { type: 'string' }, example: p.value, description: p.description });
    if (params.length > 0) op.parameters = params;
    const headers = req.headers.filter((h) => h.enabled && !['content-type', 'authorization'].includes(h.key.toLowerCase()));
    if (headers.length > 0) op.parameters = [...(op.parameters as O[] ?? []), ...headers.map((h) => ({ name: h.key, in: 'header', required: false, schema: { type: 'string' }, example: h.value }))];
    const rb = requestBodyToOpenApi(req);
    if (rb) op.requestBody = rb;
    if (req.tags.length > 0) op.tags = req.tags;
    item[req.method.toLowerCase()] = op;
  }
  // security from collection auth
  const auth = collection.auth;
  if (auth && auth.type !== 'none' && auth.type !== 'inherit') {
    const schemes: O = {};
    if (auth.type === 'basic') schemes.BasicAuth = { type: 'http', scheme: 'basic' };
    if (auth.type === 'bearer') schemes.BearerAuth = { type: 'http', scheme: 'bearer' };
    if (auth.type === 'apikey') schemes.ApiKeyAuth = { type: 'apiKey', in: auth.apikey?.addTo === 'query' ? 'query' : 'header', name: auth.apikey?.key ?? 'X-API-Key' };
    if (Object.keys(schemes).length > 0) {
      doc.components = { securitySchemes: schemes };
      doc.security = Object.keys(schemes).map((k) => ({ [k]: [] }));
    }
  }
  return opts.format === 'yaml' ? stringifyYaml(doc) : JSON.stringify(doc, null, 2);
}

function requestBodyToOpenApi(req: ApiRequest): O | undefined {
  const b = req.body;
  switch (b.type) {
    case 'json': {
      return { required: true, content: { 'application/json': { schema: inferSchemaFromJson(b.raw ?? ''), example: tryParse(b.raw ?? '') } } };
    }
    case 'xml': return { required: true, content: { 'application/xml': { schema: { type: 'string' }, example: b.raw } } };
    case 'urlencoded': return { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: Object.fromEntries((b.urlencoded ?? []).map((p) => [p.key, { type: 'string' }])) } } } };
    case 'form-data': return { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: Object.fromEntries((b.formData ?? []).map((p) => [p.key, p.fieldType === 'file' ? { type: 'string', format: 'binary' } : { type: 'string' }])) } } } };
    case 'text': return { required: true, content: { 'text/plain': { schema: { type: 'string' }, example: b.raw } } };
    default: return undefined;
  }
}

export function inferSchemaFromJson(json: string): O {
  const parsed = tryParse(json);
  return schemaForValue(parsed);
}

function schemaForValue(v: unknown): O {
  if (v === null) return { nullable: true };
  if (Array.isArray(v)) return { type: 'array', items: v.length > 0 ? schemaForValue(v[0]) : {} };
  switch (typeof v) {
    case 'string': return { type: 'string' };
    case 'number': return { type: Number.isInteger(v) ? 'integer' : 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': return { type: 'object', properties: Object.fromEntries(Object.entries(v as O).map(([k, val]) => [k, schemaForValue(val)])), required: Object.keys(v as O) };
    default: return {};
  }
}

function tryParse(s: string): unknown { try { return JSON.parse(s); } catch { return undefined; } }

// ---------------------------------------------------------------------------
// Diff & breaking changes
// ---------------------------------------------------------------------------

export interface SpecOperation { method: string; path: string; operationId?: string; deprecated?: boolean; requiredParams: string[]; responseStatuses: string[] }

export function specOperations(content: string): SpecOperation[] {
  const parsed = parseOpenApi(content);
  if (!parsed) return [];
  const ops: SpecOperation[] = [];
  for (const [path, itemRaw] of Object.entries(asObj(parsed.doc.paths))) {
    const item = asObj(itemRaw);
    for (const m of HTTP_METHODS) {
      if (!(m in item)) continue;
      const op = asObj(item[m]);
      const params = (asArr(op.parameters) as O[]).map((p) => dereferenceParam(parsed.doc, p));
      ops.push({
        method: m.toUpperCase(), path,
        operationId: op.operationId as string | undefined,
        deprecated: op.deprecated === true,
        requiredParams: params.filter((p) => p.required).map((p) => `${p.in}:${p.name}`),
        responseStatuses: Object.keys(asObj(op.responses)),
      });
    }
  }
  return ops;
}

export function diffSpecs(oldContent: string, newContent: string): BreakingChange[] {
  const a = specOperations(oldContent);
  const b = specOperations(newContent);
  const changes: BreakingChange[] = [];
  const key = (o: SpecOperation) => `${o.method} ${o.path}`;
  const aMap = new Map(a.map((o) => [key(o), o]));
  const bMap = new Map(b.map((o) => [key(o), o]));
  for (const [k, op] of aMap) {
    if (!bMap.has(k)) { changes.push({ kind: 'operation-removed', message: `Operation removed: ${k}`, path: op.path, severity: 'breaking' }); continue; }
    const nowOp = bMap.get(k)!;
    for (const p of op.requiredParams) if (!nowOp.requiredParams.includes(p)) changes.push({ kind: 'param-removed', message: `${k}: required parameter "${p}" removed`, path: op.path, severity: 'dangerous' });
    for (const p of nowOp.requiredParams) if (!op.requiredParams.includes(p)) changes.push({ kind: 'param-required-added', message: `${k}: new required parameter "${p}"`, path: op.path, severity: 'breaking' });
    for (const s of op.responseStatuses) if (!nowOp.responseStatuses.includes(s)) changes.push({ kind: 'response-removed', message: `${k}: response status ${s} removed`, path: op.path, severity: 'dangerous' });
    if (!op.deprecated && nowOp.deprecated) changes.push({ kind: 'deprecated', message: `${k} is now deprecated`, path: op.path, severity: 'info' });
  }
  for (const k of bMap.keys()) if (!aMap.has(k)) changes.push({ kind: 'operation-added', message: `Operation added: ${k}`, severity: 'info' });
  return changes;
}

// ---------------------------------------------------------------------------
// Spec ↔ collection sync
// ---------------------------------------------------------------------------

export function specSyncReport(specContent: string, requests: ApiRequest[]): SpecSyncReport {
  const ops = specOperations(specContent);
  const report: SpecSyncReport = { missingInCollection: [], missingInSpec: [], methodMismatch: [], parameterMismatch: [], schemaMismatch: [] };
  const reqKey = new Map<string, ApiRequest[]>();
  for (const r of requests) {
    const path = r.url.replace(/^https?:\/\/[^/]+/, '').replace(/^\{\{[^}]+\}\}/, '').split('?')[0].replace(/:([A-Za-z_][A-Za-z0-9_-]*)/g, '{$1}') || '/';
    const k = `${r.method.toUpperCase()} ${path}`;
    if (!reqKey.has(k)) reqKey.set(k, []);
    reqKey.get(k)!.push(r);
  }
  const specKeys = new Set(ops.map((o) => `${o.method} ${o.path}`));
  const specPaths = new Map<string, SpecOperation[]>();
  for (const o of ops) {
    if (!specPaths.has(o.path)) specPaths.set(o.path, []);
    specPaths.get(o.path)!.push(o);
    if (!reqKey.has(`${o.method} ${o.path}`)) report.missingInCollection.push({ method: o.method, path: o.path });
  }
  for (const [k, rs] of reqKey) {
    if (!specKeys.has(k)) {
      const [, path] = k.split(' ', 2);
      if (specPaths.has(path)) {
        report.methodMismatch.push({ path, specMethods: specPaths.get(path)!.map((o) => o.method), collectionMethods: rs.map((r) => r.method.toUpperCase()) });
      } else {
        for (const r of rs) report.missingInSpec.push({ method: rs[0].method.toUpperCase(), path, requestId: r.id });
      }
    } else {
      // parameter mismatch check
      const op = ops.find((o) => `${o.method} ${o.path}` === k)!;
      const r = rs[0];
      const specQueries = new Set(op.requiredParams.filter((p) => p.startsWith('query:')).map((p) => p.slice(6)));
      const reqQueries = new Set(r.queryParams.filter((q) => q.enabled).map((q) => q.key));
      for (const q of specQueries) if (!reqQueries.has(q)) report.parameterMismatch.push({ method: op.method, path: op.path, detail: `required query param "${q}" missing in request "${r.name}"` });
    }
  }
  return report;
}

// ---------------------------------------------------------------------------
// Mock route generation
// ---------------------------------------------------------------------------

export function openApiToMockRoutes(content: string, dynamicVars: boolean): MockRoute[] {
  const parsed = parseOpenApi(content);
  if (!parsed) return [];
  const routes: MockRoute[] = [];
  for (const [path, itemRaw] of Object.entries(asObj(parsed.doc.paths))) {
    const item = asObj(itemRaw);
    for (const m of HTTP_METHODS) {
      if (!(m in item)) continue;
      const op = asObj(item[m]);
      const responses = asObj(op.responses);
      // prefer 200/201 response with examples
      const statusEntry = Object.entries(responses).find(([code]) => code.startsWith('2')) ?? Object.entries(responses)[0];
      const status = statusEntry ? parseInt(statusEntry[0], 10) || 200 : 200;
      let body = '';
      let contentType = 'application/json';
      if (statusEntry) {
        const respObj = asObj(statusEntry[1]);
        if (parsed.format === 'swagger2') {
          const ex = asObj(respObj.examples);
          body = JSON.stringify(ex['application/json'] ?? exampleFromSchema(parsed.doc, respObj.schema) ?? {}, null, 2);
        } else {
          const content = asObj(respObj.content);
          for (const [mime, mediaRaw] of Object.entries(content)) {
            const media = asObj(mediaRaw);
            contentType = mime;
            if (media.example !== undefined) body = typeof media.example === 'string' ? media.example : JSON.stringify(media.example, null, 2);
            else if (media.examples && typeof media.examples === 'object') {
              const first = Object.values(asObj(media.examples))[0];
              body = JSON.stringify(asObj(first).value ?? {}, null, 2);
            } else body = JSON.stringify(exampleFromSchema(parsed.doc, media.schema) ?? {}, null, 2);
            break;
          }
          if (!body) body = JSON.stringify({ status: 'ok' });
        }
      }
      if (dynamicVars) {
        body = body.replace(/"datetime-now"/g, '"{{$isoTimestamp}}"').replace(/"uuid"/g, '"{{$uuid}}"');
      }
      routes.push({
        id: uid(),
        method: m.toUpperCase(),
        pathPattern: path.replace(/\{([^}]+)\}/g, ':$1'),
        status: Number.isNaN(status) ? 200 : status,
        headers: [kv('Content-Type', contentType)],
        body,
        enabled: true,
      });
    }
  }
  return routes;
}
