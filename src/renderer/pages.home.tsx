/**
 * Home: request-free view — workspaces, quick actions, import/export,
 * getting started, app stats.
 */
import React, { useEffect, useState } from 'react';
import { call } from './bridge';
import { useApp } from './state';
import { uid } from './components';

export function HomePage(): React.ReactElement {
  const s = useApp();
  const [importText, setImportText] = useState<string | null>(null);

  const quickImport = async (cmd: string): Promise<void> => {
    if (cmd === 'file') {
      const files = await call<string[]>('dialog.openFile', { multiple: false });
      const f = files?.[0];
      if (!f) return;
      try {
        const r = await call<{ report: { format: string }; collectionIds: string[] }>('import.run', { path: f });
        s.toast('ok', `Imported (${r.report.format})`);
        void s.refreshCollections();
      } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
    } else if (cmd === 'text') {
      setImportText('');
    }
  };

  return (
    <div className="pad" style={{ maxWidth: 940 }}>
      <h2 style={{ margin: '8px 0 2px' }}>API Manager</h2>
      <div className="dim" style={{ marginBottom: 20 }}>Offline-first · Postman-class · workspace <b>{s.workspaces.find((w) => w.id === s.workspaceId)?.name ?? ''}</b></div>

      <div className="grid3">
        <div className="stat-tile"><div className="v">{s.collections.length}</div><div className="l">Collections</div></div>
        <div className="stat-tile"><div className="v">{s.requests.length}</div><div className="l">Saved requests</div></div>
        <div className="stat-tile"><div className="v">{s.environments.length}</div><div className="l">Environments</div></div>
      </div>

      <h3 style={{ marginTop: 22 }}>Quick actions</h3>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button className="btn" onClick={() => s.openTab({ id: `req:new:${uid()}`, kind: 'request', title: 'Untitled' })}>＋ New request</button>
        <button className="btn" onClick={() => { const name = prompt('Collection name'); if (name) void call('collection.create', { name }).then(() => s.refreshCollections()); }}>＋ New collection</button>
        <button className="btn" onClick={() => void quickImport('file')}>⬆ Import file (Postman/OpenAPI/WSDL/SOAPUI/HAR)</button>
        <button className="btn" onClick={() => void quickImport('text')}>⬆ Import raw text</button>
        <button className="btn" onClick={() => {
          void call<string>('export.workspace', {}).then((j) => {
            const blob = new Blob([j], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'workspace.apimanager.json'; a.click();
            URL.revokeObjectURL(url);
          });
        }}>⬇ Backup workspace JSON</button>
      </div>

      <h3 style={{ marginTop: 22 }}>Workspaces</h3>
      <div className="col" style={{ gap: 6 }}>
        {s.workspaces.map((w) => (
          <div key={w.id} className={`card row`} style={{ padding: '8px 12px', borderColor: w.id === s.workspaceId ? 'var(--accent)' : undefined }}>
            <b>{w.name}</b>
            {w.id === s.workspaceId && <span className="badge-pill blue">active</span>}
            <span className="spacer" />
            {w.id !== s.workspaceId && <button className="btn sm" onClick={() => void s.setWorkspace(w.id)}>Switch</button>}
          </div>
        ))}
        <div>
          <button className="btn sm" onClick={() => {
            const name = prompt('Workspace name');
            if (name) void call<{ id: string }>('workspace.create', { name }).then(async (ws) => { await s.refreshWorkspace(); await s.setWorkspace(ws.id); });
          }}>＋ New workspace</button>
        </div>
      </div>

      {importText !== null && (
        <div className="card" style={{ marginTop: 20 }}>
          <h3>Paste to import</h3>
          <div className="muted">Auto-detects: Postman collection/env · OpenAPI JSON/YAML · Swagger · WSDL · SOAPUI XML · HAR · Insomnia · cURL · raw HTTP (.http) · .env</div>
          <textarea className="input mono" rows={10} style={{ marginTop: 8, width: '100%' }} value={importText} onChange={(e) => setImportText(e.target.value)} />
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => {
              void call<{ report: { format: string } }>('import.run', { content: importText })
                .then((r) => { s.toast('ok', `Imported (${r.report.format})`); setImportText(null); void s.refreshCollections(); })
                .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
            }}>Import</button>
            <button className="btn" onClick={() => setImportText(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 22 }}>
        <h3>Getting started</h3>
        <ol className="dim" style={{ lineHeight: 1.8 }}>
          <li>Create a <b>collection</b> (sidebar “＋”), add a request (Ctrl+N or via the sidebar context menu).</li>
          <li>Paste a URL like <code>http://localhost:8080/api</code> — press <b>Send</b>.</li>
          <li>Add <b>variables</b>: <code>{'{{base}}'}</code> resolves from environment → globals; define under “Environments & Vars”.</li>
          <li>Add assertions/tests under <b>Scripts/Tests</b>; run an entire collection with the <b>Runner</b> (⌘+T in Runner tab) or the CLI: <code>api-manager run "My Collection" -e Prod</code>.</li>
          <li>For HTTPS with self-signed dev APIs, toggle “Verify TLS” off under Settings on the request.</li>
        </ol>
      </div>
    </div>
  );
}
