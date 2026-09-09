import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTextForSecrets } from '../../src/core/secrets/scanner';
import { verifyHmacSignature } from '../../src/services/webhooks/webhookServer';
import { Vault } from '../../src/services/vault/vault';

const WS = { id: 'ws-test', name: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };

describe('secret scanner', () => {
  it('flags AWS keys, JWTs, and private key blocks', () => {
    const text = [
      'AWS: AKIAEXAMPLE12345678Z',
      'token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK...\n-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const findings = scanTextForSecrets(text, 'unit-test');
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const cats = findings.map((f) => f.category.toLowerCase() + f.message.toLowerCase()).join(' ');
    expect(cats).toContain('aws');
    expect(cats).toMatch(/jwt|json web token/);
  });

  it('does not flag benign text', () => {
    const findings = scanTextForSecrets('const port = 8080; get("/api/users", handler);', 'unit-test');
    expect(findings).toEqual([]);
  });

  it('masks the secret in findings (never full value)', () => {
    const findings = scanTextForSecrets('AKIAEXAMPLE12345678Z', 'unit');
    expect(findings.length).toBeGreaterThan(0);
    const first = findings[0];
    expect(first.snippet ?? '').not.toContain('AKIAEXAMPLE12345678Z');
  });
});

describe('webhook HMAC verification', () => {
  it('verifies sha256 signature correctly', async () => {
    const { createHmac } = await import('node:crypto');
    const secret = 's3cr3t';
    const body = '{"event":"push"}';
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyHmacSignature(secret, body, sig, 'sha256')).toBe(true);
    expect(verifyHmacSignature(secret, body, 'wronghex', 'sha256')).toBe(false);
    expect(verifyHmacSignature('', body, sig, 'sha256')).toBe(false);
  });
});

describe('vault (AES-256-GCM, scrypt KDF)', () => {
  let dir: string;
  let vault: Vault;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'am-vault-'));
    vault = new Vault(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('initializes → set → lock → unlock → list roundtrip', async () => {
    expect(vault.isInitialized()).toBe(false);
    await vault.initialize('correct horse battery staple');
    expect(vault.isInitialized()).toBe(true);
    vault.set({ name: 'api-key', secret: 'supersecret-value', workspaceId: WS.id });
    const items = vault.list(WS.id);
    expect(items.map((i) => i.name)).toContain('api-key');
    vault.lock();
    expect(vault.status().locked).toBe(true);
    await vault.unlock('correct horse battery staple');
    expect(vault.status().locked).toBe(false);
    const items2 = vault.list(WS.id);
    expect(items2.map((i) => i.name)).toContain('api-key');
  });

  it('rejects a wrong master password', async () => {
    await vault.initialize('right-password-123');
    vault.lock();
    await expect(vault.unlock('wrong-password-123')).rejects.toThrow();
  });

  it('persists the file in encrypted form (no plaintext secrets on disk)', async () => {
    await vault.initialize('pw-1234567');
    vault.set({ name: 'top-secret', secret: 'PLAINTEXT-SENTINEL-9b', workspaceId: WS.id });
    const files = [join(dir, 'vault.bin')];
    const raw = files.filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(raw).not.toContain('PLAINTEXT-SENTINEL-9b');
  });
});
