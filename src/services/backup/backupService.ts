/**
 * Backup & restore (§50): ZIP snapshots of the workspace DB + vault metadata
 * with optional AES-256-GCM password encryption, SHA-256 verification,
 * listing, deletion, and comparison (collections added/removed/changed).
 */
import AdmZip from 'adm-zip';
import { createHash, randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { BackupInfo } from '../../shared/types';
import type { BackupCompareResult } from '../../shared/api';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';

export interface BackupDeps {
  dataDir: string;
  backupDir: string;
  dbFilePath: string;
  /** SQL dump of the whole database as JSON rows, used for raw restore */
  exportDataJson: () => string;
  importDataJson: (json: string, mode: 'merge' | 'replace') => { annotations: string[] };
  countTables: () => Record<string, number>;
}

interface BackupManifest {
  kind: 'api-manager-backup';
  version: 1;
  id: string;
  createdAt: string;
  encrypted: boolean;
  encryptedWithPassword: boolean;
  sha256Data: string;
  salt?: string;
  nonce?: string;
  tag?: string;
  note?: string;
  tables: Record<string, number>;
  backupKind: BackupInfo['kind'];
}

const MAGIC = Buffer.from('AMBK1');

export function createBackup(deps: BackupDeps, opts: { kind?: BackupInfo['kind']; encryptPassword?: string; note?: string }): BackupInfo {
  mkdirSync(deps.backupDir, { recursive: true });
  const id = uid();
  const stamp = now().replace(/[:.]/g, '-');
  const name = `${opts.kind ?? 'manual'}_${stamp}_${id.slice(0, 8)}.zip`;
  const target = join(deps.backupDir, name);

  const dataJson = deps.exportDataJson();
  const sha256Data = createHash('sha256').update(dataJson).digest('hex');

  let payload = Buffer.from(dataJson, 'utf8');
  const manifest: BackupManifest = {
    kind: 'api-manager-backup', version: 1, id, createdAt: now(),
    encrypted: !!opts.encryptPassword, encryptedWithPassword: !!opts.encryptPassword,
    sha256Data,
    tables: deps.countTables(),
    backupKind: opts.kind ?? 'manual',
    note: opts.note,
  };

  if (opts.encryptPassword) {
    const salt = randomBytes(32);
    const nonce = randomBytes(12);
    const key = scryptSync(opts.encryptPassword, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    payload = Buffer.concat([cipher.update(payload), cipher.final()]);
    manifest.salt = salt.toString('base64');
    manifest.nonce = nonce.toString('base64');
    manifest.tag = cipher.getAuthTag().toString('base64');
    payload = Buffer.concat([MAGIC, payload]);
  }

  // attach raw db file too (fast restore path)
  let dbBytes: Buffer | undefined;
  if (existsSync(deps.dbFilePath)) {
    try { dbBytes = readFileSync(deps.dbFilePath); manifest.tables.dbFileSha256 = createHash('sha256').update(dbBytes).digest('hex') as unknown as number; } catch { /* optional */ }
  }

  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  zip.addFile('data.json', payload);
  if (dbBytes && !opts.encryptPassword) zip.addFile('api_manager.db', dbBytes);
  zip.writeZip(target);

  const sizeBytes = statSync(target).size;
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
  return { id, path: target, createdAt: manifest.createdAt, sizeBytes, encrypted: !!opts.encryptPassword, sha256, kind: opts.kind ?? 'manual', note: opts.note };
}

export function listBackups(deps: BackupDeps): BackupInfo[] {
  if (!existsSync(deps.backupDir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(deps.backupDir)) {
    if (!name.endsWith('.zip')) continue;
    const p = join(deps.backupDir, name);
    try {
      const manifest = readManifest(p);
      if (!manifest) continue;
      const sha256 = createHash('sha256').update(readFileSync(p)).digest('hex');
      out.push({
        id: manifest.id, path: p, createdAt: manifest.createdAt,
        sizeBytes: statSync(p).size, encrypted: manifest.encrypted,
        sha256, kind: manifest.backupKind ?? 'manual', note: manifest.note,
      });
    } catch { /* skip unreadable backup */ }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function readManifest(path: string): BackupManifest | null {
  try {
    const zip = new AdmZip(path);
    const entry = zip.getEntry('manifest.json');
    if (!entry) return null;
    return JSON.parse(entry.getData().toString('utf8')) as BackupManifest;
  } catch { return null; }
}

export function deleteBackup(path: string, deps: BackupDeps): void {
  const resolved = path;
  if (!resolved.startsWith(deps.backupDir)) throw new Error('Backup path outside backup dir refused');
  if (!existsSync(resolved)) throw new Error('Backup not found');
  unlinkSync(resolved);
}

export function verifyBackup(path: string, _deps: BackupDeps): { ok: boolean; sha256: string } {
  if (!existsSync(path)) return { ok: false, sha256: '' };
  const manifest = readManifest(path);
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (!manifest) return { ok: false, sha256 };
  const zip = new AdmZip(path);
  const data = zip.getEntry('data.json');
  if (!data) return { ok: false, sha256 };
  let payload = data.getData();
  if (!manifest.encrypted) {
    const check = createHash('sha256').update(payload).digest('hex');
    return { ok: check === manifest.sha256Data, sha256 };
  }
  return { ok: true, sha256 }; // encrypted payloads verified on restore via GCM auth tag
}

export function restoreBackup(path: string, password: string | undefined, deps: BackupDeps): { restored: boolean } {
  const manifest = readManifest(path);
  if (!manifest) throw new Error('Not an API Manager backup file');
  const zip = new AdmZip(path);
  const dataEntry = zip.getEntry('data.json');
  if (!dataEntry) throw new Error('Backup missing data.json');
  let payload = dataEntry.getData();
  if (manifest.encrypted) {
    if (!password) throw new Error('Backup is encrypted; password required');
    const magicLeft = payload.subarray(0, MAGIC.length);
    if (!magicLeft.equals(MAGIC)) throw new Error('Backup encryption header corrupted');
    payload = payload.subarray(MAGIC.length);
    const key = scryptSync(password, Buffer.from(manifest.salt!, 'base64'), 32);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(manifest.nonce!, 'base64'));
      decipher.setAuthTag(Buffer.from(manifest.tag!, 'base64'));
      payload = Buffer.concat([decipher.update(payload), decipher.final()]);
    } catch {
      throw new Error('Failed to decrypt backup — wrong password or corrupted data');
    }
  }
  const json = payload.toString('utf8');
  const check = createHash('sha256').update(json).digest('hex');
  if (check !== manifest.sha256Data) throw new Error('Backup integrity check failed (sha256 mismatch)');
  deps.importDataJson(json, 'replace');
  return { restored: true };
}

interface BackupDataShape {
  collections?: { id: string; name: string; doc?: string }[];
}

export function compareBackups(aPath: string, bPath: string, password?: string): BackupCompareResult {
  const a = readData(aPath, password);
  const b = readData(bPath, password);
  const aCols = new Map((a.collections ?? []).map((c) => [c.id, c]));
  const bCols = new Map((b.collections ?? []).map((c) => [c.id, c]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, c] of bCols) if (!aCols.has(id)) added.push(c.name);
  for (const [id, c] of aCols) if (!bCols.has(id)) removed.push(c.name);
  for (const [id, c] of bCols) {
    const o = aCols.get(id);
    if (o && JSON.stringify(o) !== JSON.stringify(c)) changed.push(c.name);
  }
  return { added, removed, changed };
}

function readData(path: string, _password?: string): BackupDataShape {
  const zip = new AdmZip(path);
  const data = zip.getEntry('data.json');
  if (!data) return {};
  let payload = data.getData();
  const manifest = readManifest(path);
  if (manifest?.encrypted) throw new Error('Encrypted backups cannot be compared in-place yet');
  try { return JSON.parse(payload.toString('utf8')) as BackupDataShape; } catch { return {}; }
}

export function pruneAutoBackups(deps: BackupDeps, keep: number): number {
  const all = listBackups(deps).filter((b) => b.kind === 'auto').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  let removed = 0;
  for (const extra of all.slice(Math.max(0, keep))) {
    try { deleteBackup(extra.path, deps); removed++; } catch { /* skip */ }
  }
  return removed;
}

export function backupsRoot(deps: BackupDeps): string { return deps.backupDir; }
export function backupBasename(p: string): string { return basename(p); }

export function writeTextBackupTo(targetDir: string, name: string, content: string): { path: string } {
  mkdirSync(targetDir, { recursive: true });
  const path = join(targetDir, name);
  writeFileSync(path, content);
  return { path };
}
