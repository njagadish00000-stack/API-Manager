/**
 * Automation pages: Mocks, Monitors, Performance, Flows, Datasets, Webhooks, Capture.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { call, onEventType } from './bridge';
import { useApp } from './state';
import { Chart, CodeArea, ConfirmButton, JsonView, KVEditor, Modal, ts, uid } from './components';
import type { MockServer, MockRoute, MockRequestLog, Monitor, MonitorResult, Dataset, PerfRun, PerfMetrics, Flow, FlowNode, FlowEdge, FlowRunLog, FlowRun, WebhookReceiver, WebhookEvent, CapturedExchange, PerfConfig } from '../shared/types';

// ---------------------------------------------------------------------------
// Mocks
export function MocksPage(): React.ReactElement {
  const s = useApp();
  const [mocks, setMocks] = useState<MockServer[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const load = async (): Promise<void> => setMocks(await call<MockServer[]>('mock.list', {}));
  useEffect(() => { void load(); }, [s.workspaceId]);
  const current = mocks.find((m) => m.id === sel) ?? null;
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 270, padding: 10 }}>
        <div className="row"><b>Mock servers</b><span className="spacer" />
          <button className="btn sm primary" onClick={() => {
            const name = prompt('Mock server name'); if (!name) return;
            void call<MockServer>('mock.save', { mock: { id: uid(), workspaceId: s.workspaceId, name, port: 0, running: false, routes: [], dynamicVars: true, createdAt: new Date().toISOString() } }).then((m) => { void load(); setSel(m.id); });
          }}>＋ New</button></div>
        {s.collections.length > 0 && (
          <button className="btn sm" style={{ marginBottom: 8 }} onClick={() => {
            const name = prompt('Name for mock from collection', s.collections[0]?.name ?? 'mock'); if (!name) return;
            const col = s.collections[0]; if (!col) return;
            void call<MockServer>('mock.fromCollection', { collectionId: col.id, name }).then((m) => { void load(); setSel(m.id); });
          }}>From collection…</button>
        )}
        {mocks.map((m) => (
          <div key={m.id} className={`tree-item ${sel === m.id ? 'sel' : ''}`} onClick={() => setSel(m.id)}>
            <span className="ti-label">{m.name}</span>
            {m.running ? <span className="badge-pill green">● :{m.port}</span> : <span className="badge-pill grey">stopped</span>}
          </div>
        ))}
        {mocks.length === 0 && <div className="muted pad">Generate a mock from a collection or spec, or start from scratch.</div>}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {current ? <MockDetail key={`${current.id}-${String(current.running)}`} mock={current} onChanged={() => void load()} /> : <div className="empty"><div className="big">🛰</div>Select a mock</div>}
      </div>
    </div>
  );
}

function MockDetail(props: { mock: MockServer; onChanged: () => void }): React.ReactElement {
  const s = useApp();
  const [logs, setLogs] = useState<MockRequestLog[]>([]);
  const [mock, setMock] = useState<MockServer>(props.mock);
  useEffect(() => {
    setMock(props.mock);
    void call<MockRequestLog[]>('mock.logs', { id: props.mock.id, limit: 100 }).then(setLogs).catch(() => setLogs([]));
  }, [props.mock]);
  const save = (patch: Partial<MockServer>): void => {
    const next = { ...mock, ...patch };
    setMock(next);
    void call<MockServer>('mock.save', { mock: next }).then(() => props.onChanged());
  };
  const addRoute = (): void => {
    save({ routes: [...mock.routes, { id: uid(), method: 'GET', pathPattern: '/new', status: 200, headers: [{ id: uid(), key: 'Content-Type', value: 'application/json', enabled: true }], body: '{"ok":true}', enabled: true }] });
  };
  const updateRoute = (routeId: string, patch: Partial<MockRoute>): void => {
    save({ routes: mock.routes.map((r) => (r.id === routeId ? { ...r, ...patch } : r)) });
  };
  return (
    <div style={{ padding: 12 }}>
      <div className="row">
        <b>{mock.name}</b>
        {mock.running ? <span className="badge-pill green">● port {mock.port}</span> : <span className="badge-pill grey">port {mock.port || '(auto)'}</span>}
        <span className="spacer" />
        {mock.running ? (
          <button className="btn sm danger" onClick={() => void call('mock.stop', { id: mock.id }).then(props.onChanged)}>Stop</button>
        ) : (
          <button className="btn sm primary" onClick={() => {
            void call<{ url: string; port: number }>('mock.start', { id: mock.id })
              .then((r) => { s.toast('ok', `Mock live at ${r.url}`); props.onChanged(); })
              .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
          }}>Start</button>
        )}
        <ConfirmButton label="Delete server" onConfirm={() => void call('mock.delete', { id: mock.id }).then(props.onChanged)} />
        <button className="btn sm" onClick={() => { void call<MockRequestLog[]>('mock.logs', { id: mock.id, limit: 100 }).then(setLogs); }}>↻ logs</button>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <div className="row"><b>Routes ({mock.routes.length})</b><span className="spacer" />
          <button className="btn sm" onClick={addRoute}>＋ Route</button></div>
        {mock.routes.map((r) => (
          <div key={r.id} className="card" style={{ marginTop: 10 }}>
            <div className="row">
              <input type="checkbox" checked={r.enabled} onChange={(e) => updateRoute(r.id, { enabled: e.target.checked })} />
              <select className="input sm mono" style={{ width: 95 }} value={r.method} onChange={(e) => updateRoute(r.id, { method: e.target.value })}>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => <option key={m}>{m}</option>)}
              </select>
              <input className="input mono" defaultValue={r.pathPattern} onBlur={(e) => updateRoute(r.id, { pathPattern: e.target.value })} title="URL pattern, e.g. /users/:id" />
              <input className="input sm" style={{ width: 80 }} type="number" defaultValue={r.status} onBlur={(e) => updateRoute(r.id, { status: Number(e.target.value) })} title="status" />
              <ConfirmButton label="Delete" onConfirm={() => save({ routes: mock.routes.filter((x) => x.id !== r.id) })} />
            </div>
            <div className="muted dim" style={{ margin: '6px 0' }}>
              Condition script (optional; return truthy to match this route):
            </div>
            <CodeArea minRows={1} value={r.conditionScript ?? ''} onChange={(v) => updateRoute(r.id, { conditionScript: v || undefined })} />
            <div className="muted dim" style={{ margin: '6px 0' }}>Response body (when dynamic vars are on you can use <code>{'{{uuid}}'}</code>, <code>{'{{timestamp}}'}</code>, <code>{'{{name}}'}</code>…):</div>
            <CodeArea minRows={2} value={r.body} onChange={(v) => updateRoute(r.id, { body: v })} />
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <label className="checkbox">
            <input type="checkbox" checked={mock.dynamicVars} onChange={(e) => save({ dynamicVars: e.target.checked })} />
            generate dynamic variables in bodies
          </label>
        </div>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <div className="row"><b>Hit log ({logs.length})</b><span className="spacer" />
          <button className="btn sm" onClick={() => setLogs([])} title="Clears the view (hub keeps its own log)">clear view</button></div>
        <table className="tbl" style={{ marginTop: 6 }}>
          <tbody>
            {logs.map((l) => <tr key={l.id}><td className="dim">{ts(l.timestamp)}</td><td className="mono">{l.method}</td><td className="mono">{l.path}</td><td>{l.status}</td></tr>)}
            {logs.length === 0 && <tr><td className="muted">No hits yet (start the mock and send traffic).</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Monitors
export function MonitorsPage(): React.ReactElement {
  const s = useApp();
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const load = async (): Promise<void> => setMonitors(await call<Monitor[]>('monitor.list', {}));
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 290, padding: 10 }}>
        <div className="row"><b>Monitors</b><span className="spacer" />
          <button className="btn sm" onClick={() => {
            const name = prompt('Monitor name'); if (!name) return;
            const col = s.collections[0]; if (!col) { s.toast('warn', 'Create a collection first'); return; }
            void call('monitor.save', { monitor: { id: uid(), workspaceId: s.workspaceId, name, collectionId: col.id, intervalMinutes: 5, enabled: true, failureThreshold: 1, notifyWebhooks: [], consecutiveFailures: 0, createdAt: new Date().toISOString() } }).then((m) => { void load(); setSel((m as Monitor).id); });
          }}>＋ New</button></div>
        {monitors.map((m) => (
          <div key={m.id} className={`tree-item ${sel === m.id ? 'sel' : ''}`} onClick={() => setSel(m.id)}>
            <span className="ti-label">{m.name}</span>
            {m.enabled ? <span className="badge-pill green">on</span> : <span className="badge-pill grey">paused</span>}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {sel && monitors.find((m) => m.id === sel)
          ? <MonitorDetail monitor={monitors.find((m) => m.id === sel)!} onChanged={() => void load()} />
          : <div className="empty"><div className="big">📡</div>Select a monitor</div>}
      </div>
    </div>
  );
}

function MonitorDetail(props: { monitor: Monitor; onChanged: () => void }): React.ReactElement {
  const s = useApp();
  const mon = props.monitor;
  const [results, setResults] = useState<MonitorResult[]>([]);
  useEffect(() => { void call<MonitorResult[]>('monitor.results', { id: mon.id, limit: 100 }).then(setResults).catch(() => setResults([])); }, [mon.id, mon.lastRunAt]);
  const save = (patch: Partial<Monitor>): void => {
    void call('monitor.save', { monitor: { ...mon, ...patch } }).then(() => props.onChanged());
  };
  return (
    <div style={{ padding: 12 }}>
      <div className="row">
        <b>{mon.name}</b>
        {mon.enabled ? <span className="badge-pill green">enabled</span> : <span className="badge-pill grey">paused</span>}
        {mon.lastStatus && <span className={`badge-pill ${mon.lastStatus === 'up' ? 'green' : mon.lastStatus === 'degraded' ? 'yellow' : 'red'}`}>{mon.lastStatus}</span>}
        {mon.lastRunAt && <span className="dim">last run {ts(mon.lastRunAt)}</span>}
        {mon.uptimePct !== undefined && <span className="badge-pill blue">uptime {mon.uptimePct.toFixed(1)}%</span>}
        {mon.consecutiveFailures > 0 && <span className="badge-pill red">{mon.consecutiveFailures} consecutive failure(s)</span>}
        <span className="spacer" />
        <button className="btn primary sm" onClick={() => {
          void call<{ resultId: string }>('monitor.runNow', { id: mon.id })
            .then(() => setTimeout(() => { void call<MonitorResult[]>('monitor.results', { id: mon.id, limit: 100 }).then(setResults); props.onChanged(); }, 2000))
            .catch((e) => s.toast('err', String(e instanceof Error ? e.message : e)));
        }}>▶ Run now</button>
        <button className="btn sm" onClick={() => save({ enabled: !mon.enabled })}>{mon.enabled ? 'Pause' : 'Enable'}</button>
        <ConfirmButton label="Delete" onConfirm={() => void call('monitor.delete', { id: mon.id }).then(props.onChanged)} />
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <div className="row">
          <div style={{ flex: 1 }}><label className="lbl">Collection</label>
            <select className="input sm" value={mon.collectionId} onChange={(e) => save({ collectionId: e.target.value })}>
              {s.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div style={{ flex: 1 }}><label className="lbl">Interval (minutes)</label>
            <input className="input sm" type="number" min={1} defaultValue={mon.intervalMinutes} onBlur={(e) => save({ intervalMinutes: Math.max(1, Number(e.target.value)) })} /></div>
          <div style={{ flex: 1 }}><label className="lbl">Fail threshold (consecutive)</label>
            <input className="input sm" type="number" min={1} defaultValue={mon.failureThreshold} onBlur={(e) => save({ failureThreshold: Math.max(1, Number(e.target.value)) })} /></div>
          <div style={{ flex: 1 }}><label className="lbl">Environment</label>
            <select className="input sm" value={mon.environmentId ?? ''} onChange={(e) => save({ environmentId: e.target.value || undefined })}>
              <option value="">—</option>
              {s.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select></div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <b>Recent runs</b>
        <table className="tbl" style={{ marginTop: 6 }}>
          <thead><tr><th>Time</th><th>Status</th><th>Tests</th><th>Duration</th><th>Error</th></tr></thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td className="dim">{ts(r.timestamp)}</td>
                <td><span className={`badge-pill ${r.status === 'up' ? 'green' : r.status === 'degraded' ? 'yellow' : 'red'}`}>{r.status}</span></td>
                <td className="dim">{r.passedTests} pass / {r.failedTests} fail</td>
                <td className="dim">{r.durationMs.toFixed(0)} ms</td>
                <td className="dim">{r.error ?? ''}</td>
              </tr>
            ))}
            {results.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Performance
export function PerfPage(): React.ReactElement {
  const s = useApp();
  const [runs, setRuns] = useState<PerfRun[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<PerfMetrics | null>(null);
  const [ticks, setTicks] = useState<{ t: number; rps: number; p50: number; p90: number }[]>([]);
  const [cfg, setCfg] = useState<{ concurrency: number; rampUpSec: number; durationSec: number; iterations: number; delayMs: number }>({ concurrency: 10, rampUpSec: 5, durationSec: 30, iterations: 0, delayMs: 0 });
  const [reqId, setReqId] = useState<string>('');
  const load = async (): Promise<void> => {
    setRuns(await call<PerfRun[]>('perf.list', { limit: 50 }));
    if (sel) {
      try { const run = await call<{ metrics?: PerfMetrics }>('perf.get', { runId: sel }); setMetrics(run.metrics ?? null); } catch { setMetrics(null); }
    }
  };
  useEffect(() => { void load(); }, [s.workspaceId, sel]);
  useEffect(() => {
    const off = onEventType<import('../shared/events').PerfTickEvent>('perf.tick', (p) => {
      setTicks((prev) => [...prev.slice(-119), { t: p.t, rps: p.rps, p50: p.p50, p90: p.p90 }]);
      setMetrics((m) => (m ? { ...m, totalRequests: p.total, avgMs: p.avgMs, p50: p.p50, p90: p.p90, errorCount: p.errors } : m));
    });
    return off;
  }, []);
  const chartCfg = useMemo(() => ({
    type: 'line',
    data: {
      labels: ticks.map((t) => `${t.t.toFixed(0)}s`),
      datasets: [
        { label: 'p50 ms', data: ticks.map((t) => t.p50), borderColor: '#3dd68c', tension: .2, pointRadius: 0 },
        { label: 'p90 ms', data: ticks.map((t) => t.p90), borderColor: '#f2545b', tension: .2, pointRadius: 0 },
        { label: 'rps', data: ticks.map((t) => t.rps), borderColor: '#4f9cf9', tension: .2, pointRadius: 0, yAxisID: 'y1' },
      ],
    },
    options: { scales: { y: { type: 'linear' }, y1: { type: 'linear', position: 'right' } }, plugins: { legend: { labels: { color: '#e8eaf0' } } } },
  }), [ticks]);
  const run = runs.find((r) => r.id === sel) ?? runs[0];
  return (
    <div className="pad">
      <div className="row">
        <h3 style={{ margin: 0 }}>Performance testing</h3><span className="spacer" />
        <select className="input sm" value={sel ?? ''} onChange={(e) => setSel(e.target.value || null)}>
          <option value="">— pick a run —</option>
          {runs.map((r) => <option key={r.id} value={r.id}>{r.id.slice(0, 8)} · {r.status}</option>)}
        </select>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <div><label className="lbl">Request</label>
            <select className="input sm" value={reqId} onChange={(e) => setReqId(e.target.value)}>
              <option value="">— choose —</option>
              {s.requests.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select></div>
          {(['concurrency', 'rampUpSec', 'durationSec', 'iterations'] as const).map((k) => (
            <div key={k}><label className="lbl">{k}</label>
              <input className="input sm" style={{ width: 90 }} type="number" value={cfg[k]}
                onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} /></div>
          ))}
          <span className="spacer" />
          <button className="btn primary" disabled={!reqId} onClick={() => {
            const config: PerfConfig = { target: { kind: 'request', id: reqId }, concurrency: cfg.concurrency, rampUpSec: cfg.rampUpSec, rampDownSec: 0, durationSec: cfg.durationSec, iterations: cfg.iterations || undefined, ratePerSecond: 0, timeoutMs: 30000 };
            void call<{ runId: string }>('perf.start', config).then((r) => { setTicks([]); setSel(r.runId); void load(); s.toast('ok', 'Run started'); });
          }}>▶ Start run</button>
          <button className="btn danger" onClick={() => run && void call('perf.stop', { runId: run.id }).then(load)}>■ Stop</button>
        </div>
      </div>
      {ticks.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Live</h3>
          <Chart config={chartCfg as unknown} height={220} />
        </div>
      )}
      {run && metrics && (
        <div className="card" style={{ marginTop: 12 }}>
          <h3>Result — <span className={`badge-pill ${run.status === 'completed' ? 'green' : run.status === 'running' ? 'blue' : 'red'}`}>{run.status}</span></h3>
          <div className="grid3" style={{ marginTop: 8 }}>
            <div className="stat-tile"><div className="v">{metrics.totalRequests}</div><div className="l">Requests</div></div>
            <div className="stat-tile"><div className="v">{metrics.errorCount}</div><div className="l">Errors</div></div>
            <div className="stat-tile"><div className="v">{metrics.avgMs.toFixed(0)}ms</div><div className="l">avg</div></div>
            <div className="stat-tile"><div className="v">{metrics.p50.toFixed(0)}ms</div><div className="l">p50</div></div>
            <div className="stat-tile"><div className="v">{metrics.p95.toFixed(0)}ms</div><div className="l">p95</div></div>
            <div className="stat-tile"><div className="v">{metrics.p99.toFixed(0)}ms</div><div className="l">p99</div></div>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary className="dim">Raw samples ({metrics.samples?.length ?? 0})</summary>
            <JsonView text={JSON.stringify(metrics.samples?.slice(0, 200) ?? [], null, 2)} maxHeight={220} />
          </details>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flows
export function FlowsPage(): React.ReactElement {
  const s = useApp();
  const [sel, setSel] = useState<string | null>(null);
  const [flows, setFlows] = useState<Flow[]>([]);
  const load = async (): Promise<void> => setFlows(await call<Flow[]>('flow.list', {}));
  useEffect(() => { void load(); }, [s.workspaceId]);
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 250, padding: 10 }}>
        <div className="row"><b>Flows</b><span className="spacer" />
          <button className="btn sm" onClick={() => {
            const name = prompt('Flow name'); if (!name) return;
            void call<Flow>('flow.save', { flow: { id: uid(), workspaceId: s.workspaceId, name, nodes: [], edges: [], variables: [], version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }).then((f) => { void load(); setSel(f.id); });
          }}>＋ New</button></div>
        {flows.map((f) => (
          <div key={f.id} className={`tree-item ${sel === f.id ? 'sel' : ''}`} onClick={() => setSel(f.id)}>
            <span className="ti-label">{f.name}</span>
          </div>
        ))}
        {flows.length === 0 && <div className="muted pad">Chain requests/scripts/conditions into automation.</div>}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <FlowDetail id={sel} onChanged={() => void load()} />
      </div>
    </div>
  );
}

function FlowDetail(props: { id: string | null; onChanged: () => void }): React.ReactElement {
  const s = useApp();
  const id = props.id;
  const [flow, setFlow] = useState<Flow | null>(null);
  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [logs, setLogs] = useState<FlowRunLog[]>([]);
  const [saving, setSaving] = useState(false);
  const [dragModify, setDragModify] = useState<FlowNode[] | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadFlow = async (): Promise<void> => { if (id) setFlow(await call<Flow>('flow.get', { id })); };
  useEffect(() => { setDragModify(null); void loadFlow(); }, [id]);
  useEffect(() => {
    const off = onEventType<import('../shared/events').FlowNodeEvent>('flow.node', (p) => { setLogs((prev) => [...prev, p.node]); });
    return off;
  }, []);
  if (!id) return <div className="empty"><div className="big">🧭</div>Select a flow to edit</div>;
  if (!flow) return <div className="pad muted">Loading…</div>;
  const nodes = dragModify ?? flow.nodes;
  const scheduleSave = (next: Flow): void => {
    setFlow(next);
    setSaving(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void call('flow.save', { flow: { ...flow, nodes: next.nodes, edges: next.edges, updatedAt: new Date().toISOString() } }).then(() => { setSaving(false); props.onChanged(); });
    }, 400);
  };
  const addNode = (kind: 'request' | 'script' | 'delay' | 'condition' | 'variable'): void => {
    const base: FlowNode = { id: uid(), type: kind, label: kind, x: 120 + nodes.length * 160, y: 200, config: {} };
    if (kind === 'request') base.config = { requestId: s.requests[0]?.id };
    if (kind === 'delay') base.config = { ms: 1000 };
    if (kind === 'condition') base.config = { expression: '{{var}} == "1"' };
    scheduleSave({ ...flow, nodes: [...flow.nodes, base] });
  };
  return (
    <div style={{ padding: 10, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="row">
        <b>{flow.name}</b>{saving && <span className="muted">saving…</span>}
        <button className="btn sm" onClick={() => addNode('request')}>＋ request</button>
        <button className="btn sm" onClick={() => addNode('script')}>＋ script</button>
        <button className="btn sm" onClick={() => addNode('delay')}>＋ delay</button>
        <button className="btn sm" onClick={() => addNode('condition')}>＋ condition</button>
        <button className="btn sm" onClick={() => addNode('variable')}>＋ variable</button>
        <span className="spacer" />
        {running ? (
          <button className="btn danger" onClick={() => { runId && void call('flow.stop', { runId }).then(() => setRunning(false)); }}>■ Stop</button>
        ) : (
          <button className="btn primary" onClick={() => {
            setLogs([]); setRunning(true);
            void call<{ runId: string }>('flow.run', { flowId: flow.id }).then((res) => { setRunId(res.runId); }).catch(() => undefined).finally(() => setTimeout(() => setRunning(false), 300));
          }}>▶ Run</button>
        )}
        <ConfirmButton label="Delete flow" onConfirm={() => void call('flow.delete', { id: flow.id }).then(() => { props.onChanged(); })} />
      </div>
      <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 10, marginTop: 8, overflow: 'auto', position: 'relative', background: 'var(--bg)' }}>
        <svg style={{ position: 'absolute', inset: 0, width: 1400, height: 800, pointerEvents: 'none' }}>
          {flow.edges.map((e) => {
            const from = nodes.find((n) => n.id === e.source);
            const to = nodes.find((n) => n.id === e.target);
            if (!from || !to) return null;
            const x1 = from.x + 120, y1 = from.y + 26, x2 = to.x, y2 = to.y + 26;
            const mx = (x1 + x2) / 2;
            return <path key={e.id} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`} stroke="var(--dim)" fill="none" strokeWidth={1.5} />;
          })}
        </svg>
        <FlowCanvas nodes={nodes} logByNode={logs.map((l) => ({ nodeId: l.nodeId, status: l.status }))} onMove={(nodeId, x, y) => {
          const next = (dragModify ?? flow.nodes).map((n) => (n.id === nodeId ? { ...n, x, y } : n));
          setDragModify(next);
        }} onDrop={() => {
          if (dragModify) { scheduleSave({ ...flow, nodes: dragModify }); setDragModify(null); }
        }} onConfig={(nodeId, key, value) => {
          const next = flow.nodes.map((n) => (n.id === nodeId ? { ...n, config: { ...n.config, [key]: value } } : n));
          scheduleSave({ ...flow, nodes: next });
        }} onRemove={(nodeId) => {
          scheduleSave({ ...flow, nodes: flow.nodes.filter((n) => n.id !== nodeId), edges: flow.edges.filter((e) => e.source !== nodeId && e.target !== nodeId) });
        }} onConnect={(from, to) => {
          scheduleSave({ ...flow, edges: [...flow.edges, { id: uid(), source: from, target: to }] });
        }} onRemoveEdge={(edgeId) => scheduleSave({ ...flow, edges: flow.edges.filter((e) => e.id !== edgeId) })} edgesForDelete={flow.edges} requests={s.requests.map((r) => ({ id: r.id, name: r.name }))} />
      </div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, marginTop: 8, padding: 8, maxHeight: 190, overflow: 'auto' }}>
        <div className="row"><b>Run log</b><span className="spacer" /><button className="btn xs" onClick={() => setLogs([])}>clear</button></div>
        {logs.map((l, i) => (
          <div key={i} className="row" style={{ marginTop: 4 }}>
            <span className={`badge-pill ${l.status === 'success' ? 'green' : l.status === 'failed' ? 'red' : 'grey'}`}>{l.status}</span>
            <span className="dim mono">{l.nodeId.slice(0, 8)}</span>
            <span className="dim">{l.durationMs.toFixed(0)} ms</span>
            {l.error && <span style={{ color: 'var(--red)' }}>{l.error}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowCanvas(props: {
  nodes: FlowNode[];
  logByNode: { nodeId: string; status: string }[];
  onMove: (id: string, x: number, y: number) => void;
  onDrop: () => void;
  onConfig: (id: string, key: string, value: unknown) => void;
  onRemove: (id: string) => void;
  onConnect: (from: string, to: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  edgesForDelete: FlowEdge[];
  requests: { id: string; name: string }[];
}): React.ReactElement {
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const latest = (nodeId: string): string | null => {
    const hits = props.logByNode.filter((l) => l.nodeId === nodeId);
    return hits.length ? hits[hits.length - 1].status : null;
  };
  return (
    <div style={{ position: 'relative', width: 1400, height: 800 }}
      onMouseMove={(e) => {
        if (dragRef.current) {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          props.onMove(dragRef.current.id, Math.max(0, e.clientX - rect.left - dragRef.current.dx), Math.max(0, e.clientY - rect.top - dragRef.current.dy));
        }
      }}
      onMouseUp={() => { if (dragRef.current) { dragRef.current = null; props.onDrop(); } }}>
      {props.nodes.map((n) => {
        const st = latest(n.id);
        return (
          <div key={n.id} className={`flow-node ${connectFrom === n.id ? 'conn' : ''}`} style={{ left: n.x, top: n.y, width: 120, borderColor: st === 'success' ? 'var(--green)' : st === 'failed' ? 'var(--red)' : st === 'skipped' ? 'var(--yellow)' : undefined }}
            onMouseDown={(e) => {
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              dragRef.current = { id: n.id, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
            }}
            onClick={() => {
              if (connectFrom && connectFrom !== n.id) { props.onConnect(connectFrom, n.id); setConnectFrom(null); }
            }}>
            <div className="row">
              <b>{n.type}</b><span className="spacer" />
              <button className="btn xs" title="start connect here" onClick={(e) => { e.stopPropagation(); setConnectFrom(connectFrom === n.id ? null : n.id); }}>⇢</button>
              <button className="btn xs danger" title="delete node" onClick={(e) => { e.stopPropagation(); props.onRemove(n.id); }}>✕</button>
            </div>
            {n.type === 'request' && (
              <select className="input" onChange={(e) => props.onConfig(n.id, 'requestId', e.target.value)} value={String(n.config['requestId'] ?? '')} onMouseDown={(e) => e.stopPropagation()}>
                <option value="">— request —</option>
                {props.requests.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            )}
            {n.type === 'script' && (
              <textarea className="input mono" rows={2} placeholder="return { x: 1 }" defaultValue={String(n.config['code'] ?? '')}
                onBlur={(e) => props.onConfig(n.id, 'code', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
            )}
            {n.type === 'delay' && (
              <input className="input" type="number" placeholder="ms" defaultValue={Number(n.config['ms'] ?? 1000)} onBlur={(e) => props.onConfig(n.id, 'ms', Number(e.target.value))} onMouseDown={(e) => e.stopPropagation()} />
            )}
            {n.type === 'condition' && (
              <input className="input mono" placeholder="expression, e.g. response.status == 200" defaultValue={String(n.config['expression'] ?? '')} onBlur={(e) => props.onConfig(n.id, 'expression', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
            )}
            {n.type === 'variable' && (
              <input className="input mono" placeholder="set var: name=value" defaultValue={String(n.config['assign'] ?? '')} onBlur={(e) => props.onConfig(n.id, 'assign', e.target.value)} onMouseDown={(e) => e.stopPropagation()} />
            )}
          </div>
        );
      })}
      {props.edgesForDelete.map((e) => (
        <button key={`del-${e.id}`} className="btn xs danger" title="delete edge"
          style={{ position: 'absolute', zIndex: 5, left: (props.nodes.find((n) => n.id === e.source)?.x ?? 0) + 122, top: (props.nodes.find((n) => n.id === e.target)?.y ?? 0) + 2 }}
          onClick={() => props.onRemoveEdge(e.id)}>✕</button>
      ))}
      {connectFrom && <div style={{ position: 'absolute', bottom: 12, left: 12 }} className="badge-pill blue">Connecting from node — click a target node</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Datasets
export function DatasetsPage(): React.ReactElement {
  const s = useApp();
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<{ rows: Record<string, string>[]; columns: string[] } | null>(null);
  const load = async (): Promise<void> => setDatasets(await call<Dataset[]>('dataset.list', {}));
  useEffect(() => { void load(); }, [s.workspaceId]);
  const current = datasets.find((d) => d.id === sel) ?? datasets[0];
  useEffect(() => { setContent(current?.content ?? ''); setPreview(null); }, [current?.id]);
  const parse = async (): Promise<void> => {
    if (!current) return;
    setPreview(await call<{ rows: Record<string, string>[]; columns: string[] }>('dataset.parse', { content, format: current.format }));
  };
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 250, padding: 10 }}>
        <div className="row"><b>Datasets</b><span className="spacer" />
          <button className="btn sm" onClick={() => {
            const name = prompt('Dataset name'); if (!name) return;
            void call<Dataset>('dataset.save', { dataset: { id: uid(), workspaceId: s.workspaceId, name, format: 'csv', content: 'id,name\n1,Ada\n2,Grace\n', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }).then(load);
          }}>＋ New</button></div>
        {datasets.map((d) => (
          <div key={d.id} className={`tree-item ${current?.id === d.id ? 'sel' : ''}`} onClick={() => setSel(d.id)}>
            <span className="ti-label">{d.name}</span><span className="badge-pill grey">{d.format}</span>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {current ? (
          <div>
            <div className="row">
              <b>{current.name}</b>
              <select className="input sm" style={{ width: 110 }} value={current.format} onChange={(e) => { void call('dataset.save', { dataset: { ...current, format: e.target.value as 'csv' | 'json', updatedAt: new Date().toISOString() } }).then(load); }}>
                <option value="csv">csv</option><option value="json">json</option>
              </select>
              <button className="btn sm" onClick={() => { void call('dataset.save', { dataset: { ...current, content, updatedAt: new Date().toISOString() } }).then(() => { s.toast('ok', 'Saved'); void parse(); }); }}>Save</button>
              <button className="btn sm" onClick={() => void parse()}>Preview</button>
              <button className="btn sm" onClick={() => {
                const fileInput = document.createElement('input'); fileInput.type = 'file'; fileInput.accept = '.csv,.json';
                fileInput.onchange = async () => { const f = fileInput.files?.[0]; if (f) { setContent(await f.text()); s.toast('ok', 'Loaded into editor — press Save'); } };
                fileInput.click();
              }}>Load file</button>
              <span className="spacer" />
              <ConfirmButton label="Delete" onConfirm={() => void call('dataset.delete', { id: current.id }).then(load)} />
            </div>
            <CodeArea minRows={12} value={content} onChange={setContent} />
            {preview && (
              <div style={{ marginTop: 12 }}>
                <b>{preview.rows.length} rows × {preview.columns.length} cols</b>
                <table className="tbl" style={{ marginTop: 8 }}>
                  <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{preview.rows.slice(0, 30).map((r, i) => <tr key={i}>{preview.columns.map((c) => <td key={c} className="mono">{r[c]}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        ) : <div className="empty"><div className="big">🗃</div>Datasets feed collection runs (iteration data).</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhooks
export function WebhooksPage(): React.ReactElement {
  const s = useApp();
  const [hooks, setHooks] = useState<WebhookReceiver[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [patch, setPatch] = useState<{ responseStatus: number; responseBody: string; secret: string; hmacHeader: string }>({ responseStatus: 200, responseBody: 'ok', secret: '', hmacHeader: '' });
  const load = async (): Promise<void> => setHooks(await call<WebhookReceiver[]>('webhook.list', {}));
  const loadEvents = async (id: string): Promise<void> => setEvents(await call<WebhookEvent[]>('webhook.events', { id, limit: 100 }));
  useEffect(() => { void load(); }, [s.workspaceId]);
  useEffect(() => { if (sel) void loadEvents(sel); }, [sel]);
  useEffect(() => {
    const off = onEventType<WebhookEvent>('webhook.event', (p) => { if (sel && p.webhookId === sel) setEvents((prev) => [...prev, p]); });
    return off;
  }, [sel]);
  const current = hooks.find((h) => h.id === sel) ?? null;
  useEffect(() => {
    if (current) setPatch({ responseStatus: current.responseStatus, responseBody: current.responseBody, secret: current.secret ?? '', hmacHeader: current.hmacHeader ?? '' });
  }, [current?.id]);
  return (
    <div className="resizable-cols">
      <div className="col-l" style={{ width: 280, padding: 10 }}>
        <div className="row"><b>Webhooks</b><span className="spacer" />
          <button className="btn sm" onClick={() => {
            const name = prompt('Webhook name'); if (!name) return;
            const path = '/' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            void call('webhook.save', { webhook: { id: uid(), workspaceId: s.workspaceId, name, path, port: 0, running: false, responseStatus: 200, responseBody: 'ok', responseHeaders: [], createdAt: new Date().toISOString() } }).then(load);
          }}>＋ New</button></div>
        {hooks.map((h) => (
          <div key={h.id} className={`tree-item ${sel === h.id ? 'sel' : ''}`} onClick={() => setSel(h.id)}>
            <span className="ti-label">{h.name}</span>
            {h.running ? <span className="badge-pill green">● :{h.port}</span> : <span className="badge-pill grey">stopped</span>}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
        {current ? (
          <div>
            <div className="row">
              <b>{current.name}</b><code className="badge-pill grey">{current.path}</code>
              {current.running ? <span className="badge-pill green">listening :{current.port}</span> : <span className="badge-pill grey">will listen :{current.port}</span>}
              <span className="spacer" />
              {current.running ? (
                <button className="btn danger sm" onClick={() => void call('webhook.stop', { id: current.id }).then(load)}>Stop</button>
              ) : (
                <button className="btn primary sm" onClick={() => void call('webhook.start', { id: current.id }).then(load)}>Start</button>
              )}
              <ConfirmButton label="Delete" onConfirm={() => void call('webhook.delete', { id: current.id }).then(() => { setSel(null); void load(); })} />
            </div>
            <div className="card" style={{ marginTop: 10 }}>
              <h3>Responder config</h3>
              <div className="row">
                <label className="lbl" style={{ width: 46 }}>status</label>
                <input className="input sm" type="number" style={{ width: 90 }} value={patch.responseStatus} onChange={(e) => setPatch({ ...patch, responseStatus: Number(e.target.value) })} />
                <label className="lbl" style={{ width: 60 }}>secret</label>
                <input className="input sm" style={{ width: 180 }} placeholder="HMAC secret (optional)" value={patch.secret} onChange={(e) => setPatch({ ...patch, secret: e.target.value })} />
                <label className="lbl" style={{ width: 86 }}>sig header</label>
                <input className="input sm mono" style={{ width: 160 }} placeholder="x-signature" value={patch.hmacHeader} onChange={(e) => setPatch({ ...patch, hmacHeader: e.target.value })} />
              </div>
              <CodeArea minRows={2} value={patch.responseBody} onChange={(v) => setPatch({ ...patch, responseBody: v })} />
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => {
                void call('webhook.save', { webhook: { ...current, responseStatus: patch.responseStatus, responseBody: patch.responseBody, secret: patch.secret || undefined, hmacHeader: patch.hmacHeader || undefined } }).then(() => { void load(); s.toast('ok', 'Saved'); });
              }}>Save config</button>
            </div>
            <div className="card" style={{ marginTop: 10 }}>
              <div className="row"><b>Hits ({events.length})</b><span className="spacer" /><button className="btn sm" onClick={() => sel && void loadEvents(sel)}>↻</button></div>
              {events.map((e) => (
                <div key={e.id} className="card" style={{ marginTop: 8 }}>
                  <div className="row">
                    <span className="badge-pill grey">{e.method}</span><code className="mono">{e.path}</code>
                    <span className="dim">{ts(e.timestamp)}</span>
                    {e.signatureValid !== undefined && <span className={`badge-pill ${e.signatureValid ? 'green' : 'red'}`}>{e.signatureValid ? 'sig ✓' : 'sig ✗'}</span>}
                    <span className="spacer" />
                    <button className="btn xs" onClick={() => { void call<{ id: string }>('webhook.saveAsRequest', { eventId: e.id }).then((r) => { s.toast('ok', 'Saved as request'); void s.refreshCollections(); setSel(r.id); }).catch((err) => s.toast('err', String(err && (err as Error).message))); }}>→ request</button>
                  </div>
                  <div className="mono dim" style={{ marginTop: 6 }}>{e.body.slice(0, 300)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : <div className="empty"><div className="big">🔔</div>Pick a webhook receiver — incoming hits show live, and can be converted to requests.</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capture
export function CapturePage(): React.ReactElement {
  const s = useApp();
  const [exchanges, setExchanges] = useState<CapturedExchange[]>([]);
  const [selected, setSelected] = useState<CapturedExchange | null>(null);
  const [status, setStatus] = useState<{ running: boolean; port: number }>({ running: false, port: 0 });
  const [port, setPort] = useState(9999);
  const refresh = async (): Promise<void> => {
    setExchanges(await call<CapturedExchange[]>('capture.list', { limit: 200 }));
    setStatus(await call<{ running: boolean; port: number }>('capture.status', {}));
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    const off = onEventType<CapturedExchange>('capture.exchange', (p) => setExchanges((prev) => [...prev, p].slice(-200)));
    return off;
  }, []);
  return (
    <div className="pad">
      <div className="row">
        <h3 style={{ margin: 0 }}>Traffic capture (local HTTP proxy)</h3><span className="spacer" />
        {status.running ? <span className="badge-pill green">● :{status.port}</span> : <span className="badge-pill grey">stopped</span>}
        <button className="btn xs" onClick={() => void refresh()}>↻</button>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <div className="row">
          <label className="lbl">port</label>
          <input className="input sm" style={{ width: 100 }} type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          {status.running ? (
            <button className="btn danger sm" onClick={() => void call('capture.stop', {}).then(refresh)}>Stop</button>
          ) : (
            <button className="btn primary sm" onClick={() => void call('capture.start', { port }).then(refresh)}>Start proxy</button>
          )}
          <button className="btn sm" onClick={() => void call('capture.clear', {}).then(() => setExchanges([]))}>Clear</button>
          <div className="muted" style={{ flex: 1 }}>Point your tool at <code>http://127.0.0.1:{port}</code> — requests get proxied and shown below. Every hit can be saved as a request.</div>
        </div>
      </div>
      <div className="resizable-cols" style={{ marginTop: 12 }}>
        <div style={{ width: 340, overflow: 'auto' }}>
          {exchanges.map((x) => (
            <div key={x.id} className={`tree-item ${selected?.id === x.id ? 'sel' : ''}`} onClick={() => setSelected(x)}>
              <span className="badge-pill grey">{x.method}</span>
              <span className="ti-label mono">{x.url.slice(0, 40)}</span>
              <span className={typeof x.status === 'number' ? (x.status >= 400 ? 'status-4xx' : x.status >= 300 ? 'status-3xx' : 'status-2xx') : 'dim'}>{x.status ?? '…'}</span>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
          {selected ? (
            <div>
              <div className="row">
                <b className="mono">{selected.method} {selected.url}</b>
                <span className="spacer" />
                <button className="btn sm primary" onClick={() => {
                  void call<{ id: string }>('capture.saveAsRequest', { id: selected.id }).then(() => { s.toast('ok', 'Saved as request'); void s.refreshCollections(); setSelected(null); });
                }}>Save as request</button>
              </div>
              <div className="dim mono" style={{ marginTop: 6 }}>client: {selected.client ?? '—'} · duration {selected.durationMs ?? '—'} ms · {ts(selected.timestamp)}</div>
              <h4>Response ({selected.status})</h4>
              <CodeArea readOnly minRows={3} value={typeof selected.responseBody === 'string' ? selected.responseBody : ''} onChange={() => undefined} />
              <h4 style={{ marginTop: 10 }}>Request body</h4>
              <CodeArea readOnly minRows={2} value={String(selected.requestBody ?? '')} onChange={() => undefined} />
            </div>
          ) : <div className="empty">Select an exchange</div>}
        </div>
      </div>
    </div>
  );
}
