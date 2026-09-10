import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, emptySession } from '../../src/services/session/sessionStore';
import { SESSION_VERSION } from '../../src/shared/session';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'am-session-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SessionStore crash-safe persistence (§6)', () => {
  it('starts empty when no session file exists', () => {
    const s = new SessionStore(dir);
    expect(s.get().tabs).toEqual([]);
    expect(s.get().version).toBe(SESSION_VERSION);
    expect(s.recoveryStatus().recoveredFromCrash).toBe(false);
  });

  it('persists saves atomically (no lingering tmp file) and stamps cleanExit:false', () => {
    const s = new SessionStore(dir);
    s.save({ tabs: [{ id: 't1', kind: 'request', title: 'Users', entityId: 'req-1' }], activeTabId: 't1' });
    const files = readdirSync(dir);
    expect(files).toContain('session.json');
    expect(files.some((f) => f.startsWith('session.json.tmp'))).toBe(false);
    const onDisk = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'));
    expect(onDisk.cleanExit).toBe(false);
    expect(onDisk.tabs).toHaveLength(1);
    expect(onDisk.saveCounter).toBe(1);
  });

  it('increments saveCounter and merges patches', () => {
    const s = new SessionStore(dir);
    s.save({ tabs: [{ id: 't1', kind: 'request', title: 'A' }] });
    s.save({ activeTabId: 't1', workspaceId: 'w1' });
    expect(s.get().saveCounter).toBe(2);
    expect(s.get().tabs).toHaveLength(1);
    expect(s.get().activeTabId).toBe('t1');
    expect(s.get().workspaceId).toBe('w1');
  });

  it('detects a crash when the previous process never marked a clean exit', () => {
    // Simulate a "killed" previous instance: save then no markCleanExit.
    const s1 = new SessionStore(dir);
    s1.save({ tabs: [{ id: 't1', kind: 'request', title: 'DRAFT', dirty: true, draft: { method: 'POST', url: 'https://x.test' } }] });
    // process dies here (no markCleanExit)
    const s2 = new SessionStore(dir);
    const rec = s2.recoveryStatus();
    expect(rec.recoveredFromCrash).toBe(true);
    expect(rec.note).toContain('did not record a clean exit');
    expect(rec.tabCount).toBe(1);
    // the crashed session was copied aside for inspection
    expect(existsSync(join(dir, 'session.previous.json'))).toBe(true);
    // tabs/drafts restored intact
    expect(s2.get().tabs[0].title).toBe('DRAFT');
    expect(s2.get().tabs[0].draft).toMatchObject({ method: 'POST', url: 'https://x.test' });
  });

  it('does NOT flag a crash after a graceful exit', () => {
    const s1 = new SessionStore(dir);
    s1.save({ tabs: [{ id: 't1', kind: 'request', title: 'A' }] });
    s1.markCleanExit();
    const s2 = new SessionStore(dir);
    expect(s2.recoveryStatus().recoveredFromCrash).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')).cleanExit).toBe(true);
  });

  it('acknowledging/re-saving after recovery returns to live cleanExit:false state', () => {
    const s1 = new SessionStore(dir);
    s1.save({ tabs: [{ id: 't1', kind: 'request', title: 'A' }] });
    const s2 = new SessionStore(dir);
    expect(s2.recoveryStatus().recoveredFromCrash).toBe(true);
    s2.save({ consoleOpen: true });
    // crash flag is a one-shot startup signal; file content must be live again
    expect(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')).cleanExit).toBe(false);
  });

  it('quarantines a corrupt session file instead of crashing or overwriting', () => {
    writeFileSync(join(dir, 'session.json'), '{ this is not valid json,,,', 'utf8');
    const s = new SessionStore(dir);
    expect(s.get().tabs).toEqual([]);
    expect(s.recoveryStatus().recoveredFromCrash).toBe(true);
    expect(s.recoveryStatus().note).toMatch(/quarantined|unreadable/i);
    const quarantined = readdirSync(dir).filter((f) => f.startsWith('session.corrupt-'));
    expect(quarantined).toHaveLength(1);
    // and subsequent saves still work, producing a healthy file
    s.save({ tabs: [{ id: 't', kind: 'request', title: 'Recovered' }] });
    expect(JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')).tabs[0].title).toBe('Recovered');
  });

  it('sanitizes malformed incoming state and caps tab count defensively', () => {
    writeFileSync(join(dir, 'session.json'), JSON.stringify({
      version: 999,
      cleanExit: false,
      saveCounter: 5,
      tabs: 'not-an-array' as unknown,
    }), 'utf8');
    const s = new SessionStore(dir);
    expect(s.get().version).toBe(SESSION_VERSION);
    expect(Array.isArray(s.get().tabs)).toBe(true);
  });

  it('clear() writes an empty clean session', () => {
    const s = new SessionStore(dir);
    s.save({ tabs: [{ id: 't1', kind: 'request', title: 'A' }] });
    s.clear();
    expect(s.get().tabs).toHaveLength(0);
    expect(s.get().cleanExit).toBe(true);
    expect(s.recoveryStatus().recoveredFromCrash).toBe(false);
  });

  it('emptySession defaults are sane', () => {
    const e = emptySession();
    expect(e.tabs).toEqual([]);
    expect(e.cleanExit).toBe(false);
    expect(e.saveCounter).toBe(0);
  });
});
