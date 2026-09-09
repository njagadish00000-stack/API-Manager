/** Insomnia (v4 JSON/YAML export) importer (§46). */
import { parse as parseYaml } from 'yaml';
import type { ApiRequest } from '../../shared/types';
import { uid } from '../../shared/ids';
import { kv } from '../url/urlBuilder';
import { emptyImport, freshCollection, freshFolder, freshRequest, NormalizedImport } from './model';
import { now } from '../../shared/types';

type V = Record<string, unknown>;

export function detectInsomnia(content: string): boolean {
  return content.includes('_type') && (content.includes('"export"') || content.includes('_type: export') || content.includes('_insomnia'));
}

export function importInsomnia(content: string, workspaceId: string): NormalizedImport {
  const out = emptyImport('insomnia');
  let parsed: V;
  try { parsed = content.trimStart().startsWith('{') ? JSON.parse(content) : (parseYaml(content) as V); }
  catch (e) { out.report.warnings.push(`Parse error: ${e instanceof Error ? e.message : e}`); return out; }
  const resources = (parsed.resources as V[]) ?? [];
  const workspace = resources.find((r) => r._type === 'workspace');
  const collection = freshCollection(workspaceId, String(workspace?.name ?? parsed.__export_source ? 'Insomnia Import' : 'Insomnia Import'));
  const folders: ReturnType<typeof freshFolder>[] = [];
  const requests: ApiRequest[] = [];
  const folderMap = new Map<string, string>();

  for (const r of resources.filter((x) => x._type === 'request_group')) {
    const parentId = folderMap.get(String(r.parentId));
    const folder = freshFolder(collection.id, String(r.name ?? 'Folder'), parentId);
    folders.push(folder);
    folderMap.set(String(r._id), folder.id);
    out.report.converted.push({ kind: 'folder', name: folder.name });
  }
  for (const r of resources.filter((x) => x._type === 'request')) {
    const req = freshRequest(workspaceId, String(r.name ?? r._id ?? 'Request'), collection.id, folderMap.get(String(r.parentId)));
    req.method = String(r.method ?? 'GET').toUpperCase();
    req.url = String(r.url ?? '');
    req.headers = ((r.headers as { name: string; value: string; disabled?: boolean }[]) ?? []).map((h) => ({ ...kv(h.name, h.value, !h.disabled), description: '' }));
    req.queryParams = ((r.parameters as { name: string; value: string; disabled?: boolean }[]) ?? []).map((p) => kv(p.name, p.value, !p.disabled));
    const body = r.body as V | undefined;
    if (body) {
      const mime = String(body.mimeType ?? '');
      if (mime.includes('json')) req.body = { type: 'json', raw: String(body.text ?? '') };
      else if (mime.includes('xml')) req.body = { type: 'xml', raw: String(body.text ?? '') };
      else if (mime.includes('x-www-form-urlencoded')) req.body = { type: 'urlencoded', urlencoded: ((body.params as { name: string; value: string }[]) ?? []).map((p) => kv(p.name, p.value)) };
      else if (mime.includes('form-data')) req.body = { type: 'form-data', formData: ((body.params as { name: string; value: string; type?: string; fileName?: string }[]) ?? []).map((p) => ({ ...kv(p.name, p.value), fieldType: p.type === 'file' ? 'file' as const : 'text' as const, filePath: p.type === 'file' ? p.value : undefined })) };
      else if (mime.includes('graphql')) { req.protocol = 'graphql'; req.body = { type: 'graphql', graphql: { query: String((body as V).graphql?.toString() ?? body.text ?? ''), variables: '' } }; }
      else if (body.text) req.body = { type: 'text', raw: String(body.text) };
    }
    const auth = r.authentication as V | undefined;
    if (auth && Object.keys(auth).length > 0) {
      const t = String(auth.type ?? '');
      if (t === 'basic') req.auth = { type: 'basic', basic: { username: String(auth.username ?? ''), password: String(auth.password ?? '') } };
      else if (t === 'bearer') req.auth = { type: 'bearer', bearer: { token: String(auth.token ?? ''), prefix: auth.prefix ? String(auth.prefix) : undefined } };
      else if (t === 'digest') req.auth = { type: 'digest', digest: { username: String(auth.username ?? ''), password: String(auth.password ?? '') } };
      else if (t === 'oauth1') { req.auth = { type: 'oauth1', oauth1: { consumerKey: String(auth.consumerKey ?? ''), consumerSecret: String(auth.consumerSecret ?? ''), token: String(auth.tokenKey ?? auth.token ?? ''), tokenSecret: String(auth.tokenSecret ?? ''), signatureMethod: 'HMAC-SHA1', addTo: 'header' } }; }
      else out.report.unsupported.push({ kind: 'auth', name: String(auth.type), detail: 'Insomnia auth type not mapped' });
    }
    if (r.preRequestScript) { req.scripts.preRequest = String(r.preRequestScript); out.report.scriptsRequiringReview.push({ location: req.name, reason: 'Insomnia scripts use a different API; review manually' }); }
    const created = typeof r.created === 'number' ? new Date(r.created).toISOString() : now();
    req.createdAt = created;
    requests.push(req);
    out.report.converted.push({ kind: 'request', name: req.name });
  }
  // environments
  for (const env of resources.filter((x) => x._type === 'environment')) {
    const data = env.data as Record<string, unknown>;
    out.environments.push({
      id: uid(), workspaceId, name: String(env.name ?? 'Environment'),
      variables: Object.entries(data ?? {}).filter(([, v]) => typeof v === 'string').map(([key, value]) => ({ id: uid(), key, value: String(value), type: 'default' as const, enabled: true })),
      sortOrder: 0, createdAt: now(), updatedAt: now(),
    });
  }
  out.collections.push({ collection, folders, requests, examples: [] });
  out.report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  out.report.finishedAt = now();
  return out;
}
