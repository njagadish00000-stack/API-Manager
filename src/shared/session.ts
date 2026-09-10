/**
 * UI session persistence types (crash-safe resume, §6).
 * Kept in `shared/` (no Node imports) so both the Node-side SessionStore and
 * the renderer/state store use identical types.
 */

export interface SessionTab {
  id: string;
  kind: string;               // 'request' | 'run' | ...
  title: string;
  entityId?: string;
  pinned?: boolean;
  dirty?: boolean;
  /** Full in-memory request snapshot for unsaved/new ("draft") tabs. */
  draft?: unknown;
  /** Per-tab viewer state (request builder subtab, response tab, zoom overrides…). */
  view?: {
    builderTab?: string;
    responseTab?: string;
    responseZoom?: number;
    responseWrap?: boolean;
  };
}

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  fullscreen?: boolean;
}

export interface SessionState {
  version: number;
  savedAt: string;
  cleanExit: boolean;
  saveCounter: number;
  workspaceId?: string;
  route?: string;
  activeEnvironmentId?: string | null;
  tabs: SessionTab[];
  activeTabId?: string | null;
  sidebarTab?: string;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  activityNav?: string;
  expandedNodes?: string[];
  consoleOpen?: boolean;
  consoleHeight?: number;
  splitRatio?: number;
  theme?: string;
  responseViewer?: { zoom: number; wordWrap: boolean; view?: string };
  requestEditor?: { zoom: number; wordWrap: boolean };
  window?: WindowState;
  lastRequestTab?: string;
}

export interface RecoveryStatus {
  recoveredFromCrash: boolean;
  note: string;
  savedAt: string;
  tabCount: number;
}

export const SESSION_VERSION = 1;
