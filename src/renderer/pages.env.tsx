/**
 * Environments & variables pages: environments CRUD, globals, cookie jar,
 * script library, snapshots.
 */
import React, { useEffect, useState } from 'react';
import { call } from './bridge';
import { useApp } from './state';
import { CodeArea, ConfirmButton, KVEditor, Modal, ts, uid } from './components';
import type { Environment, KeyValue, Variable, ScriptLibraryEntry, Snapshot, StoredCookie } from '../shared/types';

export function EnvironmentsPage(): React.ReactElement {
  const s = useApp();
  const [sel, setSel] = useState<string | null>(null);
  const env = s.environments.find((e) => e.id === sel) ?? s.environments[0];
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 270, padding: 10 }}>
        <div className="row" style={{ marginBottom: 8 }}>
          <b>Environments</b><span className="spacer" />
          <button className="btn sm" onClick={() => {
            const name = prompt('New environment name'); if (name) void call('environment.create', { name }).then(() => s.refreshEnvironments());
          }}>＋</button>
        </div>
        {s.environments.map((e) => (
          <div key={e.id} className={`tree-item ${env?.id === e.id ? 'sel' : ''}`} onClick={() => setSel(e.id)}>
            <span className="ti-label">{e.name}</span>
            {s.activeEnvironmentId === e.id && <span className="badge-pill green">active</span>}
          </div>
        ))}
        {s.environments.length === 0 && <div className="muted pad">No environments yet.</div>}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {env ? <EnvEditor env={env} onChanged={() => void s.refreshEnvironments()} isActive={s.activeEnvironmentId === env.id}
          onActivate={() => void s.setActiveEnvironment(env.id)} /> : <div className="empty">Create an environment to start defining variables.</div>}
      </div>
    </div>
  );
}

function EnvEditor(props: { env: Environment; onChanged: () => void; isActive: boolean; onActivate: () => void }): React.ReactElement {
  const s = useApp();
  const [vars, setVars] = useState<Variable[]>(props.env.variables);
  const [name, setName] = useState(props.env.name);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { setVars(props.env.variables); setName(props.env.name); setDirty(false); }, [props.env.id, props.env]);
  const save = async (): Promise<void> => {
    await call('environment.update', { id: props.env.id, patch: { name, variables: vars } });
    setDirty(false); props.onChanged();
  };
  return (
    <div style={{ maxWidth: 860 }}>
      <div className="row">
        <input className="input" style={{ width: 260, fontWeight: 600 }} value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
        {props.isActive ? <span className="badge-pill green">active</span> : <button className="btn sm" onClick={props.onActivate}>Make active</button>}
        <span className="spacer" />
        <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(JSON.stringify(vars, null, 2)); }}>Copy JSON</button>
        <button className="btn sm" onClick={() => void call<string>('environment.exportDotEnv', { id: props.env.id }).then((t) => { void navigator.clipboard.writeText(t); s.toast('ok', '.env copied'); })}>Export .env</button>
        <button className="btn primary sm" onClick={() => void save()}>{dirty ? 'Save*' : 'Save'}</button>
        <ConfirmButton label="Delete" onConfirm={() => { void call('environment.delete', { id: props.env.id }).then(() => s.refreshEnvironments()); }} />
      </div>
      <VariableTable vars={vars} setVars={(v) => { setVars(v); setDirty(true); }} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn sm" onClick={() => { const v = [...vars, { id: uid(), key: '', value: '', type: 'default' as const, enabled: true }]; setVars(v); setDirty(true); }}>+ Add variable</button>
        <button className="btn sm" onClick={() => {
          const text = prompt('Paste .env lines (KEY=VALUE)'); if (!text) return;
          void call<Environment>('environment.importDotEnv', { content: text, name: name + '-imported' }).then(() => s.refreshEnvironments());
        }}>Import .env</button>
      </div>
    </div>
  );
}

function VariableTable(props: { vars: Variable[]; setVars: (v: Variable[]) => void }): React.ReactElement {
  const { vars } = props;
  const update = (i: number, patch: Partial<Variable>): void => props.setVars(vars.map((v, k) => (k === i ? { ...v, ...patch } : v)));
  return (
    <table className="tbl" style={{ marginTop: 14 }}>
      <thead><tr><th>On</th><th style={{ width: 260 }}>Key</th><th>Value</th><th style={{ width: 100 }}>Kind</th></tr></thead>
      <tbody>
        {vars.map((v, i) => (
          <tr key={v.id}>
            <td><input type="checkbox" checked={v.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} /></td>
            <td><input className="input sm" value={v.key} onChange={(e) => update(i, { key: e.target.value })} /></td>
            <td><input className="input sm mono" type={v.type === 'secret' ? 'password' : 'text'} value={v.value} onChange={(e) => update(i, { value: e.target.value })} /></td>
            <td>
              <select className="input sm" value={v.type} onChange={(e) => update(i, { type: e.target.value as Variable['type'] })}>
                <option value="default">default</option><option value="secret">secret</option>
              </select>
            </td>
            <td><button className="icon-btn" onClick={() => props.setVars(vars.filter((_, k) => k !== i))}>✕</button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function GlobalsPage(): React.ReactElement {
  const s = useApp();
  const [vars, setVars] = useState<Variable[]>([]);
  const [dirty, setDirty] = useState(false);
  const load = async (): Promise<void> => {
    const list = await call<Variable[]>('variables.globals', {});
    setVars(list); setDirty(false);
  };
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="pad" style={{ maxWidth: 860 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Global variables</h3><span className="spacer" />
        <button className="btn primary sm" onClick={() => {
          void call('variables.setGlobals', { variables: vars }).then(() => { setDirty(false); s.toast('ok', 'Globals saved'); });
        }}>{dirty ? 'Save*' : 'Save'}</button>
      </div>
      <div className="muted">Globals apply across the whole app; per-workspace data overrides them.</div>
      <VariableTable vars={vars} setVars={(v) => { setVars(v); setDirty(true); }} />
      <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setVars([...vars, { id: uid(), key: '', value: '', type: 'default', enabled: true }])}>+ Add</button>
    </div>
  );
}

export function CookiesPage(): React.ReactElement {
  const s = useApp();
  const [cookies, setCookies] = useState<StoredCookie[]>([]);
  const [importText, setImportText] = useState<string | null>(null);
  const load = async (): Promise<void> => {
    const list = await call<StoredCookie[]>('cookies.list', {});
    setCookies(list);
  };
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="pad">
      <div className="row">
        <h3 style={{ margin: 0 }}>Cookie jar</h3><span className="spacer" />
        <button className="btn sm" onClick={() => setImportText('')}>Import</button>
        <button className="btn sm" onClick={() => void call<string>('cookies.export', { format: 'json' }).then((j) => { void navigator.clipboard.writeText(j); s.toast('ok', 'Copied JSON'); })}>Export JSON</button>
        <ConfirmButton label="Clear all" onConfirm={() => void call('cookies.clear', {}).then(load)} />
      </div>
      <table className="tbl" style={{ marginTop: 12 }}>
        <thead><tr><th>Domain</th><th>Name</th><th>Value</th><th>Path</th><th>Expires</th><th>Flags</th><th /></tr></thead>
        <tbody>
          {cookies.map((c, i) => (
            <tr key={i}>
              <td>{c.domain}</td><td className="mono">{c.name}</td><td className="mono">{c.value}</td>
              <td>{c.path}</td><td>{c.expires ? ts(c.expires) : 'Session'}</td>
              <td>{c.httpOnly ? 'HttpOnly ' : ''}{c.secure ? 'Secure' : ''}</td>
              <td><button className="icon-btn" onClick={() => void call('cookies.delete', { ...c }).then(load)}>✕</button></td>
            </tr>
          ))}
          {cookies.length === 0 && <tr><td colSpan={7} className="muted">No cookies yet.</td></tr>}
        </tbody>
      </table>
      {importText !== null && (
        <Modal title="Import cookies" onClose={() => setImportText(null)} footer={<>
          <button className="btn" onClick={() => setImportText(null)}>Cancel</button>
          <button className="btn primary" onClick={() => {
            const format: 'json' | 'netscape' = importText.trimStart().startsWith('[') || importText.trimStart().startsWith('{') ? 'json' : 'netscape';
            void call<{ count: number }>('cookies.import', { content: importText, format })
              .then((r) => { s.toast('ok', `Imported ${r.count} cookies`); setImportText(null); void load(); })
              .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
          }}>Import</button>
        </>}>
          <CodeArea minRows={8} value={importText} onChange={setImportText} placeholder='Paste cookies JSON array or Netscape txt format…' />
        </Modal>
      )}
    </div>
  );
}

export function ScriptLibraryPage(): React.ReactElement {
  const s = useApp();
  const [entries, setEntries] = useState<ScriptLibraryEntry[]>([]);
  const [editing, setEditing] = useState<ScriptLibraryEntry | null>(null);
  const load = async (): Promise<void> => {
    const list = await call<ScriptLibraryEntry[]>('scriptLibrary.list', {});
    setEntries(list);
  };
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="pad">
      <div className="row"><h3 style={{ margin: 0 }}>Script library</h3><span className="spacer" />
        <button className="btn sm" onClick={() => setEditing({ id: uid(), name: '', code: '', version: 1, tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })}>＋ New</button></div>
      <div className="muted">Reusable <code>pm.*</code> snippets; insert into any request's Scripts tabs.</div>
      {entries.map((e) => (
        <div key={e.id} className="card" style={{ marginTop: 10 }}>
          <div className="row">
            <b>{e.name}</b><span className="badge-pill grey">v{e.version}</span>
            <span className="dim">{ts(e.updatedAt)}</span><span className="spacer" />
            <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(e.code); s.toast('ok', 'Copied'); }}>Copy</button>
            <button className="btn sm" onClick={() => setEditing(e)}>Edit</button>
            <button className="btn sm" onClick={() => void call<string>('scriptLibrary.export', { id: e.id }).then((j) => { void navigator.clipboard.writeText(j); s.toast('ok', 'Exported'); })}>Export</button>
            <ConfirmButton label="Delete" onConfirm={() => void call('scriptLibrary.delete', { id: e.id }).then(load)} />
          </div>
          <pre className="codemini" style={{ marginTop: 8 }}>{e.code}</pre>
        </div>
      ))}
      {entries.length === 0 && <div className="empty"><div className="big">📚</div>No library entries yet.</div>}
      {editing && <ScriptEditor entry={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
    </div>
  );
}

function ScriptEditor(props: { entry: ScriptLibraryEntry; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const s = useApp();
  const [entry, setEntry] = useState(props.entry);
  return (
    <Modal title={entry.name ? 'Edit library script' : 'New library script'} onClose={props.onClose}
      footer={<>
        <button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn primary" onClick={() => {
          void call('scriptLibrary.save', { entry: { ...entry, updatedAt: new Date().toISOString() } })
            .then(() => props.onSaved())
            .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
        }}>Save</button>
      </>}>
      <label className="lbl">Name</label>
      <input className="input" value={entry.name} onChange={(e) => setEntry({ ...entry, name: e.target.value })} />
      <label className="lbl">Code</label>
      <CodeArea minRows={14} value={entry.code} onChange={(code) => setEntry({ ...entry, code })} />
    </Modal>
  );
}

export function SnapshotsPage(): React.ReactElement {
  const s = useApp();
  const [requestId, setRequestId] = useState('');
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  useEffect(() => {
    if (!requestId) { setSnaps([]); return; }
    void call<Snapshot[]>('snapshot.list', { requestId }).then(setSnaps).catch(() => setSnaps([]));
  }, [requestId]);
  return (
    <div className="pad">
      <h3>Snapshots</h3>
      <select className="input" style={{ width: 420 }} value={requestId} onChange={(e) => setRequestId(e.target.value)}>
        <option value="">(choose a request)</option>
        {s.requests.map((r) => <option key={r.id} value={r.id}>{r.method} · {r.name}</option>)}
      </select>
      {requestId && snaps.map((snap) => (
        <div key={snap.id} className="card" style={{ marginTop: 10 }}>
          <div className="row">
            <b>{snap.name}</b><span className="dim">{ts(snap.createdAt)}</span><span className="spacer" />
            <span className="badge-pill blue">{snap.response.status}</span>
            <ConfirmButton label="Delete" onConfirm={() => void call('snapshot.delete', { id: snap.id }).then(() => call<Snapshot[]>('snapshot.list', { requestId }).then(setSnaps))} />
          </div>
          <JsonViewMin text={snap.response.bodyText ?? ''} />
        </div>
      ))}
      {requestId && snaps.length === 0 && <div className="muted" style={{ marginTop: 10 }}>No snapshots for this request. Create one from a response in the request tab ("snapshot" action).</div>}
    </div>
  );
}

function JsonViewMin(props: { text: string }): React.ReactElement {
  let t = props.text;
  try { t = JSON.stringify(JSON.parse(t), null, 2); } catch { /* non-json */ }
  return <pre className="codemini" style={{ marginTop: 8, maxHeight: 220, overflow: 'auto' }}>{t.slice(0, 4000)}</pre>;
}
