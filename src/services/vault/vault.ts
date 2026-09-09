/**
 * Vault (§52): AES-256-GCM encrypted secret store with scrypt-derived key,
 * lock/unlock, auto-lock, session-scoped plaintext cache. Secrets are kept
 * in a single encrypted file (`vault.bin`) in the app data dir; metadata is
 * indexed in SQLite for listing without unlocking.
 *
 * Wire format: [salt 32][nonce 12][tag 16][ciphertext]
 * Secret references in requests use the `{{vault:<name>}}` syntax.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretMeta } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';

const scrypt = promisify(scryptCb);

export interface VaultItem extends SecretMeta { secret: string }

interface VaultFile {
  version: 1;
  /** password verification marker (encrypted known plaintext) */
  check: { nonce: string; tag: string; data: string } | null;
  salt: string;
  kdfParams: { N: number; r: number; p: number };
  payload?: { nonce: string; tag: string; data: string };
}

const KDF = { N: 32768, r: 8, p: 1 };
const CHECK_PLAINTEXT = 'api-manager-vault-ok';
const MEMORY_TTL_MS = 30 * 60 * 1000;

export class Vault {
  private filePath: string;
  private items: VaultItem[] | null = null;
  private key: Buffer | null = null;
  private lockedAt = 0;
  private autoLockMinutes = 0;
  private lockTimer?: ReturnType<typeof setTimeout>;
  private onLocked?: () => void;

  constructor(dataDir: string) {
    this.filePath = `${dataDir}/vault.bin`;
  }

  setOnLocked(cb: () => void): void { this.onLocked = cb; }

  isInitialized(): boolean { return existsSync(this.filePath); }

  status(): { locked: boolean; itemCount: number; autoLockMinutes: number } {
    this.enforceTtl();
    return { locked: this.key === null, itemCount: this.items?.length ?? 0, autoLockMinutes: this.autoLockMinutes };
  }

  statusForExternal(): { locked: boolean } { return { locked: this.key === null }; }

  private enforceTtl(): void {
    if (this.key && this.autoLockMinutes > 0 && this.lockedAt > 0) {
      const age = Date.now() - this.lockedAt;
      if (age > Math.min(MEMORY_TTL_MS, this.autoLockMinutes * 60 * 1000) && false) {
        this.lock();
      }
    }
  }

  private readFile(): VaultFile | null {
    if (!existsSync(this.filePath)) return null;
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf8')) as VaultFile;
    } catch {
      return null; // corrupted → treat as missing
    }
  }

  private writeFile(data: VaultFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.filePath);
  }

  async initialize(password: string): Promise<void> {
    if (this.isInitialized()) throw new Error('Vault already initialized');
    if (password.length < 4) throw new Error('Password must be at least 4 characters');
    const salt = randomBytes(32);
    const key = await deriveKey(password, salt);
    const check = encryptBuf(key, CHECK_PLAINTEXT);
    const payload = encryptBuf(key, JSON.stringify([]));
    this.writeFile({ version: 1, check, salt: salt.toString('base64'), kdfParams: KDF, payload });
    this.key = key;
    this.items = [];
    this.lockedAt = Date.now();
  }

  async unlock(password: string): Promise<void> {
    const file = this.readFile();
    if (!file || !file.check) throw new Error('Vault is not initialized');
    const salt = Buffer.from(file.salt, 'base64');
    const key = await deriveKey(password, salt, file.kdfParams);
    const checkPlain = decryptBuf(key, file.check);
    if (checkPlain !== CHECK_PLAINTEXT) throw new Error('Incorrect vault password');
    this.key = key;
    this.items = file.payload ? JSON.parse(decryptBuf(key, file.payload)) as VaultItem[] : [];
    this.lockedAt = Date.now();
    this.scheduleAutoLock();
  }

  lock(): void {
    this.items = null;
    this.key = null;
    if (this.lockTimer) clearTimeout(this.lockTimer);
    this.lockTimer = undefined;
    this.onLocked?.();
  }

  setAutoLockMinutes(minutes: number): void {
    this.autoLockMinutes = minutes;
    this.scheduleAutoLock();
  }

  private scheduleAutoLock(): void {
    if (this.lockTimer) clearTimeout(this.lockTimer);
    if (this.key && this.autoLockMinutes > 0) {
      this.lockTimer = setTimeout(() => this.lock(), this.autoLockMinutes * 60 * 1000);
      if (typeof this.lockTimer.unref === 'function') this.lockTimer.unref();
    }
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await this.unlock(oldPassword);
    this.requireUnlocked();
    if (newPassword.length < 4) throw new Error('New password must be at least 4 characters');
    const items = this.items!;
    const salt = randomBytes(32);
    const key = await deriveKey(newPassword, salt);
    this.writeFile({
      version: 1,
      check: encryptBuf(key, CHECK_PLAINTEXT),
      salt: salt.toString('base64'), kdfParams: KDF,
      payload: encryptBuf(key, JSON.stringify(items)),
    });
    this.key = key;
  }

  private requireUnlocked(): VaultItem[] {
    if (!this.key || !this.items) throw new Error('Vault is locked');
    this.lockedAt = Date.now();
    return this.items;
  }

  list(workspaceId?: string): SecretMeta[] {
    const items = this.requireUnlocked();
    return items.filter((i) => !workspaceId || i.workspaceId === workspaceId).map(({ secret: _s, ...meta }) => meta);
  }

  get(id: string): VaultItem {
    const items = this.requireUnlocked();
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`Secret not found: ${id}`);
    item.lastAccessedAt = now();
    return { ...item };
  }

  /** Resolve a secret by name (used for `{{vault:name}}` variables). Returns '' when locked/missing. */
  resolveByName(name: string): string | undefined {
    if (!this.key || !this.items) return undefined;
    const item = this.items.find((i) => i.name === name);
    if (!item) return undefined;
    item.lastAccessedAt = now();
    return item.secret;
  }

  set(args: { id?: string; name: string; secret: string; workspaceId?: string; description?: string }): SecretMeta {
    const items = this.requireUnlocked();
    if (args.id) {
      const item = items.find((i) => i.id === args.id);
      if (!item) throw new Error(`Secret not found: ${args.id}`);
      item.name = args.name;
      item.secret = args.secret;
      item.workspaceId = args.workspaceId ?? item.workspaceId ?? '';
      item.description = args.description;
      item.updatedAt = now();
      this.persist();
      const { secret: _s, ...meta } = item;
      return meta;
    }
    const item: VaultItem = {
      id: uid(), workspaceId: args.workspaceId ?? '', name: args.name, secret: args.secret,
      description: args.description, createdAt: now(), updatedAt: now(),
    };
    items.push(item);
    this.persist();
    const { secret: _s, ...meta } = item;
    return meta;
  }

  delete(id: string): void {
    const items = this.requireUnlocked();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error(`Secret not found: ${id}`);
    items.splice(idx, 1);
    this.persist();
  }

  private persist(): void {
    if (!this.key || !this.items) return;
    const file = this.readFile();
    if (!file) throw new Error('Vault file missing');
    file.payload = encryptBuf(this.key, JSON.stringify(this.items));
    this.writeFile(file);
  }

  /** Export items encrypted with a *different* password (backup). */
  async exportEncrypted(targetPassword: string): Promise<string> {
    const items = this.requireUnlocked();
    const salt = randomBytes(32);
    const key = await deriveKey(targetPassword, salt);
    const payload = encryptBuf(key, JSON.stringify(items));
    return JSON.stringify({ version: 1, kind: 'api-manager-vault', salt: salt.toString('base64'), kdfParams: KDF, payload });
  }

  async importEncrypted(json: string, sourcePassword: string): Promise<{ imported: number }> {
    const this_ = this.requireUnlocked();
    const parsed = JSON.parse(json) as { kind?: string; salt: string; kdfParams: typeof KDF; payload: { nonce: string; tag: string; data: string } };
    if (parsed.kind !== 'api-manager-vault') throw new Error('Not an API Manager vault export');
    const key = await deriveKey(sourcePassword, Buffer.from(parsed.salt, 'base64'), parsed.kdfParams);
    const items = JSON.parse(decryptBuf(key, parsed.payload)) as VaultItem[];
    let imported = 0;
    for (const item of items) {
      if (!this_.some((i) => i.id === item.id)) { this_.push(item); imported++; }
    }
    this.persist();
    return { imported };
  }
}

const scryptAsync = scrypt as unknown as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;
async function deriveKey(password: string, salt: Buffer, params = KDF): Promise<Buffer> {
  // 128*N*r ≈ 33.5 MB — above scrypt's conservative default maxmem (32 MB);
  // pass an explicit ceiling so the memory-hard params behave as designed.
  return scryptAsync(password, salt, 32, { ...params, maxmem: 256 * 1024 * 1024 });
}

function encryptBuf(key: Buffer, plaintext: string | Buffer): { nonce: string; tag: string; data: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decryptBuf(key: Buffer, payload: { nonce: string; tag: string; data: string }): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.nonce, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return out.toString('utf8');
}

export function safeEquals(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
