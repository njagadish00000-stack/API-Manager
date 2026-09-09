/**
 * Runtime container: wires SQLite + repositories + vault + console store +
 * settings + pipeline deps into one AppContainer shared by the registry,
 * Electron shell, hub server, and CLI.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  ApiRequest, AppSettings, Environment, Folder, HistoryEntry, StoredCookie, Variable,
} from '../shared/types';
import { DEFAULT_SETTINGS, now } from '../shared/types';
import { uid } from '../shared/ids';
import { SqliteDb } from '../services/db/sqlite';
import { Repos } from '../services/db/repositories';
import { Vault } from '../services/vault/vault';
import { ConsoleStore } from '../services/console/consoleService';
import { PipelineDeps } from '../services/http/sendPipeline';
import { CookieJar } from 'tough-cookie';
import { ProxyConfig, TlsMaterial } from '../services/http/engine';
import type { BridgeEventType, BridgeEvents } from '../shared/events';

export interface ContainerConfig {
  dataDir: string;
  emit?: <K extends BridgeEventType>(type: K, payload: BridgeEvents[K]) => void;
  log?: (level: string, source: string, message: string) => void;
}

export interface AppContainer {
  dataDir: string;
  db: SqliteDb;
  repos: Repos;
  vault: Vault;
  consoleStore: ConsoleStore;
  settings: AppSettings;
  emit: <K extends BridgeEventType>(type: K, payload: BridgeEvents[K]) => void;
  setEmit(cb: <K extends BridgeEventType>(type: K, payload: BridgeEvents[K]) => void): void;
  saveSettings(patch: Partial<AppSettings>): AppSettings;
  audit(action: string, detail?: string, category?: string, workspaceId?: string): void;
  getActiveWorkspaceId(): string;
  setActiveWorkspaceId(id: string): void;
  getActiveEnvironmentId(): string | undefined;
  setActiveEnvironmentId(id: string | null): void;
  getGlobalVars(): Variable[];
  setGlobalVars(vars: Variable[]): void;
  pipelineDeps(workspaceId: string): PipelineDeps;
  setSetting(key: string, value: unknown): void;
  getSetting<T>(key: string, fallback: T): T;
  flush(): Promise<void>;
}

export async function createContainer(config: ContainerConfig): Promise<AppContainer> {
  mkdirSync(config.dataDir, { recursive: true });
  const dbPath = join(config.dataDir, 'api_manager.db');
  const { db, corrupted, recoveredFrom } = await SqliteDb.open(dbPath);
  const repos = new Repos(db);

  let emitFn: <K extends BridgeEventType>(type: K, payload: BridgeEvents[K]) => void = config.emit ?? (() => undefined);
  const emit: typeof emitFn = (type, payload) => {
    try { emitFn(type, payload); } catch { /* sink failure must not break core */ }
  };

  const consoleStore = new ConsoleStore({
    filePath: join(config.dataDir, 'console.log'),
    maxEntries: 20_000,
    retentionHours: 24 * 7,
    emit: (type, payload) => emit(type as never, payload as never),
  });
  const log = config.log ?? ((level: string, source: string, message: string) => consoleStore.log(level, source, message));
  if (corrupted) log('error', 'db', `Database file appeared corrupted; started fresh. Previous file preserved at ${recoveredFrom}`);

  // ----- settings ----------------------------------------------------------
  const settingsRaw = repos.getSetting('settings.v1');
  const settings: AppSettings = mergeDeepRecords(DEFAULT_SETTINGS as unknown as Record<string, unknown>, (settingsRaw ?? {}) as Record<string, unknown>) as unknown as AppSettings;
  const saveSettings = (patch: Partial<AppSettings>): AppSettings => {
    const merged = mergeDeepRecords(JSON.parse(JSON.stringify(settings)) as Record<string, unknown>, patch as Record<string, unknown>) as unknown as AppSettings;
    for (const key of Object.keys(merged) as (keyof AppSettings)[]) {
      (settings as unknown as Record<string, unknown>)[key as string] = (merged as unknown as Record<string, unknown>)[key as string];
    }
    repos.setSetting('settings.v1', settings);
    return settings;
  };


  const vault = new Vault(config.dataDir);
  vault.setOnLocked(() => emit('vault.locked', {}));
  const autoLock = Number(repos.getSetting('vault.autoLockMinutes') ?? 30);
  if (Number.isFinite(autoLock) && autoLock >= 0) vault.setAutoLockMinutes(autoLock);

  const container: AppContainer = {
    dataDir: config.dataDir,
    db, repos, vault, consoleStore,
    get settings() { return settings; },
    emit,
    setEmit(cb) { emitFn = cb; },
    saveSettings,
    audit(action, detail, category, workspaceId) {
      try {
        repos.addAudit({
          id: uid(), workspaceId: workspaceId ?? getActiveWorkspaceId(), timestamp: now(),
          actor: 'local-user', action,
          category: (category as never) ?? inferCategory(action), detail,
        });
      } catch { /* audit never breaks the app */ }
    },
    getActiveWorkspaceId,
    setActiveWorkspaceId(id) {
      repos.setSetting('app.activeWorkspaceId', id);
    },
    getActiveEnvironmentId,
    setActiveEnvironmentId(id) {
      repos.setSetting(`app.activeEnvironment.${getActiveWorkspaceId()}`, id ?? null);
    },
    getGlobalVars() {
      return globalVars();
    },
    setGlobalVars(vars) {
      repos.setKv(getActiveWorkspaceId(), 'globals', { variables: vars });
    },
    getSetting<T>(key: string, fallback: T): T {
      const v = repos.getSetting(key);
      return (v === undefined || v === null ? fallback : v) as T;
    },
    setSetting(key: string, value: unknown) { repos.setSetting(key, value); },
    pipelineDeps,
    async flush() { await Promise.resolve(); db.saveNow(); },
  };

  function getActiveWorkspaceId(): string {
    let id = repos.getSetting('app.activeWorkspaceId') as string | undefined;
    if (id && repos.getWorkspace(id)) return id;
    const all = repos.listWorkspaces();
    if (all.length === 0) {
      const created = repos.saveWorkspace({
        id: uid(), name: 'My Workspace', description: '', isDefault: true, readOnly: false, encrypted: false,
        settings: {}, createdAt: now(), updatedAt: now(),
      });
      repos.setSetting('app.activeWorkspaceId', created.id);
      return created.id;
    }
    id = (all.find((w) => w.isDefault) ?? all[0]).id;
    repos.setSetting('app.activeWorkspaceId', id!);
    return id!;
  }

  function getActiveEnvironmentId(): string | undefined {
    const id = repos.getSetting(`app.activeEnvironment.${getActiveWorkspaceId()}`) as string | null | undefined;
    if (!id) return undefined;
    return repos.getEnvironment(id) ? id : undefined;
  }

  function globalVars(): Variable[] {
    const doc = repos.getKv(getActiveWorkspaceId(), 'globals') as { variables?: Variable[] };
    return doc.variables ?? [];
  }

  function pipelineDeps(workspaceId: string): PipelineDeps {
    return {
      getEnvironment: (id?: string) => (id ? repos.getEnvironment(id) : undefined),
      getActiveEnvironmentId,
      getCollection: (id?: string) => (id ? repos.getCollection(id) : undefined),
      getFolderChain: makeFolderChain(),
      getGlobalVars: globalVars,
      getWorkspaceVars: () => {
        const doc = repos.getKv(workspaceId, 'workspaceVars') as { variables?: Variable[] };
        return doc.variables ?? [];
      },
      getCollectionParents: (id?: string) => ({ collection: id ? repos.getCollection(id) : undefined }),
      resolveSecretRef: (value: string) => {
        // {{vault:name}} and secret variables are resolved here
        return value.replace(/\{\{\s*vault:([\w.-]+)\s*\}\}/g, (_m, name: string) => vault.resolveByName(name) ?? '');
      },
      getCookieHeader: (url: string) => buildCookieHeader(workspaceId, url),
      storeCookies: (wsId, url, cookies) => {
        const persist = container.getSetting('http.persistCookies', true);
        if (!persist) return;
        for (const c of cookies) {
          repos.upsertCookie(wsId, {
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            expires: undefined, httpOnly: false, secure: false, sameSite: 'Lax',
          });
        }
      },
      loadCertificate: (certId?: string, host?: string) => loadTlsMaterial(workspaceId, certId, host),
      resolveProxy: (request: ApiRequest) => resolveProxyFor(workspaceId, request),
      onConsole: (level: string, source: string, message: string) => consoleStore.log(level, source, message),
      onProgress: (ev) => emit('request.progress', ev),
      persistHistory: (entry: { request: ApiRequest; response?: import('../shared/types').ApiResponse; error?: string }) => {
        const hist: HistoryEntry = {
          id: uid(), workspaceId,
          requestId: entry.request.id,
          name: entry.request.name, method: entry.request.method, url: entry.request.url,
          status: entry.response?.status, durationMs: entry.response?.timing.totalMs,
          timestamp: now(), request: entry.request, response: entry.response,
        };
        repos.addHistory(hist);
      },
      persistResponse: (wsId, response) => {
        if (!settings.runner.persistResponses) return;
        const clone = { ...response };
        const maxBytes = settings.data.maxResponseBodyBytes;
        if (clone.bodyText && clone.bodyText.length > maxBytes) {
          clone.bodyText = `${clone.bodyText.slice(0, maxBytes)}\n[truncated — max ${maxBytes} bytes]`;
        }
        repos.saveResponse(wsId, clone);
      },
      audit: (action: string, detail?: string, category?: string) => container.audit(action, detail, category, workspaceId),
      maxBodyBytes: Math.max(1024 * 1024, settings.data.maxResponseBodyBytes),
      dataRow: undefined,
    };
  }

  function makeFolderChain(): (folderId?: string) => Folder[] {
    return (folderId?: string) => {
      const chain: Folder[] = [];
      let cur = folderId ? repos.getFolder(folderId) : undefined;
      let guard = 100;
      while (cur && guard-- > 0) {
        chain.unshift(cur);
        cur = cur.parentFolderId ? repos.getFolder(cur.parentFolderId) : undefined;
      }
      return chain;
    };
  }

  function buildCookieHeader(workspaceId: string, url: string): string {
    const rows = repos.listCookies(workspaceId);
    let fullUrl = url;
    try { new URL(fullUrl); } catch { fullUrl = `https://${fullUrl.replace(/^\/+/, '')}`; }
    try {
      const jar = new CookieJar();
      for (const row of rows) {
        try {
          jar.setCookieSync(`${row.name}=${row.value}; Domain=${row.domain}; Path=${row.path}`, fullUrl);
        } catch { /* incompatible domain for this URL — skip */ }
      }
      return jar.getCookieStringSync(fullUrl);
    } catch { return ''; }
  }

  function loadTlsMaterial(workspaceId: string, certId?: string, host?: string): TlsMaterial | undefined {
    const certs = repos.listCertificates(workspaceId);
    let certRecord = certId ? certs.find((c) => c.id === certId) : undefined;
    if (!certRecord && host) certRecord = certs.find((c) => c.hosts.some((h) => hostMatches(h, host)));
    if (!certRecord) return undefined;
    const read = (p?: string) => {
      if (!p) return undefined;
      try { return readFileSync(p); } catch { return undefined; }
    };
    const passphrase = certRecord.passphraseSecretId ? vault.resolveByName(certRecord.passphraseSecretId) ?? container.getSetting(`secret:${certRecord.passphraseSecretId}`, undefined as string | undefined) : undefined;
    const material: TlsMaterial = {};
    const ca = read(certRecord.caPath); if (ca) material.ca = ca;
    const cert = read(certRecord.certPath); if (cert) material.cert = cert;
    const key = read(certRecord.keyPath); if (key) material.key = key;
    const pfxPath = certRecord.pfxPath;
    if (pfxPath) { try { material.pfx = readFileSync(pfxPath); } catch { /* ignore */ } }
    if (passphrase) material.passphrase = passphrase;
    if (!material.ca && !material.cert && !material.key && !material.pfx) return undefined;
    return material;
  }

  function hostMatches(pattern: string, host: string): boolean {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2);
    return pattern === host;
  }

  function resolveProxyFor(workspaceId: string, request: ApiRequest): ProxyConfig | null {
    const ref = request.settings.proxy;
    if (ref?.mode === 'none') return null;
    let host = '';
    try { host = new URL(request.url.includes('://') ? request.url : `https://${request.url}`).hostname; } catch { return null; }
    if (ref?.mode === 'custom' && ref.customUrl) return { url: ref.customUrl };
    let profile: ReturnType<Repos['listProxies']>[number] | undefined;
    if (ref?.mode === 'profile' && ref.profileId) {
      profile = repos.listProxies(workspaceId).find((p) => p.id === ref.profileId);
    } else {
      // default: first profile in workspace
      profile = repos.listProxies(workspaceId)[0];
    }
    if (profile && profile.type !== 'system' && profile.type !== 'none' && profile.host) {
      if (matchesBypass(profile.noProxy ?? [], host)) return null;
      return { url: buildProxyUrl(profile), noProxy: profile.noProxy };
    }
    if (settings.network.proxyMode === 'custom' && settings.network.proxyUrl) {
      if (matchesBypass(settings.network.noProxy ?? [], host)) return null;
      return { url: settings.network.proxyUrl, noProxy: settings.network.noProxy };
    }
    if (settings.network.proxyMode === 'system') {
      const envUrl = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? process.env.https_proxy ?? process.env.http_proxy;
      if (envUrl && !matchesBypass(settings.network.noProxy ?? [], host)) return { url: envUrl, noProxy: settings.network.noProxy };
    }
    return null;
  }

  function buildProxyUrl(profile: ReturnType<Repos['listProxies']>[number]): string {
    const scheme = profile.type === 'socks5' ? 'socks5h' : profile.type === 'socks4' ? 'socks4' : profile.type;
    const password = profile.passwordSecretId ? (vault.resolveByName(profile.passwordSecretId) ?? container.getSetting(`secret:${profile.passwordSecretId}`, '') ?? '') : '';
    const auth = profile.username ? `${encodeURIComponent(profile.username)}${password ? `:${encodeURIComponent(password)}` : ''}@` : '';
    return `${scheme}://${auth}${profile.host}:${profile.port}`;
  }

  function matchesBypass(bypass: string[], host: string): boolean {
    for (const b of bypass) {
      const rule = b.trim();
      if (!rule) continue;
      if (rule === '*') return true;
      if (rule.startsWith('.') && host.endsWith(rule)) return true;
      if (rule.startsWith('*') && host.endsWith(rule.slice(1))) return true;
      if (rule === host) return true;
    }
    return false;
  }

  return container;
}

function inferCategory(action: string): string {
  if (action.startsWith('vault.')) return 'secret';
  if (action.startsWith('script.') || action.startsWith('flow.')) return 'script';
  if (action.startsWith('import.') || action.startsWith('export.')) return 'import';
  if (action.startsWith('mcp.')) return 'mcp';
  if (action.startsWith('git.')) return 'git';
  if (action.startsWith('security.')) return 'security';
  if (action.startsWith('settings.')) return 'settings';
  if (action.startsWith('run.') || action.startsWith('perf.') || action.startsWith('monitor.')) return 'run';
  if (action.startsWith('backup.')) return 'backup';
  if (action.startsWith('oauth.') || action.startsWith('auth.')) return 'auth';
  return 'project';
}


function mergeDeepRecords(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const merge = (target: Record<string, unknown>, src: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] !== null && !Array.isArray(target[k])) {
        merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
      } else if (v !== undefined) {
        target[k] = v;
      }
    }
  };
  merge(out, patch);
  return out;
}
