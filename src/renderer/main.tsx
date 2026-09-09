/** App entry: router, shell (activity bar / sidebar / tabs / statusbar). */
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import './styles.css';
import { initBridge, onEvent } from './bridge';
import { applyTheme, useApp } from './state';
import { ToastHost, Tree, useContextMenu, type TreeNode, uid } from './components';
import { call } from './bridge';
import type { ApiRequest, Collection, Folder, HistoryEntry } from '../shared/types';
import { HomePage } from './pages.home';
import { RequestPage } from './pages.request';
import { EnvironmentsPage, GlobalsPage, CookiesPage, ScriptLibraryPage, SnapshotsPage } from './pages.env';
import { MocksPage, MonitorsPage, PerfPage, FlowsPage, DatasetsPage, WebhooksPage, CapturePage } from './pages.automation';
import { SpecsPage, DocsPage, FilesPage, InventoryPage, SearchPage, AnalyticsPage, AuditPage } from './pages.assets';
import { SessionsPage, OAuthPage, McpPage, AiAssistantPage } from './pages.protocols';
import { VaultPage, SecurityPage, BackupPage, GitPage, PluginsPage, SettingsPage, AboutPage } from './pages.infra';

interface NavSection { id: string; label: string; icon: string; path: string; group: 'main' | 'tooling' | 'system'; }

const NAV: NavSection[] = [
  { id: 'home', label: 'APIs', icon: '⇄', path: '/', group: 'main' },
  { id: 'envs', label: 'Environments & Vars', icon: '◍', path: '/environments', group: 'main' },
  { id: 'globals', label: 'Globals', icon: '◎', path: '/globals', group: 'main' },
  { id: 'cookies', label: 'Cookies', icon: '🍪', path: '/cookies', group: 'main' },
  { id: 'sessions', label: 'Protocols', icon: '⌁', path: '/sessions', group: 'main' },
  { id: 'oauth', label: 'OAuth', icon: '🔑', path: '/oauth', group: 'main' },
  { id: 'mocks', label: 'Mocks', icon: '🃏', path: '/mocks', group: 'tooling' },
  { id: 'monitors', label: 'Monitors', icon: '📡', path: '/monitors', group: 'tooling' },
  { id: 'perf', label: 'Performance', icon: '📈', path: '/perf', group: 'tooling' },
  { id: 'flows', label: 'Flows', icon: '⟲', path: '/flows', group: 'tooling' },
  { id: 'datasets', label: 'Datasets', icon: '⊞', path: '/datasets', group: 'tooling' },
  { id: 'specs', label: 'Specs & APIs', icon: '📐', path: '/specs', group: 'tooling' },
  { id: 'docs', label: 'Docs', icon: '📖', path: '/docs', group: 'tooling' },
  { id: 'webhooks', label: 'Webhooks', icon: '🪝', path: '/webhooks', group: 'tooling' },
  { id: 'capture', label: 'Capture', icon: '📥', path: '/capture', group: 'tooling' },
  { id: 'vault', label: 'Vault', icon: '🔒', path: '/vault', group: 'system' },
  { id: 'security', label: 'Security', icon: '🛡', path: '/security', group: 'system' },
  { id: 'search', label: 'Find & Replace', icon: '🔎', path: '/search', group: 'system' },
  { id: 'analytics', label: 'Analytics', icon: '📊', path: '/analytics', group: 'system' },
  { id: 'inventory', label: 'Ports/Binaries', icon: '🧭', path: '/inventory', group: 'system' },
  { id: 'git', label: 'Git', icon: '⎇', path: '/git', group: 'system' },
  { id: 'backup', label: 'Backups', icon: '💾', path: '/backup', group: 'system' },
  { id: 'audit', label: 'Audit Log', icon: '📜', path: '/audit', group: 'system' },
  { id: 'plugins', label: 'Plugins / MCP', icon: '🧩', path: '/plugins', group: 'system' },
  { id: 'settings', label: 'Settings', icon: '⚙', path: '/settings', group: 'system' },
];

function ActivityBar(): React.ReactElement {
  const groups: [string, NavSection[]][] = [['main', NAV.filter((n) => n.group === 'main')], ['tooling', NAV.filter((n) => n.group === 'tooling')], ['system', NAV.filter((n) => n.group === 'system')]];
  return (
    <div className="activitybar">
      {groups.map(([g, items], gi) => (
        <React.Fragment key={g}>
          {gi > 0 && <div className="ab-sep" />}
          {items.map((n) => (
            <NavLink key={n.id} to={n.path} end={n.path === '/'} className={({ isActive }) => `ab-item ${isActive ? 'active' : ''}`} title={n.label}>
              <span style={{ fontSize: 17 }}>{n.icon}</span>
            </NavLink>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

function Sidebar(): React.ReactElement | null {
  const s = useApp();
  const loc = useLocation();
  const navigate = useNavigate();
  const { ctx, open } = useContextMenu();
  const [newColName, setNewColName] = useState<string | null>(null);
  if (!['/', '/request'].some((p) => loc.pathname.startsWith(p)) && !loc.pathname.startsWith('/specs')) return null;

  const search = s.sidebarSearch.toLowerCase();
  const match = (r: ApiRequest): boolean => !search || r.name.toLowerCase().includes(search) || r.url.toLowerCase().includes(search);

  const nodes: TreeNode<ApiRequest>[] = useMemo(() => {
    const buildNodes = (): TreeNode<ApiRequest>[] => {
      const folderChildren = (parentId: string | undefined, collectionId: string): TreeNode<ApiRequest>[] => {
        const folders = s.folders.filter((f) => f.collectionId === collectionId && (parentId ? f.parentFolderId === parentId : !f.parentFolderId));
        const reqs = s.requests.filter((r) => r.collectionId === collectionId && (parentId ? r.folderId === parentId : !r.folderId));
        return [
          ...folders.map((f) => ({
            id: f.id, label: `📁 ${f.name}`, value: undefined,
            children: folderChildren(f.id, collectionId),
          })),
          ...reqs.filter((r) => match(r)).sort((a, b) => a.sortOrder - b.sortOrder).map((r) => ({
            id: r.id, label: r.name, value: r,
            icon: <span className={`m-chip m-${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) ? r.method : 'OTHER'}`}>{r.method}</span>,
          })),
        ];
      };
      return s.collections.map((c) => ({
        id: c.id, label: c.name, value: undefined,
        children: folderChildren(undefined, c.id),
      }));
    };
    return buildNodes();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.collections, s.folders, s.requests, search]);

  const requestCtx = (n: TreeNode<ApiRequest>, e: React.MouseEvent): void => {
    const r = n.value;
    if (!r) return;
    open(e, [
      { label: 'Open', onClick: () => s.openRequest(r) },
      { label: 'Duplicate', onClick: () => { void call('request.duplicate', { id: r.id }).then(() => s.refreshCollections()); } },
      { label: 'curl (copy)', onClick: () => { void call<string>('curl.generate', { request: r }).then((c) => { void navigator.clipboard.writeText(String(c)); s.toast('ok', 'cURL copied'); }); } },
      { label: 'Export (Postman)', sep: true, onClick: () => { void call<string>('export.request', { requestId: r.id, format: 'postman' }).then((j) => { void navigator.clipboard.writeText(j); s.toast('ok', 'Postman request copied to clipboard'); }); } },
      { label: `Favorite${r.favorite ? ' (remove)' : ''}`, onClick: () => { void call('favorite.toggle', { entityType: 'request', entityId: r.id }).then(() => s.refreshCollections()); } },
      { label: 'Delete', danger: true, onClick: () => { if (confirm(`Delete "${r.name}"?`)) void call('request.delete', { id: r.id }).then(() => s.refreshCollections()); } },
    ]);
  };

  return (
    <div className="sidebar">
      {ctx}
      <div className="sb-head">
        <span>Collections</span><span className="spacer" />
        <button className="icon-btn" title="New collection" onClick={() => {
          const name = prompt('Collection name');
          if (name) { void call('collection.create', { name }).then(() => s.refreshCollections()); }
        }}>＋</button>
      </div>
      <div>
        <input className="input sm sb-search" placeholder="Filter requests…" value={s.sidebarSearch} onChange={(e) => s.setSidebarSearch(e.target.value)} />
      </div>
      <div className="sb-scroll">
        <Tree nodes={nodes} selected={s.activeTabId?.startsWith('req:') ? s.activeTabId.slice(4) : null}
          onSelect={(n) => { if (n.value) s.openRequest(n.value); }}
          onContext={requestCtx} />
        <HistorySection />
      </div>
    </div>
  );
}

function HistorySection(): React.ReactElement {
  const s = useApp();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  useEffect(() => { void call<any>('history.list', {}); }, [s.workspaceId]);
  useEffect(() => {
    if (s.sidebarTab !== 'history') return;
    void call<{ items: HistoryEntry[] }>('history.list', { limit: 60 }).then((r) => setHistory(r.items)).catch(() => undefined);
  }, [s, s.sidebarTab, s.activeTabId]);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-title" style={{ marginLeft: 4 }}>Recent history</div>
      {history.length === 0 && <div className="muted" style={{ padding: '2px 8px' }}>Nothing yet.</div>}
      {history.slice(0, 40).map((h) => (
        <div key={h.id} className="tree-item"
          title={h.url}
          onClick={() => { void call<ApiRequest>('request.get', { id: h.requestId }).then((r) => s.openRequest(r)).catch(() => undefined); }}>
          <span className={`m-chip m-${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(h.method) ? h.method : 'OTHER'}`}>{h.method}</span>
          <span className="ti-label">{h.url}</span>
          <span className="badge-pill" style={{ background: 'transparent', color: h.status && h.status < 400 ? 'var(--green)' : 'var(--red)', flexShrink: 0 }}>{h.status ?? '—'}</span>
        </div>
      ))}
    </div>
  );
}

function TabBar(): React.ReactElement {
  const s = useApp();
  return (
    <div className="tabbar">
      {s.tabs.map((t) => (
        <div key={t.id} className={`tab ${s.activeTabId === t.id ? 'active' : ''}`} onClick={() => s.setActiveTab(t.id)} onAuxClick={(e) => { if (e.button === 1) s.closeTab(t.id); }}>
          <span>{t.title}{t.dirty ? ' •' : ''}</span>
          <span className="t-x" onClick={(e) => { e.stopPropagation(); s.closeTab(t.id); }}>✕</span>
        </div>
      ))}
      <span className="spacer" />
    </div>
  );
}

function StatusBar(): React.ReactElement {
  const s = useApp();
  const ws = s.workspaces.find((w) => w.id === s.workspaceId);
  const env = s.environments.find((e) => e.id === s.activeEnvironmentId);
  return (
    <div className="statusbar">
      <span className="sb-item"><span className={`badge ${s.netStatus === 'offline' ? 'warn' : ''}`} />
        {s.netStatus === 'online' ? 'Online' : 'Offline-mode'}</span>
      <span className="sb-item">Workspace: {ws?.name ?? '—'}</span>
      <span className="sb-item">Env: {env?.name ?? 'None'}</span>
      <span className="sb-item">{s.collections.length} col · {s.requests.length} req</span>
      <span className="sb-spacer" />
      <span className="sb-item">API Manager v1.0.0 · offline-first · by Manish Kumar Singh</span>
    </div>
  );
}

function Shell(): React.ReactElement {
  const s = useApp();
  const navigate = useNavigate();
  const activeTab = s.tabs.find((t) => t.id === s.activeTabId);
  const location = useLocation();

  // command palette
  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); setQuery(''); }
      if (e.key === 'Escape') setPalette(false);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        // dispatch save event — pages listen
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('am:save'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    return onEvent((ev) => {
      if (ev.type === 'response.created' || ev.type === 'history.created') { /* noop */ }
    });
  }, []);

  const paletteItems = useMemo(() => {
    const q = query.toLowerCase();
    const items = [
      ...s.requests.filter((r) => r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q)).slice(0, 8).map((r) => ({ label: `↳ ${r.method} ${r.name}`, action: () => s.openRequest(r) })),
      ...s.collections.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 4).map((c) => ({ label: `📦 ${c.name}`, action: () => navigate('/') })),
      ...(location.pathname !== '/' ? [{ label: 'Back to APIs', action: () => navigate('/') }] : []),
      { label: 'New request tab', action: () => s.openTab({ id: `req:new:${uid()}`, kind: 'request', title: 'Untitled' }) },
    ];
    return items.filter((i) => {
      if (!q) return true;
      return i.label.toLowerCase().includes(q);
    }).slice(0, 12);
  }, [query, s, s.requests, s.collections, location.pathname, navigate]);

  return (
    <div className="shell">
      <ActivityBar />
      <Sidebar />
      <div className="main">
        <TabBar />
        <div className="tab-content">
          {activeTab?.kind === 'request'
            ? <RequestPage key={activeTab.id} tab={activeTab} />
            : <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/environments" element={<EnvironmentsPage />} />
                <Route path="/globals" element={<GlobalsPage />} />
                <Route path="/cookies" element={<CookiesPage />} />
                <Route path="/sessions" element={<SessionsPage />} />
                <Route path="/oauth" element={<OAuthPage />} />
                <Route path="/mocks" element={<MocksPage />} />
                <Route path="/monitors" element={<MonitorsPage />} />
                <Route path="/perf" element={<PerfPage />} />
                <Route path="/flows" element={<FlowsPage />} />
                <Route path="/datasets" element={<DatasetsPage />} />
                <Route path="/specs" element={<SpecsPage />} />
                <Route path="/docs" element={<DocsPage />} />
                <Route path="/webhooks" element={<WebhooksPage />} />
                <Route path="/capture" element={<CapturePage />} />
                <Route path="/vault" element={<VaultPage />} />
                <Route path="/security" element={<SecurityPage />} />
                <Route path="/search" element={<SearchPage />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/inventory" element={<InventoryPage />} />
                <Route path="/git" element={<GitPage />} />
                <Route path="/backup" element={<BackupPage />} />
                <Route path="/audit" element={<AuditPage />} />
                <Route path="/files" element={<FilesPage />} />
                <Route path="/plugins" element={<PluginsPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/script-library" element={<ScriptLibraryPage />} />
                <Route path="/snapshots" element={<SnapshotsPage />} />
                <Route path="/mcp" element={<McpPage />} />
                <Route path="/ai" element={<AiAssistantPage />} />
                <Route path="*" element={<HomePage />} />
              </Routes>}
        </div>
      </div>
      <StatusBar />
      <ToastHost />
      {palette && (
        <div className="palette card">
          <input autoFocus className="input" placeholder="Type to search requests, collections, actions… (Ctrl+K to close)"
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && paletteItems[0]) { paletteItems[0].action(); setPalette(false); } }} />
          <div style={{ marginTop: 8, maxHeight: 340, overflow: 'auto' }}>
            {paletteItems.map((i, k) => (
              <div key={k} className={`p-item ${k === 0 ? 'sel' : ''}`} onClick={() => { i.action(); setPalette(false); }}>{i.label}</div>
            ))}
            {paletteItems.length === 0 && <div className="muted pad">No matches.</div>}
          </div>
        </div>
      )}
    </div>
  );
}

async function boot(): Promise<void> {
  await initBridge();
  // restore persisted theme/zoom asap
  applyTheme(localStorage.getItem('am.theme') ?? undefined, Number(localStorage.getItem('am.zoom') ?? 1));
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <React.StrictMode>
      <HashRouter>
        <Shell />
      </HashRouter>
    </React.StrictMode>,
  );
  void useApp.getState().init();
}

void boot();
