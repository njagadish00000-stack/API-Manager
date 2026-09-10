/**
 * Application state (zustand) — workspace data + UI session state.
 *
 * Session resume (§6): every meaningful UI mutation schedules a debounced
 * crash-safe save to `session.json` on the backend (atomic writes, separate
 * from SQLite). Drafts (unsaved request edits, including brand-new tabs) are
 * snapshotted per tab. On launch, init() restores workspace, environment,
 * tabs (with drafts), tree expansion, sidebar/console/split layout and the
 * last route.
 */
import { create } from 'zustand';
import { call, onEvent } from './bridge';
import type { Collection, Folder, ApiRequest, Environment, Workspace, AppSettings } from '../shared/types';
import type { SessionState, SessionTab } from '../shared/session';
import { clampZoom } from '../core/response/responseFormat';

export interface Toast { id: number; kind: 'ok' | 'err' | 'info' | 'warn'; text: string }
export interface OpenTab {
  id: string;         // tab id ('req:<uuid>' saved, 'req:new:<uuid>' draft)
  kind: string;       // 'request' | 'run' | ...
  title: string;
  entityId?: string;  // saved request id
  dirty?: boolean;
  pinned?: boolean;
  /** Full request snapshot for unsaved/new or dirty tabs. */
  draft?: ApiRequest | null;
  /** Per-tab viewer state */
  view?: { builderTab?: string; responseTab?: string; responseZoom?: number; responseWrap?: boolean };
}

export interface RecoveryInfo { recoveredFromCrash: boolean; note: string; savedAt: string; tabCount: number }

interface AppState {
  workspaces: Workspace[];
  workspaceId: string;
  collections: Collection[];
  folders: Folder[];
  requests: ApiRequest[];
  environments: Environment[];
  activeEnvironmentId: string | null;
  settings: AppSettings | null;
  tabs: OpenTab[];
  activeTabId: string | null;
  closedTabs: OpenTab[];
  toasts: Toast[];
  sidebarSearch: string;
  sidebarTab: 'collections' | 'history' | 'favorites' | 'tags';
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  consoleOpen: boolean;
  consoleHeight: number;
  splitRatio: number;
  expandedNodes: string[];
  route: string;
  netStatus: 'online' | 'offline';
  ready: boolean;
  recovery: RecoveryInfo | null;

  init: () => Promise<RecoveryInfo | null>;
  refreshWorkspace: () => Promise<void>;
  refreshCollections: () => Promise<void>;
  refreshEnvironments: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  setWorkspace: (id: string, opts?: { keepTabs?: boolean }) => Promise<void>;
  setActiveEnvironment: (id: string | null) => Promise<void>;
  setSidebarSearch: (s: string) => void;
  setSidebarTab: (t: AppState['sidebarTab']) => void;
  toast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: number) => void;
  openTab: (tab: OpenTab, activate?: boolean) => void;
  closeTab: (id: string) => void;
  closeOtherTabs: (id: string) => void;
  setActiveTab: (id: string) => void;
  moveTab: (id: string, toIndex: number) => void;
  pinTab: (id: string, pinned: boolean) => void;
  duplicateTab: (id: string) => void;
  reopenClosed: () => void;
  openNewRequest: () => void;
  markDirty: (tabId: string, dirty: boolean) => void;
  updateTabDraft: (tabId: string, req: ApiRequest | null, dirty?: boolean) => void;
  updateTabView: (tabId: string, view: Partial<NonNullable<OpenTab['view']>>) => void;
  convertDraftTab: (oldId: string, saved: ApiRequest) => void;
  openRequest: (r: ApiRequest) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setConsoleOpen: (v: boolean) => void;
  setConsoleHeight: (h: number) => void;
  setSplitRatio: (r: number) => void;
  toggleTreeNode: (id: string) => void;
  setExpandedNodes: (ids: string[]) => void;
  setRoute: (r: string) => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  patchResponseViewer: (patch: { zoom?: number; wordWrap?: boolean }) => Promise<void>;
  patchRequestEditor: (patch: { zoom?: number; wordWrap?: boolean }) => Promise<void>;
  flushSession: () => Promise<void>;
  acknowledgeRecovery: () => void;
}

let toastId = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function uidPart(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const useApp = create<AppState>((set, get) => ({
  workspaces: [],
  workspaceId: '',
  collections: [],
  folders: [],
  requests: [],
  environments: [],
  activeEnvironmentId: null,
  settings: null,
  tabs: [],
  activeTabId: null,
  closedTabs: [],
  toasts: [],
  sidebarSearch: '',
  sidebarTab: 'collections',
  sidebarCollapsed: false,
  sidebarWidth: 280,
  consoleOpen: false,
  consoleHeight: 240,
  splitRatio: 0.44,
  expandedNodes: [],
  route: '/',
  netStatus: navigator.onLine ? 'online' : 'offline',
  ready: false,
  recovery: null,

  init: async () => {
    // 1) restore crash-safe session BEFORE any workspace load
    let savedSession: SessionState | null = null;
    let recovery: RecoveryInfo | null = null;
    try {
      const got = await call<{ state: SessionState; recovery: RecoveryInfo }>('session.get');
      savedSession = got.state;
      recovery = got.recovery;
    } catch { /* first launch */ }

    const workspaces = await call<Workspace[]>('workspace.list');
    const activeWs = await call<Workspace | null>('workspace.getActive').catch((): null => null) as Workspace | null;
    const storedWs = savedSession?.workspaceId ?? localStorage.getItem('am.workspaceId');
    const workspaceId = storedWs && workspaces.some((w) => w.id === storedWs)
      ? storedWs
      : (activeWs && workspaces.some((w) => w.id === activeWs.id) ? activeWs.id : (workspaces[0]?.id ?? ''));
    set({ workspaces, workspaceId, recovery });
    await get().setWorkspace(workspaceId, { keepTabs: true });
    void call('workspace.setActive', { id: workspaceId }).catch(() => undefined);

    // 2) restore layout prefs
    if (savedSession) {
      const ss = savedSession;
      set({
        sidebarCollapsed: !!ss.sidebarCollapsed,
        sidebarWidth: ss.sidebarWidth ?? 280,
        consoleOpen: !!ss.consoleOpen,
        consoleHeight: ss.consoleHeight ?? 240,
        splitRatio: clamp01(ss.splitRatio ?? 0.44),
        expandedNodes: ss.expandedNodes ?? [],
        sidebarTab: (ss.sidebarTab as AppState['sidebarTab']) ?? 'collections',
        route: ss.route ?? '/',
      });
      if (typeof ss.activeEnvironmentId === 'string' && ss.activeEnvironmentId) {
        await get().setActiveEnvironment(ss.activeEnvironmentId).catch(() => undefined);
      }
      // 3) restore tabs, dropping any whose saved request no longer exists
      const valid = (ss.tabs ?? []).filter((t) => {
        if (t.entityId) return get().requests.some((r) => r.id === t.entityId);
        return true; // unsaved drafts always restore
      });
      const tabs: OpenTab[] = valid.map((t) => sessionTabToTab(t));
      const activeTabId = tabs.some((t) => t.id === ss.activeTabId) ? ss.activeTabId : (tabs[0]?.id ?? null);
      set({ tabs, activeTabId });
      if (recovery?.recoveredFromCrash && tabs.some((t) => t.dirty)) {
        get().toast('warn', `Recovered ${tabs.filter((t) => t.dirty).length} tab(s) with unsaved changes after an unexpected exit.`);
      } else if (recovery?.recoveredFromCrash) {
        get().toast('info', 'Previous session restored after an unexpected exit.');
      }
      // normalise the clean-exit marker now that the session has been resumed
      void call('session.save', { state: { cleanExit: true } }).catch(() => undefined);
    }

    onEvent((ev) => {
      const s = get();
      if (ev.type === 'vault.locked') s.toast('warn', 'Vault locked');
      if (ev.type === 'backup.created') s.toast('ok', `Backup created: ${String((ev.payload as { path?: string }).path ?? '')}`);
    });
    window.addEventListener('online', () => set({ netStatus: 'online' }));
    window.addEventListener('offline', () => set({ netStatus: 'offline' }));
    // last-chance persistence
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void get().flushSession(); });
    window.addEventListener('pagehide', () => { void get().flushSession(); });
    set({ ready: true });
    return recovery;
  },

  refreshWorkspace: async () => {
    const workspaces = await call<Workspace[]>('workspace.list');
    set({ workspaces });
  },

  refreshCollections: async () => {
    const { workspaceId } = get();
    if (!workspaceId) { set({ collections: [], folders: [], requests: [] }); return; }
    const [collections, folders, reqPage] = await Promise.all([
      call<Collection[]>('collection.list', { workspaceId }),
      call<Folder[]>('folder.list', { workspaceId }),
      call<{ items: ApiRequest[] }>('request.list', { workspaceId, limit: 100000 }),
    ]);
    set({ collections, folders, requests: reqPage.items });
  },

  refreshEnvironments: async () => {
    const { workspaceId, activeEnvironmentId } = get();
    if (!workspaceId) { set({ environments: [], activeEnvironmentId: null }); return; }
    const environments = await call<Environment[]>('environment.list', { workspaceId });
    const stored = localStorage.getItem('am.activeEnv.' + workspaceId);
    let next = activeEnvironmentId;
    if (!next) next = stored && environments.some((e) => e.id === stored) ? stored : null;
    if (next && !environments.some((e) => e.id === next)) next = null;
    set({ environments, activeEnvironmentId: next });
  },

  refreshSettings: async () => {
    const settings = await call<AppSettings>('settings.get');
    set({ settings });
    applyTheme(settings.general?.theme);
  },

  setWorkspace: async (id, opts) => {
    set((s) => ({ workspaceId: id, tabs: opts?.keepTabs ? s.tabs : [], activeTabId: opts?.keepTabs ? s.activeTabId : null }));
    localStorage.setItem('am.workspaceId', id);
    await Promise.all([get().refreshCollections(), get().refreshEnvironments(), get().refreshSettings()]);
    if (!opts?.keepTabs) scheduleSave(get);
  },

  setActiveEnvironment: async (id) => {
    const { workspaceId } = get();
    set({ activeEnvironmentId: id });
    if (workspaceId) localStorage.setItem('am.activeEnv.' + workspaceId, id ?? '');
    void call('environment.setActive', { id }).catch(() => undefined);
    scheduleSave(get);
  },

  setSidebarSearch: (sidebarSearch) => set({ sidebarSearch }),
  setSidebarTab: (sidebarTab) => { set({ sidebarTab }); scheduleSave(get); },

  toast: (kind, text) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === 'err' ? 8000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  openTab: (tab, activate = true) => {
    const s = get();
    const existing = s.tabs.find((t) => t.id === tab.id || (t.kind === tab.kind && t.entityId === tab.entityId && tab.entityId));
    if (existing) { if (activate) set({ activeTabId: existing.id }); return; }
    const pinnedCount = s.tabs.filter((t) => t.pinned).length;
    const tabs = [...s.tabs, tab];
    // unpinned tabs always follow pinned ones
    if (!tab.pinned && pinnedCount < tabs.length - 1) {
      tabs.splice(tabs.length - 1, 1);
      tabs.splice(pinnedCount, 0, tab);
    }
    set({ tabs, activeTabId: activate ? tab.id : s.activeTabId });
    scheduleSave(get);
  },
  closeTab: (id) => {
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (s.activeTabId === id) {
        const idx = s.tabs.findIndex((t) => t.id === id);
        activeTabId = tabs[Math.max(0, idx - 1)]?.id ?? null;
      }
      const closedTabs = tab ? [tab, ...s.closedTabs].slice(0, 12) : s.closedTabs;
      return { tabs, activeTabId, closedTabs };
    });
    scheduleSave(get);
  },
  closeOtherTabs: (id) => {
    set((s) => ({ tabs: s.tabs.filter((t) => t.pinned || t.id === id), activeTabId: id }));
    scheduleSave(get);
  },
  setActiveTab: (id) => { set({ activeTabId: id }); scheduleSave(get); },
  moveTab: (id, toIndex) => {
    set((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      if (from < 0 || toIndex < 0 || toIndex >= s.tabs.length) return s;
      const tabs = [...s.tabs];
      const [t] = tabs.splice(from, 1);
      const firstUnpinned = tabs.findIndex((x) => !x.pinned);
      const limit = t.pinned ? (firstUnpinned < 0 ? tabs.length : firstUnpinned) : tabs.length;
      const idx = Math.max(firstUnpinned < 0 ? 0 : (t.pinned ? 0 : firstUnpinned), Math.min(toIndex, limit));
      tabs.splice(idx, 0, t);
      return { tabs };
    });
    scheduleSave(get);
  },
  pinTab: (id, pinned) => {
    set((s) => {
      const tabs = s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t));
      tabs.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
      return { tabs };
    });
    scheduleSave(get);
  },
  duplicateTab: (id) => {
    const s = get();
    const t = s.tabs.find((x) => x.id === id);
    if (!t) return;
    const copy: OpenTab = { ...t, id: `req:new:${uidPart()}`, title: `${t.title} copy`, pinned: false, dirty: true,
      draft: t.draft ? { ...t.draft, id: t.draft.id } : (t.entityId ? s.requests.find((r) => r.id === t.entityId) ?? null : null) };
    get().openTab(copy);
  },
  reopenClosed: () => {
    const t = get().closedTabs[0];
    if (!t) return;
    set((s) => ({ closedTabs: s.closedTabs.slice(1) }));
    get().openTab({ ...t });
  },
  openNewRequest: () => {
    const s = get();
    const wsId = s.workspaceId;
    const draft: ApiRequest = {
      id: uidPart(), workspaceId: wsId, name: 'Untitled', method: 'GET', url: '',
      pathParams: [], queryParams: [], headers: [], body: { type: 'none' }, auth: { type: 'inherit' },
      assertions: [], scripts: { preRequest: '', postResponse: '' }, protocol: 'http', tags: [],
      favorite: false, sortOrder: 0, settings: defaultReqSettings(),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    get().openTab({ id: `req:new:${draft.id}`, kind: 'request', title: draft.name, draft, dirty: true });
  },

  markDirty: (tabId, dirty) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, dirty } : t)) }));
    scheduleSave(get);
  },
  updateTabDraft: (tabId, req, dirty) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId
        ? { ...t, draft: req, dirty: dirty ?? t.dirty, title: t.entityId ? t.title : (req?.name || 'Untitled') }
        : t)),
    }));
    scheduleSave(get);
  },
  updateTabView: (tabId, view) => {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, view: { ...t.view, ...view } } : t)) }));
    scheduleSave(get);
  },
  convertDraftTab: (oldId, saved) => {
    set((s) => {
      const tabs = s.tabs.map((t) => (t.id === oldId
        ? { id: `req:${saved.id}`, kind: 'request', title: saved.name, entityId: saved.id, dirty: false, draft: null, view: t.view }
        : t));
      return { tabs, activeTabId: s.activeTabId === oldId ? `req:${saved.id}` : s.activeTabId };
    });
    scheduleSave(get);
  },

  openRequest: (r) => {
    get().openTab({ id: `req:${r.id}`, kind: 'request', title: r.name, entityId: r.id });
  },

  setSidebarCollapsed: (v) => { set({ sidebarCollapsed: v }); scheduleSave(get); },
  setSidebarWidth: (w) => set({ sidebarWidth: Math.max(180, Math.min(560, w)) }), // committed on drag end below
  setConsoleOpen: (v) => { set({ consoleOpen: v }); scheduleSave(get); },
  setConsoleHeight: (h) => set({ consoleHeight: Math.max(120, Math.min(640, h)) }),
  setSplitRatio: (r) => set({ splitRatio: clamp01(r) }),
  toggleTreeNode: (id) => {
    set((s) => ({ expandedNodes: s.expandedNodes.includes(id) ? s.expandedNodes.filter((x) => x !== id) : [...s.expandedNodes, id] }));
    scheduleSave(get);
  },
  setExpandedNodes: (ids) => { set({ expandedNodes: ids }); scheduleSave(get); },
  setRoute: (route) => { if (route !== get().route) { set({ route }); scheduleSave(get); } },

  updateSettings: async (patch) => {
    const merged = await call<AppSettings>('settings.update', { patch });
    set({ settings: merged });
    applyTheme(merged.general?.theme);
    scheduleSave(get);
  },
  patchResponseViewer: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    await get().updateSettings({
      editor: {
        ...cur.editor,
        responseZoom: patch.zoom !== undefined ? clampZoom(patch.zoom) : cur.editor.responseZoom,
        wordWrap: patch.wordWrap !== undefined ? patch.wordWrap : cur.editor.wordWrap,
      },
    });
  },
  patchRequestEditor: async (patch) => {
    const cur = get().settings;
    if (!cur) return;
    await get().updateSettings({
      editor: {
        ...cur.editor,
        requestZoom: patch.zoom !== undefined ? clampZoom(patch.zoom) : cur.editor.requestZoom,
        wordWrap: patch.wordWrap !== undefined ? patch.wordWrap : cur.editor.wordWrap,
      },
    });
  },

  flushSession: async () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    const s = get();
    if (!s.workspaceId) return;
    const state: Partial<SessionState> = buildSessionState(s);
    try { await call('session.save', { state }); } catch { /* best effort */ }
  },

  acknowledgeRecovery: () => set({ recovery: null }),
}));

function clamp01(n: number): number { return Math.min(0.85, Math.max(0.15, n)); }

function defaultReqSettings(): ApiRequest['settings'] {
  return {
    timeoutMs: 30000, followRedirects: true, maxRedirects: 10, preserveAuthOnRedirect: true, stripSensitiveHeaders: true,
    retry: { enabled: false, maxRetries: 0, strategy: 'fixed', delayMs: 0, retryStatusCodes: [], retryOnNetworkError: false, retryOnTimeout: false, onlyIdempotent: false },
    httpVersion: 'auto', encodeUrl: true, verifyTls: false, storeResponse: true,
  };
}

function sessionTabToTab(t: SessionTab): OpenTab {
  return {
    id: t.id, kind: t.kind, title: t.title, entityId: t.entityId,
    pinned: t.pinned, dirty: t.dirty, draft: (t.draft as ApiRequest | undefined) ?? null, view: t.view,
  };
}

function buildSessionState(s: AppState): Partial<SessionState> {
  return {
    workspaceId: s.workspaceId,
    route: s.route,
    activeEnvironmentId: s.activeEnvironmentId,
    tabs: s.tabs.map<SessionTab>((t) => ({
      id: t.id, kind: t.kind, title: t.title, entityId: t.entityId, pinned: !!t.pinned,
      dirty: !!t.dirty,
      draft: t.dirty ? t.draft : (t.id.startsWith('req:new:') ? t.draft : undefined),
      view: t.view,
    })),
    activeTabId: s.activeTabId,
    sidebarTab: s.sidebarTab,
    sidebarCollapsed: s.sidebarCollapsed,
    sidebarWidth: s.sidebarWidth,
    expandedNodes: s.expandedNodes,
    consoleOpen: s.consoleOpen,
    consoleHeight: s.consoleHeight,
    splitRatio: s.splitRatio,
    responseViewer: s.settings
      ? { zoom: s.settings.editor.responseZoom, wordWrap: s.settings.editor.wordWrap }
      : undefined,
    requestEditor: s.settings
      ? { zoom: s.settings.editor.requestZoom, wordWrap: s.settings.editor.wordWrap }
      : undefined,
    theme: s.settings?.general?.theme,
  };
}

function scheduleSave(get2: () => AppState): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void get2().flushSession(); }, 700);
}

export function applyTheme(theme?: string): void {
  let t = theme;
  if (t === 'system' || !t) {
    t = window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  const resolved = t === 'light' ? 'light' : t === 'hc' || t === 'high-contrast' ? 'hc' : 'dark';
  document.documentElement.setAttribute('data-theme', resolved);
}
