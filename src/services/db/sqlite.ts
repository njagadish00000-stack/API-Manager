/**
 * SQLite database wrapper using sql.js (WASM build of SQLite — real SQLite,
 * zero native dependencies, works identically in Node and packaged apps).
 * Handles migrations, persistence, corruption recovery, diagnostics (§73).
 */
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MIGRATIONS } from './migrations';
import { now } from '../../shared/types';

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function locateWasm(): string {
  if (process.env.API_MANAGER_SQL_WASM) return process.env.API_MANAGER_SQL_WASM;
  // Resolution anchors (__dirname in CJS bundles, import.meta in ESM/examples below)
  const anchors: string[] = [];
  try { anchors.push(__filename); } catch { /* ESM */ }
  if (typeof import.meta !== 'undefined') {
    const metaUrl = (import.meta as unknown as { url?: string }).url;
    if (metaUrl) anchors.push(metaUrl);
  }
  if (process.argv[1]) anchors.push(process.argv[1]);
  anchors.push(join(process.cwd(), '.build-anchor.cjs'));
  for (const anchor of anchors) {
    try { return createRequire(anchor).resolve('sql.js/dist/sql-wasm.wasm'); } catch { /* next anchor */ }
  }
  const here = anchors.map((a) => { try { return dirname(a); } catch { return ''; } }).filter(Boolean);
  const candidates = here.flatMap((h) => [
    join(h, 'sql-wasm.wasm'),
    join(h, '..', 'sql-wasm.wasm'),
    join(h, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    join(h, '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
    join(h, '..', '..', '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  ]);
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error('sql-wasm.wasm not found; launch from the app bundle or set API_MANAGER_SQL_WASM');
}

export function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs({ locateFile: () => locateWasm() });
  }
  return sqlJsPromise as Promise<SqlJsStatic>;
}

export type Row = Record<string, unknown>;

export interface DbOpenResult { corrupted: boolean; recoveredFrom?: string }

export class SqliteDb {
  db!: Database;
  path: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  destroyed = false;

  private constructor(path: string) {
    this.path = path;
  }

  static async open(path: string): Promise<{ db: SqliteDb; corrupted: boolean; recoveredFrom?: string }> {
    const SQL = await getSqlJs();
    const wrapper = new SqliteDb(path);
    mkdirSync(dirname(path), { recursive: true });
    let corrupted = false;
    let recoveredFrom: string | undefined;
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      try {
        wrapper.db = new SQL.Database(bytes);
        wrapper.get('SELECT 1 AS ok');
      } catch (e) {
        corrupted = true;
        recoveredFrom = `${path}.corrupt-${Date.now()}`;
        try { renameSync(path, recoveredFrom); } catch { /* best effort */ }
        wrapper.db = new SQL.Database();
      }
    } else {
      wrapper.db = new SQL.Database();
    }
    wrapper.db.run('PRAGMA foreign_keys = ON;');
    wrapper.db.run('PRAGMA journal_mode = MEMORY;'); // sql.js persists manually
    wrapper.migrate();
    wrapper.saveNow();
    return { db: wrapper, corrupted, recoveredFrom };
  }

  // ------------------------------------------------------------------ queries
  private p(param: unknown): string | number | Uint8Array | null {
    if (param === undefined || param === null) return null;
    if (typeof param === 'boolean') return param ? 1 : 0;
    if (typeof param === 'number' || typeof param === 'string') return param;
    if (param instanceof Uint8Array) return param;
    return JSON.stringify(param);
  }

  private params(params: unknown[] = []): (string | number | Uint8Array | null)[] {
    return params.map((x) => this.p(x));
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, this.params(params));
    this.markDirty();
  }

  get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(this.params(params));
      if (stmt.step()) return stmt.getAsObject() as T;
      return undefined;
    } finally {
      stmt.free();
    }
  }

  all<T = Row>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    const out: T[] = [];
    try {
      stmt.bind(this.params(params));
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally {
      stmt.free();
    }
  }

  scalar<T = unknown>(sql: string, params: unknown[] = []): T | undefined {
    const row = this.get<Row>(sql, params);
    if (!row) return undefined;
    return Object.values(row)[0] as T;
  }

  tx<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      this.markDirty();
      return result;
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
  }

  // -------------------------------------------------------------- migrations
  migrate(): { applied: string[] } {
    this.db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = new Set(this.all<{ name: string }>('SELECT name FROM schema_migrations').map((r) => r.name));
    const newly: string[] = [];
    for (const m of MIGRATIONS) {
      if (applied.has(m.name)) continue;
      this.tx(() => {
        const statements = m.sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
        for (const stmt of statements) this.db.run(stmt);
        this.db.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [m.name, now()]);
      });
      newly.push(m.name);
    }
    return { applied: newly };
  }

  migrationStatus(): { applied: number; latest: number; pending: string[] } {
    const rows = this.all<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    const names = new Set(rows.map((r) => r.name));
    return {
      applied: rows.length,
      latest: MIGRATIONS.length,
      pending: MIGRATIONS.filter((m) => !names.has(m.name)).map((m) => m.name),
    };
  }

  // -------------------------------------------------------------- persistence
  private markDirty(): void {
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 300);
      if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref();
    }
  }

  saveNow(): void {
    if (this.destroyed) return;
    if (!this.dirty && existsSync(this.path)) return;
    try {
      const data = this.db.export();
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, Buffer.from(data));
      renameSync(tmp, this.path);
      this.dirty = false;
    } catch (e) {
      console.error('[db] failed to persist database:', e);
    }
  }

  flush(): void { this.saveNow(); }

  close(): void {
    if (this.destroyed) return;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.saveNow();
    this.destroyed = true;
    this.db.close();
  }

  // -------------------------------------------------------------- diagnostics
  integrityCheck(): { ok: boolean; report: string } {
    try {
      const rows = this.all<{ integrity_check: string }>('PRAGMA integrity_check(20)');
      const report = rows.map((r) => r.integrity_check).join('\n');
      return { ok: report.trim() === 'ok', report };
    } catch (e) {
      return { ok: false, report: e instanceof Error ? e.message : String(e) };
    }
  }

  wipeAll(): void {
    const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'");
    const names: string[] = [];
    while (tables.step()) {
      const row = tables.getAsObject() as { name: string };
      if (row.name !== 'sqlite_sequence' && row.name !== 'schema_meta') names.push(row.name);
    }
    tables.free();
    this.db.run('BEGIN');
    try {
      for (const n of names) this.db.run('DELETE FROM "' + n + '"');
      this.db.run('COMMIT');
    } catch (e) { this.db.run('ROLLBACK'); throw e; }
    this.markDirty();
  }

  vacuum(): void {
    this.db.run('VACUUM');
    this.markDirty();
    this.saveNow();
  }

  diagnostics(): { sizeBytes: number; integrityOk: boolean; quickCheck: string; schemaVersion: number; tableCounts: Record<string, number>; walMode: boolean } {
    this.saveNow();
    const sizeBytes = existsSync(this.path) ? statSync(this.path).size : 0;
    const tables = this.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`);
    const counts: Record<string, number> = {};
    for (const t of tables) {
      counts[t.name] = Number(this.scalar(`SELECT COUNT(*) FROM "${t.name}"`) ?? 0);
    }
    const integrity = this.integrityCheck();
    return { sizeBytes, integrityOk: integrity.ok, quickCheck: integrity.report.split('\n')[0] ?? '', schemaVersion: this.migrationStatus().applied, tableCounts: counts, walMode: false };
  }
}
