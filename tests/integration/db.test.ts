import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDb } from '../../src/services/db/sqlite';
import { Repos } from '../../src/services/db/repositories';
import { freshCollection, freshRequest } from '../../src/core/importers/model';
import { uid } from '../../src/shared/ids';
import type { Workspace } from '../../src/shared/types';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'am-db-'));
  dbPath = join(dir, 'data', 'api-manager.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Seed a default workspace (normally done by the app bootstrap). */
function seedWorkspace(repos: Repos): Workspace {
  let ws = repos.listWorkspaces()[0];
  if (!ws) {
    ws = { id: uid(), name: 'My Workspace', description: '', isDefault: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    repos.saveWorkspace(ws);
  }
  return ws;
}

describe('SqliteDb lifecycle (§7 storage / corruption recovery)', () => {
  it('creates a fresh database and schema when no file exists', async () => {
    const { db, corrupted } = await SqliteDb.open(dbPath);
    expect(corrupted).toBe(false);
    expect(existsSync(dbPath)).toBe(true);
    // migrations created core tables
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    for (const t of ['workspaces', 'collections', 'requests', 'environments', 'history', 'responses', 'cookies']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('reopens and preserves data across instances', async () => {
    const opened1 = await SqliteDb.open(dbPath);
    const repos1 = new Repos(opened1.db);
    const ws = seedWorkspace(repos1);
    const col = freshCollection(ws.id, 'Persistent Col');
    repos1.saveCollection(col);
    const req = freshRequest(ws.id, 'Persistent Req', col.id);
    req.url = 'https://persist.test/ok';
    req.method = 'PATCH';
    repos1.saveRequest(req);
    opened1.db.close();

    const opened2 = await SqliteDb.open(dbPath);
    expect(opened2.corrupted).toBe(false);
    const repos2 = new Repos(opened2.db);
    expect(repos2.listCollections(ws.id)[0].name).toBe('Persistent Col');
    const got = repos2.listRequests(ws.id, { collectionId: col.id }).items[0];
    expect(got.name).toBe('Persistent Req');
    expect(got.method).toBe('PATCH');
    expect(got.url).toBe('https://persist.test/ok');
    opened2.db.close();
  });

  it('quarantines a corrupted database file and starts clean, keeping the corrupt copy', async () => {
    // First create a valid DB so the path exists.
    const good = await SqliteDb.open(dbPath);
    good.db.close();
    // Corrupt it with garbage.
    writeFileSync(dbPath, 'this is definitely not a sqlite database' + '\0'.repeat(64));
    const opened = await SqliteDb.open(dbPath);
    expect(opened.corrupted).toBe(true);
    expect(opened.recoveredFrom).toBeTruthy();
    expect(existsSync(opened.recoveredFrom as string)).toBe(true);
    // a healthy new database stands at the original path
    expect(readFileSync(dbPath).subarray(0, 16).toString('latin1')).toContain('SQLite format 3');
    const repos = new Repos(opened.db);
    const ws = seedWorkspace(repos); // migrations re-run; app can bootstrap normally
    expect(repos.getWorkspace(ws.id)?.name).toBe('My Workspace');
    opened.db.close();
  });
});

describe('Repositories CRUD round-trips (§73)', () => {
  it('creates/updates collections and requests and persists nested doc fields', async () => {
    const { db } = await SqliteDb.open(dbPath);
    const repos = new Repos(db);
    const ws = seedWorkspace(repos);
    expect(ws.isDefault).toBe(true);

    const col = repos.saveCollection(freshCollection(ws.id, 'API'));
    const req = freshRequest(ws.id, 'Login', col.id);
    req.method = 'POST';
    req.url = '{{baseUrl}}/login';
    req.headers = [{ id: 'h', key: 'Content-Type', value: 'application/json', enabled: true }];
    req.body = { type: 'json', raw: '{"user":"a"}' };
    req.auth = { type: 'bearer', bearer: { token: '{{token}}' } };
    repos.saveRequest(req);

    // update the same request (same id) → no duplicate
    req.name = 'Login v2';
    repos.saveRequest(req);

    const { items, total } = repos.listRequests(ws.id, { collectionId: col.id });
    expect(total).toBe(1);
    const back = items[0];
    expect(back.name).toBe('Login v2');
    expect(back.body).toMatchObject({ type: 'json', raw: '{"user":"a"}' });
    expect(back.auth).toMatchObject({ type: 'bearer' });
    expect(back.headers[0].key).toBe('Content-Type');
    db.close();
  });

  it('persists environments with variables, including disabled/secret vars', async () => {
    const { db } = await SqliteDb.open(dbPath);
    const repos = new Repos(db);
    const ws = seedWorkspace(repos);
    repos.saveEnvironment({
      id: 'env-1', workspaceId: ws.id, name: 'QA', sortOrder: 0,
      variables: [
        { id: 'v1', key: 'HOST', value: 'qa.test', enabled: true, type: 'default' },
        { id: 'v2', key: 'OFF', value: 'x', enabled: false, type: 'default' },
        { id: 'v3', key: 'SECRET', value: 'shh', enabled: true, type: 'secret' },
      ],
      createdAt: '', updatedAt: '',
    });
    const env = repos.getEnvironment('env-1')!;
    expect(env.name).toBe('QA');
    expect(env.variables).toHaveLength(3);
    expect(env.variables.find((v) => v.key === 'OFF')?.enabled).toBe(false);
    expect(env.variables.find((v) => v.key === 'SECRET')?.type).toBe('secret');
    db.close();
  });

  it('records and searches history', async () => {
    const { db } = await SqliteDb.open(dbPath);
    const repos = new Repos(db);
    const ws = seedWorkspace(repos);
    repos.addHistory({
      id: 'h1', workspaceId: ws.id, requestId: 'r1', name: 'Search users',
      method: 'GET', url: 'https://x.test/users?q=ada', status: 200, durationMs: 12,
      request: { id: 'r1' } as never,
      timestamp: '2026-01-01T00:00:00Z',
    });
    repos.addHistory({
      id: 'h2', workspaceId: ws.id, name: 'Other', method: 'POST', url: 'https://x.test/items',
      status: 500, durationMs: 99, request: { id: 'r2' } as never,
      timestamp: '2026-01-02T00:00:00Z',
    });
    const all = repos.listHistory(ws.id);
    expect(all.total).toBe(2);
    const found = repos.listHistory(ws.id, { search: 'users' });
    expect(found.total).toBe(1);
    expect(found.items[0].name).toBe('Search users');
    // newest first
    expect(all.items[0].id).toBe('h2');
    db.close();
  });

  it('persists responses and computes aggregate stats', async () => {
    const { db } = await SqliteDb.open(dbPath);
    const repos = new Repos(db);
    const ws = seedWorkspace(repos);
    const mk = (id: string, status: number, ms: number) => ({
      id, requestId: 'r1', status, statusText: '', httpVersion: '1.1',
      headers: [], cookies: [], bodyText: '', bodySize: 0,
      timing: { totalMs: ms, dnsMs: 0, connectMs: 0, tlsMs: 0, uploadMs: 0, serverMs: ms, downloadMs: 0 },
      redirects: [], timestamp: `2026-01-01T00:00:0${id.slice(-1)}Z`,
    });
    repos.saveResponse(ws.id, mk('resp1', 200, 10) as never);
    repos.saveResponse(ws.id, mk('resp2', 201, 30) as never);
    repos.saveResponse(ws.id, mk('resp3', 500, 60) as never);
    expect(repos.countResponses(ws.id)).toBe(3);
    const stats = repos.avgResponseStats(ws.id);
    expect(stats.totalSends).toBe(3);
    expect(stats.avgMs).toBeCloseTo(33.33, 1);
    expect(stats.errorRate).toBeCloseTo(1 / 3, 2);
    expect(repos.getResponse('resp2')?.status).toBe(201);
    expect(repos.recentResponses('r1', 2)).toHaveLength(2);
    db.close();
  });

  it('stores, lists and clears cookies per domain', async () => {
    const { db } = await SqliteDb.open(dbPath);
    const repos = new Repos(db);
    const ws = seedWorkspace(repos);
    repos.upsertCookie(ws.id, { id: 'c1', name: 'a', value: '1', domain: 'x.test', path: '/', httpOnly: false, secure: false } as never);
    repos.upsertCookie(ws.id, { id: 'c2', name: 'b', value: '2', domain: 'api.x.test', path: '/', httpOnly: false, secure: false } as never);
    expect(repos.listCookies(ws.id)).toHaveLength(2);
    expect(repos.listCookies(ws.id, 'x.test')).toHaveLength(2); // exact + subdomain
    repos.clearCookies(ws.id, 'api.x.test');
    expect(repos.listCookies(ws.id)).toHaveLength(1);
    db.close();
  });
});
