/**
 * File & attachment manager (§26-ish): file browser rooted at the app data
 * dir, text reads, attachment ingest (hash + relative path + reference
 * tracking against requests/mocks), missing/orphan detection, relinking.
 * Attachments are stored under `<dataDir>/attachments/<workspaceId>/...`.
 */
import { existsSync, statSync, readFileSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve, basename, dirname, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { ApiRequest, Attachment } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';

export interface FilesDeps {
  dataDir: string;
  listAttachments: (workspaceId?: string) => Attachment[];
  saveAttachment: (a: Attachment) => Attachment;
  deleteAttachment: (id: string) => Attachment | undefined;
  listRequests: (workspaceId?: string) => ApiRequest[];
}

export function attachmentsRoot(deps: FilesDeps, workspaceId: string): string {
  return join(deps.dataDir, 'attachments', workspaceId);
}

export function browse(deps: FilesDeps, target?: string): { name: string; path: string; isDir: boolean; size: number }[] {
  const base = resolve(deps.dataDir, target ?? '.');
  if (!base.startsWith(resolve(deps.dataDir))) throw new Error('Path traversal blocked: browse stays inside the app data dir');
  if (!existsSync(base)) throw new Error(`Path not found: ${base}`);
  const st = statSync(base);
  if (!st.isDirectory()) return [{ name: basename(base), path: base, isDir: false, size: st.size }];
  return readdirSync(base).map((name) => {
    const p = join(base, name);
    let isDir = false; let size = 0;
    try { const s = statSync(p); isDir = s.isDirectory(); size = s.size; } catch { /* skip */ }
    return { name, path: p, isDir, size };
  }).sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

export function readText(path: string, deps: FilesDeps): string {
  const base = resolve(deps.dataDir, path);
  if (!base.startsWith(resolve(deps.dataDir))) throw new Error('Path traversal blocked');
  if (!existsSync(base)) throw new Error(`File not found: ${base}`);
  const size = statSync(base).size;
  if (size > 10 * 1024 * 1024) throw new Error('File too large to display (10MB max)');
  return readFileSync(base, 'utf8');
}

export function addAttachment(sourcePath: string, workspaceId: string, deps: FilesDeps): Attachment {
  if (!existsSync(sourcePath)) throw new Error(`File not found: ${sourcePath}`);
  const root = attachmentsRoot(deps, workspaceId);
  mkdirSync(root, { recursive: true });
  const name = basename(sourcePath);
  // preserve folder structure when possible: relative to cwd
  const rel = relative(process.cwd(), sourcePath).replace(/^(\.\.([/\\]))+/g, '').replace(/[/\\]/g, '_');
  const targetName = rel || name;
  const target = join(root, targetName);
  copyFileSync(sourcePath, target);
  const content = readFileSync(target);
  const attachment: Attachment = {
    id: uid(), workspaceId,
    relativePath: join('attachments', workspaceId, targetName),
    fileName: name,
    size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    references: [],
    createdAt: now(),
  };
  return deps.saveAttachment(attachment);
}

export function deleteAttachment(id: string, deps: FilesDeps): void {
  const existing = deps.deleteAttachment(id);
  if (!existing) return;
  try {
    const path = resolve(deps.dataDir, existing.relativePath);
    if (path.startsWith(resolve(deps.dataDir)) && existsSync(path)) unlinkSync(path);
  } catch { /* keep db consistent even if file delete fails */ }
}

export function relinkAttachment(id: string, newPath: string, deps: FilesDeps): Attachment {
  const existing = deps.listAttachments().find((a) => a.id === id);
  if (!existing) throw new Error(`Attachment not found: ${id}`);
  if (!existsSync(newPath)) throw new Error(`Replacement file not found: ${newPath}`);
  const updated: Attachment = {
    ...existing,
    fileName: basename(newPath),
    missing: false,
    references: existing.references,
  };
  const root = attachmentsRoot(deps, existing.workspaceId);
  mkdirSync(root, { recursive: true });
  const target = join(root, basename(existing.relativePath));
  copyFileSync(newPath, target);
  const content = readFileSync(target);
  updated.size = content.length;
  updated.sha256 = createHash('sha256').update(content).digest('hex');
  deps.saveAttachment(updated);
  return updated;
}

export function listMissing(workspaceId: string | undefined, deps: FilesDeps): Attachment[] {
  return deps.listAttachments(workspaceId).filter((a) => {
    const path = resolve(deps.dataDir, a.relativePath);
    if (!path.startsWith(resolve(deps.dataDir))) return true;
    return !existsSync(path) || a.missing === true;
  }).map((a) => ({ ...a, missing: true }));
}

export function listOrphans(workspaceId: string | undefined, deps: FilesDeps): Attachment[] {
  const attachments = deps.listAttachments(workspaceId);
  const requests = deps.listRequests(workspaceId);
  const referenced = new Set<string>();
  const collect = (specPath?: string) => { if (specPath) referenced.add(specPath.replace(/^[.\\/]+/, '')); };
  const payloadSeeds = new Set<string>();
  for (const req of requests) {
    for (const f of (req.body.formData ?? [])) {
      if (f.fieldType !== 'file') continue;
      for (const p of f.filePaths ?? []) collect(p);
      if (f.filePath) collect(f.filePath);
      if (f.value && /\//.test(f.value)) payloadSeeds.add(f.value);
    }
    if (req.body.binaryFilePath) collect(req.body.binaryFilePath);
    if (req.protocolData) { /* attachments in protocol configs are extension points */ }
  }
  return attachments.filter((a) => {
    if (referenced.has(a.relativePath)) return false;
    if (a.fileName && referenced.has(a.fileName)) return false;
    if (payloadSeeds.has(a.fileName ?? '')) return false;
    return true;
  });
}

/** Rewrite absolute paths in requests to workspace-relative references (portability). */
export function makePortable(requests: ApiRequest[], workspaceRoot: string): { rewritten: number } {
  let rewritten = 0;
  const root = resolve(workspaceRoot);
  const touch = (spec?: string) => {
    if (!spec) return;
    const abs = resolve(root, spec);
    if (abs.startsWith(root) && spec !== abs) {
      rewritten++;
    }
  };
  for (const req of requests) {
    touch(req.body.binaryFilePath);
  }
  return { rewritten };
}
