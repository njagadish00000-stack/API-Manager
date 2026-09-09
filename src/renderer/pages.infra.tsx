/**
 * Infra pages: Vault (AES-256-GCM), Security scanner, Backups, Settings,
 * Git, Plugins, About.
 */
import React, { useEffect, useState } from 'react';
import { call } from './bridge';
import { useApp } from './state';
import { CodeArea, ConfirmButton, ts, uid } from './components';
import type { SecretPattern, BackupInfo, Plugin, AppSettings, SecurityFinding } from '../shared/types';
import type { GitStatusInfo, GitLogEntry } from '../shared/api';

export const DEVELOPER = { name: 'Manish Kumar Singh', email: 'manishkumars264@gmail.com' };

// ---------------------------------------------------------------------------
// Vault
interface SecretMeta { id: string; name: string; description?: string; createdAt: string }
export function VaultPage(): React.ReactElement {
  const s = useApp();
  const [status, setStatus] = useState<{ locked: boolean; itemCount: number; autoLockMinutes: number } | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [list, setList] = useState<SecretMeta[]>([]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');

  const refresh = async (): Promise<void> => {
    const st = await call<{ locked: boolean; itemCount: number; autoLockMinutes: number }>('vault.status', {});
    setStatus(st);
    setInitialized(await call<boolean>('vault.isInitialized', {}));
    if (!st.locked) setList(await call<SecretMeta[]>('vault.list', {}));
  };
  useEffect(() => { void refresh(); }, []);

  const unlock = async (): Promise<void> => {
    setErr('');
    try { await call('vault.unlock', { password }); setPassword(''); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const init = async (): Promise<void> => {
    setErr('');
    if (password !== confirm) { setErr('Passwords do not match'); return; }
    if (password.length < 8) { setErr('Master password must be ≥ 8 characters'); return; }
    try { await call('vault.initialize', { password }); setPassword(''); setConfirm(''); await refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  if (!initialized) {
    return (
      <div className="pad" style={{ maxWidth: 560 }}>
        <h3>Initialize vault</h3>
        <div className="card">
          <div className="muted">AES-256-GCM at rest with a strong KDF. The vault holds secrets worth more than workspace envs (API keys, client secrets, private keys). Choose a strong master password — there is no recovery.</div>
          <label className="lbl">Master password</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label className="lbl">Confirm</label>
          <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {err && <div style={{ color: 'var(--red)', marginTop: 8 }}>{err}</div>}
          <button className="btn primary" style={{ marginTop: 14 }} onClick={() => void init()}>Create vault</button>
        </div>
      </div>
    );
  }

  if (status?.locked !== false) {
    return (
      <div className="pad" style={{ maxWidth: 560 }}>
        <div className="vault-locked">
          <div className="lock">🔒</div>
          <h3>Vault is locked</h3>
          <input className="input" type="password" placeholder="master password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void unlock(); }} />
          {err && <div style={{ color: 'var(--red)' }}>{err}</div>}
          <button className="btn primary" onClick={() => void unlock()}>Unlock</button>
          <div className="muted dim">Unlock lasts until app restart or manual lock (or auto-lock per Settings → Security).</div>
        </div>
      </div>
    );
  }

  return (
    <div className="pad" style={{ maxWidth: 820 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Vault <span className="badge-pill green">unlocked · {status.itemCount} item(s)</span></h3>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAdding(!adding)}>＋ New secret</button>
        <button className="btn danger sm" onClick={() => { void call('vault.lock', {}).then(refresh); }}>🔒 Lock</button>
      </div>
      <div className="muted">Reference secrets anywhere with <code>{'{{vault:name}}'}</code>; they are injected at send-time and never persisted to disk in plain form.</div>
      {adding && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="grid2">
            <div><label className="lbl">Name</label><input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
            <div><label className="lbl">Secret value</label><input className="input" type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} /></div>
          </div>
          <button className="btn primary sm" style={{ marginTop: 10 }} onClick={() => {
            void call('vault.set', { name: newName, secret: newValue }).then(() => { setNewName(''); setNewValue(''); setAdding(false); void refresh(); s.toast('ok', 'Secret stored'); });
          }}>Store</button>
        </div>
      )}
      <table className="tbl" style={{ marginTop: 12 }}>
        <thead><tr><th>Name</th><th>Added</th><th /></tr></thead>
        <tbody>
          {list.map((v) => (
            <tr key={v.id}>
              <td className="mono">{v.name}</td><td>{ts(v.createdAt)}</td>
              <td className="dim">
                <button className="btn xs" onClick={() => { void navigator.clipboard.writeText(`{{vault:${v.name}}}`); s.toast('ok', 'Reference copied'); }}>copy ref</button>
                {'  '}<ConfirmButton label="Delete" className="btn xs danger" onConfirm={() => void call('vault.delete', { id: v.id }).then(refresh)} />
              </td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={3} className="muted">Empty. Add your first secret above — OAuth client secrets, bearer tokens, API keys…</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Security scanner
export function SecurityPage(): React.ReactElement {
  const s = useApp();
  const [patterns, setPatterns] = useState<SecretPattern[]>([]);
  const [findings, setFindings] = useState<SecurityFinding[] | null>(null);
  const [text, setText] = useState('');
  const [textFindings, setTextFindings] = useState<SecurityFinding[] | null>(null);
  const [newPattern, setNewPattern] = useState({ name: '', pattern: '', severity: 'high' });
  const loadPatterns = async (): Promise<void> => setPatterns(await call<SecretPattern[]>('security.patterns', {}));
  useEffect(() => { void loadPatterns(); }, [s.workspaceId]);
  const scan = async (): Promise<void> => {
    const r = await call<SecurityFinding[]>('security.scanWorkspace', {});
    setFindings(r);
    if (r.length === 0) s.toast('ok', 'No secrets found ✓');
  };
  const pill = (sev: string): string => {
    const l = sev.toLowerCase();
    return l.startsWith('crit') || l.startsWith('high') ? 'red' : l.startsWith('med') ? 'yellow' : 'grey';
  };
  return (
    <div className="pad" style={{ maxWidth: 940 }}>
      <h3>Security & secret scanning</h3>
      <div className="row">
        <button className="btn primary" onClick={() => void scan()}>Scan workspace</button>
        <div className="muted" style={{ flex: 1 }}>Built-in patterns: AWS/GCP/Azure keys, JWTs, Bearer tokens, private keys (RSA/EC/OpenSSH), Slack/Stripe/GitHub…</div>
      </div>
      {findings && (
        <div className="card" style={{ marginTop: 14 }}>
          <h4>Workspace findings: {findings.length}</h4>
          {findings.map((f) => (
            <div key={f.id} className="row" style={{ marginTop: 8 }}>
              <span className={`badge-pill ${pill(f.severity)}`}>{f.severity}</span>
              <span className="badge-pill grey">{f.category}</span>
              <span className="mono dim">{f.location}</span>
            </div>
          ))}
          {findings.length === 0 && <div className="muted pad">All clear — no secret-shaped strings in any request/env/spec/doc.</div>}
        </div>
      )}
      <div className="card" style={{ marginTop: 14 }}>
        <h4>Scan arbitrary text</h4>
        <CodeArea minRows={4} value={text} onChange={setText} placeholder="paste a config/log fragment to check for secrets…" />
        <button className="btn" style={{ marginTop: 8 }} onClick={() => { void call<SecurityFinding[]>('security.scanText', { text, location: 'editor paste' }).then(setTextFindings); }}>Scan</button>
        {textFindings && (
          <div style={{ marginTop: 8 }}>
            {textFindings.length === 0 ? <span className="badge-pill green">clean</span> : textFindings.map((f) => (
              <div key={f.id} className="mono" style={{ color: 'var(--yellow)' }}>{f.category}: {f.message}{f.snippet ? ` (${f.snippet})` : ''}</div>
            ))}
          </div>
        )}
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h4>Pattern list ({patterns.length})</h4>
        <table className="tbl">
          <tbody>
            {patterns.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b></td>
                <td className="mono dim" style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.pattern}</td>
                <td><span className={`badge-pill ${pill(p.severity)}`}>{p.severity}</span></td>
                <td>{p.builtin ? <span className="muted">builtin</span> : <ConfirmButton label="Remove" className="btn xs danger" onConfirm={() => void call('security.deletePattern', { id: p.id }).then(loadPatterns)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <input className="input sm" placeholder="name" style={{ width: 200 }} value={newPattern.name} onChange={(e) => setNewPattern({ ...newPattern, name: e.target.value })} />
          <input className="input sm mono" placeholder="regex" value={newPattern.pattern} onChange={(e) => setNewPattern({ ...newPattern, pattern: e.target.value })} />
          <select className="input sm" style={{ width: 110 }} value={newPattern.severity} onChange={(e) => setNewPattern({ ...newPattern, severity: e.target.value })}>
            <option value="critical">critical</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option>
          </select>
          <button className="btn sm primary" onClick={() => {
            void call('security.addPattern', { name: newPattern.name, pattern: newPattern.pattern, severity: newPattern.severity })
              .then(() => { setNewPattern({ name: '', pattern: '', severity: 'high' }); void loadPatterns(); });
          }}>＋ Add pattern</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Backups & recovery
export function BackupPage(): React.ReactElement {
  const s = useApp();
  const [items, setItems] = useState<BackupInfo[]>([]);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (): Promise<void> => setItems(await call<BackupInfo[]>('backup.list', {}));
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="pad" style={{ maxWidth: 860 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Backups</h3><span className="spacer" />
        <input className="input sm" type="password" placeholder="encryption password (optional)" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="btn primary" disabled={busy} onClick={() => {
          setBusy(true);
          void call<BackupInfo>('backup.create', { kind: 'manual', encryptPassword: pw || undefined })
            .then((b) => { s.toast('ok', `Backup created: ${b.path}`); void load(); })
            .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)))
            .finally(() => setBusy(false));
        }}>Create backup</button>
      </div>
      <div className="muted">App-level backups mirror the full database (collections, vault-encrypted contents, settings…). <code>api-manager backup create</code> in CI makes snapshots too.</div>
      <table className="tbl" style={{ marginTop: 12 }}>
        <thead><tr><th>Kind</th><th>Created</th><th>Size</th><th>Encrypted</th><th /></tr></thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.path}>
              <td><span className="badge-pill grey">{b.kind}</span></td>
              <td>{ts(b.createdAt)}</td>
              <td className="num">{(b.sizeBytes / 1024).toFixed(1)} KB</td>
              <td>{b.encrypted ? '🔒' : '—'}</td>
              <td className="row">
                <button className="btn xs" onClick={() => { void call<{ ok: boolean }>('backup.verify', { path: b.path }).then((r) => s.toast(r.ok ? 'ok' : 'err', r.ok ? 'Checksum verified' : 'verification failed')); }}>verify</button>
                <button className="btn xs" onClick={() => {
                  const pw2 = b.encrypted ? (prompt('Decryption password') ?? '') : '';
                  void call('backup.restore', { path: b.path, password: pw2 || undefined }).then(() => {
                    s.toast('ok', 'Restored — reloading…');
                    setTimeout(() => location.reload(), 800);
                  }).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
                }}>restore</button>
                <ConfirmButton label="Delete" className="btn xs danger" onConfirm={() => void call('backup.delete', { path: b.path }).then(load)} />
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={5} className="muted">No backups yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git
export function GitPage(): React.ReactElement {
  const s = useApp();
  const [status, setStatus] = useState<GitStatusInfo | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [remotes, setRemotes] = useState<{ name: string; url: string }[]>([]);
  const [logs, setLogs] = useState<GitLogEntry[]>([]);
  const [repoPath, setRepoPath] = useState('');
  const [branchName, setBranchName] = useState('');
  const [message, setMessage] = useState('');
  const [diffFile, setDiffFile] = useState<string | null>(null);
  const [diffContent, setDiffContent] = useState('');
  const [initialized, setInitialized] = useState(false);
  const refresh = async (): Promise<void> => {
    try {
      setStatus(await call<GitStatusInfo>('git.status', { path: repoPath || undefined }));
      setBranches(await call<string[]>('git.branches', { path: repoPath || undefined }));
      setRemotes(await call<typeof remotes>('git.remotes', { path: repoPath || undefined }));
      setLogs(await call<GitLogEntry[]>('git.log', { path: repoPath || undefined, limit: 30 }).catch(() => [] as GitLogEntry[]));
      setInitialized(true);
    } catch {
      setInitialized(false);
      setStatus(null);
    }
  };
  useEffect(() => { void refresh(); }, []);
  return (
    <div className="pad" style={{ maxWidth: 900 }}>
      <h3>Git version control</h3>
      {!initialized && (
        <div className="card">
          <p>Version-control your workspace data dir (isomorphic-git, fully offline). Initialize to get local commits, branching, and diffing.</p>
          <div className="row">
            <input className="input mono" placeholder="repo path (blank = data dir)" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
            <button className="btn primary" onClick={() => { void call('git.init', { path: repoPath || undefined }).then(refresh).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e))); }}>Initialize</button>
          </div>
        </div>
      )}
      {status && (
        <>
          <div className="row">
            <b>Branch: {status.branch}</b>
            {status.ahead > 0 && <span className="badge-pill blue">↑ {status.ahead}</span>}
            {status.behind > 0 && <span className="badge-pill yellow">↓ {status.behind}</span>}
            {status.staged.length > 0 && <span className="badge-pill green">{status.staged.length} staged</span>}
            {status.modified.length > 0 && <span className="badge-pill yellow">{status.modified.length} modified</span>}
            {status.untracked.length > 0 && <span className="badge-pill grey">{status.untracked.length} untracked</span>}
            <span className="spacer" />
            <button className="btn sm" onClick={() => void refresh()}>refresh</button>
          </div>
          {status.modified.length + status.untracked.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <h4>Changes ({status.modified.length + status.untracked.length})</h4>
              {[...status.modified, ...status.untracked].map((f) => (
                <div key={f} className="row" style={{ marginBottom: 4 }}>
                  <code className="mono">{f}</code><span className="spacer" />
                  <button className="btn xs" onClick={() => void call<string>('git.diff', { path: repoPath || undefined, file: f }).then((d) => { setDiffFile(f); setDiffContent(d); })}>diff</button>
                  <button className="btn xs" onClick={() => void call('git.add', { path: repoPath || undefined, files: [f] }).then(refresh)}>stage</button>
                </div>
              ))}
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => void call('git.addAll', { path: repoPath || undefined }).then(refresh)}>Stage all</button>
            </div>
          )}
          {status.staged.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <h4>Staged ({status.staged.length})</h4>
              {status.staged.map((f) => <div key={f} className="mono dim">{f}</div>)}
            </div>
          )}
          <div className="card" style={{ marginTop: 12 }}>
            <h4>Commit</h4>
            <div className="row">
              <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="commit message…" />
              <button className="btn primary" disabled={!message} onClick={() => {
                void call<{ oid: string; findings: SecurityFinding[] }>('git.commit', { path: repoPath || undefined, message })
                  .then((r) => {
                    if (r.findings.length > 0) s.toast('warn', `Committed ${r.oid.slice(0, 7)} — ⚠ ${r.findings.length} secret-like value(s) detected!`);
                    else s.toast('ok', `Committed ${r.oid.slice(0, 7)}`);
                    setMessage(''); void refresh();
                  })
                  .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
              }}>Commit</button>
            </div>
          </div>
          {diffFile !== null && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="row"><h4>diff — {diffFile}</h4><span className="spacer" /><button className="btn xs" onClick={() => setDiffFile(null)}>close</button></div>
              <pre className="codemini" style={{ maxHeight: 320 }}>{diffContent.split('\n').map((l, i) => (
                <div key={i} style={{ color: l.startsWith('+') && !l.startsWith('+++') ? 'var(--green)' : l.startsWith('-') && !l.startsWith('---') ? 'var(--red)' : l.startsWith('@@') ? 'var(--purple)' : undefined }}>{l}</div>
              ))}</pre>
            </div>
          )}
          <div className="card" style={{ marginTop: 12 }}>
            <h4>Branches</h4>
            {branches.map((b) => (
              <div key={b} className="row" style={{ marginBottom: 4 }}>
                <span className={b === status.branch ? 'badge-pill green' : 'badge-pill grey'}>{b}</span>
                {b !== status.branch && (
                  <button className="btn xs" onClick={() => { void call('git.checkout', { path: repoPath || undefined, ref: b }).then(refresh).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e))); }}>checkout</button>
                )}
                {b !== status.branch && (
                  <button className="btn xs" onClick={() => {
                    void call<{ merged: boolean; conflicts: string[] }>('git.merge', { path: repoPath || undefined, branch: b })
                      .then((r) => { s.toast(r.conflicts.length ? 'warn' : 'ok', r.conflicts.length ? `Conflicts: ${r.conflicts.join(', ')}` : 'Merged'); void refresh(); })
                      .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
                  }}>merge → current</button>
                )}
              </div>
            ))}
            <div className="row" style={{ marginTop: 8 }}>
              <input className="input sm" placeholder="new branch name" value={branchName} onChange={(e) => setBranchName(e.target.value)} />
              <button className="btn sm" disabled={!branchName} onClick={() => void call('git.createBranch', { path: repoPath || undefined, name: branchName, checkout: true }).then(() => { setBranchName(''); void refresh(); })}>＋ Branch</button>
            </div>
          </div>
          <div className="card" style={{ marginTop: 12 }}>
            <h4>Remotes</h4>
            {remotes.map((r) => <div key={r.name} className="row"><b>{r.name}</b><code className="dim mono">{r.url}</code></div>)}
            {remotes.length === 0 && <div className="muted">No remotes configured.</div>}
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn sm" onClick={() => { void call('git.fetch', { path: repoPath || undefined }).then(() => { s.toast('ok', 'Fetched'); void refresh(); }).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e))); }}>☁ fetch</button>
              <button className="btn sm" onClick={() => { void call('git.pull', { path: repoPath || undefined }).then(() => { s.toast('ok', 'Pulled'); void refresh(); }).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e))); }}>↓ pull</button>
              <button className="btn sm" onClick={() => { void call('git.push', { path: repoPath || undefined }).then(() => s.toast('ok', 'Pushed')).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e))); }}>↑ push</button>
              <button className="btn sm" onClick={() => { void call('git.stash', { path: repoPath || undefined }).then(refresh).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e))); }}>stash</button>
              <button className="btn sm" onClick={() => { void call('git.stashPop', { path: repoPath || undefined }).then(refresh).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e))); }}>pop</button>
            </div>
          </div>
          {logs.length > 0 && (
            <div className="card" style={{ marginTop: 12 }}>
              <h4>Log</h4>
              {logs.map((l) => (
                <div key={l.oid} className="row" style={{ marginBottom: 4 }}>
                  <code className="mono dim">{l.oid.slice(0, 7)}</code>
                  <span>{l.message}</span>
                  <span className="dim">{l.author} · {ts(l.date)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plugins
export function PluginsPage(): React.ReactElement {
  const s = useApp();
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const load = async (): Promise<void> => setPlugins(await call<Plugin[]>('plugin.list', {}));
  useEffect(() => { void load(); }, []);
  const [installPath, setInstallPath] = useState('');
  const [hookResult, setHookResult] = useState('');
  return (
    <div className="pad" style={{ maxWidth: 860 }}>
      <h3>Plugins</h3>
      <div className="muted">Local plugins (manifest + script entry) extend the sandbox. Remote registry distribution is on the roadmap; local install works now.</div>
      <div className="row" style={{ marginTop: 12 }}>
        <input className="input mono" placeholder="/path/to/plugin (folder with manifest)" value={installPath} onChange={(e) => setInstallPath(e.target.value)} />
        <button className="btn primary" disabled={!installPath} onClick={() => {
          void call<Plugin>('plugin.install', { path: installPath })
            .then((p) => { s.toast('ok', `Installed ${p.manifest.name}`); void load(); })
            .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
        }}>Install</button>
      </div>
      {plugins.map((p) => (
        <div key={p.id} className="card" style={{ marginTop: 10 }}>
          <div className="row">
            <b>{p.manifest.name}</b><span className="badge-pill grey">v{p.manifest.version}</span>
            <span className={`badge-pill ${p.enabled ? 'green' : 'grey'}`}>{p.enabled ? 'enabled' : 'disabled'}</span>
            <span className="spacer" />
            <button className="btn sm" onClick={() => void call('plugin.setEnabled', { id: p.id, enabled: !p.enabled }).then(load)}>
              {p.enabled ? 'Disable' : 'Enable'}
            </button>
            <ConfirmButton label="Remove" onConfirm={() => void call('plugin.uninstall', { id: p.id }).then(load)} />
          </div>
          {p.manifest.description && <div className="dim" style={{ marginTop: 6 }}>{p.manifest.description}</div>}
          <div className="dim mono" style={{ marginTop: 6 }}>
            entry: {p.manifest.entry} · permissions: {p.manifest.permissions.join(', ') || 'none'} · installed {p.installedAt ? ts(p.installedAt) : ''}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn xs" onClick={() => {
              void call<string>('plugin.runHook', { id: p.id, hook: 'onRequest', payloadJson: '{}' })
                .then((r) => setHookResult(r))
                .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
            }}>run onRequest hook</button>
          </div>
        </div>
      ))}
      {plugins.length === 0 && <div className="empty"><div className="big">🧩</div>No plugins installed.</div>}
      {hookResult && <div className="card" style={{ marginTop: 10 }}><h4>Hook result</h4><pre className="codemini">{hookResult}</pre></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
export function SettingsPage(): React.ReactElement {
  const s = useApp();
  const settings = s.settings;
  const [section, setSection] = useState('general');
  if (!settings) return <div className="empty">Loading settings…</div>;
  const sections = ['general', 'editor', 'network', 'security', 'data', 'runner', 'git'] as const;
  const set = <K extends keyof AppSettings>(key: K, v: AppSettings[K]): void => { void s.updateSettings({ [key]: v } as Partial<AppSettings>); };
  const NUM = (label: string, v: number, onChange: (n: number) => void, hint?: string): React.ReactElement => (
    <div className="row" style={{ marginBottom: 10 }}>
      <span style={{ width: 300 }}>{label}{hint && <span className="dim"> — {hint}</span>}</span>
      <input className="input sm" type="number" style={{ width: 120 }} value={v} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
  const CHECK = (label: string, v: boolean, onChange: (b: boolean) => void, hint?: string): React.ReactElement => (
    <label className="checkbox" style={{ display: 'flex', marginBottom: 10, gap: 8 }}>
      <Switch on={v} onChange={onChange} /> <span>{label}{hint && <span className="dim"> — {hint}</span>}</span>
    </label>
  );
  const g = settings.general, ed = settings.editor, net = settings.network, sec = settings.security, dat = settings.data, run = settings.runner, git = settings.git;
  return (
    <div className="resizable-cols">
      <div className="settings-nav col-l">
        {sections.map((sec2) => (
          <div key={sec2} className={`sn-item ${section === sec2 ? 'sel' : ''}`} onClick={() => setSection(sec2)}>{sec2}</div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 18, maxWidth: 800 }}>
        {section === 'general' && (
          <div>
            <h3>General</h3>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Theme</span>
              <select className="input sm" style={{ width: 170 }} value={g.theme} onChange={(e) => { set('general', { ...g, theme: e.target.value as AppSettings['general']['theme'] }); document.documentElement.setAttribute('data-theme', e.target.value === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : e.target.value); }}>
                <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
              </select>
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Density</span>
              <select className="input sm" style={{ width: 170 }} value={g.density} onChange={(e) => set('general', { ...g, density: e.target.value as AppSettings['general']['density'] })}>
                <option value="comfortable">Comfortable</option><option value="compact">Compact</option>
              </select>
            </div>
            {CHECK('Autosave', g.autosave, (v) => set('general', { ...g, autosave: v }))}
            {NUM('Autosave interval (ms)', g.autosaveIntervalMs, (v) => set('general', { ...g, autosaveIntervalMs: v }))}
            {CHECK('Crash recovery', g.crashRecovery, (v) => set('general', { ...g, crashRecovery: v }))}
            {CHECK('Reopen last workspace on start', g.reopenLastWorkspace, (v) => set('general', { ...g, reopenLastWorkspace: v }))}
            {CHECK('Restore open tabs', g.restoreTabs, (v) => set('general', { ...g, restoreTabs: v }))}
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Telemetry / accounts / cloud sync</span>
              <span className="badge-pill green">always off — offline-first by design</span>
            </div>
          </div>
        )}
        {section === 'editor' && (
          <div>
            <h3>Editor</h3>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Font family</span>
              <input className="input sm mono" style={{ width: 340 }} value={ed.fontFamily} onChange={(e) => set('editor', { ...ed, fontFamily: e.target.value })} />
            </div>
            {NUM('Font size', ed.fontSize, (v) => set('editor', { ...ed, fontSize: v }))}
            {NUM('Tab size', ed.tabSize, (v) => set('editor', { ...ed, tabSize: v }))}
            {CHECK('Word wrap', ed.wordWrap, (v) => set('editor', { ...ed, wordWrap: v }))}
            {CHECK('Line numbers', ed.lineNumbers, (v) => set('editor', { ...ed, lineNumbers: v }))}
            {CHECK('Minimap', ed.minimap, (v) => set('editor', { ...ed, minimap: v }))}
            {CHECK('Bracket matching', ed.bracketMatching, (v) => set('editor', { ...ed, bracketMatching: v }))}
            {NUM('Response zoom', ed.responseZoom, (v) => set('editor', { ...ed, responseZoom: v }), '0.5 – 2')}
            {NUM('Request editor zoom', ed.requestZoom, (v) => set('editor', { ...ed, requestZoom: v }))}
            {NUM('Script editor zoom', ed.scriptZoom, (v) => set('editor', { ...ed, scriptZoom: v }))}
          </div>
        )}
        {section === 'network' && (
          <div>
            <h3>Network</h3>
            {NUM('Default timeout (ms)', net.timeoutMs, (v) => set('network', { ...net, timeoutMs: v }))}
            {CHECK('Follow redirects', net.followRedirects, (v) => set('network', { ...net, followRedirects: v }))}
            {NUM('Max redirects', net.maxRedirects, (v) => set('network', { ...net, maxRedirects: v }))}
            {CHECK('Verify TLS certificates', net.verifyTls, (v) => set('network', { ...net, verifyTls: v }), 'disable only for self-signed dev servers')}
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Proxy mode</span>
              <select className="input sm" style={{ width: 190 }} value={net.proxyMode} onChange={(e) => set('network', { ...net, proxyMode: e.target.value as AppSettings['network']['proxyMode'] })}>
                <option value="system">System (env)</option><option value="custom">Custom</option><option value="none">Off</option>
              </select>
            </div>
            {net.proxyMode === 'custom' && (
              <div className="row" style={{ marginBottom: 10 }}>
                <span style={{ width: 300 }}>Proxy URL</span>
                <input className="input sm mono" style={{ width: 340 }} value={net.proxyUrl ?? ''} onChange={(e) => set('network', { ...net, proxyUrl: e.target.value })} />
              </div>
            )}
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Proxy bypass (one per line)</span>
              <textarea className="input sm mono" rows={3} style={{ width: 340 }} value={net.noProxy.join('\n')} onChange={(e) => set('network', { ...net, noProxy: e.target.value.split('\n').filter(Boolean) })} />
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>HTTP version</span>
              <select className="input sm" style={{ width: 150 }} value={net.httpVersion} onChange={(e) => set('network', { ...net, httpVersion: e.target.value as 'auto' | 'http1' | 'http2' })}>
                <option value="auto">Auto</option><option value="http1">HTTP/1.1</option><option value="http2">HTTP/2</option>
              </select>
            </div>
          </div>
        )}
        {section === 'security' && (
          <div>
            <h3>Security</h3>
            {NUM('Vault auto-lock (minutes, 0 = off)', sec.vaultAutoLockMinutes, (v) => set('security', { ...sec, vaultAutoLockMinutes: v }))}
            {CHECK('Mask secrets in UI', sec.maskSecrets, (v) => set('security', { ...sec, maskSecrets: v }))}
            {CHECK('Encrypt database at rest', sec.encryptDatabase, (v) => set('security', { ...sec, encryptDatabase: v }), 'takes effect on next app start')}
            {CHECK('Run scripts in sandbox', sec.scriptSandbox, (v) => set('security', { ...sec, scriptSandbox: v }))}
            {CHECK('Confirm before running untrusted import scripts', sec.confirmDangerousScripts, (v) => set('security', { ...sec, confirmDangerousScripts: v }))}
            {CHECK('Redact secrets in logs/history', sec.redactSecretsInLogs, (v) => set('security', { ...sec, redactSecretsInLogs: v }))}
          </div>
        )}
        {section === 'data' && (
          <div>
            <h3>Data & storage</h3>
            {NUM('History retention (days)', dat.historyRetentionDays, (v) => set('data', { ...dat, historyRetentionDays: v }))}
            {NUM('Response retention (days)', dat.responseRetentionDays, (v) => set('data', { ...dat, responseRetentionDays: v }))}
            {NUM('Console retention (hours)', dat.consoleRetentionHours, (v) => set('data', { ...dat, consoleRetentionHours: v }))}
            {NUM('Audit retention (days)', dat.auditRetentionDays, (v) => set('data', { ...dat, auditRetentionDays: v }))}
            {NUM('Max stored response body (MB)', Math.round(dat.maxResponseBodyBytes / 1024 / 1024), (v) => set('data', { ...dat, maxResponseBodyBytes: v * 1024 * 1024 }))}
            {CHECK('Automatic backups', dat.autoBackup, (v) => set('data', { ...dat, autoBackup: v }))}
            {NUM('Backup interval (hours)', dat.autoBackupIntervalHours, (v) => set('data', { ...dat, autoBackupIntervalHours: v }))}
            {NUM('Keep backups (count)', dat.maxAutoBackups, (v) => set('data', { ...dat, maxAutoBackups: v }))}
            <div className="card" style={{ marginTop: 14 }}>
              <b>Danger zone</b>
              <div className="muted" style={{ margin: '6px 0' }}>Wipes all rows and reseeds defaults. An automatic backup is made first — restore page lists it after reload.</div>
              <ConfirmButton label="Reset workspace data" className="btn danger" onConfirm={() => {
                void call('db.wipe', {}).then(() => { s.toast('ok', 'Workspace wiped — reloading'); setTimeout(() => location.reload(), 600); });
              }} />
            </div>
          </div>
        )}
        {section === 'runner' && (
          <div>
            <h3>Runner</h3>
            {NUM('Default delay between requests (ms)', run.defaultDelayMs, (v) => set('runner', { ...run, defaultDelayMs: v }))}
            {NUM('Default timeout (ms)', run.defaultTimeoutMs, (v) => set('runner', { ...run, defaultTimeoutMs: v }))}
            {CHECK('Stop on first failure', run.stopOnFailure, (v) => set('runner', { ...run, stopOnFailure: v }))}
            {CHECK('Persist responses in run history', run.persistResponses, (v) => set('runner', { ...run, persistResponses: v }))}
            {NUM('Max concurrency', run.maxConcurrency, (v) => set('runner', { ...run, maxConcurrency: v }))}
          </div>
        )}
        {section === 'git' && (
          <div>
            <h3>Git</h3>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Author name</span>
              <input className="input sm" style={{ width: 260 }} value={git.userName} onChange={(e) => set('git', { ...git, userName: e.target.value })} />
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Author email</span>
              <input className="input sm" style={{ width: 260 }} value={git.userEmail} onChange={(e) => set('git', { ...git, userEmail: e.target.value })} />
            </div>
            <div className="row" style={{ marginBottom: 10 }}>
              <span style={{ width: 300 }}>Default branch</span>
              <input className="input sm" style={{ width: 160 }} value={git.defaultBranch} onChange={(e) => set('git', { ...git, defaultBranch: e.target.value })} />
            </div>
            {CHECK('Scan for secrets before commit', git.secretScanBeforeCommit, (v) => set('git', { ...git, secretScanBeforeCommit: v }))}
            {CHECK('Auto-generate .gitignore', git.autoGenerateGitignore, (v) => set('git', { ...git, autoGenerateGitignore: v }))}
          </div>
        )}
        <div className="card" style={{ marginTop: 24 }}>
          <h4>About</h4>
          <div className="dim">
            API Manager v1.0.0 — offline-first, MIT licensed.<br />
            Developer: <b>{DEVELOPER.name}</b> · <a href={`mailto:${DEVELOPER.email}`}>{DEVELOPER.email}</a>
          </div>
        </div>
      </div>
    </div>
  );
}

function Switch(props: { on: boolean; onChange: (b: boolean) => void }): React.ReactElement {
  return <div className={`switch ${props.on ? 'on' : ''}`} onClick={() => props.onChange(!props.on)} role="switch" aria-checked={props.on} />;
}

export function AboutPage(): React.ReactElement {
  return (
    <div className="pad" style={{ maxWidth: 640 }}>
      <h3>About API Manager</h3>
      <div className="card">
        <b>API Manager</b> — offline-first API development, testing & automation desktop app.
        <div className="dim" style={{ marginTop: 8 }}>
          Developer: <b>{DEVELOPER.name}</b> · <a href={`mailto:${DEVELOPER.email}`}>{DEVELOPER.email}</a><br />
          Version 1.0.0 · MIT License<br />
          No accounts, no telemetry, no cloud — your data stays on your machine.
        </div>
      </div>
    </div>
  );
}
