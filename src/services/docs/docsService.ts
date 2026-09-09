/**
 * Documentation generation & serving (§49): HTML docs from collections/specs
 * via the core docsGen renderer, export to file, serve over a local
 * HTTP server, and DocSite registry for saved sites.
 */
import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApiRequest, Collection, DocSite, Folder, Specification } from '../../shared/types';
import { generateDocsHtml, DocsInput } from '../../core/docsx/docsGen';

export interface DocsDeps {
  getCollection: (id?: string) => Collection | undefined;
  getFolders: (collectionId: string) => Folder[];
  getRequestsForCollection: (collectionId: string) => ApiRequest[];
  getSpec: (id?: string) => Specification | undefined;
  listDocSites: (workspaceId?: string) => DocSite[];
  saveDocSite: (site: DocSite) => DocSite;
}

const servers = new Map<string, http.Server>();

export function renderDocs(args: { collectionId?: string; specId?: string; theme?: 'light' | 'dark'; workspaceId?: string }, deps: DocsDeps): { html: string } {
  const input: DocsInput = { title: 'API Documentation', theme: args.theme ?? 'light' };
  if (args.collectionId) {
    const collection = deps.getCollection(args.collectionId);
    if (!collection) throw new Error(`Collection not found: ${args.collectionId}`);
    input.title = collection.name;
    input.description = collection.description;
    input.collections = [{
      collection, folders: deps.getFolders(collection.id),
      requests: deps.getRequestsForCollection(collection.id),
      examples: [],
    }];
  }
  if (args.specId) {
    const spec = deps.getSpec(args.specId);
    if (spec) { input.specs = [spec]; if (!args.collectionId) input.title = spec.name; }
  }
  return { html: generateDocsHtml(input) };
}

export function exportDocs(args: { collectionId?: string; specId?: string; path: string; workspaceId?: string }, deps: DocsDeps): { path: string } {
  const { html } = renderDocs(args, deps);
  mkdirSync(dirname(args.path), { recursive: true });
  writeFileSync(args.path, html);
  return { path: args.path };
}

export async function serveDocs(args: { collectionId?: string; specId?: string; port?: number }, deps: DocsDeps): Promise<{ url: string }> {
  const key = `${args.collectionId ?? 'x'}:${args.specId ?? 'y'}`;
  const existing = servers.get(key);
  if (existing) {
    const address = existing.address();
    if (typeof address === 'object' && address) return { url: `http://127.0.0.1:${address.port}` };
  }
  const server = http.createServer((_req, res) => {
    try {
      const { html } = renderDocs(args, deps);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(`docs error: ${e instanceof Error ? e.message : e}`);
    }
  });
  const port = args.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  servers.set(key, server);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { url: `http://127.0.0.1:${actualPort}` };
}

export function stopDocServers(): void {
  for (const [key, server] of servers) { try { server.close(); } catch { /* ignore */ } servers.delete(key); }
}
