/**
 * Request page: full request editor + response viewer (HTTP workbench).
 *
 * Custom controls implemented here (see CUSTOM_FEATURES.md):
 *  - response zoom out / % / in / reset with Ctrl+= Ctrl+- Ctrl+0
 *  - response word wrap ON/OFF (persisted)
 *  - Copy: Body · Headers · Headers+Body · Status+Headers+Body (with confirmation)
 *  - Download: Body · Headers · Headers+Body · Raw response (content-type extensions)
 *  - response search: next/prev/count, case-sensitive / whole-word / regex
 *  - request body toolbar: zoom · wrap · find · replace · format
 *  - per-tab drafts + viewer state survive restarts via the crash-safe session
 */
import React, { useEffect, useMemo, useState } from 'react';
import { call, onEventType } from './bridge';
import { useApp, type OpenTab } from './state';
import {
  CodeArea, countMatches, EnvSelect, escapeTextHtml, fmtBytes, fmtMs, JsonView, KVEditor,
  Modal, saveBlob, SubTabs, ts, uid, type SubTab,
} from './components';
import { CodeEditorField } from './CodeEditorField';
import { MonacoEditor } from './MonacoEditor';
import type { ApiRequest, ApiResponse, AuthConfig, KeyValue, RequestBody, FormDataField } from '../shared/types';
import {
  copyBundles, downloadBundles, zoomIn as zIn, zoomOut as zOut, zoomPct, clampZoom,
  suggestExtension,
} from '../core/response/responseFormat';
import { markSearch, buildSearchRegExp, type SearchOptions } from './responseExport';

type CoreSearchOpts = SearchOptions;

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
const BODY_TYPES = ['none', 'json', 'xml', 'html', 'javascript', 'text', 'graphql', 'urlencoded', 'form-data', 'binary'] as const;

function defaultSettings(): ApiRequest['settings'] {
  return {
    timeoutMs: 30000, followRedirects: true, maxRedirects: 10, preserveAuthOnRedirect: true, stripSensitiveHeaders: true,
    retry: { enabled: false, maxRetries: 0, strategy: 'fixed', delayMs: 0, retryStatusCodes: [], retryOnNetworkError: false, retryOnTimeout: false, onlyIdempotent: false },
    httpVersion: 'auto', encodeUrl: true, verifyTls: false, storeResponse: true,
  };
}

function emptyRequest(workspaceId: string): ApiRequest {
  return {
    id: uid(), workspaceId, name: 'Untitled', method: 'GET', url: '',
    pathParams: [], queryParams: [], headers: [], body: { type: 'none' }, auth: { type: 'inherit' },
    assertions: [], scripts: { preRequest: '', postResponse: '' }, protocol: 'http', tags: [],
    favorite: false, sortOrder: 0, settings: defaultSettings(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

interface SendResultPayload {
  opId: string; response?: ApiResponse; error?: string;
  preTestResults: TestRow[]; postTestResults: TestRow[]; assertionResults: TestRow[];
  consoleLogs: { level: string; args: unknown[] }[];
  variableTrace: { variable: string; scope: string; valueMasked: string; found: boolean }[];
  resolvedUrl: string;
}
interface TestRow { name: string; passed: boolean; error?: string; source?: string }
interface SearchState extends CoreSearchOpts { }

export function RequestPage(props: { tab: OpenTab }): React.ReactElement {
  const s = useApp();
  const [req, setReq] = useState<ApiRequest | null>(null);
  const [resp, setResp] = useState<ApiResponse | null>(null);
  const [preResults, setPreResults] = useState<TestRow[]>([]);
  const [postResults, setPostResults] = useState<TestRow[]>([]);
  const [consoleLogs, setConsoleLogs] = useState<{ level: string; args: unknown[] }[]>([]);
  const [variableTrace, setVariableTrace] = useState<SendResultPayload['variableTrace']>([]);
  const [resolvedUrl, setResolvedUrl] = useState('');
  const [subtab, setSubtab] = useState('params');
  const [respTab, setRespTab] = useState('body');
  const [progress, setProgress] = useState<string | null>(null);
  const [opId, setOpId] = useState<string | null>(null);
  const [showSaveTo, setShowSaveTo] = useState(false);
  const [showCurlImport, setShowCurlImport] = useState(false);
  const [showCodegen, setShowCodegen] = useState(false);
  const [zoom, setZoom] = useState(() => clampZoom(s.settings?.editor.responseZoom ?? 1));
  const [wrap, setWrap] = useState(() => s.settings?.editor.wordWrap ?? false);
  const [respSearch, setRespSearch] = useState<string | null>(null);
  const [searchState, setSearchState] = useState<SearchState>({});
  const [activeHit, setActiveHit] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [errored, setErrored] = useState<string | null>(null);

  const isNew = props.tab.id.startsWith('req:new:');

  // ---- load entity or restore a draft ----
  useEffect(() => {
    setResp(null);
    const draft = props.tab.draft;
    setSubtab(props.tab.view?.builderTab ?? 'params');
    setRespTab(props.tab.view?.responseTab ?? 'body');
    if (props.tab.view?.responseZoom) setZoom(clampZoom(props.tab.view.responseZoom));
    if (typeof props.tab.view?.responseWrap === 'boolean') setWrap(props.tab.view.responseWrap);
    if (draft) { setReq(draft); setDirty(!!props.tab.dirty); return; }
    if (isNew || !props.tab.entityId) { setReq(emptyRequest(s.workspaceId)); return; }
    let alive = true;
    void call<ApiRequest>('request.get', { id: props.tab.entityId }).then((r) => {
      if (!alive) return;
      setReq(r); setDirty(false);
      void call<ApiResponse[]>('http.recentResponses', { requestId: r.id, limit: 1 }).then((rs) => alive && setResp(rs[0] ?? null)).catch(() => undefined);
    }).catch(() => alive && setReq(emptyRequest(s.workspaceId)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tab.entityId, isNew, s.workspaceId]);

  // persist zoom/wrap preference and per-tab view state
  useEffect(() => { void s.patchResponseViewer({ zoom, wordWrap: wrap }); }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void s.patchResponseViewer({ wordWrap: wrap }); }, [wrap]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { s.updateTabView(props.tab.id, { builderTab: subtab, responseTab: respTab, responseZoom: zoom, responseWrap: wrap }); }, [subtab, respTab]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (req) s.markDirty(props.tab.id, dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onEventType<import('../shared/events').RequestProgressEvent>('request.progress', (payload) => {
    if (payload.phase === 'done') { setProgress(null); return; }
    setProgress(() => (payload.detail ? `${payload.phase} · ${payload.detail}` : payload.phase) + (payload.attempt && payload.attempt > 1 ? ` (attempt ${payload.attempt})` : ''));
  }), []);

  useEffect(() => {
    const onSave = (): void => { void saveRequest(); };
    window.addEventListener('am:save', onSave);
    return () => window.removeEventListener('am:save', onSave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, dirty]);

  // ---- keyboard: response zoom + Ctrl+F search + Ctrl+Enter send ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key;
      const inMonaco = (e.target as HTMLElement)?.closest?.('.monaco-editor');
      const inField = inMonaco || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
      if (key === '=' || key === '+' || key === '-') {
        if (inField && !inMonaco) return; // don't hijack typing in tiny inputs
        e.preventDefault();
        setZoom((z) => key === '-' ? zOut(z) : zIn(z));
      } else if (key === '0') {
        if (inField && !inMonaco) return;
        e.preventDefault();
        setZoom(1);
      } else if (key.toLowerCase() === 'f' && !inField && resp) {
        e.preventDefault();
        setRespSearch((v) => v ?? '');
      } else if (key === 'Enter' && inField) {
        e.preventDefault(); void sendRequest();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resp]);

  const patch = (p: Partial<ApiRequest>): void => {
    setReq((r) => {
      if (!r) return r;
      const next = { ...r, ...p };
      s.updateTabDraft(props.tab.id, next, true);
      return next;
    });
    setDirty(true);
  };

  const saveRequest = async (): Promise<void> => {
    if (!req) return;
    if (!req.collectionId) { setShowSaveTo(true); return; }
    const { id: _id, workspaceId: _w, favorite, sortOrder, createdAt, updatedAt, ...rest } = req;
    void favorite; void sortOrder; void createdAt; void updatedAt;
    await call('request.update', { id: req.id, patch: rest });
    setDirty(false);
    s.convertDraftTab(props.tab.id, req);
    void s.refreshCollections();
    s.toast('ok', 'Request saved');
  };

  const sendRequest = async (): Promise<void> => {
    if (!req) return;
    setProgress('starting'); setErrored(null); setPostResults([]); setConsoleLogs([]); setVariableTrace([]);
    try {
      const result = await call<SendResultPayload>('http.send', {
        request: req, environmentId: s.activeEnvironmentId ?? undefined, saveHistory: true,
      });
      setOpId(result.opId);
      setErrored(result.error ? String(result.error) : null);
      setResp(result.response ?? null);
      setPreResults(result.preTestResults ?? []);
      setPostResults([...(result.preTestResults ?? []), ...(result.postTestResults ?? []), ...(result.assertionResults ?? [])] as TestRow[]);
      setConsoleLogs(result.consoleLogs ?? []);
      setVariableTrace(result.variableTrace ?? []);
      setResolvedUrl(result.resolvedUrl ?? '');
      setRespTab(result.error ? 'console' : 'body');
      void s.refreshCollections();
    } catch (e) {
      setErrored(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      setOpId(null);
    }
  };

  const cancel = async (): Promise<void> => { if (opId) await call('http.cancel', { opId }); setProgress(null); };

  if (!req) return <div className="empty"><div className="big">⏳</div>Loading…</div>;

  const subtabs: SubTab[] = [
    { id: 'params', label: 'Params', count: req.queryParams.filter((q) => q.enabled).length },
    { id: 'headers', label: 'Headers', count: req.headers.filter((h) => h.enabled).length },
    { id: 'body', label: 'Body', count: req.body.type === 'none' ? 0 : 1 },
    { id: 'auth', label: 'Auth', count: req.auth.type === 'none' || req.auth.type === 'inherit' ? 0 : 1 },
    { id: 'scripts', label: 'Scripts' },
    { id: 'tests', label: 'Tests', count: req.assertions.length },
    { id: 'settings', label: 'Settings' },
    { id: 'notes', label: 'Notes' },
  ];

  const respSubtabs: SubTab[] = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', count: resp?.headers.length ?? 0 },
    { id: 'cookies', label: 'Cookies' },
    { id: 'timeline', label: 'Timeline' },
    { id: 'tests', label: 'Test Results', count: preResults.length + postResults.length },
    { id: 'console', label: 'Console', count: consoleLogs.length },
    { id: 'trace', label: 'Variables', count: variableTrace.length },
    { id: 'compare', label: 'Compare' },
  ];

  const onSplitDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    if (!container) return;
    const move = (ev: MouseEvent): void => {
      const ratio = (ev.clientY - container.top) / container.height;
      s.setSplitRatio(ratio);
    };
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); void s.flushSession(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div style={{ height: '100%', display: 'grid', gridTemplateRows: 'auto auto minmax(0,1fr)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 170px 72px 76px 42px', gap: 8, padding: '10px 10px 6px' }}>
        <select className="input sm" value={req.method} onChange={(e) => patch({ method: e.target.value as ApiRequest['method'] })}
          title="HTTP method">
          {METHODS.map((m) => <option key={m}>{m}</option>)}
        </select>
        <input className="input" placeholder="Enter request URL (paste cURL to import)…  Ctrl+Enter to send" value={req.url}
          onChange={(e) => patch({ url: e.target.value })}
          onPaste={(e) => { const text = e.clipboardData.getData('text'); if (text.trimStart().startsWith('curl ')) { e.preventDefault(); setShowCurlImport(true); } }}
          onKeyDown={(e) => { if (e.key === 'Enter') void sendRequest(); }} />
        <EnvSelect />
        <button className="btn primary" onClick={() => void sendRequest()} disabled={!!progress} accessKey="s">{progress ? '…' : 'Send'}</button>
        <button className="btn" onClick={() => void saveRequest()}>{dirty ? 'Save*' : 'Save'}</button>
        <button className="btn" title="Save as / choose collection" onClick={() => setShowSaveTo(true)}>⌄</button>
      </div>
      <div className="row pad-x" style={{ gap: 10, paddingBottom: 6 }}>
        <button className="btn xs" onClick={() => setShowCurlImport(true)}>⌗ from cURL</button>
        <button className="btn xs" onClick={() => setShowCodegen(true)}>{'</ > code'}</button>
        {resolvedUrl && <span className="mono dim" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '46%' }}>resolved: {resolvedUrl}</span>}
        {progress && <span className="dim" style={{ fontSize: 11.5 }}>{progress}{' '}<button className="link" onClick={() => void cancel()}>cancel</button></span>}
        <span className="spacer" />
        {dirty && <span className="muted" style={{ fontSize: 11.5 }}>unsaved</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateRows: `minmax(0, ${s.splitRatio * 100}fr) 7px minmax(0, 1fr)`, minHeight: 0 }}>
        <div style={{ overflow: 'auto', minHeight: 0 }}>
          <SubTabs tabs={subtabs} active={subtab} onChange={setSubtab} />
          <div className="pad" style={{ paddingTop: 10 }}>
            {subtab === 'params' && <KVEditor items={req.queryParams} onChange={(items) => patch({ queryParams: items })} allowDesc />}
            {subtab === 'headers' && <KVEditor items={req.headers} onChange={(items) => patch({ headers: items })} allowDesc />}
            {subtab === 'body' && <BodyEditor req={req} patch={patch} />}
            {subtab === 'auth' && <AuthEditor req={req} patch={patch} />}
            {subtab === 'scripts' && (
              <div className="grid2">
                <div>
                  <div className="section-title">Pre-request script (pm.*)</div>
                  <CodeEditorField value={req.scripts.preRequest ?? ''} language="javascript" minHeight={260}
                    onChange={(preRequest) => patch({ scripts: { ...req.scripts, preRequest } })} />
                </div>
                <div>
                  <div className="section-title">Post-response / tests (pm.test)</div>
                  <CodeEditorField value={req.scripts.postResponse ?? ''} language="javascript" minHeight={260}
                    onChange={(postResponse) => patch({ scripts: { ...req.scripts, postResponse } })} />
                </div>
              </div>
            )}
            {subtab === 'tests' && <AssertionsPanel req={req} patch={patch} />}
            {subtab === 'settings' && <RequestSettingsEditor req={req} patch={patch} />}
            {subtab === 'notes' && (
              <CodeEditorField value={req.documentation ?? ''} language="markdown" minHeight={200} showToolbar={false}
                placeholder="Markdown documentation for this request…"
                onChange={(documentation) => patch({ documentation })} />
            )}
          </div>
        </div>

        <div className="split-drag" onMouseDown={onSplitDrag} title="Drag to resize" />

        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <ResponseTopBar
            resp={resp} errored={errored}
            zoom={zoom} setZoom={(z) => setZoom(clampZoom(z))}
            wrap={wrap} setWrap={setWrap}
            search={respSearch} setSearch={(v) => { setRespSearch(v); setActiveHit(0); }}
            searchState={searchState} setSearchState={setSearchState}
            activeHit={activeHit} setActiveHit={setActiveHit}
            req={req}
          />
          <SubTabs tabs={respSubtabs} active={respTab} onChange={setRespTab} />
          <div id="resp-scroll" style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '10px' }}>
            {respTab === 'body' && <ResponseBody resp={resp} errored={errored} zoom={zoom} wrap={wrap} search={respSearch} searchState={searchState} activeHit={activeHit} />}
            {respTab === 'headers' && (resp ? (
              <div>
                <div className="row" style={{ marginBottom: 6 }}>
                  <button className="btn xs" onClick={() => { void navigator.clipboard.writeText(copyBundles(withSnap(resp, req)).headers.content); s.toast('ok', 'Response headers copied'); }}>Copy headers</button>
                  <button className="btn xs" onClick={() => { const d = downloadBundles(withSnap(resp, req)).headers; saveBlob(d.name, d.mime, d.content); s.toast('ok', `Downloaded ${d.name}`); }}>Download headers</button>
                </div>
                <table className="tbl"><tbody>
                  {resp.headers.map((h, i) => <tr key={i}><td className="mono" style={{ width: 320 }}>{h.key}</td><td className="mono">{h.value}</td></tr>)}
                </tbody></table>
              </div>
            ) : <div className="muted">—</div>)}
            {respTab === 'cookies' && <CookiesTab workspaceId={s.workspaceId} />}
            {respTab === 'timeline' && (resp ? <Timeline resp={resp} /> : <div className="muted">—</div>)}
            {respTab === 'tests' && <TestResults rows={[...preResults, ...postResults]} />}
            {respTab === 'console' && (
              <div>
                {consoleLogs.length === 0 && <div className="muted">No script output. Use console.log / console.warn / console.error in scripts.</div>}
                {consoleLogs.map((l, i) => (
                  <div key={i} className="mono" style={{ padding: '2px 0' }}>
                    <span className="badge-pill grey">{l.level}</span> {l.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}
                  </div>
                ))}
                {errored && <div className="mono" style={{ color: 'var(--red)', marginTop: 6 }}>{errored}</div>}
              </div>
            )}
            {respTab === 'trace' && (variableTrace.length > 0 ? (
              <table className="tbl"><tbody>
                {variableTrace.map((t, i) => (
                  <tr key={i}>
                    <td className="mono">{`{{${t.variable}}}`}</td><td>{t.scope}</td><td className="mono">{t.valueMasked}</td>
                    <td>{t.found ? '✓' : <span className="badge-pill red">unresolved</span>}</td>
                  </tr>
                ))}
              </tbody></table>
            ) : <div className="muted">No variables used in URL/headers/body or resolution not recorded yet.</div>)}
            {respTab === 'compare' && <CompareResponses requestId={req.id} current={resp} />}
          </div>
        </div>
      </div>

      <div className="row pad" style={{ borderTop: '1px solid var(--border)', gap: 8, marginTop: 4 }}>
        <span className="lbl" style={{ margin: 0 }}>Save to:</span>
        <select className="input sm" style={{ width: 220 }} value={req.collectionId ?? ''} onChange={(e) => patch({ collectionId: e.target.value || undefined, folderId: undefined })}>
          <option value="">(choose a collection)</option>
          {s.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {req.collectionId && (
          <select className="input sm" style={{ width: 170 }} value={req.folderId ?? ''} onChange={(e) => patch({ folderId: e.target.value || undefined })}>
            <option value="">(no folder)</option>
            {s.folders.filter((f) => f.collectionId === req.collectionId).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <span className="spacer" />
      </div>

      {showSaveTo && <SaveToModal tab={props.tab} req={req} onClose={() => setShowSaveTo(false)}
        onSaved={(saved) => { setShowSaveTo(false); setDirty(false); setReq(saved); s.convertDraftTab(props.tab.id, saved); void s.refreshCollections(); s.toast('ok', 'Request saved'); }} />}
      {showCurlImport && <CurlImportModal onClose={() => setShowCurlImport(false)}
        onApply={(r) => { setReq({ ...emptyRequest(s.workspaceId), ...r }); setDirty(true); s.updateTabDraft(props.tab.id, { ...emptyRequest(s.workspaceId), ...r }, true); setShowCurlImport(false); s.toast('ok', 'cURL parsed'); }} />}
      {showCodegen && <CodegenModal request={req} onClose={() => setShowCodegen(false)} />}
    </div>
  );
}

function withSnap(r: ApiResponse, req: ApiRequest): ApiResponse {
  return { ...r, requestSnapshot: r.requestSnapshot ?? { method: req.method, url: req.url, headers: req.headers } };
}

// ---------------------------------------------------------------------------
function BodyEditor(props: { req: ApiRequest; patch: (p: Partial<ApiRequest>) => void }): React.ReactElement {
  const { req, patch } = props;
  const body = req.body ?? { type: 'none' };
  const setType = (type: string): void => {
    const next: RequestBody = { ...body, type: type as RequestBody['type'] };
    if (['json', 'xml', 'html', 'javascript', 'text', 'graphql'].includes(type) && next.raw === undefined) next.raw = '';
    patch({ body: next });
  };
  const langFor: Record<string, string> = {
    json: 'json', xml: 'xml', html: 'html', javascript: 'javascript',
    graphql: 'graphql', text: 'plaintext',
  };
  const rawType = body.type;
  const RAW_LIKE: readonly string[] = ['json', 'xml', 'html', 'javascript', 'text', 'graphql'];
  return (
    <div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {BODY_TYPES.map((t) => (
          <label key={t} className="checkbox">
            <input type="radio" name="body-type" checked={body.type === t} onChange={() => setType(t)} />
            <span className={body.type === t ? '' : 'dim'}>{t}</span>
          </label>
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        {RAW_LIKE.includes(rawType) && (
          <CodeEditorField
            value={body.raw ?? ''}
            language={langFor[rawType] ?? 'plaintext'}
            minHeight={240}
            onChange={(raw) => patch({ body: { ...body, raw } })}
            placeholder={rawType === 'json' ? '{ "hello": "world" }' : rawType === 'graphql' ? 'query { viewer { login } }\n\n--- variables ---\n{ }' : 'Body…'}
          />
        )}
        {rawType === 'graphql' && (
          <div className="muted" style={{ marginTop: 4 }}>
            GraphQL body is POSTed as {'{ query, variables }'}. Put optional variables after a <code>--- variables ---</code> line.
          </div>
        )}
        {rawType === 'urlencoded' && <KVEditor items={body.urlencoded ?? []} onChange={(urlencoded) => patch({ body: { ...body, urlencoded } })} />}
        {rawType === 'form-data' && <MultipartEditor items={body.formData ?? []} onChange={(formData) => patch({ body: { ...body, formData } })} />}
        {rawType === 'binary' && (
          <div className="card" style={{ maxWidth: 640 }}>
            <label className="lbl">File path (absolute)</label>
            <div className="row">
              <input className="input mono" placeholder="/path/to/upload.bin" value={body.binaryFilePath ?? ''} onChange={(e) => patch({ body: { ...body, binaryFilePath: e.target.value } })} />
              <button className="btn sm" onClick={async () => {
                const paths = await call<string[]>('dialog.openFile', { filters: [{ name: 'All files', extensions: ['*'] }] });
                if (paths?.[0]) patch({ body: { ...body, binaryFilePath: paths[0] } });
              }}>Browse…</button>
            </div>
            <label className="lbl">Content-Type (blank = auto-detect)</label>
            <input className="input" style={{ maxWidth: 280 }} value={body.contentTypeOverride ?? ''} onChange={(e) => patch({ body: { ...body, contentTypeOverride: e.target.value } })} />
          </div>
        )}
        {rawType === 'none' && <div className="muted">This request has no body.</div>}
      </div>
    </div>
  );
}

function MultipartEditor(props: { items: FormDataField[]; onChange: (m: FormDataField[]) => void }): React.ReactElement {
  const { items } = props;
  const update = (i: number, p: Partial<FormDataField>): void => props.onChange(items.map((x, k) => (k === i ? { ...x, ...p } : x)));
  return (
    <div>
      {items.map((it, i) => (
        <div className="kv-row" key={it.id} style={{ gridTemplateColumns: '22px 1fr 1fr 150px 24px' }}>
          <input type="checkbox" checked={it.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
          <input className="input sm" placeholder="Field name" value={it.key} onChange={(e) => update(i, { key: e.target.value })} />
          <input className="input sm" placeholder={it.fieldType === 'file' ? 'File path…' : 'Value'} value={it.value} onChange={(e) => update(i, { value: e.target.value })} />
          <select
            className="input sm"
            value={it.fieldType === 'file' ? 'file' : (it.mimeType ?? 'text')}
            onChange={(e) => update(i, e.target.value === 'file' ? { fieldType: 'file' } : e.target.value === 'text' ? { fieldType: 'text', mimeType: undefined } : { fieldType: 'text', mimeType: e.target.value })}
          >
            <option value="text">text</option>
            <option value="file">file *</option>
            <option value="application/json">application/json</option>
            <option value="image/png">image/png</option>
            <option value="application/octet-stream">octet-stream</option>
          </select>
          <button className="icon-btn" onClick={() => props.onChange(items.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      <button className="btn sm" onClick={() => props.onChange([...items, { id: uid(), key: '', value: '', enabled: true, fieldType: 'text' }])}>+ Add part</button>
      <div className="muted" style={{ marginTop: 6 }}>(* file parts: value holds the absolute file path)</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function AuthEditor(props: { req: ApiRequest; patch: (p: Partial<ApiRequest>) => void }): React.ReactElement {
  const { req, patch } = props;
  const auth = req.auth ?? { type: 'inherit' };
  const set = (a: AuthConfig): void => patch({ auth: a });
  const TYPES: string[] = ['inherit', 'none', 'basic', 'bearer', 'apikey', 'digest', 'hawk', 'ntlm', 'aws4', 'oauth1', 'oauth2', 'jwt', 'custom'];
  return (
    <div>
      <div className="row">
        <span className="lbl" style={{ margin: 0 }}>Type</span>
        <select className="input sm" style={{ width: 200 }} value={auth.type} onChange={(e) => set({ type: e.target.value as AuthConfig['type'] })}>
          {TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        {auth.type === 'inherit' && <span className="muted">Inherits from collections/folders, falling back to “none”.</span>}
      </div>
      <div style={{ marginTop: 10, maxWidth: 620 }}>
        {auth.type === 'basic' && (<>
          <label className="lbl">Username</label>
          <input className="input" value={auth.basic?.username ?? ''} onChange={(e) => set({ ...auth, basic: { ...auth.basic, username: e.target.value, password: auth.basic?.password ?? '' } })} />
          <label className="lbl">Password</label>
          <input className="input" type="password" value={auth.basic?.password ?? ''} onChange={(e) => set({ ...auth, basic: { username: auth.basic?.username ?? '', password: e.target.value } })} />
        </>)}
        {auth.type === 'bearer' && (<>
          <label className="lbl">Token</label>
          <CodeArea minRows={2} value={auth.bearer?.token ?? ''} onChange={(token) => set({ ...auth, bearer: { ...auth.bearer, token } })} />
          <label className="lbl">Prefix (default: Bearer)</label>
          <input className="input" value={auth.bearer?.prefix ?? ''} onChange={(e) => set({ ...auth, bearer: { token: auth.bearer?.token ?? '', prefix: e.target.value } })} />
        </>)}
        {auth.type === 'apikey' && (<>
          <label className="lbl">Key</label>
          <input className="input" value={auth.apikey?.key ?? ''} onChange={(e) => set({ ...auth, apikey: { addTo: auth.apikey?.addTo ?? 'header', key: e.target.value, value: auth.apikey?.value ?? '' } })} />
          <label className="lbl">Value</label>
          <input className="input" value={auth.apikey?.value ?? ''} onChange={(e) => set({ ...auth, apikey: { addTo: auth.apikey?.addTo ?? 'header', value: e.target.value, key: auth.apikey?.key ?? '' } })} />
          <label className="lbl">Add to</label>
          <select className="input" value={auth.apikey?.addTo ?? 'header'} onChange={(e) => set({ ...auth, apikey: { key: auth.apikey?.key ?? '', value: auth.apikey?.value ?? '', addTo: e.target.value as 'header' | 'query' } })}>
            <option value="header">Header</option><option value="query">Query param</option>
          </select>
        </>)}
        {auth.type === 'digest' && (<>
          <label className="lbl">Username</label>
          <input className="input" value={auth.digest?.username ?? ''} onChange={(e) => set({ ...auth, digest: { ...auth.digest, username: e.target.value, password: auth.digest?.password ?? '' } })} />
          <label className="lbl">Password</label>
          <input className="input" type="password" value={auth.digest?.password ?? ''} onChange={(e) => set({ ...auth, digest: { username: auth.digest?.username ?? '', password: e.target.value } })} />
        </>)}
        {auth.type === 'hawk' && (<>
          <label className="lbl">ID</label>
          <input className="input" value={auth.hawk?.authId ?? ''} onChange={(e) => set({ ...auth, hawk: { ...auth.hawk, algorithm: auth.hawk?.algorithm ?? 'sha256', authId: e.target.value, authKey: auth.hawk?.authKey ?? '' } })} />
          <label className="lbl">Key</label>
          <input className="input" value={auth.hawk?.authKey ?? ''} onChange={(e) => set({ ...auth, hawk: { algorithm: auth.hawk?.algorithm ?? 'sha256', authId: auth.hawk?.authId ?? '', authKey: e.target.value } })} />
        </>)}
        {auth.type === 'ntlm' && (<>
          <label className="lbl">Username</label>
          <input className="input" value={auth.ntlm?.username ?? ''} onChange={(e) => set({ ...auth, ntlm: { ...auth.ntlm, username: e.target.value, password: auth.ntlm?.password ?? '' } })} />
          <label className="lbl">Password</label>
          <input className="input" type="password" value={auth.ntlm?.password ?? ''} onChange={(e) => set({ ...auth, ntlm: { username: auth.ntlm?.username ?? '', password: e.target.value } })} />
          <label className="lbl">Domain</label>
          <input className="input" value={auth.ntlm?.domain ?? ''} onChange={(e) => set({ ...auth, ntlm: { username: auth.ntlm?.username ?? '', password: auth.ntlm?.password ?? '', domain: e.target.value } })} />
        </>)}
        {auth.type === 'aws4' && (<>
          <label className="lbl">Access key</label>
          <input className="input" value={auth.aws4?.accessKey ?? ''} onChange={(e) => set({ ...auth, aws4: { region: auth.aws4?.region ?? '', service: auth.aws4?.service ?? '', accessKey: e.target.value, secretKey: auth.aws4?.secretKey ?? '' } })} />
          <label className="lbl">Secret key</label>
          <input className="input" type="password" value={auth.aws4?.secretKey ?? ''} onChange={(e) => set({ ...auth, aws4: { region: auth.aws4?.region ?? '', service: auth.aws4?.service ?? '', accessKey: auth.aws4?.accessKey ?? '', secretKey: e.target.value } })} />
          <label className="lbl">Region / Service</label>
          <div className="row">
            <input className="input" placeholder="us-east-1" value={auth.aws4?.region ?? ''} onChange={(e) => set({ ...auth, aws4: { service: auth.aws4?.service ?? '', accessKey: auth.aws4?.accessKey ?? '', secretKey: auth.aws4?.secretKey ?? '', region: e.target.value } })} />
            <input className="input" placeholder="s3/execute-api/…" value={auth.aws4?.service ?? ''} onChange={(e) => set({ ...auth, aws4: { region: auth.aws4?.region ?? '', accessKey: auth.aws4?.accessKey ?? '', secretKey: auth.aws4?.secretKey ?? '', service: e.target.value } })} />
          </div>
        </>)}
        {auth.type === 'oauth1' && <div className="muted">OAuth 1.0a is applied at send time using consumer key/secret + token — configure via the OAuth page and reference with {'{{oauthToken}}'}.</div>}
        {auth.type === 'oauth2' && (
          <div>
            <label className="lbl">Access token (generate via OAuth page)</label>
            <input className="input" value={auth.oauth2?.accessToken ?? ''} onChange={(e) => set({ ...auth, oauth2: { ...auth.oauth2, grantType: auth.oauth2?.grantType ?? 'authorization_code_pkce', accessToken: e.target.value } })} />
            <div className="muted" style={{ marginTop: 4 }}>Grant config (auth URL, PKCE, client id/secret…) lives under OAuth in the sidebar; the stored token is used here.</div>
          </div>
        )}
        {auth.type === 'jwt' && (
          <div>
            <label className="lbl">Signed JWT (paste or reference {'{{vault:jwt}}'})</label>
            <CodeArea minRows={3} value={auth.bearer?.token ?? ''} onChange={(token) => set({ ...auth, type: 'jwt', bearer: { token } })} />
          </div>
        )}
        {auth.type === 'custom' && (<>
          <label className="lbl">Header name</label>
          <input className="input" value={auth.custom?.headerName ?? ''} onChange={(e) => set({ ...auth, custom: { ...auth.custom, headerName: e.target.value, expression: auth.custom?.expression ?? '' } })} />
          <label className="lbl">Value</label>
          <input className="input mono" placeholder="e.g. {{token}} or raw value" value={auth.custom?.expression ?? ''} onChange={(e) => set({ ...auth, custom: { headerName: auth.custom?.headerName ?? '', expression: e.target.value } })} />
        </>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function AssertionsPanel(props: { req: ApiRequest; patch: (p: Partial<ApiRequest>) => void }): React.ReactElement {
  const [defs, setDefs] = useState<{ type: string; label: string; params: string[] }[]>([]);
  useEffect(() => { void call<{ type: string; label: string; params: string[] }[]>('assertion.types').then(setDefs).catch(() => { setDefs([{ type: 'status-equals', label: 'status-equals', params: [] }]); }); }, []);
  const items = props.req.assertions ?? [];
  const setItems = (arr: typeof items): void => props.patch({ assertions: arr });
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn sm" onClick={() => setItems([...items, { id: uid(), type: 'statusCode', enabled: true, operator: 'eq', property: '', expected: '200' }])}>+ Add assertion</button>
        <span className="muted">type · optional target (jsonpath $..id / xpath / header name) · expected value</span>
      </div>
      {items.map((a, i) => (
        <div className="kv-row" key={a.id} style={{ gridTemplateColumns: '22px 220px 1fr 1fr 24px' }}>
          <input type="checkbox" checked={a.enabled} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, enabled: e.target.checked } : x)))} />
          <select className="input sm" value={a.type} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, type: e.target.value as never } : x)))}>
            {defs.map((d) => <option key={d.type} value={d.type}>{d.type}</option>)}
          </select>
          <input className="input sm" placeholder="Target (jsonpath / header name; blank = body)" value={a.property ?? ''} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, property: e.target.value } : x)))} />
          <input className="input sm" placeholder="Expected" value={a.expected ?? ''} onChange={(e) => setItems(items.map((x, k) => (k === i ? { ...x, expected: e.target.value } : x)))} />
          <button className="icon-btn" onClick={() => setItems(items.filter((_, k) => k !== i))}>✕</button>
        </div>
      ))}
      {items.length === 0 && <div className="muted">No assertions configured. Or use pm.test(…) in scripts.</div>}
    </div>
  );
}

function RequestSettingsEditor(props: { req: ApiRequest; patch: (p: Partial<ApiRequest>) => void }): React.ReactElement {
  const st = props.req.settings;
  const set = (p: Partial<typeof st>): void => props.patch({ settings: { ...st, ...p } });
  return (
    <div className="grid2" style={{ maxWidth: 960 }}>
      <div>
        <label className="lbl">Timeout (ms)</label>
        <input className="input" type="number" value={st.timeoutMs} onChange={(e) => set({ timeoutMs: Number(e.target.value) })} />
      </div>
      <div>
        <label className="lbl">Max redirects</label>
        <input className="input" type="number" value={st.maxRedirects} onChange={(e) => set({ maxRedirects: Number(e.target.value) })} />
      </div>
      <div className="col" style={{ gap: 10 }}>
        <label className="checkbox"><input type="checkbox" checked={st.followRedirects} onChange={(e) => set({ followRedirects: e.target.checked })} /> Follow redirects</label>
        <label className="checkbox"><input type="checkbox" checked={st.preserveAuthOnRedirect} onChange={(e) => set({ preserveAuthOnRedirect: e.target.checked })} /> Keep Authorization header across same-host redirects</label>
        <label className="checkbox"><input type="checkbox" checked={st.stripSensitiveHeaders} onChange={(e) => set({ stripSensitiveHeaders: e.target.checked })} /> Strip sensitive headers on cross-host redirects</label>
        <label className="checkbox"><input type="checkbox" checked={st.encodeUrl} onChange={(e) => set({ encodeUrl: e.target.checked })} /> Encode URL automatically</label>
        <label className="checkbox"><input type="checkbox" checked={st.verifyTls} onChange={(e) => set({ verifyTls: e.target.checked })} /> Verify TLS certificates (off = accept self-signed)</label>
        <label className="checkbox"><input type="checkbox" checked={st.storeResponse} onChange={(e) => set({ storeResponse: e.target.checked })} /> Store full response in history</label>
      </div>
      <div>
        <label className="lbl">Retry policy</label>
        <label className="checkbox"><input type="checkbox" checked={st.retry.enabled} onChange={(e) => set({ retry: { ...st.retry, enabled: e.target.checked } })} /> Enable retries</label>
        <div className="row" style={{ marginTop: 6 }}>
          <input className="input" type="number" min={0} max={10} style={{ width: 90 }} value={st.retry.maxRetries}
            onChange={(e) => set({ retry: { ...st.retry, maxRetries: Number.parseInt(e.target.value || '0', 10) } })} />
          <select className="input" style={{ width: 120 }} value={st.retry.strategy}
            onChange={(e) => set({ retry: { ...st.retry, strategy: e.target.value as typeof st.retry.strategy } })}>
            <option value="fixed">fixed</option><option value="exponential">exponential</option><option value="jittered">jittered</option>
          </select>
          <input className="input" type="number" min={0} style={{ width: 110 }} placeholder="delay ms" value={st.retry.delayMs}
            onChange={(e) => set({ retry: { ...st.retry, delayMs: Number.parseInt(e.target.value || '0', 10) } })} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function MenuButton(props: { label: string; title?: string; actions: { label: string; run: () => void; disabled?: boolean }[] }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button className="btn xs" title={props.title} onClick={() => setOpen((v) => !v)}>{props.label} ▾</button>
      {open && (
        <span className="ctx-menu mono" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 500, fontSize: 12 }}
          onMouseLeave={() => setOpen(false)} onClick={(e) => e.stopPropagation()}>
          {props.actions.map((a, i) => (
            <div key={i} className="ci" style={a.disabled ? { opacity: .45, pointerEvents: 'none' } : undefined}
              onClick={() => { a.run(); setOpen(false); }}>{a.label}</div>
          ))}
        </span>
      )}
    </span>
  );
}

function ResponseTopBar(props: {
  resp: ApiResponse | null; errored: string | null;
  zoom: number; setZoom: (z: number) => void;
  wrap: boolean; setWrap: (b: boolean) => void;
  search: string | null; setSearch: (v: string | null) => void;
  searchState: SearchState; setSearchState: (s: SearchState) => void;
  activeHit: number; setActiveHit: (n: number) => void;
  req: ApiRequest;
}): React.ReactElement {
  const app = useApp();
  if (props.errored && !props.resp) {
    return <div className="resp-top"><span className="badge-pill red">Error</span><span className="mono" style={{ color: 'var(--red)', fontSize: 12 }}>{props.errored}</span></div>;
  }
  const r = props.resp;
  if (!r) return <div className="resp-top"><span className="muted">Send a request to see the response here.</span></div>;
  const rr = withSnap(r, props.req);
  const body = r.bodyText ?? '';
  const opts = props.searchState;
  const hits = countMatches(body, props.search ?? '', opts);
  const disabledNoBody = body.length === 0 && !r.bodyBase64;
  const searchRe = useMemo(() => buildSearchRegExp(props.search ?? '', opts), [props.search, opts.caseSensitive, opts.wholeWord, opts.regex]);
  void searchRe;

  const copy = (which: 'body' | 'headers' | 'headersBody' | 'statusHeadersBody'): void => {
    const bundles = copyBundles(rr);
    const b = bundles[which];
    void navigator.clipboard.writeText(b.content).then(() => {
      app.toast('ok', `Copied ${b.label.toLowerCase()} (${fmtBytes(b.content.length)})`);
    }).catch(() => {
      // non-secure-context fallback (e.g. plain http remote preview)
      const ta = document.createElement('textarea');
      ta.value = b.content; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); app.toast('ok', `Copied ${b.label.toLowerCase()}`); } catch { app.toast('err', 'Clipboard unavailable'); }
      ta.remove();
    });
  };

  const download = (which: 'body' | 'headers' | 'headersBody' | 'raw'): void => {
    // binary bodies go through the native save dialog so bytes are preserved
    if (which === 'body' && r.bodyBase64 && /image|pdf|zip|octet-stream|audio|video/.test((r.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value) ?? '')) {
      const ext = suggestExtension(r);
      void call<{ path: string } | null>('dialog.saveFile', {
        defaultName: `response-${r.status}.${ext}`,
        filters: [{ name: 'Response body', extensions: [ext] }],
        contentBase64: r.bodyBase64,
      }).then((p) => p && app.toast('ok', `Saved ${p.path}`));
      return;
    }
    const d = downloadBundles(rr)[which];
    saveBlob(d.name, d.mime, d.content);
    app.toast('ok', `Downloaded ${d.name}`);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="resp-top">
        <span className="resp-status" style={{ color: r.status < 300 ? 'var(--green)' : r.status < 500 ? 'var(--yellow)' : 'var(--red)' }}>{r.status}</span>
        <span className="dim">{r.statusText}</span>
        <span className="dim mono">{fmtMs(r.timing?.totalMs ?? 0)}</span>
        <span className="dim mono">{fmtBytes(r.bodySize ?? 0)}</span>
        <span className={`badge-pill ${props.search != null ? 'green' : 'grey'}`}
          title="Search in response body (Ctrl+F)" role="button" style={{ cursor: 'pointer' }}
          onClick={() => props.setSearch(props.search == null ? '' : null)}>🔍 search</span>
        <span className="spacer" />
        <button className="btn xs" title="Zoom out (Ctrl+-)" onClick={() => props.setZoom(zOut(props.zoom))}>−</button>
        <button className="btn xs zoom-pct" title="Zoom percentage — click to reset (Ctrl+0)" onClick={() => props.setZoom(1)}>{zoomPct(props.zoom)}</button>
        <button className="btn xs" title="Zoom in (Ctrl+=)" onClick={() => props.setZoom(zIn(props.zoom))}>＋</button>
        <button className="btn xs" title="Reset zoom (Ctrl+0)" onClick={() => props.setZoom(1)}>Reset</button>
        <button className={`btn xs ${props.wrap ? 'active' : ''}`} title="Toggle line wrap (persisted)"
          onClick={() => props.setWrap(!props.wrap)}>{props.wrap ? 'Wrap: ON' : 'Wrap: OFF'}</button>
        <MenuButton label="Copy" title="Copy response to clipboard" actions={[
          { label: 'Copy body', disabled: disabledNoBody, run: () => copy('body') },
          { label: 'Copy headers', run: () => copy('headers') },
          { label: 'Copy headers + body', run: () => copy('headersBody') },
          { label: 'Copy status + headers + body', run: () => copy('statusHeadersBody') },
        ]} />
        <MenuButton label="Download" title="Download response to disk (extension chosen from Content-Type)" actions={[
          { label: 'Download body', disabled: disabledNoBody, run: () => download('body') },
          { label: 'Download headers (.txt)', run: () => download('headers') },
          { label: 'Download headers + body (.txt)', run: () => download('headersBody') },
          { label: 'Download raw response (.http)', run: () => download('raw') },
        ]} />
      </div>
      {props.search != null && (
        <div className="row" style={{ gap: 6, padding: '4px 2px 2px' }}>
          <input autoFocus className="sel" style={{ flex: 1, maxWidth: 340, height: 26, fontSize: 12 }} placeholder="Search response body…"
            value={props.search}
            onChange={(e) => { props.setSearch(e.target.value); props.setActiveHit(0); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') props.setActiveHit(hits ? (props.activeHit + (e.shiftKey ? hits - 1 : 1)) % hits : 0);
              if (e.key === 'Escape') props.setSearch(null);
            }} />
          <span className="dim mono" style={{ fontSize: 12, minWidth: 64 }}>{body === '' && props.search ? 'no body' : hits ? `${props.activeHit + 1}/${hits}` : (props.search ? '0 matches' : '')}</span>
          <button className="btn xs" title="Previous match (Shift+Enter)" disabled={!hits}
            onClick={() => props.setActiveHit(hits ? (props.activeHit + hits - 1) % hits : 0)}>↑</button>
          <button className="btn xs" title="Next match (Enter)" disabled={!hits}
            onClick={() => props.setActiveHit(hits ? (props.activeHit + 1) % hits : 0)}>↓</button>
          <label className="checkbox" style={{ fontSize: 11.5 }} title="Case sensitive">
            <input type="checkbox" checked={!!opts.caseSensitive} onChange={(e) => { props.setSearchState({ ...opts, caseSensitive: e.target.checked }); props.setActiveHit(0); }} /> Aa
          </label>
          <label className="checkbox" style={{ fontSize: 11.5 }} title="Whole word">
            <input type="checkbox" checked={!!opts.wholeWord} onChange={(e) => { props.setSearchState({ ...opts, wholeWord: e.target.checked }); props.setActiveHit(0); }} /> W
          </label>
          <label className="checkbox mono" style={{ fontSize: 11.5 }} title="Regular expression">
            <input type="checkbox" checked={!!opts.regex} onChange={(e) => { props.setSearchState({ ...opts, regex: e.target.checked }); props.setActiveHit(0); }} /> .*
          </label>
          <button className="btn xs" title="Close search (Esc)" onClick={() => props.setSearch(null)}>✕</button>
        </div>
      )}
    </div>
  );
}

function ResponseBody(props: {
  resp: ApiResponse | null; errored: string | null; zoom: number; wrap: boolean;
  search: string | null; searchState: CoreSearchOpts; activeHit: number;
}): React.ReactElement {
  const r = props.resp;
  const search = props.search ?? '';
  const opts = props.searchState;
  useEffect(() => {
    if (!search) return;
    const el = document.getElementById(`resp-hit-${props.activeHit}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('active');
      return () => el.classList.remove('active');
    }
    return undefined;
  }, [search, props.activeHit, r, opts.caseSensitive, opts.wholeWord, opts.regex]);

  if (props.errored && !r) return <div className="muted">Request could not complete: {props.errored}</div>;
  if (!r) return <div className="empty"><div className="big">📭</div>Nothing here yet.</div>;
  const ct = (r.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '').toLowerCase();
  const body = r.bodyText ?? (r.bodyBase64 ? '(base64 body — use Download ▸ Download body to save)' : '');
  const style: React.CSSProperties = { zoom: props.zoom };
  const marked = (text: string): string => markSearch(escapeTextHtml(text), search, opts);
  const isPdf = ct.includes('pdf');
  if (isPdf && r.bodyBase64) {
    return <div style={style}><iframe title="pdf-preview" src={`data:application/pdf;base64,${r.bodyBase64}`} style={{ width: '100%', height: '85vh', border: 0 }} /></div>;
  }
  if (ct.includes('image/') && r.bodyBase64) {
    return <div style={style}><img src={`data:${ct.split(';')[0]};base64,${r.bodyBase64}`} alt="response body" /></div>;
  }
  if (ct.includes('text/html') && !search) {
    return (
      <div className="grid2">
        <div className="card zoomable" style={style} dangerouslySetInnerHTML={{ __html: sanitizeHtmlPreview(body.slice(0, 100_000)) }} />
        <pre className={`resp-body ${props.wrap ? 'wrap' : 'nowrap'}`}>{body.slice(0, 100_000)}</pre>
      </div>
    );
  }
  if (ct.includes('text/html') && search) {
    return <pre className={`resp-body ${props.wrap ? 'wrap' : 'nowrap'}`} style={style} dangerouslySetInnerHTML={{ __html: marked(body) }} />;
  }
  if (ct.includes('json') || body.trim().startsWith('{') || body.trim().startsWith('[')) {
    return <div className="zoomable" style={style}><JsonView text={body} wrap={props.wrap} search={search} searchOpts={opts} /></div>;
  }
  if (ct.includes('xml') || body.trimStart().startsWith('<')) {
    return <pre className={`resp-body ${props.wrap ? 'wrap' : 'nowrap'}`} style={style} dangerouslySetInnerHTML={{ __html: marked(prettyXml(body)) }} />;
  }
  return <pre className={`resp-body ${props.wrap ? 'wrap' : 'nowrap'}`} style={style}
    dangerouslySetInnerHTML={{ __html: marked(body || '(empty body)') }} />;
}

function sanitizeHtmlPreview(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '');
}

function prettyXml(xml: string): string {
  let out = '';
  let indent = 0;
  const tokens = xml.replace(/>\s+</g, '><').split(/(?=<)/);
  for (const rawTok of tokens) {
    const t = rawTok.trim();
    if (!t) continue;
    if (t.startsWith('</')) { indent = Math.max(0, indent - 1); out += `${'  '.repeat(indent)}${t}\n`; continue; }
    out += `${'  '.repeat(indent)}${t}\n`;
    if (t.startsWith('<') && !t.startsWith('</') && !t.startsWith('<?') && !t.startsWith('<!') && !t.endsWith('/>') && !t.includes('</')) indent++;
  }
  return out;
}

function Timeline(props: { resp: ApiResponse }): React.ReactElement {
  const t = props.resp.timing;
  if (!t) return <div className="muted">Timing data unavailable.</div>;
  const segs: [string, number | undefined][] = [
    ['DNS', t.dnsMs], ['Connect', t.connectMs], ['TLS', t.tlsMs], ['Upload', t.uploadMs], ['Server', t.serverMs], ['Download', t.downloadMs]];
  const total = segs.reduce((a, [, v]) => a + (v ?? 0), 0) || 1;
  return (
    <div style={{ maxWidth: 640 }}>
      {segs.map(([label, v]) => (
        <div key={label} className="row" style={{ gap: 10, marginBottom: 6 }}>
          <span style={{ width: 80 }}>{label}</span>
          <div className="progress" style={{ flex: 1 }}><div style={{ width: `${(((v ?? 0) / total) * 100).toFixed(1)}%` }} /></div>
          <span className="mono dim" style={{ width: 90, textAlign: 'right' }}>{fmtMs(v ?? 0)}</span>
        </div>
      ))}
      <div className="dim">Total: {fmtMs(props.resp.timing?.totalMs ?? total)}</div>
    </div>
  );
}

function CookiesTab(props: { workspaceId: string }): React.ReactElement {
  const [cookies, setCookies] = useState<{ domain: string; name: string; value: string; path: string; expires?: string; httpOnly?: boolean; secure?: boolean }[]>([]);
  useEffect(() => {
    void call<{ items?: typeof cookies } | typeof cookies>('cookies.list', {}).then((c) => setCookies(Array.isArray(c) ? c : (c.items ?? []))).catch(() => undefined);
  }, [props.workspaceId]);
  return (
    <table className="tbl">
      <thead><tr><th>Domain</th><th>Name</th><th>Value</th><th>Path</th><th>Expires</th><th>Flags</th></tr></thead>
      <tbody>
        {cookies.map((c, i) => (
          <tr key={i}><td>{c.domain}</td><td className="mono">{c.name}</td><td className="mono">{c.value}</td><td>{c.path}</td>
            <td>{c.expires ? ts(c.expires) : 'Session'}</td><td>{c.httpOnly ? 'HttpOnly ' : ''}{c.secure ? 'Secure' : ''}</td></tr>
        ))}
        {cookies.length === 0 && <tr><td colSpan={6} className="muted">Cookie jar is empty.</td></tr>}
      </tbody>
    </table>
  );
}

function TestResults(props: { rows: TestRow[] }): React.ReactElement {
  if (props.rows.length === 0) return <div className="muted">No tests executed. Add scripts or assertions, then Send.</div>;
  return (
    <div>
      {props.rows.map((t, i) => (
        <div key={i} className="row" style={{ marginBottom: 4 }}>
          <span>{t.passed ? '✅' : '❌'}</span>
          <span>{t.name}</span>
          {t.source && <span className="badge-pill grey">{t.source}</span>}
          {t.error && <span className="mono" style={{ color: 'var(--red)' }}>{t.error}</span>}
        </div>
      ))}
    </div>
  );
}

function CompareResponses(props: { requestId: string; current: ApiResponse | null }): React.ReactElement {
  const [history, setHistory] = useState<ApiResponse[]>([]);
  const [otherId, setOtherId] = useState('');
  const [report, setReport] = useState<{ statusMatch: boolean; summary: string; bodyDiff: { kind: string; path: string; a?: string; b?: string }[]; headerDiff: { kind: string; name: string }[] } | null>(null);
  useEffect(() => {
    void call<ApiResponse[]>('http.recentResponses', { requestId: props.requestId, limit: 30 })
      .then((rs) => setHistory(rs.filter((r) => r.id !== props.current?.id))).catch(() => undefined);
  }, [props.requestId, props.current]);
  const other = history.find((r) => r.id === otherId);
  useEffect(() => {
    if (!other || !props.current) { setReport(null); return; }
    void call<typeof report>('response.compare', { a: props.current, b: other }).then(setReport).catch(() => undefined);
  }, [other, props.current]);
  return (
    <div>
      <div className="row">
        <span>Compare against a stored response:</span>
        <select className="input sm" style={{ width: 360 }} value={otherId} onChange={(e) => setOtherId(e.target.value)}>
          <option value="">(choose)</option>
          {history.map((r) => <option key={r.id} value={r.id}>{ts(r.timestamp)} — {r.status}</option>)}
        </select>
      </div>
      {report && (
        <div style={{ marginTop: 10 }}>
          <div className="card"><b>{report.summary}</b></div>
          {report.bodyDiff.length > 0 && (
            <div className="codemini" style={{ marginTop: 8 }}>
              {report.bodyDiff.slice(0, 80).map((d, i) => (
                <div key={i} style={{ color: d.kind === 'added' ? 'var(--green)' : d.kind === 'removed' ? 'var(--red)' : 'var(--yellow)' }}>
                  {d.kind === 'added' ? '+' : d.kind === 'removed' ? '−' : '~'} {d.path}{d.a !== undefined ? ` (was "${d.a}")` : ''}{d.b !== undefined ? ` (now "${d.b}")` : ''}
                </div>
              ))}
            </div>
          )}
          {report.headerDiff.length > 0 && (
            <div className="codemini" style={{ marginTop: 8 }}>
              {report.headerDiff.map((d, i) => (
                <div key={i} style={{ color: d.kind === 'added' ? 'var(--green)' : d.kind === 'removed' ? 'var(--red)' : 'var(--yellow)' }}>{d.kind}: {d.name}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function SaveToModal(props: { tab: OpenTab; req: ApiRequest; onClose: () => void; onSaved: (saved: ApiRequest) => void }): React.ReactElement {
  const s = useApp();
  const [name, setName] = useState(props.req.name || 'New request');
  const [collectionId, setCollectionId] = useState(props.req.collectionId ?? s.collections[0]?.id ?? '');
  const [folderId, setFolderId] = useState(props.req.folderId ?? '');
  const [newCollectionName, setNewCollectionName] = useState('');
  const save = async (): Promise<void> => {
    let cid = collectionId;
    if (newCollectionName.trim()) {
      const created = await call<{ id: string }>('collection.create', { name: newCollectionName.trim() });
      cid = created.id;
    }
    if (!cid) { s.toast('warn', 'Pick or create a collection'); return; }
    const { req } = props;
    const { id: _id, workspaceId: _w, favorite, sortOrder, createdAt, updatedAt, collectionId: _c, folderId: _f, name: _n, ...rest } = req;
    void _id; void _w; void favorite; void sortOrder; void createdAt; void updatedAt; void _c; void _f; void _n;
    let saved: ApiRequest;
    if (props.req.collectionId) {
      saved = await call<ApiRequest>('request.update', { id: req.id, patch: { ...rest, name, collectionId: cid, folderId: folderId || undefined } });
    } else {
      saved = await call<ApiRequest>('request.create', { ...rest, name, collectionId: cid, folderId: folderId || undefined });
    }
    await s.refreshCollections();
    props.onSaved(saved);
  };
  return (
    <Modal title="Save request" onClose={props.onClose}
      footer={<><button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn primary" onClick={() => void save()}>Save</button></>}>
      <label className="lbl">Name</label>
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      <label className="lbl">Collection</label>
      <select className="input" value={collectionId} onChange={(e) => setCollectionId(e.target.value)}>
        {s.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <label className="lbl">…or create a new collection</label>
      <input className="input" placeholder="New collection name" value={newCollectionName} onChange={(e) => setNewCollectionName(e.target.value)} />
      <label className="lbl">Folder</label>
      <select className="input" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
        <option value="">(root)</option>
        {s.folders.filter((f) => f.collectionId === collectionId).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </Modal>
  );
}

function CurlImportModal(props: { onClose: () => void; onApply: (r: Partial<ApiRequest>) => void }): React.ReactElement {
  const [curl, setCurl] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal title="Import cURL" onClose={props.onClose} wide
      footer={<><button className="btn" onClick={props.onClose}>Cancel</button>
        <button className="btn primary" onClick={() => {
          void call<{ method?: string; url?: string; headers?: KeyValue[]; body?: RequestBody }>('curl.parse', { command: curl }).then((p) => {
            if (!p || !p.url) { setErr('Could not parse — check the command'); return; }
            props.onApply({
              name: (p.url ?? '').slice(0, 80), method: (p.method as ApiRequest['method']) ?? 'GET',
              url: p.url ?? '', headers: p.headers ?? [], body: p.body ?? { type: 'none' },
            });
          }).catch((e) => setErr(String(e instanceof Error ? e.message : e)));
        }}>Apply</button></>}>
      <MonacoEditor value={curl} onChange={setCurl} language="shell" minHeight={220} placeholder="curl -X GET https://api.example.com -H 'X: 1'" />
      {err && <div style={{ color: 'var(--red)', marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}

function CodegenModal(props: { request: ApiRequest; onClose: () => void }): React.ReactElement {
  const [targets, setTargets] = useState<{ language: string; label: string; variants: string[] }[]>([]);
  const [language, setLanguage] = useState('curl');
  const [variant, setVariant] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => {
    void call<typeof targets>('codegen.targets').then((t) => { setTargets(t); if (t[0]) setLanguage(t[0].language); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    void call<string>('codegen.generate', { request: props.request, language, variant: variant || undefined })
      .then((c) => setCode(String(c)))
      .catch((e) => setCode(`// ${String(e instanceof Error ? e.message : e)}`));
  }, [language, variant, props.request]);
  const sel = targets.find((t) => t.language === language);
  return (
    <Modal title="Generate code" onClose={props.onClose} wide
      footer={<><span className="spacer" />
        <button className="btn" onClick={() => { void navigator.clipboard.writeText(code); useApp.getState().toast('ok', 'Code copied'); }}>Copy</button>
        <button className="btn" onClick={props.onClose}>Close</button></>}>
      <div className="row">
        <select className="input sm" style={{ width: 280 }} value={language} onChange={(e) => { setLanguage(e.target.value); setVariant(''); }}>
          {targets.map((t) => <option key={t.language} value={t.language}>{t.label}</option>)}
        </select>
        {sel && sel.variants.length > 1 && (
          <select className="input sm" style={{ width: 180 }} value={variant} onChange={(e) => setVariant(e.target.value)}>
            <option value="">default</option>
            {sel.variants.map((v) => <option key={v}>{v}</option>)}
          </select>
        )}
      </div>
      <div style={{ marginTop: 10, height: '55vh' }}>
        <MonacoEditor value={code} readOnly language={language === 'curl' ? 'shell' : language === 'powershell' ? 'powershell' : language === 'python' ? 'python' : language === 'go' ? 'go' : 'plaintext'} minHeight={400} />
      </div>
    </Modal>
  );
}
