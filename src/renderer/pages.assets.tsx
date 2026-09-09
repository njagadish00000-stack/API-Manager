/**
 * Asset & analysis pages: Specs/APIs, Docs, Files/Attachments, Governance,
 * Inventory (ports/listeners), global Search & Replace, Analytics, Audit log.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { call } from './bridge';
import { useApp } from './state';
import { Chart, CodeArea, ConfirmButton, Modal, SubTabs, ts, uid } from './components';
import type { Specification, GovernanceRule, SecurityFinding, AuditEvent, Attachment, DocSite, NetworkPortInfo } from '../shared/types';
import type { SearchHit, SpecValidation, BreakingChange, SpecFormat } from '../shared/api-types';

// ---------------------------------------------------------------------------
// Specs
export function SpecsPage(): React.ReactElement {
  const s = useApp();
  const [specs, setSpecs] = useState<Specification[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [lint, setLint] = useState<SpecValidation | null>(null);
  const [breaking, setBreaking] = useState<BreakingChange[] | null>(null);
  const [tab, setTab] = useState('edit');
  const load = async (): Promise<void> => setSpecs(await call<Specification[]>('spec.list', {}));
  useEffect(() => { void load(); }, [s.workspaceId]);
  const current = specs.find((x) => x.id === sel) ?? specs[0];
  useEffect(() => { setContent(current?.content ?? ''); setLint(null); setBreaking(null); }, [current?.id]);
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 270, padding: 10 }}>
        <div className="row"><b>Specifications</b><span className="spacer" />
          <button className="btn sm" onClick={() => {
            const name = prompt('Spec name'); if (!name) return;
            void call('spec.create', { name, format: 'openapi3', content: '{\n  "openapi": "3.0.0",\n  "info": { "title": "Example", "version": "1.0.0" },\n  "paths": {}\n}\n' }).then(load);
          }}>＋</button></div>
        {specs.map((x) => (
          <div key={x.id} className={`tree-item ${current?.id === x.id ? 'sel' : ''}`} onClick={() => setSel(x.id)}>
            <span className="ti-label">{x.name}</span><span className="badge-pill grey">{x.format}</span>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {current ? (
          <div>
            <div className="row">
              <b>{current.name}</b>
              <span className={`badge-pill ${current.lifecycle === 'Active' ? 'green' : current.lifecycle === 'Draft' ? 'grey' : 'yellow'}`}>{current.lifecycle}</span>
              <button className="btn sm" onClick={() => { void call('spec.update', { id: current.id, patch: { content } }).then(() => { s.toast('ok', 'Saved'); void load(); }); }}>Save</button>
              <button className="btn sm" onClick={() => { void call<SpecValidation>('spec.lint', { id: current.id }).then(setLint); setTab('lint'); }}>Lint</button>
              <button className="btn sm" onClick={() => { void call<{ name: string }>('spec.generateCollection', { id: current.id }).then((c) => { s.toast('ok', `Collection "${c.name}" generated`); void s.refreshCollections(); }); }}>→ Collection</button>
              <button className="btn sm" onClick={() => { void call<{ name: string }>('mock.fromSpec', { specId: current.id }).then((m) => s.toast('ok', `Mock "${m.name}" created — start it under Mocks`)); }}>→ Mock</button>
              <button className="btn sm" onClick={() => {
                const otherId = prompt('Diff against spec id (pick from list on left):'); if (!otherId) return;
                void call<BreakingChange[]>('spec.diff', { aId: current.id, bId: otherId }).then((r) => { setBreaking(r); setTab('diff'); });
              }}>Diff…</button>
              <span className="spacer" />
              <ConfirmButton label="Delete" onConfirm={() => void call('spec.delete', { id: current.id }).then(load)} />
            </div>
            <SubTabs active={tab} onChange={setTab} tabs={[{ id: 'edit', label: 'Editor' }, { id: 'lint', label: 'Lint results' }, { id: 'diff', label: 'Breaking changes' }, { id: 'refs', label: 'Reference graph' }]} />
            {tab === 'edit' && <CodeArea minRows={24} value={content} onChange={setContent} />}
            {tab === 'lint' && (
              lint ? (
                <div className="card">
                  <div className={lint.ok ? 'badge-pill green' : 'badge-pill red'}>{lint.ok ? 'valid' : 'issues found'}</div>
                  {lint.stats && <div className="dim" style={{ marginTop: 6 }}>{Object.entries(lint.stats).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>}
                  {lint.errors.map((e, k) => (
                    <div key={k} className="row" style={{ marginTop: 6 }}>
                      <span className={`badge-pill ${e.severity === 'error' ? 'red' : 'yellow'}`}>{e.severity}</span>
                      <span className="mono dim">{e.path ?? ''}</span>
                      <span>{e.message}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="muted pad">Run Lint to validate semantics + style.</div>
            )}
            {tab === 'diff' && (
              breaking ? (
                <div className="card">
                  {breaking.map((b, k) => (
                    <div key={k} className="row" style={{ marginTop: 6 }}>
                      <span className={`badge-pill ${b.severity === 'breaking' ? 'red' : b.severity === 'dangerous' ? 'yellow' : 'grey'}`}>{b.severity}</span>
                      <span className="badge-pill grey">{b.kind}</span>
                      <span className="mono dim">{b.path ?? ''}</span>
                      <span>{b.message}</span>
                    </div>
                  ))}
                  {breaking.length === 0 && <div className="badge-pill green">no breaking changes</div>}
                </div>
              ) : <div className="muted pad">Pick “Diff…” and compare with another revision/spec.</div>
            )}
            {tab === 'refs' && <SpecRefGraph specId={current.id} />}
          </div>
        ) : <div className="empty"><div className="big">📐</div>Import or create OpenAPI/AsyncAPI/GraphQL/Protobuf specs. Generate collections + mocks straight from them.</div>}
      </div>
    </div>
  );
}

function SpecRefGraph(props: { specId: string }): React.ReactElement {
  const [graph, setGraph] = useState<{ nodes: { id: string }[]; edges: { from: string; to: string }[] } | null>(null);
  useEffect(() => { void call<typeof graph>('spec.refGraph', { id: props.specId }).then(setGraph); }, [props.specId]);
  if (!graph) return <div className="muted pad">Computing…</div>;
  return (
    <div className="pad">
      <div className="muted">{graph.nodes.length} ref(s), {graph.edges.length} link(s)</div>
      <table className="tbl" style={{ marginTop: 8 }}>
        <thead><tr><th>Ref kind</th><th>Linked to</th></tr></thead>
        <tbody>
          {graph.edges.map((e, i) => <tr key={i}><td className="mono">{e.from}</td><td className="mono">{e.to}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Docs
export function DocsPage(): React.ReactElement {
  const s = useApp();
  const [sites, setSites] = useState<DocSite[]>([]);
  const [generating, setGenerating] = useState(false);
  const load = async (): Promise<void> => setSites(await call<DocSite[]>('docs.list', {}).catch(() => []));
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="pad" style={{ maxWidth: 860 }}>
      <h3>Documentation</h3>
      <div className="muted">Polished documentation generated from your collection (descriptions, examples, variables, auth notes) in light or dark theme.</div>
      {s.collections.map((c) => (
        <div key={c.id} className="card" style={{ marginTop: 10 }}>
          <div className="row">
            <b>{c.name}</b>
            <span className="spacer" />
            <button className="btn sm" disabled={generating} onClick={() => {
              setGenerating(true);
              void call<{ html: string }>('docs.generate', { collectionId: c.id, theme: 'dark' })
                .then((r) => {
                  const blob = new Blob([r.html], { type: 'text/html' });
                  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${c.name.replace(/\W+/g, '-')}.html`; a.click();
                  s.toast('ok', 'HTML downloaded');
                })
                .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)))
                .finally(() => setGenerating(false));
            }}>Export HTML</button>
            <button className="btn sm" disabled={generating} onClick={() => {
              setGenerating(true);
              void call<{ path: string }>('docs.export', { collectionId: c.id, path: `docs-${c.id}.html` })
                .then((r) => { s.toast('ok', `Exported to ${r.path}`); void load(); })
                .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)))
                .finally(() => setGenerating(false));
            }}>Export to folder</button>
            <button className="btn sm" onClick={() => {
              void call<{ url: string }>('docs.serve', { collectionId: c.id })
                .then((r) => { s.toast('ok', `Docs at ${r.url}`); void navigator.clipboard.writeText(r.url); })
                .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
            }}>Serve locally</button>
          </div>
        </div>
      ))}
      {s.collections.length === 0 && <div className="empty">No collections yet — docs are generated per collection.</div>}
      {sites.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h4>Saved doc sites</h4>
          {sites.map((d) => <div key={d.id} className="row"><b>{d.name}</b><span className="badge-pill grey">{d.theme}</span><span className="dim mono">{ts(d.createdAt)}</span></div>)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Files & attachments
export function FilesPage(): React.ReactElement {
  const s = useApp();
  const [files, setFiles] = useState<Attachment[]>([]);
  const [missing, setMissing] = useState<Attachment[]>([]);
  const [orphans, setOrphans] = useState<Attachment[]>([]);
  const load = async (): Promise<void> => {
    setFiles(await call<Attachment[]>('files.listAttachments', {}));
    setMissing(await call<Attachment[]>('files.missing', {}));
    setOrphans(await call<Attachment[]>('files.orphans', {}));
  };
  useEffect(() => { void load(); }, [s.workspaceId]);
  const missingIds = new Set(missing.map((m) => m.id));
  const orphanIds = new Set(orphans.map((m) => m.id));
  return (
    <div className="pad" style={{ maxWidth: 940 }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>Files & attachments</h3><span className="spacer" />
        <button className="btn sm" onClick={() => {
          const path = prompt('Absolute path to attach'); if (!path) return;
          void call('files.addAttachment', { path }).then(() => { void load(); s.toast('ok', 'Attached'); }).catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
        }}>Attach file</button>
      </div>
      <table className="tbl" style={{ marginTop: 12 }}>
        <thead><tr><th>File</th><th>Size</th><th>MIME</th><th>Added</th><th>Status</th><th /></tr></thead>
        <tbody>
          {files.map((f) => (
            <tr key={f.id}>
              <td className="mono">{f.relativePath || f.fileName}</td>
              <td className="num">{f.size}</td>
              <td>{f.mimeType ?? 'unknown'}</td>
              <td>{ts(f.createdAt)}</td>
              <td>{missingIds.has(f.id) ? <span className="badge-pill red">missing</span> : orphanIds.has(f.id) ? <span className="badge-pill yellow">orphaned</span> : <span className="badge-pill green">ok</span>}</td>
              <td>
                <button className="btn xs" onClick={() => {
                  const newPath = prompt('Relink to path', f.relativePath); if (!newPath) return;
                  void call('files.relink', { id: f.id, newPath }).then(load);
                }}>relink</button>
                <ConfirmButton label="Remove" className="btn xs danger" onConfirm={() => void call('files.deleteAttachment', { id: f.id }).then(load)} />
              </td>
            </tr>
          ))}
          {files.length === 0 && <tr><td colSpan={6} className="muted">No attachments.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Governance
const GOVERNANCE_KINDS = ['https-required', 'auth-required', 'no-hardcoded-secrets', 'response-time-threshold', 'documentation-required', 'tests-required', 'openapi-validation', 'naming-convention'] as const;
export function GovernancePage(): React.ReactElement {
  const s = useApp();
  const [rules, setRules] = useState<GovernanceRule[]>([]);
  const [report, setReport] = useState<{ rule: string; kind: string; passed: boolean; violations: { message: string; location: string }[] }[] | null>(null);
  const load = async (): Promise<void> => setRules(await call<GovernanceRule[]>('governance.rules', {}));
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="pad" style={{ maxWidth: 900 }}>
      <h3>Governance rules</h3>
      <div className="muted">Guardrails evaluated across your workspace — “https only”, “every request has tests”, “specs must pass OpenAPI validation”, naming conventions…</div>
      {rules.map((r) => (
        <div key={r.id} className="card" style={{ marginTop: 10 }}>
          <div className="row">
            <input type="checkbox" checked={r.enabled} onChange={(e) => { void call('governance.saveRule', { rule: { ...r, enabled: e.target.checked } }).then(load); }} />
            <b>{r.name}</b>
            <span className="badge-pill blue">{r.kind}</span>
            <span className="spacer" />
            <ConfirmButton label="Delete" onConfirm={() => void call('governance.deleteRule', { id: r.id }).then(load)} />
          </div>
          {r.config && Object.keys(r.config).length > 0 && (
            <div className="dim mono" style={{ marginTop: 6 }}>{Object.entries(r.config).map(([k, v]) => `${k}=${v}`).join(', ')}</div>
          )}
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <select className="input sm" id="gov-kind" defaultValue="https-required">
          {GOVERNANCE_KINDS.map((k) => <option key={k}>{k}</option>)}
        </select>
        <button className="btn sm" onClick={() => {
          const el = document.getElementById('gov-kind') as HTMLSelectElement;
          const kind = el.value as GovernanceRule['kind'];
          const name = prompt('Rule name', kind); if (!name) return;
          const cfg: Record<string, string> = {};
          if (kind === 'response-time-threshold') cfg['maxMs'] = prompt('Max response ms', '2000') ?? '2000';
          if (kind === 'naming-convention') cfg['pattern'] = prompt('Regex for request names', '^[a-z0-9\\-]+$') ?? '^[a-z0-9\\-]+$';
          void call('governance.saveRule', { rule: { id: uid(), workspaceId: s.workspaceId, name, kind, enabled: true, config: Object.keys(cfg).length ? cfg : undefined } }).then(load);
        }}>＋ New rule</button>
        <button className="btn primary sm" style={{ marginLeft: 8 }} onClick={() => { void call<typeof report>('governance.evaluate', {}).then(setReport); }}>Evaluate workspace</button>
      </div>
      {report && (
        <div className="card" style={{ marginTop: 14 }}>
          {report!.map((r, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <div className="row">
                <span className={`badge-pill ${r.passed ? 'green' : 'red'}`}>{r.passed ? 'PASS' : 'FAIL'}</span>
                <b>{r.rule}</b><span className="badge-pill grey">{r.kind}</span>
              </div>
              {r.violations.map((v, j) => <div key={j} className="dim mono" style={{ marginLeft: 40 }}>{v.location}: {v.message}</div>)}
            </div>
          ))}
          {report!.length === 0 && <div className="muted">No enabled rules to evaluate.</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inventory
export function InventoryPage(): React.ReactElement {
  const [ports, setPorts] = useState<NetworkPortInfo[]>([]);
  const [listeners, setListeners] = useState<NetworkPortInfo[]>([]);
  const [ifaces, setIfaces] = useState<{ name: string; addresses: string[] }[]>([]);
  useEffect(() => {
    void call<NetworkPortInfo[]>('inventory.ports', {}).then(setPorts).catch(() => undefined);
    void call<NetworkPortInfo[]>('inventory.listeners', {}).then(setListeners).catch(() => undefined);
    void call<{ name: string; addresses: string[] }[]>('inventory.interfaces', {}).then(setIfaces).catch(() => undefined);
  }, []);
  return (
    <div className="pad">
      <h3>Ports / listeners / network interfaces</h3>
      <div className="grid2">
        <div>
          <div className="card">
            <h3>Listening sockets ({listeners.length})</h3>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              <table className="tbl">
                <tbody>
                  {listeners.map((l, i) => <tr key={i}><td className="mono">{l.localAddress}:{l.localPort}</td><td><span className="badge-pill grey">{l.protocol}</span></td><td>{l.process ?? '—'}</td></tr>)}
                  {listeners.length === 0 && <tr><td className="muted">—</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div className="card" style={{ marginTop: 12 }}>
            <h3>Interfaces</h3>
            {ifaces.map((i) => (
              <div key={i.name} style={{ marginBottom: 6 }}>
                <code>{i.name}</code>
                <div className="dim mono">{i.addresses.join(', ')}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>Open connections ({ports.length})</h3>
          <div style={{ maxHeight: 480, overflow: 'auto' }}>
            <table className="tbl">
              <tbody>
                {ports.map((p, i) => <tr key={i}><td className="mono">{p.localPort}</td><td><span className="badge-pill grey">{p.state}</span></td><td className="dim">{p.process ?? '—'}</td></tr>)}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search & replace
export function SearchPage(): React.ReactElement {
  const s = useApp();
  const [query, setQuery] = useState('');
  const [replace, setReplace] = useState('');
  const [scope, setScope] = useState<SearchHit['kind'] | 'all'>('all');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const doSearch = async (): Promise<void> => {
    setBusy(true); setResultCount(null);
    try {
      setHits(await call<SearchHit[]>('search.global', { query, scope, regex, caseSensitive, wholeWord }));
    } finally { setBusy(false); }
  };
  const doReplace = async (dryRun: boolean): Promise<void> => {
    setBusy(true);
    try {
      const out = await call<{ replaced: number; hits: SearchHit[] }>('search.replace', { query, replace, scope, regex, caseSensitive, wholeWord, dryRun });
      setHits(out.hits); setResultCount(out.replaced);
      if (!dryRun) { s.toast('ok', `Replaced ${out.replaced} occurrence(s)`); void s.refreshCollections(); }
    } finally { setBusy(false); }
  };
  return (
    <div className="pad" style={{ maxWidth: 960 }}>
      <h3>Global find & replace</h3>
      <div className="grid2">
        <div><label className="lbl">Find</label><input className="input" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div><label className="lbl">Replace with</label><input className="input" value={replace} onChange={(e) => setReplace(e.target.value)} /></div>
      </div>
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        <select className="input sm" style={{ width: 170 }} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="all">everywhere</option><option value="collections">collections</option><option value="requests">requests</option><option value="specs">specs</option><option value="variables">variables</option><option value="scripts">scripts</option>
        </select>
        <label className="checkbox"><input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} /> regex</label>
        <label className="checkbox"><input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} /> case</label>
        <label className="checkbox"><input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} /> whole word</label>
        <span className="spacer" />
        <button className="btn" onClick={() => void doSearch()} disabled={!query || busy}>Find</button>
        <button className="btn" onClick={() => void doReplace(true)} disabled={!query || busy}>Dry run</button>
        <button className="btn primary" onClick={() => void doReplace(false)} disabled={!query || busy}>Replace all</button>
      </div>
      {resultCount !== null && <div className="dim" style={{ marginTop: 8 }}>{resultCount} occurrence(s) replaced</div>}
      <div style={{ marginTop: 14 }}>
        {hits.map((h, i) => (
          <div key={i} className="card" style={{ marginBottom: 8 }}>
            <div className="row">
              <span className="badge-pill grey">{h.kind}</span>
              <b>{h.title}</b>
              <span className="dim">{h.path.join(' / ')}</span>
            </div>
            <div className="mono dim" style={{ marginTop: 4 }}>{h.snippet.slice(0, 240)}</div>
          </div>
        ))}
        {hits.length === 0 && !busy && <div className="muted pad">No results yet.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analytics
export function AnalyticsPage(): React.ReactElement {
  const s = useApp();
  const [summary, setSummary] = useState<{
    requests: number; collections: number; runs: number; passRate: number; avgResponseMs: number;
    byMethod: Record<string, number>; byStatus: Record<string, number>;
    timeline: { date: string; count: number; avgMs: number }[];
  } | null>(null);
  useEffect(() => { void call<typeof summary>('analytics.summary', {}).then(setSummary).catch(() => undefined); }, [s.workspaceId]);
  const timelineCfg = useMemo(() => summary ? ({
    type: 'line',
    data: { labels: summary.timeline.map((t) => t.date), datasets: [
      { label: 'requests/day', data: summary.timeline.map((t) => t.count), borderColor: '#4f9cf9', tension: .2, pointRadius: 0 },
      { label: 'avg ms', data: summary.timeline.map((t) => t.avgMs), borderColor: '#ff6c37', tension: .2, pointRadius: 0, yAxisID: 'y1' },
    ] },
    options: { scales: { y: { type: 'linear' }, y1: { type: 'linear', position: 'right' } }, plugins: { legend: { labels: { color: '#e8eaf0' } } } },
  }) : null, [summary]);
  const methodCfg = useMemo(() => summary ? ({
    type: 'doughnut',
    data: { labels: Object.keys(summary.byMethod), datasets: [{ data: Object.values(summary.byMethod), backgroundColor: ['#3dd68c', '#eac54f', '#4f9cf9', '#b084f9', '#f2545b', '#4fd1e0', '#ff9364'] }] },
    options: { plugins: { legend: { labels: { color: '#e8eaf0' } } } },
  }) : null, [summary]);
  return (
    <div className="pad">
      <h3>Usage analytics</h3>
      {!summary && <div className="muted">Loading…</div>}
      {summary && (
        <>
          <div className="grid3" style={{ maxWidth: 860 }}>
            <div className="stat-tile"><div className="v">{summary.requests}</div><div className="l">Requests</div></div>
            <div className="stat-tile"><div className="v">{summary.runs}</div><div className="l">Collection runs</div></div>
            <div className="stat-tile"><div className="v">{summary.passRate}%</div><div className="l">Run pass rate</div></div>
            <div className="stat-tile"><div className="v">{summary.avgResponseMs.toFixed(0)}ms</div><div className="l">Avg response</div></div>
            <div className="stat-tile"><div className="v">{summary.collections}</div><div className="l">Collections</div></div>
          </div>
          <div className="grid2" style={{ marginTop: 14, maxWidth: 960 }}>
            <div className="card"><h3>Volume timeline</h3>{timelineCfg && <Chart config={timelineCfg as never} height={220} deps={[summary as unknown]} />}</div>
            <div className="card"><h3>Methods</h3>{methodCfg && <Chart config={methodCfg as never} height={220} deps={[summary as unknown]} />}</div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit
const AUDIT_CATEGORIES = ['auth', 'project', 'settings', 'secret', 'script', 'run', 'network', 'export', 'import', 'git', 'backup', 'destructive', 'security', 'mcp'];
export function AuditPage(): React.ReactElement {
  const s = useApp();
  const [entries, setEntries] = useState<AuditEvent[]>([]);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const load = async (): Promise<void> => {
    const out = await call<{ items: AuditEvent[] }>('audit.list', { category: category || undefined, search: search || undefined, limit: 300 });
    setEntries(out.items);
  };
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 200, padding: 10 }}>
        <b>Categories</b>
        <div className="tree-item" onClick={() => setCategory('')}>all</div>
        {AUDIT_CATEGORIES.map((c) => <div key={c} className="tree-item" onClick={() => setCategory(c)}>{c}</div>)}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        <div className="row">
          <input className="input" placeholder="search action/detail…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void load()} />
          <button className="btn" onClick={() => void load()}>Filter</button>
          <button className="btn" onClick={() => void call<string>('audit.export', {}).then(async (t) => { await navigator.clipboard.writeText(t); s.toast('ok', 'Audit export copied'); })}>Export</button>
        </div>
        <table className="tbl" style={{ marginTop: 12 }}>
          <thead><tr><th>Time</th><th>Category</th><th>Actor</th><th>Action</th><th>Detail</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}><td className="dim">{ts(e.timestamp)}</td><td><span className="badge-pill grey">{e.category}</span></td><td>{e.actor ?? 'system'}</td><td className="mono">{e.action}</td><td className="dim">{e.detail ?? ''}</td></tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={5} className="muted">No audit entries yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
