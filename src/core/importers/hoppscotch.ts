/** Hoppscotch collection importer (§46). */
import { uid } from '../../shared/ids';
import { kv } from '../url/urlBuilder';
import { emptyImport, freshCollection, freshFolder, freshRequest, NormalizedImport } from './model';
import { now } from '../../shared/types';

type V = Record<string, unknown>;
const arrify = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

export function detectHoppscotch(content: string): boolean {
  return content.includes('"v"') && (content.includes('"folders"') || content.includes('"requests"')) && !content.includes('getpostman');
}

export function importHoppscotch(content: string, workspaceId: string): NormalizedImport {
  const out = emptyImport('hoppscotch');
  let parsed: V | V[];
  try { parsed = JSON.parse(content); } catch (e) { out.report.warnings.push(`Parse error: ${e instanceof Error ? e.message : e}`); return out; }
  const collections = arrify(parsed);
  for (const collNode of collections) {
    const cv = collNode as V;
    const collection = freshCollection(workspaceId, String(cv.name ?? 'Hoppscotch Collection'));
    const folders: ReturnType<typeof freshFolder>[] = [];
    const requests: NormalizedImport['collections'][number]['requests'] = [];

    const walkRequests = (nodes: V[], folderId?: string) => {
      for (const node of nodes) {
        const req = freshRequest(workspaceId, String(node.name ?? 'Request'), collection.id, folderId);
        req.method = String(node.method ?? 'GET').toUpperCase();
        req.url = String(node.endpoint ?? node.url ?? '');
        req.headers = arrify(node.headers as V[]).map((h) => kv(String(h.key ?? ''), String(h.value ?? ''), h.active !== false));
        req.queryParams = arrify(node.params as V[]).map((p) => kv(String(p.key ?? ''), String(p.value ?? ''), p.active !== false));
        const body = node.body as V | undefined;
        if (body && body.contentType && String(body.contentType) !== 'null') {
          const ct = String(body.contentType);
          const raw = typeof body.body === 'string' ? body.body : '';
          if (ct.includes('json')) req.body = { type: 'json', raw };
          else if (ct.includes('xml')) req.body = { type: 'xml', raw };
          else if (ct.includes('x-www-form-urlencoded')) {
            let params: ReturnType<typeof kv>[] = [];
            try { const obj = JSON.parse(raw); params = Object.entries(obj as Record<string, string>).map(([k, v]) => kv(k, String(v))); } catch { params = [{ ...kv('raw', raw) }]; }
            req.body = { type: 'urlencoded', urlencoded: params };
          } else if (ct.includes('form-data')) req.body = { type: 'form-data', formData: [] , raw};
          else req.body = { type: 'text', raw };
        }
        const auth = node.auth as V | undefined;
        if (auth && auth.authType && auth.authType !== 'none' && auth.authType !== 'inherit') {
          const t = String(auth.authType);
          if (t === 'basic') req.auth = { type: 'basic', basic: { username: String(auth.username ?? ''), password: String(auth.password ?? '') } };
          else if (t === 'bearer') req.auth = { type: 'bearer', bearer: { token: String(auth.token ?? '') } };
          else if (t === 'api-key') req.auth = { type: 'apikey', apikey: { key: String(auth.key ?? ''), value: String(auth.value ?? ''), addTo: auth.addTo === 'query-params' ? 'query' : 'header' } };
        }
        if (node.preRequestScript) { req.scripts.preRequest = String(node.preRequestScript); out.report.scriptsRequiringReview.push({ location: req.name, reason: 'Hoppscotch scripts use pw.* API; convert to pm.*' }); }
        if (node.testScript) { req.scripts.postResponse = String(node.testScript); out.report.scriptsRequiringReview.push({ location: req.name, reason: 'Hoppscotch test scripts use pw.* API; convert to pm.*' }); }
        requests.push(req);
        out.report.converted.push({ kind: 'request', name: req.name });
      }
    };
    const walkFolders = (nodes: V[], parentId?: string) => {
      for (const node of nodes) {
        const folder = freshFolder(collection.id, String(node.name ?? 'Folder'), parentId);
        folders.push(folder);
        walkRequests(arrify(node.requests as V[]), folder.id);
        walkFolders(arrify(node.folders as V[]), folder.id);
      }
    };
    walkRequests(arrify(cv.requests as V[]));
    walkFolders(arrify(cv.folders as V[]));
    out.collections.push({ collection, folders, requests, examples: [] });
    out.report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  }
  out.report.finishedAt = now();
  return out;
}
