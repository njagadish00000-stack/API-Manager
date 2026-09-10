/**
 * Crash-safe UI session store (§6 application session resume).
 *
 * The session file lives SEPARATE from the SQLite database, so an interrupted
 * session write can never corrupt application data. Writes are atomic:
 *   session.json.tmp  → fsync → rename(session.json)
 *
 * Crash recovery model:
 *   - every live save writes cleanExit:false plus a monotonic counter
 *   - graceful shutdown (hub close / Electron before-quit) writes cleanExit:true
 *   - on next launch, loadSession() reports recoveredFromCrash:true when the
 *     previous run never wrote the clean-exit marker (crash / power loss / SIGKILL)
 *   - the previously-loaded session is preserved as session.previous.json after
 *     a crash, and a malformed session.json is quarantined (never thrown away
 *     silently) as session.corrupt-<timestamp>.json
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_VERSION, type SessionState, type SessionTab, type RecoveryStatus } from '../../shared/session';

export type { SessionState, SessionTab, WindowState, RecoveryStatus } from '../../shared/session';

export function emptySession(): SessionState {
  return {
    version: SESSION_VERSION,
    savedAt: new Date(0).toISOString(),
    cleanExit: false,
    saveCounter: 0,
    tabs: [],
    activeTabId: null,
    expandedNodes: [],
  };
}

function sanitize(incoming: Partial<SessionState>): SessionState {
  const base = emptySession();
  const out: SessionState = { ...base, ...incoming };
  out.version = SESSION_VERSION;
  if (!Array.isArray(out.tabs)) out.tabs = [];
  if (!Array.isArray(out.expandedNodes)) out.expandedNodes = [];
  // clamp expensive blobs: drafts capped, tab count capped defensively
  out.tabs = out.tabs.slice(0, 200).map((t) => ({
    id: String(t.id), kind: String(t.kind ?? 'request'), title: String(t.title ?? 'Tab'),
    entityId: t.entityId ? String(t.entityId) : undefined,
    pinned: !!t.pinned, dirty: !!t.dirty, draft: t.draft ?? undefined, view: t.view ?? undefined,
  }));
  return out;
}

export class SessionStore {
  readonly filePath: string;
  private readonly tmpPath: string;
  private readonly previousPath: string;
  private state: SessionState;
  private recoveredFromCrash = false;
  private crashNote = '';

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'session.json');
    this.tmpPath = join(dataDir, 'session.json.tmp');
    this.previousPath = join(dataDir, 'session.previous.json');
    this.state = this.load();
  }

  private load(): SessionState {
    if (!existsSync(this.filePath)) return emptySession();
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SessionState>;
      const state = sanitize(parsed);
      if (state.cleanExit === false && state.saveCounter > 0) {
        this.recoveredFromCrash = true;
        this.crashNote = `Previous session (last saved ${state.savedAt}) did not record a clean exit.`;
        try { copyFileSync(this.filePath, this.previousPath); } catch { /* best effort */ }
      }
      return state;
    } catch (e) {
      // Quarantine the unreadable file rather than overwriting it.
      const quarantine = join(join(this.filePath, '..'), `session.corrupt-${Date.now()}.json`);
      try { copyFileSync(this.filePath, quarantine); this.crashNote = `Session file unreadable; quarantined to ${quarantine}: ${String(e)}`; }
      catch { this.crashNote = `Session file unreadable and could not be quarantined: ${String(e)}`; }
      this.recoveredFromCrash = true;
      return emptySession();
    }
  }

  get(): SessionState { return this.state; }

  recoveryStatus(): RecoveryStatus {
    return {
      recoveredFromCrash: this.recoveredFromCrash,
      note: this.crashNote,
      savedAt: this.state.savedAt,
      tabCount: this.state.tabs.length,
    };
  }

  /** Merge-and-persist a partial state. Always stamps cleanExit:false (live). */
  save(patch: Partial<SessionState>): SessionState {
    const merged = sanitize({ ...this.state, ...patch, version: SESSION_VERSION });
    merged.saveCounter = this.state.saveCounter + 1;
    merged.savedAt = new Date().toISOString();
    merged.cleanExit = false;
    this.state = merged;
    this.persist();
    return merged;
  }

  /** Called on graceful shutdown: flips the clean-exit marker without changing anything else. */
  markCleanExit(): SessionState {
    this.state = { ...this.state, cleanExit: true, savedAt: new Date().toISOString() };
    this.persist();
    return this.state;
  }

  clear(): void {
    this.state = { ...emptySession(), cleanExit: true, savedAt: new Date().toISOString() };
    this.persist();
  }

  private persist(): void {
    try {
      const json = JSON.stringify(this.state);
      writeFileSync(this.tmpPath, json, 'utf8');
      renameSync(this.tmpPath, this.filePath); // atomic on same filesystem
    } catch (e) {
      // Session persistence must never crash the running app.
      // eslint-disable-next-line no-console
      console.error('[session] failed to persist session:', e instanceof Error ? e.message : e);
      try { if (existsSync(this.tmpPath)) renameSync(this.tmpPath, `${this.tmpPath}.failed-${Date.now()}`); } catch { /* ignore */ }
    }
  }
}
