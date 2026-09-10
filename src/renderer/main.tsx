/** App entry: router, shell (activity bar / sidebar / tabs / console / statusbar). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import './styles.css';
import { initBridge, onEvent, call } from './bridge';
import { applyTheme, useApp, type OpenTab } from './state';
import { ToastHost, Tree, useContextMenu, type TreeNode } from './components';
import { ConsoleDrawer } from './console-drawer';
import type { ApiRequest, Collection, HistoryEntry } from '../shared/types';
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
  { id: 'about', label: 'About API Manager', icon: 'ⓘ', path: '/about', group: 'system' },
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
  const showSidebar = ['/', '/request'].some((p) => loc.pathname.startsWith(p)) || loc.pathname.startsWith('/specs');
  const expanded = useMemo(() => new Set(s.expandedNodes), [s.expandedNodes]);

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const move = (ev: MouseEvent): void => s.setSidebarWidth(ev.clientX - 46);
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); void s.flushSession(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const collectionCtx = (c: Collection, e: React.MouseEvent): void => {
    open(e, [
      { label: 'New request', onClick: () => s.openNewRequest() },
      { label: 'Rename', onClick: () => { const name = prompt('Collection name', c.name); if (name) void call('collection.update', { id: c.id, patch: { name } }).then(() => s.refreshCollections()); } },
      { label: 'Duplicate', onClick: () => void call('collection.duplicate', { id: c.id }).then(() => s.refreshCollections()) },
      { sep: true, label: 'Export (Postman JSON)', onClick: () => void call<string>('export.collection', { id: c.id, format: 'postman' }).then((j) => { const b = new Blob([j], { type: 'application/json' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `${c.name}.postman.json`; a.click(); URL.revokeObjectURL(u); }) },
      { label: 'Export (API Manager JSON)', onClick: () => void call<string>('export.collection', { id: c.id, format: 'apimanager' }).then((j) => { const b = new Blob([j], { type: 'application/json' }); const u = URL.createObjectURL(b); const a = document.createElement('a'); a.href = u; a.download = `${c.name}.json`; a.click(); URL.revokeObjectURL(u); }) },
      { label: 'Delete', danger: true, onClick: () => { if (confirm(`Delete collection "${c.name}" and all its requests?`)) void call('collection.delete', { id: c.id }).then(() => s.refreshCollections()); } },
    ]);
  };

  if (!showSidebar) return <SidebarResizer hidden onDrag={startResize} />;

  const search = s.sidebarSearch.toLowerCase();
  const match = (r: ApiRequest): boolean => !search || r.name.toLowerCase().includes(search) || r.url.toLowerCase().includes(search);

  const nodes: TreeNode<ApiRequest>[] = s.collections.map((c) => ({
    id: c.id,
    label: (
      <span className="col-label" onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); collectionCtx(c, e); }}>{c.name}</span>
    ) as unknown as string,
    value: undefined,
    children: (() => {
      const folderChildren = (parentId: string | undefined): TreeNode<ApiRequest>[] => {
        const folders = s.folders.filter((f) => f.collectionId === c.id && (parentId ? f.parentFolderId === parentId : !f.parentFolderId));
        const reqs = s.requests.filter((r) => r.collectionId === c.id && (parentId ? r.folderId === parentId : !r.folderId));
        return [
          ...folders.map((f) => ({
            id: f.id, label: `📁 ${f.name}`, value: undefined,
            children: folderChildren(f.id),
          })),
          ...reqs.filter(match).sort((a, b) => a.sortOrder - b.sortOrder).map((r) => ({
            id: r.id, label: <span className="req-label">{r.name}</span> as unknown as string, value: r,
            icon: <span className={`m-chip m-${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) ? r.method : 'OTHER'}`}>{r.method}</span>,
          })),
        ];
      };
      return folderChildren(undefined);
    })(),
  }));

  const requestCtx = (n: TreeNode<ApiRequest>, e: React.MouseEvent): void => {
    const r = n.value;
    if (!r) return;
    open(e, [
      { label: 'Open', onClick: () => s.openRequest(r) },
      { label: 'Open in new tab', onClick: () => s.duplicateTab(`req:${r.id}`) },
      { label: 'Rename', onClick: () => { const name = prompt('Request name', r.name); if (name) void call('request.update', { id: r.id, patch: { name } }).then(() => s.refreshCollections()); } },
      { label: 'Duplicate request', onClick: () => { void call('request.duplicate', { id: r.id }).then(() => s.refreshCollections()); } },
      { label: 'Copy as cURL', onClick: () => { void call<string>('curl.generate', { request: r }).then((c) => { void navigator.clipboard.writeText(String(c)); s.toast('ok', 'cURL copied'); }); } },
      { sep: true, label: `Favorite${r.favorite ? ' (remove)' : ''}`, onClick: () => { void call('favorite.toggle', { entityType: 'request', entityId: r.id }).then(() => s.refreshCollections()); } },
      { label: 'Delete', danger: true, onClick: () => { if (confirm(`Delete "${r.name}"?`)) { void call('request.delete', { id: r.id }).then(() => s.refreshCollections()); } } },
    ]);
  };

  return (
    <>
      <div className="sidebar">
        {ctx}
        <div className="sb-head">
          <button className="icon-btn" title="Collapse sidebar (Ctrl+B)" onClick={() => s.setSidebarCollapsed(true)}>⇤</button>
          <span>Collections</span><span className="spacer" />
          <button className="icon-btn" title="New request (Ctrl+T)" onClick={() => s.openNewRequest()}>＋</button>
          <button className="icon-btn" title="New collection" onClick={() => {
            const name = prompt('Collection name');
            if (name) void call('collection.create', { name }).then(() => s.refreshCollections());
          }}>📦</button>
        </div>
        <div>
          <input className="input sm sb-search" placeholder="Filter requests…" value={s.sidebarSearch} onChange={(e) => s.setSidebarSearch(e.target.value)} />
        </div>
        <div className="sb-scroll">
          <Tree
            nodes={nodes}
            selected={s.activeTabId?.startsWith('req:') ? s.activeTabId.slice(4) : null}
            onSelect={(n) => { if (n.value) s.openRequest(n.value); }}
            onContext={requestCtx}
            expandedIds={expanded}
            onToggle={(id, isExpanded) => {
              const next = new Set(s.expandedNodes);
              if (isExpanded) next.add(id); else next.delete(id);
              s.setExpandedNodes([...next]);
            }}
          />
          <HistorySection />
        </div>
      </div>
      <SidebarResizer onDrag={startResize} />
    </>
  );
}

function SidebarResizer(props: { onDrag: (e: React.MouseEvent) => void; hidden?: boolean }): React.ReactElement {
  if (props.hidden) return <></>;
  return <div className="sidebar-resizer" onMouseDown={props.onDrag} title="Drag to resize sidebar" />;
}

function HistorySection(): React.ReactElement {
  const s = useApp();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const { ctx, open } = useContextMenu();
  useEffect(() => {
    void call<{ items: HistoryEntry[] }>('history.list', { limit: 60 }).then((r) => setHistory(r.items)).catch(() => undefined);
  }, [s.workspaceId, s.activeTabId, s.tabs.length]);
  return (
    <div style={{ marginTop: 14 }}>
      <div className="row" style={{ padding: '0 6px' }}>
        <span className="section-title" style={{ margin: 0 }}>History</span>
        <span className="spacer" />
        <button className="btn xs" title="Clear all history" onClick={() => { if (confirm('Clear all request history?')) void call('history.clear', {}).then(() => setHistory([])); }}>clear</button>
      </div>
      {history.length === 0 && <div className="muted" style={{ padding: '2px 8px' }}>Nothing yet.</div>}
      {history.slice(0, 40).map((h) => (
        <div key={h.id} className="tree-item" title={h.url}
          onClick={() => { void call<ApiRequest>('request.get', { id: h.requestId }).then((r) => s.openRequest(r)).catch(() => undefined); }}
          onContextMenu={(e) => open(e, [
            { label: 'Reopen', onClick: () => { void call<ApiRequest>('request.get', { id: h.requestId }).then((r) => s.openRequest(r)); } },
            { label: 'Delete entry', danger: true, onClick: () => { void call('history.delete', { id: h.id }).then(() => setHistory((x) => x.filter((y) => y.id !== h.id))); } },
          ])}>
          {ctx}
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
  const { ctx, open } = useContextMenu();
  const dragId = useRef<string | null>(null);

  const tabMenu = (t: OpenTab, e: React.MouseEvent): void => {
    open(e, [
      { label: t.pinned ? 'Unpin tab' : 'Pin tab', onClick: () => s.pinTab(t.id, !t.pinned) },
      { label: 'Duplicate tab', onClick: () => s.duplicateTab(t.id) },
      { sep: true, label: 'Close tab (Ctrl+W)', onClick: () => s.closeTab(t.id) },
      { label: 'Close other tabs', onClick: () => s.closeOtherTabs(t.id) },
    ]);
  };

  return (
    <div className="tabbar">
      {s.tabs.map((t, i) => (
        <div
          key={t.id}
          className={`tab ${s.activeTabId === t.id ? 'active' : ''} ${t.pinned ? 'pinned' : ''}`}
          draggable
          onDragStart={() => { dragId.current = t.id; }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (dragId.current) s.moveTab(dragId.current, i); dragId.current = null; }}
          onClick={() => s.setActiveTab(t.id)}
          onAuxClick={(e) => { if (e.button === 1) s.closeTab(t.id); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); tabMenu(t, e); }}
          title={t.title}
        >
          {t.pinned && <span title="Pinned">📌</span>}
          <span>{t.title}{t.dirty ? ' •' : ''}</span>
          {!t.pinned && <span className="t-x" onClick={(e) => { e.stopPropagation(); s.closeTab(t.id); }}>✕</span>}
        </div>
      ))}
      <button className="icon-btn" title="New request tab (Ctrl+T)" onClick={() => s.openNewRequest()}>＋</button>
      <span className="spacer" />
      <button className="icon-btn" title="Reopen closed tab (Ctrl+Shift+T)" onClick={() => s.reopenClosed()}>↺</button>
      {ctx}
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
        {s.netStatus === 'offline' ? 'Offline' : 'Online (no data leaves this app)'}</span>
      <span className="sb-item">Workspace: {ws?.name ?? '—'}</span>
      <span className="sb-item">Env: {env?.name ?? 'None'}</span>
      <span className="sb-item">{s.collections.length} col · {s.requests.length} req</span>
      <span className="sb-spacer" />
      <button className="link" style={{ color: 'inherit', fontSize: 11.5 }} onClick={() => s.setConsoleOpen(!s.consoleOpen)}>Console (Ctrl+J): {s.consoleOpen ? 'open' : 'closed'}</button>
      <span className="sb-item">API Manager v1.0.0 · 100% offline · by Manish Kumar Singh</span>
    </div>
  );
}

function Shell(): React.ReactElement {
  const s = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const activeTab = s.tabs.find((t) => t.id === s.activeTabId);
  const restoredRef = useRef(false);

  const [palette, setPalette] = useState(false);
  const [query, setQuery] = useState('');

  // persist + reflect the current route
  useEffect(() => { s.setRoute(location.pathname); }, [location.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // one-time session restore: navigate to the saved route/request tab
  useEffect(() => {
    if (!s.ready || restoredRef.current) return;
    restoredRef.current = true;
    if (s.tabs.length > 0 && s.activeTabId) navigate('/');
    else if (s.route && s.route !== '/') navigate(s.route);
  }, [s.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)
        || (e.target as HTMLElement)?.closest?.('.monaco-editor');
      if (k === 'k') { e.preventDefault(); setPalette((p) => !p); setQuery(''); }
      else if (k === 's') { e.preventDefault(); window.dispatchEvent(new CustomEvent('am:save')); }
      else if (k === 't') { e.preventDefault(); s.openNewRequest(); }
      else if (k === 'w') { e.preventDefault(); if (s.activeTabId) s.closeTab(s.activeTabId); }
      else if (k === 'b') { e.preventDefault(); s.setSidebarCollapsed(!s.sidebarCollapsed); }
      else if (k === 'j') { e.preventDefault(); s.setConsoleOpen(!s.consoleOpen); }
      else if (k === ',') { e.preventDefault(); navigate('/settings'); }
      else if (k === 'enter' && typing) { /* page handles send */ }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === 't') {
        e.preventDefault(); s.reopenClosed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s, navigate]);

  useEffect(() => onEvent(() => undefined), []);

  const paletteItems = useMemo(() => {
    const q = query.toLowerCase();
    const items = [
      ...s.requests.filter((r) => r.name.toLowerCase().includes(q) || r.url.toLowerCase().includes(q)).slice(0, 8).map((r) => ({ label: `↳ ${r.method} ${r.name}`, action: () => { s.openRequest(r); navigate('/'); } })),
      ...s.collections.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 4).map((c) => ({ label: `📦 ${c.name}`, action: () => navigate('/') })),
      ...NAV.filter((n) => n.label.toLowerCase().includes(q)).map((n) => ({ label: `${n.icon} ${n.label}`, action: () => navigate(n.path) })),
      ...(location.pathname !== '/' ? [{ label: 'Back to APIs', action: () => navigate('/') }] : []),
      { label: '＋ New request tab', action: () => s.openNewRequest() },
      { label: '🔍 Global search', action: () => navigate('/search') },
      { label: s.consoleOpen ? 'Close console' : 'Open console', action: () => s.setConsoleOpen(!s.consoleOpen) },
    ];
    return items.filter((i) => { if (!q) return true; return i.label.toLowerCase().includes(q); }).slice(0, 14);
  }, [query, s, location.pathname, navigate]);

  const sidebarVisible = location.pathname === '/' || location.pathname.startsWith('/specs');
  const sbWidth = !sidebarVisible || s.sidebarCollapsed ? 0 : s.sidebarWidth;

  return (
    <div className="shell" style={{ gridTemplateColumns: `46px ${sbWidth}px 1fr`, gridTemplateRows: `1fr auto 24px` }}>
      <ActivityBar />
      <Sidebar />
      <div className="main" style={{ gridRow: 1 }}>
        <TabBar />
        <div className="tab-content" style={s.consoleOpen ? { bottom: 0 } : undefined}>
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
                <Route path="/about" element={<AboutPage />} />
                <Route path="*" element={<HomePage />} />
              </Routes>}
        </div>
        <ConsoleDrawer />
      </div>
      <StatusBar />
      <ToastHost />
      {palette && (
        <div className="palette card">
          <input autoFocus className="input" placeholder="Type to search requests, pages, actions… (Ctrl+K to close)"
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setPalette(false); if (e.key === 'Enter' && paletteItems[0]) { paletteItems[0].action(); setPalette(false); } }} />
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

function Boot(): React.ReactElement {
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    void (async (): Promise<void> => {
      await initBridge();
      // early theme restore from last settings/session to avoid flash
      applyTheme(localStorage.getItem('am.theme') ?? undefined);
      setBooted(true);
      await useApp.getState().init();
    })();
  }, []);
  if (!booted) return <div className="empty"><div className="big">⏳</div>Starting API Manager…</div>;
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Boot />);
