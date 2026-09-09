/** Thunder Client collection importer (§46). */
import { uid } from '../../shared/ids';
import { kv } from '../url/urlBuilder';
import { emptyImport, freshCollection, freshFolder, freshRequest, NormalizedImport } from './model';
import { now } from '../../shared/types';

type V = Record<string, unknown>;
const arrify = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function detectThunder(content: string): boolean {
  return content.includes('"client"') && content.includes('"thunder"') || content.includes('thunder-client') || (content.includes('"collectionName"') && content.includes('"requests"'));
}

export function importThunder(content: string, workspaceId: string): NormalizedImport {
  const out = emptyImport('thunder');
  let parsed: V;
  try { parsed = JSON.parse(content); } catch (e) { out.report.warnings.push(`Parse error: ${e instanceof Error ? e.message : e}`); return out; }
  const collection = freshCollection(workspaceId, String(parsed.collectionName ?? parsed.name ?? 'Thunder Client Collection'));
  const folders: ReturnType<typeof freshFolder>[] = [];
  const requests: NormalizedImport['collections'][number]['requests'] = [];
  const folderById = new Map<string, string>();
  for (const f of arrify(parsed.folders as V[])) {
    const folder = freshFolder(collection.id, String(f.name ?? 'Folder'));
    folders.push(folder);
    folderById.set(String(f._id ?? f.id), folder.id);
  }
  for (const node of arrify(parsed.requests as V[])) {
    const req = freshRequest(workspaceId, String(node.name ?? 'Request'), collection.id, folderById.get(String(node.containerId ?? node.parentId ?? '')));
    req.method = String(node.method ?? 'GET').toUpperCase();
    req.url = String(node.url ?? '');
    req.headers = arrify(node.headers as V[]).map((h) => kv(String(h.name ?? h.key ?? ''), String(h.value ?? ''), !h.isDisabled));
    req.queryParams = arrify((node.params ?? node.queryParams) as V[]).map((p) => kv(String(p.name ?? p.key ?? ''), String(p.value ?? ''), !p.isDisabled));
    const body = node.body as V | undefined;
    if (body) {
      const type = String(body.type ?? '');
      const raw = String(body.raw ?? body.text ?? '');
      if (type === 'json') req.body = { type: 'json', raw };
      else if (type === 'xml') req.body = { type: 'xml', raw };
      else if (type === 'formdata' || type === 'form-data') req.body = { type: 'form-data', formData: arrify(body.form as V[]).map((f) => ({ ...kv(String(f.name ?? ''), String(f.value ?? '')), fieldType: 'text' as const })) };
      else if (type === 'formencoded' || type === 'urlencoded') req.body = { type: 'urlencoded', urlencoded: arrify(body.form as V[]).map((f) => kv(String(f.name ?? ''), String(f.value ?? ''))) };
      else if (type === 'graphql') { req.protocol = 'graphql'; req.body = { type: 'graphql', graphql: { query: String(body.query ?? ''), variables: String(body.variables ?? '{}') } }; }
      else if (raw) req.body = { type: 'text', raw };
    }
    const auth = node.auth as V | undefined;
    if (auth && auth.type && auth.type !== 'none') {
      const t = String(auth.type);
      if (t === 'basic') req.auth = { type: 'basic', basic: { username: String((auth.basic as V)?.username ?? ''), password: String((auth.basic as V)?.password ?? '') } };
      else if (t === 'bearer') req.auth = { type: 'bearer', bearer: { token: String((auth.bearer as V)?.token ?? '') } };
      else if (t === 'aws') req.auth = { type: 'aws4', aws4: { accessKey: String((auth.aws as V)?.accessKey ?? ''), secretKey: String((auth.aws as V)?.secretKey ?? ''), region: String((auth.aws as V)?.region ?? ''), service: String((auth.aws as V)?.service ?? '') } };
    }
    const tests = node.tests as V[] | undefined;
    for (const t of arrify(tests)) {
      req.assertions.push({ id: uid(), type: mapThunderAssertion(String(t.type ?? '')), enabled: !t.isDisabled, name: String(t.custom ?? t.type ?? 'test'), property: String(t.action ?? ''), expected: String(t.value ?? '') });
    }
    requests.push(req);
    out.report.converted.push({ kind: 'request', name: req.name });
  }
  out.collections.push({ collection, folders, requests, examples: [] });
  out.report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  out.report.finishedAt = now();
  return out;
}

function mapThunderAssertion(type: string): import('../../shared/types').AssertionType {
  const n = type.toLowerCase();
  if (n.includes('status')) return 'statusCode';
  if (n.includes('header')) return 'headerValue';
  if (n.includes('json')) return 'jsonPath';
  if (n.includes('response-time') || n.includes('restime')) return 'responseTime';
  if (n.includes('content-type')) return 'contentType';
  return 'bodyContains';
}
