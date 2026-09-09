/**
 * Application state (zustand) — mirrors workspace data + UI session state.
 */
import { create } from 'zustand';
import { call, onEvent } from './bridge';
import type { Collection, Folder, ApiRequest, Environment, Workspace, AppSettings } from '../shared/types';

export interface Toast { id: number; kind: 'ok' | 'err' | 'info' | 'warn'; text: string }
export interface OpenTab {
  id: string;         // tab id
  kind: string;       // 'request' | 'run' | 'env' | 'mock' | ...
  title: string;
  entityId?: string;  // request id etc
  dirty?: boolean;
}

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
  toasts: Toast[];
  sidebarSearch: string;
  sidebarTab: 'collections' | 'history' | 'favorites' | 'tags';
  netStatus: 'online' | 'offline';
  ready: boolean;

  init: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
  refreshCollections: () => Promise<void>;
  refreshEnvironments: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  setWorkspace: (id: string) => Promise<void>;
  setActiveEnvironment: (id: string | null) => Promise<void>;
  setSidebarSearch: (s: string) => void;
  setSidebarTab: (t: AppState['sidebarTab']) => void;
  toast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: number) => void;
  openTab: (tab: OpenTab) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  markDirty: (tabId: string, dirty: boolean) => void;
  openRequest: (r: ApiRequest) => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

let toastId = 0;

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
  toasts: [],
  sidebarSearch: '',
  sidebarTab: 'collections',
  netStatus: navigator.onLine ? 'online' : 'offline',
  ready: false,

  init: async () => {
    const savedWs = localStorage.getItem('am.workspaceId');
    const workspaces = await call<Workspace[]>('workspace.list');
    const activeWs = await call<Workspace | null>('workspace.getActive').catch((): null => null) as Workspace | null;
    const workspaceId = savedWs && workspaces.some((w) => w.id === savedWs) ? savedWs : (activeWs && workspaces.some((w) => w.id === activeWs.id) ? activeWs.id : (workspaces[0]?.id ?? ''));
    set({ workspaces, workspaceId });
    await get().setWorkspace(workspaceId);
    void call('workspace.setActive', { id: workspaceId }).catch(() => undefined);
    onEvent((ev) => {
      // react to interesting backend events
      const s = get();
      if (ev.type === 'vault.locked') s.toast('warn', 'Vault locked');
      if (ev.type === 'backup.created') s.toast('ok', `Backup created: ${String((ev.payload as { path?: string }).path ?? '')}`);
    });
    set({ ready: true });
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
    const { workspaceId } = get();
    if (!workspaceId) { set({ environments: [], activeEnvironmentId: null }); return; }
    const environments = await call<Environment[]>('environment.list', { workspaceId });
    const stored = localStorage.getItem('am.activeEnv.' + workspaceId);
    const [activeEnvironmentId] = [stored && environments.some((e) => e.id === stored) ? stored : null];
    set({ environments, activeEnvironmentId });
  },

  refreshSettings: async () => {
    const settings = await call<AppSettings>('settings.get');
    set({ settings });
    applyTheme(settings.general?.theme, settings.editor?.responseZoom);
  },

  setWorkspace: async (id) => {
    set({ workspaceId: id, tabs: [], activeTabId: null });
    localStorage.setItem('am.workspaceId', id);
    await Promise.all([get().refreshCollections(), get().refreshEnvironments(), get().refreshSettings()]);
  },

  setActiveEnvironment: async (id) => {
    const { workspaceId } = get();
    set({ activeEnvironmentId: id });
    if (workspaceId) localStorage.setItem('am.activeEnv.' + workspaceId, id ?? '');
  },

  setSidebarSearch: (sidebarSearch) => set({ sidebarSearch }),
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),

  toast: (kind, text) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === 'err' ? 8000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  openTab: (tab) => {
    const s = get();
    const existing = s.tabs.find((t) => t.id === tab.id || (t.kind === tab.kind && t.entityId === tab.entityId && tab.entityId));
    if (existing) { set({ activeTabId: existing.id }); return; }
    set({ tabs: [...s.tabs, tab], activeTabId: tab.id });
  },
  closeTab: (id) => {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId = s.activeTabId === id ? (tabs[Math.max(0, idx - 1)]?.id ?? null) : s.activeTabId;
      return { tabs, activeTabId };
    });
  },
  setActiveTab: (id) => set({ activeTabId: id }),
  markDirty: (tabId, dirty) => set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, dirty } : t)) })),

  openRequest: (r) => {
    get().openTab({ id: `req:${r.id}`, kind: 'request', title: r.name, entityId: r.id });
  },

  updateSettings: async (patch) => {
    const merged = await call<AppSettings>('settings.update', { patch });
    set({ settings: merged });
    applyTheme(merged.general?.theme, merged.editor?.responseZoom);
  },
}));

export function applyTheme(theme?: string, zoom?: number): void {
  const t = theme === 'light' ? 'light' : theme === 'hc' || theme === 'high-contrast' ? 'hc' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  const apply = (): void => {
    const z = zoom ?? 1;
    (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(z);
  };
  apply();
}
