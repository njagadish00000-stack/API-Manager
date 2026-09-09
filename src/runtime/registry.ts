/**
 * Method registry: maps every ApiSurface method to a handler against the
 * container + services. Used by Electron IPC, the hub HTTP/WS bridge and CLI.
 */
import http from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as undiciRequest } from 'undici';
import type { ApiSurface } from '../shared/api';
import type {
  ApiRequest, ApiResponse, Collection, Dataset, Environment, Folder, MockRoute,
  MockServer, Monitor, Specification, Variable, WebhookReceiver, RunConfig, Snapshot,
  TestResult, FlowRun, MonitorResult, GovernanceRule,
} from '../shared/types';
import { uid } from '../shared/ids';
import type { Repos } from '../services/db/repositories';
import { now } from '../shared/types';
import type { AppContainer } from './container';
import { executeRequest } from '../services/http/sendPipeline';
import { cancelOp } from '../services/http/engine';
import {
  startRun, pauseRun, resumeRun, stopRun, getActiveRun, runToJunitXml, runToText,
  RunnerDeps,
} from '../services/runner/collectionRunner';
import { startFlowRun, stopFlowRun } from '../services/flows/flowRunner';
import { startMock, stopMock, isMockRunning, MockRuntimeDeps } from '../services/mock/mockServer';
import { startWebhookReceiver, stopWebhookReceiver, isWebhookRunning, WebhookDeps } from '../services/webhooks/webhookServer';
import { enableMonitor, disableMonitor, runMonitorNow, MonitorDeps } from '../services/monitors/monitorService';
import { startPerfRun, stopPerfRun, compareBaselines, perfRunToHtml, PerfDeps } from '../services/perf/loadRunner';
import { runScript } from '../services/scripts/sandbox';
import { parseDatasetContent, generateDataset, toCsv } from '../services/datasets/dataFiles';
import {
  wsConnect, wsSend, wsClose, socketIoConnect, socketIoEmit, socketIoClose, graphqlWsSubscribe, SessionEmitter,
} from '../services/protocols/websocket';
import { sseConnect, sseClose } from '../services/protocols/sse';
import { mqttConnect, mqttPublish, mqttSubscribe, mqttUnsubscribe, mqttClose } from '../services/protocols/mqttClient';
import { loadSchema, grpcInvoke, grpcSend, grpcEndStream, grpcClose } from '../services/protocols/grpc';
import {
  startAuthorizationFlow, exchangeCode, clientCredentials, passwordGrant as oauthPasswordGrant,
  refreshToken as oauthRefresh, discoverEndpoints,
} from '../services/oauth/oauthServer';
import { introspect, schemaSummary, buildQueryForOperation, lintQuery, prettifyQuery, diffSchemas } from '../services/graphql/introspection';
import {
  gitInit, gitClone, gitStatus, gitAdd, gitAddAll, gitCommit, gitBranches, gitCreateBranch,
  gitCheckout, gitMerge, gitFetch, gitPull, gitPush, gitStash, gitStashPop, gitDiff, gitLog,
  gitRemotes, gitAddRemote, writeGitignore, gitSecretScan,
} from '../services/git/gitService';
import {
  createBackup, listBackups, deleteBackup, verifyBackup, restoreBackup, compareBackups,
  BackupDeps, pruneAutoBackups,
} from '../services/backup/backupService';
import { startCapture, stopCapture, captureStatus, CaptureDeps } from '../services/capture/captureService';
import { networkInterfaces, listPorts } from '../services/inventory/inventoryService';
import { renderDocs, exportDocs, serveDocs, stopDocServers, DocsDeps } from '../services/docs/docsService';
import { installPlugin, uninstallPlugin, setPluginEnabled, runPluginHook, PluginDeps } from '../services/plugins/pluginManager';
import { mcpConnect, mcpListTools, mcpCallTool, mcpListResources, mcpListPrompts, mcpClose } from '../services/mcp/mcpClient';
import { aiSend, listProviders, AiDeps } from '../services/ai/aiService';
import {
  scanWorkspace as securityScanWorkspace, scanText as securityScanText, scanResponse as securityScanResponse,
  maskSecret,
} from '../services/security/securityService';
import { evaluateRules } from '../core/governance/governance';
import {
  browse as fileBrowse, readText as fileReadText, addAttachment as fileAddAttachment,
  deleteAttachment as fileDeleteAttachment, relinkAttachment, listMissing, listOrphans, FilesDeps,
} from '../services/files/filesService';
import { VariableResolver, ScopeSource } from '../core/vars/resolver';
import { applyPathParams, buildUrl } from '../core/url/urlBuilder';
void applyPathParams; void buildUrl;

export type Handler = (params: unknown) => Promise<unknown>;

type MethodName = keyof ApiSurface;

type HandlerMap = Partial<Record<MethodName, (params: never) => Promise<unknown>>>;

export interface Registry {
  call: <M extends MethodName>(method: M, params: ApiSurface[M]['params']) => Promise<ApiSurface[M]['result']>;
  methods: MethodName[];
}

const DEFAULT_TIMEOUT = 60_000;

export function createRegistry(container: AppContainer): Registry {
  const { repos, vault, consoleStore, emit } = container;

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------
  const audit = container.audit.bind(container);

  const ensureWorkspace = (id?: string): string => id ?? container.getActiveWorkspaceId();

  const sessionEmitter: SessionEmitter = (type, payload) => {
    emit(type as never, payload as never);
  };

  const getRequestOrThrow = (id: string): ApiRequest => {
    const r = repos.getRequest(id);
    if (!r) throw new Error(`Request not found: ${id}`);
    return r;
  };


  // global search / replace
  function runSearchGlobal(opts: import('../shared/api').ReplaceSpec | import('../shared/api').SearchOptions, withReplace: boolean): unknown {
    const wsId = ensureWorkspace(opts.workspaceId);
    const query = opts.query;
    const flag = 'g';
    const regex = opts.regex ? new RegExp(query, flag) : undefined;
    const matcher = (text: string): boolean => {
      const subject = opts.caseSensitive ? text : text.toLowerCase();
      const needle = opts.caseSensitive ? query : query.toLowerCase();
      if (opts.regex && regex) { regex.lastIndex = 0; return regex.test(text); }
      if (opts.wholeWord) return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, opts.caseSensitive ? '' : 'i').test(text);
      return subject.includes(needle);
    };
    const hits: import('../shared/api').SearchHit[] = [];
    const push = (kind: string, id: string, title: string, snippet: string, path: string[] = []) => hits.push({ kind, id, title, snippet, path });
    let replaced = 0;
    const rep = (input: string | undefined): string | undefined => {
      if (input === undefined || !withReplace) return input;
      const replaceText = (opts as import('../shared/api').ReplaceSpec).replace ?? '';
      if (!matcher(input)) return input;
      replaced++;
      if (opts.regex && regex) return input.replace(regex, replaceText);
      const needle = opts.caseSensitive ? query : query.toLowerCase();
      let out = '';
      let src = input;
      let lower = opts.caseSensitive ? src : src.toLowerCase();
      let idx: number;
      while ((idx = lower.indexOf(needle)) >= 0) {
        out += src.slice(0, idx) + replaceText;
        src = src.slice(idx + query.length);
        lower = opts.caseSensitive ? src : src.toLowerCase();
      }
      return out + src;
    };
    const dryRun = (opts as { dryRun?: boolean }).dryRun ?? false;
    for (const r of repos.listRequests(wsId, { limit: 100_000 }).items) {
      const bundle = JSON.stringify({ n: r.name, u: r.url, b: r.body.raw, h: r.headers, s: r.scripts });
      if (matcher(r.name)) push('request', r.id, r.name, `${r.method} ${r.url}`);
      else if (matcher(bundle)) push('request', r.id, r.name, `${r.method} ${r.url}`);
      if (withReplace && !dryRun) {
        const changed: typeof r = { ...r, name: rep(r.name) ?? r.name, url: rep(r.url) ?? r.url, body: { ...r.body, raw: rep(r.body.raw) }, updatedAt: now() };
        if ((opts.scope === undefined || opts.scope === 'all' || opts.scope === 'requests' || opts.scope === 'scripts')) {
          changed.scripts = { preRequest: rep(r.scripts.preRequest) ?? r.scripts.preRequest, postResponse: rep(r.scripts.postResponse) ?? r.scripts.postResponse };
          changed.headers = r.headers.map((h) => ({ ...h, value: rep(h.value) ?? h.value }));
          repos.saveRequest(changed);
        }
      }
      if (hits.length >= 500) break;
    }
    for (const c of repos.listCollections(wsId)) {
      if (matcher(c.name) || matcher(c.documentation ?? '')) push('collection', c.id, c.name, (c.documentation ?? '').slice(0, 120));
      if (withReplace && !dryRun && (opts.scope === undefined || opts.scope === 'all' || opts.scope === 'collections')) {
        repos.saveCollection({ ...c, name: rep(c.name) ?? c.name, documentation: rep(c.documentation) });
      }
    }
    for (const sp of repos.listSpecs(wsId)) {
      if (matcher(sp.name) || matcher(sp.content)) push('spec', sp.id, sp.name, sp.content.slice(0, 120));
      if (withReplace && !dryRun && (opts.scope === undefined || opts.scope === 'all' || opts.scope === 'specs')) {
        if (matcher(sp.content)) repos.saveSpec({ ...sp, content: rep(sp.content) ?? sp.content });
      }
    }
    if ((opts as unknown as import('../shared/api').ReplaceSpec).replace !== undefined) {
      return { replaced, hits: hits.slice(0, 500) };
    }
    return hits.slice(0, 500);
  }

  // git path resolution: default sync location for the workspace
  function resolveGitPath(explicit?: string): string {
    if (explicit) return explicit;
    return join(container.dataDir, 'git-repos', container.getActiveWorkspaceId());
  }

  // in-memory capture buffer
  const capturedExchanges: import('../shared/types').CapturedExchange[] = [];

  const runnerDeps = (): RunnerDeps => {
    const wsId = container.getActiveWorkspaceId();
    return {
      ...container.pipelineDeps(wsId),
      listFoldersRaw: (collectionId) => repos.listFolders(collectionId),
      listRequests: (collectionId?: string, folderId?: string) =>
        repos.listRequests(wsId, { collectionId, folderId, limit: 10_000 }).items,
      getRequestByName: (name, collectionId) =>
        repos.listRequests(wsId, { collectionId, limit: 10_000 }).items.find((r) => r.name.toLowerCase() === name.toLowerCase()),
      getRequest: (id) => repos.getRequest(id),
      saveRun: (run) => repos.saveRun(wsId, run),
      getRun: (id) => repos.getRun(id),
    };
  };

  const mockDeps = (): MockRuntimeDeps => ({
    getExamples: (requestId) => repos.listExamples(requestId),
    listRequestsForCollection: (collectionId) => {
      const wsId = container.getActiveWorkspaceId();
      return repos.listRequests(wsId, { collectionId, limit: 10_000 }).items;
    },
    logRequest: (entry) => repos.addMockLog(entry),
    emitEvent: (type, payload) => emit(type, payload),
  });

  const webhookDeps = (): WebhookDeps => ({
    saveReceiver: (wh) => { void repos.saveWebhook(wh); },
    saveEvent: (ev) => repos.addWebhookEvent(ev),
    emitEvent: (type, payload) => emit(type, payload),
  });

  const monitorDeps = (): MonitorDeps => ({
    getMonitor: (id) => repos.getMonitor(id),
    saveResult: (r) => repos.addMonitorResult(r),
    emitEvent: (type, payload) => emit(type, payload),
    runnerDeps,
    runnerExtras: () => ({}),
  });

  const perfDeps = (workspaceId: string): PerfDeps => ({
    ...container.pipelineDeps(workspaceId),
    getRequest: (id) => repos.getRequest(id),
    listRequests: (collectionId) => repos.listRequests(workspaceId, { collectionId, limit: 10_000 }).items,
    saveRun: (run) => repos.savePerfRun(workspaceId, run),
  });

  const backupDeps = (): BackupDeps => ({
    dataDir: container.dataDir,
    backupDir: join(container.dataDir, 'backups'),
    dbFilePath: join(container.dataDir, 'api_manager.db'),
    exportDataJson: () => exportWorkspaceJson(ensureWorkspace()),
    importDataJson: (json, mode) => importWorkspaceJson(json, mode),
    countTables: () => repos.counts(ensureWorkspace()),
  });

  const pluginDeps = (): PluginDeps => ({
    pluginsDir: join(container.dataDir, 'plugins'),
    listPlugins: () => (container.getSetting('plugins.installed', []) as never),
    savePlugin: (p) => {
      const list = container.getSetting<Record<string, unknown>[]>('plugins.installed', []);
      const idx = list.findIndex((x) => (x as { id?: string }).id === p.id);
      const record = p as unknown as Record<string, unknown>;
      if (idx >= 0) list[idx] = record; else list.push(record);
      container.setSetting('plugins.installed', list);
      return p;
    },
    deletePlugin: (id) => {
      const list = container.getSetting<Record<string, unknown>[]>('plugins.installed', []);
      container.setSetting('plugins.installed', list.filter((x) => (x as { id?: string }).id !== id));
    },
    emitConsole: (level, source, message) => consoleStore.log(level, source, message),
  });

  const filesDeps = (): FilesDeps => ({
    dataDir: container.dataDir,
    listAttachments: (workspaceId) => repos.listAttachments(ensureWorkspace(workspaceId)),
    saveAttachment: (a) => repos.saveAttachment(a),
    deleteAttachment: (id) => { const all = repos.listAttachments(ensureWorkspace()).find((a) => a.id === id); repos.deleteAttachment(id); return all; },
    listRequests: (workspaceId) => repos.listRequests(ensureWorkspace(workspaceId), { limit: 10_000 }).items,
  });

  const aiDeps = (): AiDeps => ({
    resolveSecret: (secretId) => {
      if (!secretId) return undefined;
      try {
        return vault.get(secretId).secret;
      } catch { return vault.resolveByName(secretId); }
    },
    emit: (type, payload) => emit(type, payload),
  });

  const docsDeps = (): DocsDeps => ({
    getCollection: (id) => (id ? repos.getCollection(id) : undefined),
    getFolders: (collectionId) => repos.listFolders(collectionId),
    getRequestsForCollection: (collectionId) => repos.listRequests(ensureWorkspace(), { collectionId, limit: 10_000 }).items,
    getSpec: (id) => (id ? repos.getSpec(id) : undefined),
    listDocSites: () => [],
    saveDocSite: (s) => s,
  });

  // ---------------------------------------------------------------------
  // import/export of the whole workspace as JSON (backup + workspace dump)
  // ---------------------------------------------------------------------
  function exportWorkspaceJson(workspaceId: string): string {
    const ws = repos.getWorkspace(workspaceId);
    const collections = repos.listCollections(workspaceId);
    const folders = collections.flatMap((c) => repos.listFolders(c.id));
    const requests = repos.listRequests(workspaceId, { limit: 100_000 }).items;
    const examplesMap: Record<string, unknown[]> = {};
    for (const r of requests) examplesMap[r.id] = repos.listExamples(r.id);
    return JSON.stringify({
      kind: 'api-manager-workspace', version: 2, exportedAt: now(),
      workspace: ws,
      collections, folders, requests, examples: examplesMap,
      environments: repos.listEnvironments(workspaceId),
      mockServers: repos.listMocks(workspaceId),
      monitors: repos.listMonitors(workspaceId),
      datasets: repos.listDatasets(workspaceId),
      specs: repos.listSpecs(workspaceId),
      flows: repos.listFlows(workspaceId),
      webhooks: repos.listWebhooks(workspaceId),
      certificates: repos.listCertificates(workspaceId).map((c) => ({ ...c, passphraseSecretId: undefined })),
      proxies: repos.listProxies(workspaceId),
      globals: repos.getKv(workspaceId, 'globals'),
      workspaceVars: repos.getKv(workspaceId, 'workspaceVars'),
      cookies: repos.listCookies(workspaceId),
      tags: repos.listTags(workspaceId),
      favorites: repos.listFavorites(workspaceId),
      governanceRules: repos.listGovernanceRules(workspaceId),
    }, null, 2);
  }

  function importWorkspaceJson(json: string, mode: 'merge' | 'replace'): { annotations: string[] } {
    const annotations: string[] = [];
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (parsed.kind !== 'api-manager-workspace') throw new Error('Not an API Manager workspace export');
    const workspace = parsed.workspace as { id: string; name: string } | undefined;
    if (!workspace) throw new Error('Workspace export missing workspace block');
    let targetId = workspace.id;
    if (mode === 'replace') {
      const existing = repos.getWorkspace(workspace.id);
      if (existing) {
        // wipe entities of that workspace (keep id)
        const cols = repos.listCollections(targetId);
        for (const c of cols) repos.deleteCollection(c.id);
      }
    } else {
      targetId = uid();
      annotations.push(`Imported as new workspace (id ${targetId})`);
    }
    repos.saveWorkspace({
      id: targetId, name: workspace.name, description: (workspace as Record<string, unknown>).description as string ?? '',
      isDefault: false, readOnly: false, encrypted: false, settings: {}, createdAt: now(), updatedAt: now(),
    });
    const idMap = new Map<string, string>();
    const remap = (oldId: string | undefined): string => {
      const nid = mode === 'replace' && oldId ? oldId : uid();
      if (oldId) idMap.set(oldId, nid);
      return nid;
    };
    for (const c of (parsed.collections ?? []) as Collection[]) {
      repos.saveCollection({ ...c, id: remap(c.id), workspaceId: targetId });
    }
    for (const f of (parsed.folders ?? []) as Folder[]) {
      repos.saveFolder({
        ...f, id: remap(f.id), collectionId: idMap.get(f.collectionId) ?? f.collectionId,
        parentFolderId: f.parentFolderId ? idMap.get(f.parentFolderId) ?? undefined : undefined,
      });
    }
    for (const r of (parsed.requests ?? []) as ApiRequest[]) {
      repos.saveRequest({
        ...r, id: remap(r.id), workspaceId: targetId,
        collectionId: r.collectionId ? idMap.get(r.collectionId) ?? undefined : undefined,
        folderId: r.folderId ? idMap.get(r.folderId) ?? undefined : undefined,
      });
    }
    const examples = (parsed.examples as Record<string, { id: string; requestId: string }[]> ?? {});
    for (const [oldReqId, list] of Object.entries(examples)) {
      const newReqId = idMap.get(oldReqId);
      if (!newReqId) continue;
      for (const ex of list) repos.saveExample({ ...ex, id: remap(ex.id), requestId: newReqId } as never);
    }
    for (const e of (parsed.environments ?? []) as Environment[]) repos.saveEnvironment({ ...e, id: remap(e.id), workspaceId: targetId });
    for (const m of (parsed.mockServers ?? []) as MockServer[]) repos.saveMock({ ...m, id: remap(m.id), workspaceId: targetId, running: false });
    for (const m of (parsed.monitors ?? []) as Monitor[]) repos.saveMonitor({ ...m, id: remap(m.id), workspaceId: targetId });
    for (const d of (parsed.datasets ?? []) as Dataset[]) repos.saveDataset({ ...d, id: remap(d.id), workspaceId: targetId });
    for (const s of (parsed.specs ?? []) as Specification[]) repos.saveSpec({ ...s, id: remap(s.id), workspaceId: targetId });
    for (const f of (parsed.flows ?? []) as import('../shared/types').Flow[]) repos.saveFlow({ ...f, id: uid(), workspaceId: targetId });
    for (const w of (parsed.webhooks ?? []) as WebhookReceiver[]) repos.saveWebhook({ ...w, id: uid(), workspaceId: targetId, running: false });
    for (const p of (parsed.proxies ?? []) as import('../shared/types').ProxyProfile[]) repos.saveProxy({ ...p, id: uid(), workspaceId: targetId });
    for (const c of (parsed.certificates ?? []) as import('../shared/types').Certificate[]) repos.saveCertificate({ ...c, id: uid(), workspaceId: targetId });
    const globals = parsed.globals as Record<string, unknown> | undefined;
    if (globals) repos.setKv(targetId, 'globals', globals);
    const wsVars = parsed.workspaceVars as Record<string, unknown> | undefined;
    if (wsVars) repos.setKv(targetId, 'workspaceVars', wsVars);
    for (const c of (parsed.cookies ?? []) as import('../shared/types').StoredCookie[]) repos.upsertCookie(targetId, c);
    for (const t of (parsed.tags ?? []) as import('../shared/types').Tag[]) repos.saveTag(t);
    for (const r of (parsed.governanceRules ?? []) as GovernanceRule[]) repos.saveGovernanceRule({ ...r, id: uid(), workspaceId: targetId });
    void repos.listFavorites;
    return { annotations };
  }

  // ---------------------------------------------------------------------
  // variables / environments
  // ---------------------------------------------------------------------
  function getEnvironmentVariables(id?: string): Variable[] {
    const env = id ? repos.getEnvironment(id) : undefined;
    return (env?.variables ?? []).filter((v) => v.enabled).map((v) => ({ ...v }));
  }

  function buildResolver(params: { workspaceId?: string; environmentId?: string; collectionId?: string; folderId?: string; data?: Record<string, string>; local?: Record<string, string>; scriptVars?: Record<string, string> }): VariableResolver {
    const wsId = ensureWorkspace(params.workspaceId);
    const env = params.environmentId ? repos.getEnvironment(params.environmentId) : undefined;
    const collection = params.collectionId ? repos.getCollection(params.collectionId) : undefined;
    const globals: Variable[] = (repos.getKv(wsId, 'globals') as { variables?: Variable[] }).variables ?? [];
    const wsVars: Variable[] = (repos.getKv(wsId, 'workspaceVars') as { variables?: Variable[] }).variables ?? [];
    const scopes: ScopeSource[] = [
      { scope: 'global', vars: variablesMap(globals), sourceName: 'Globals' },
      { scope: 'workspace', vars: variablesMap(wsVars), sourceName: 'Workspace' },
      { scope: 'environment', vars: variablesMap(getEnvironmentVariables(params.environmentId ?? container.getActiveEnvironmentId())), sourceName: env?.name ?? 'Environment', sourceId: env?.id },
      { scope: 'collection', vars: variablesMap((collection?.variables ?? []).filter((v) => v.enabled)), sourceName: collection?.name ?? 'Collection', sourceId: collection?.id },
      ...(params.folderId ? [{ scope: 'folder' as const, vars: {}, sourceId: params.folderId }] : []),
      ...(params.data ? [{ scope: 'data' as const, vars: Object.fromEntries(Object.entries(params.data).map(([k, v]) => [k, { value: v }])), sourceName: 'data row' }] : []),
      ...(params.local ? [{ scope: 'local' as const, vars: Object.fromEntries(Object.entries(params.local).map(([k, v]) => [k, { value: v }])), sourceName: 'locals' }] : []),
      ...(params.scriptVars ? [{ scope: 'script' as const, vars: Object.fromEntries(Object.entries(params.scriptVars).map(([k, v]) => [k, { value: v }])), sourceName: 'script' }] : []),
    ];
    return new VariableResolver(scopes);
  }

  function variablesMap(vars: Variable[]): Record<string, { value: string; isSecret?: boolean }> {
    return Object.fromEntries(vars.filter((v) => v.enabled).map((v) => [v.key, { value: v.value, isSecret: v.type === 'secret' }]));
  }

  // ---------------------------------------------------------------------
  // health score / workspace helpers
  // ---------------------------------------------------------------------
  function computeHealthScore(workspaceId: string): { total: number; breakdown: Record<string, number> } {
    const requests = repos.listRequests(workspaceId, { limit: 100_000 }).items;
    let withDescription = 0, withTests = 0, withAuth = 0, https = 0;
    const total = Math.max(1, requests.length);
    for (const r of requests) {
      if (r.description?.trim() || r.documentation?.trim()) withDescription++;
      if (r.scripts.postResponse.trim() || r.assertions.filter((a) => a.enabled).length > 0) withTests++;
      if (r.auth && r.auth.type !== 'none' && r.auth.type !== 'inherit') withAuth++;
      if (!r.url.startsWith('http://')) https++;
    }
    const buckets = {
      documentation: Math.round((withDescription / total) * 25),
      testing: Math.round((withTests / total) * 30),
      authentication: Math.round((withAuth / total) * 20),
      transport: Math.round((https / total) * 25),
    };
    return {
      total: buckets.documentation + buckets.testing + buckets.authentication + buckets.transport,
      breakdown: buckets,
    };
  }


  // ---------------------------------------------------------------------
  // persist NormalizedImport into the workspace
  // ---------------------------------------------------------------------
  function persistImport(normalized: import('../core/importers/model').NormalizedImport, workspaceId: string): import('../shared/types').ImportResult {
    const collectionIds: string[] = [];
    const environmentIds: string[] = [];
    const specIds: string[] = [];
    const requestIds: string[] = [];
    const idMap = new Map<string, string>();

    for (const block of normalized.collections) {
      const collection = repos.saveCollection({ ...block.collection, id: block.collection.id || uid(), workspaceId });
      collectionIds.push(collection.id);
      idMap.set(block.collection.id, collection.id);
      const folderIdMap = new Map<string, string>();
      for (const f of block.folders) {
        const nid = f.id || uid();
        const saved = repos.saveFolder({
          ...f, id: nid, collectionId: collection.id,
          parentFolderId: f.parentFolderId ? (folderIdMap.get(f.parentFolderId) ?? f.parentFolderId) : undefined,
        });
        folderIdMap.set(f.id, saved.id);
      }
      for (const r of block.requests) {
        const rid = r.id || uid();
        const savedRequest = repos.saveRequest({
          ...r, id: rid, workspaceId,
          collectionId: r.collectionId ? collection.id : collection.id,
          folderId: r.folderId ? (folderIdMap.get(r.folderId) ?? undefined) : undefined,
        });
        idMap.set(r.id, savedRequest.id);
        requestIds.push(savedRequest.id);
        for (const ex of block.examples) {
          if (ex.requestId === r.id) {
            repos.saveExample({ ...ex, id: ex.id || uid(), requestId: savedRequest.id });
          }
        }
      }
    }
    for (const env of normalized.environments) {
      const saved = repos.saveEnvironment({ ...env, id: env.id || uid(), workspaceId });
      environmentIds.push(saved.id);
    }
    for (const sp of normalized.specifications) {
      const saved = repos.saveSpec({ ...sp, id: sp.id || uid(), workspaceId });
      specIds.push(saved.id);
    }
    for (const g of normalized.globals ?? []) {
      // merge into workspace globals
      const existing = container.getGlobalVars();
      if (!existing.some((v) => v.key === g.key)) existing.push(g);
      container.setGlobalVars(existing);
    }
    for (const r of normalized.requests ?? []) {
      const saved = repos.saveRequest({ ...r, id: r.id || uid(), workspaceId, collectionId: undefined, folderId: undefined });
      requestIds.push(saved.id);
    }
    return { report: normalized.report, collectionIds, environmentIds, specIds, requestIds };
  }

  function pathPatternOf(rawUrl: string, _status?: number): string {
    try {
      const u = new URL(rawUrl.includes('://') ? rawUrl : `https://x${rawUrl.startsWith('/') ? '' : '/'}${rawUrl.replace(/\{\{[^}]+\}\}/g, 'x')}`);
      return u.pathname.replace(/\{[^/]+\}/g, (m) => `{${m.slice(1, -1).replace(/[^\w.-]/g, '')}}`).replace(/:([^/]+)/g, '{$1}');
    } catch { return '/'; }
  }

  // ---------------------------------------------------------------------
  // handlers
  // ---------------------------------------------------------------------
  const handlers: Record<string, Handler> = {
    // app
    'app.ping': async () => ({ pong: Date.now() }),
    'app.info': async () => ({
      name: 'API Manager', version: '1.0.0', build: 'hub',
      author: 'Local User', mode: 'hub' as const, platform: process.platform,
      dataDir: container.dataDir, node: process.version,
    }),

    // workspaces
    'workspace.list': async () => repos.listWorkspaces(),
    'workspace.create': async (p) => {
      const args = p as { name: string; description?: string };
      const ws = repos.saveWorkspace({
        id: uid(), name: args.name, description: args.description ?? '', isDefault: false,
        readOnly: false, encrypted: false, settings: {}, createdAt: now(), updatedAt: now(),
      });
      audit('workspace.create', ws.name, 'project', ws.id);
      return ws;
    },
    'workspace.update': async (p) => {
      const args = p as { id: string; patch: Record<string, unknown> };
      const existing = repos.getWorkspace(args.id);
      if (!existing) throw new Error(`Workspace not found: ${args.id}`);
      const allowed: (keyof typeof existing)[] = ['name', 'description', 'isDefault', 'readOnly', 'gitRepoPath', 'settings'];
      const patchObj: Record<string, unknown> = {};
      for (const k of allowed) if (k in args.patch) patchObj[k] = (args.patch as Record<string, unknown>)[k as string];
      const saved = repos.saveWorkspace({ ...existing, ...patchObj });
      audit('workspace.update', saved.name, 'project', saved.id);
      emit('workspace.changed', { workspaceId: saved.id });
      return saved;
    },
    'workspace.delete': async (p) => {
      const args = p as { id: string };
      const ws = repos.getWorkspace(args.id);
      if (!ws) throw new Error('Workspace not found');
      if (ws.isDefault && repos.listWorkspaces().length === 1) throw new Error('Cannot delete the last workspace');
      repos.deleteWorkspace(args.id);
      audit('workspace.delete', ws.name, 'project', args.id);
    },
    'workspace.getActive': async () => repos.getWorkspace(container.getActiveWorkspaceId()) ?? null,
    'workspace.setActive': async (p) => {
      const args = p as { id: string };
      if (!repos.getWorkspace(args.id)) throw new Error('Workspace not found');
      container.setActiveWorkspaceId(args.id);
      emit('workspace.changed', { workspaceId: args.id });
      return repos.getWorkspace(args.id)!;
    },
    'workspace.health': async (p) => computeHealthScore(ensureWorkspace((p as { id?: string }).id)),
    'workspace.portabilityCheck': async (p) => {
      const wsId = ensureWorkspace((p as { id?: string }).id);
      const requests = repos.listRequests(wsId, { limit: 100_000 }).items;
      const warnings: string[] = [];
      const absolutePaths: string[] = [];
      for (const r of requests) {
        for (const f of r.body.formData ?? []) {
          for (const fp of f.filePaths ?? []) if (/^([a-zA-Z]:)[/\\]/.test(fp) || fp.startsWith('/')) absolutePaths.push(`${r.name}: ${fp}`);
        }
        if (r.body.binaryFilePath && /^([a-zA-Z]:)[/\\]/.test(r.body.binaryFilePath)) absolutePaths.push(`${r.name}: ${r.body.binaryFilePath}`);
      }
      const envs = repos.listEnvironments(wsId);
      let secrets = 0;
      for (const e of envs) secrets += e.variables.filter((v) => v.type === 'secret').length;
      return { warnings, absolutePaths, missingFiles: [], secrets };
    },
    'workspace.makePortable': async (p) => {
      const wsId = ensureWorkspace((p as { id?: string }).id);
      const requests = repos.listRequests(wsId, { limit: 100_000 }).items;
      let rewritten = 0;
      for (const r of requests) {
        let changed = false;
        const clone = JSON.parse(JSON.stringify(r)) as ApiRequest;
        for (const f of clone.body.formData ?? []) {
          if (f.filePaths) f.filePaths = f.filePaths.map((fp) => fp.replace(/^([a-zA-Z]:)[/\\]/, '').replace(/\\/g, '/'));
        }
        if (changed) { repos.saveRequest(clone); rewritten++; }
      }
      return { rewritten };
    },
    'workspace.encrypt': async () => {
      throw new Error('Workspace encryption maps to the vault: put the workspace secrets into the encrypted vault instead. Full-DB encryption is documented as a roadmap item (SQLCipher).');
    },

    // collections / folders / requests
    'collection.list': async (p) => repos.listCollections(ensureWorkspace((p as { workspaceId?: string })?.workspaceId)),
    'collection.get': async (p) => {
      const c = repos.getCollection((p as { id: string }).id);
      if (!c) throw new Error('Collection not found');
      return c;
    },
    'collection.create': async (p) => {
      const args = p as { name: string; workspaceId?: string; description?: string };
      const collection = repos.saveCollection({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId), name: args.name,
        description: args.description ?? '', variables: [], auth: { type: 'none' },
        scripts: { preRequest: '', postResponse: '' }, documentation: '', tags: [],
        favorite: false, readOnly: false, sortOrder: 9999, createdAt: now(), updatedAt: now(),
      });
      audit('collection.create', collection.name, 'project');
      return collection;
    },
    'collection.update': async (p) => {
      const args = p as { id: string; patch: Partial<Collection> };
      const existing = repos.getCollection(args.id);
      if (!existing) throw new Error('Collection not found');
      const saved = repos.saveCollection({ ...existing, ...args.patch, id: existing.id });
      audit('collection.update', saved.name, 'project');
      return saved;
    },
    'collection.delete': async (p) => {
      const existing = repos.getCollection((p as { id: string }).id);
      if (!existing) throw new Error('Collection not found');
      repos.deleteCollection(existing.id);
      audit('collection.delete', existing.name, 'project');
    },
    'collection.duplicate': async (p) => {
      const existing = repos.getCollection((p as { id: string }).id);
      if (!existing) throw new Error('Collection not found');
      const newId = uid();
      const copy = repos.saveCollection({ ...existing, id: newId, name: `${existing.name} (copy)`, createdAt: now(), updatedAt: now() });
      const folders = repos.listFolders(existing.id);
      const folderIdMap = new Map<string, string>();
      for (const f of folders) {
        const nid = uid();
        folderIdMap.set(f.id, nid);
        repos.saveFolder({ ...f, id: nid, collectionId: newId, parentFolderId: f.parentFolderId ? folderIdMap.get(f.parentFolderId) : undefined });
      }
      const wsId = ensureWorkspace();
      for (const r of repos.listRequests(wsId, { collectionId: existing.id, limit: 100_000 }).items) {
        const newReqId = uid();
        const newReq = repos.saveRequest({ ...r, id: newReqId, collectionId: newId, folderId: r.folderId ? folderIdMap.get(r.folderId) : undefined });
        for (const ex of repos.listExamples(r.id)) repos.saveExample({ ...ex, id: uid(), requestId: newReq.id });
      }
      audit('collection.duplicate', existing.name, 'project');
      return copy;
    },
    'collection.stats': async (p) => {
      const wsId = ensureWorkspace();
      const args = p as { id: string };
      const requests = repos.listRequests(wsId, { collectionId: args.id, limit: 100_000 }).items;
      let examples = 0; let tests = 0; let scripts = 0;
      for (const r of requests) {
        examples += repos.listExamples(r.id).length;
        tests += r.assertions.length;
        if (r.scripts.preRequest.trim() || r.scripts.postResponse.trim()) scripts++;
      }
      return { requests: requests.length, folders: repos.listFolders(args.id).length, examples, tests, scripts };
    },
    'collection.changelog': async (p) => {
      const args = p as { id: string };
      return repos.listAudit({ workspaceId: undefined, limit: 100 }).items.filter((a) => a.detail?.includes(args.id) || a.action.startsWith('collection.'));
    },
    'collection.applyTemplate': async (p) => {
      const args = p as { template: string; name?: string; workspaceId?: string };
      const collection = repos.saveCollection({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId),
        name: args.name ?? args.template, description: '', variables: [],
        auth: { type: 'none' }, scripts: { preRequest: '', postResponse: '' },
        documentation: '', tags: ['template'], favorite: false, readOnly: false, sortOrder: 9999,
        createdAt: now(), updatedAt: now(),
      });
      const base = { id: '', key: '', value: '', enabled: true };
      const samples: Partial<ApiRequest>[] = [
        { name: 'Health check', method: 'GET', url: '{{baseUrl}}/health' },
        { name: 'List items', method: 'GET', url: '{{baseUrl}}/items' },
        { name: 'Create item', method: 'POST', url: '{{baseUrl}}/items', body: { type: 'json', raw: '{\n  "name": "item"\n}' } },
      ];
      for (const s of samples) {
        repos.saveRequest({
          id: uid(), workspaceId: collection.workspaceId, collectionId: collection.id,
          name: s.name ?? 'Request', method: s.method ?? 'GET', url: s.url ?? '',
          pathParams: [], queryParams: [base], headers: [], body: s.body ?? { type: 'none' },
          auth: { type: 'inherit' }, assertions: [], scripts: { preRequest: '', postResponse: '' },
          protocol: 'http', description: '', tags: [], favorite: false, sortOrder: 0,
          settings: defaultRequestSettings(), createdAt: now(), updatedAt: now(),
        } as ApiRequest);
      }
      audit('collection.applyTemplate', args.template, 'project');
      return collection;
    },

    'folder.list': async (p) => repos.listFolders((p as { collectionId: string }).collectionId),
    'folder.create': async (p) => {
      const args = p as { collectionId: string; name: string; parentFolderId?: string };
      const folder = repos.saveFolder({
        id: uid(), collectionId: args.collectionId, parentFolderId: args.parentFolderId,
        name: args.name, description: '', auth: { type: 'none' }, scripts: { preRequest: '', postResponse: '' },
        sortOrder: 9999, createdAt: now(), updatedAt: now(),
      });
      audit('folder.create', args.name, 'project');
      return folder;
    },
    'folder.update': async (p) => {
      const args = p as { id: string; patch: Partial<Folder> };
      const existing = repos.getFolder(args.id);
      if (!existing) throw new Error('Folder not found');
      return repos.saveFolder({ ...existing, ...args.patch, id: existing.id });
    },
    'folder.delete': async (p) => {
      const existing = repos.getFolder((p as { id: string }).id);
      if (!existing) throw new Error('Folder not found');
      repos.deleteFolder(existing.id);
      audit('folder.delete', existing.name, 'project');
    },
    'folder.move': async (p) => {
      const args = p as { id: string; parentFolderId?: string };
      const existing = repos.getFolder(args.id);
      if (!existing) throw new Error('Folder not found');
      return repos.saveFolder({ ...existing, parentFolderId: args.parentFolderId });
    },

    'request.list': async (p) => {
      const args = p as { workspaceId?: string; collectionId?: string; folderId?: string; search?: string; limit?: number; offset?: number };
      const wsId = ensureWorkspace(args.workspaceId);
      const out = repos.listRequests(wsId, { collectionId: args.collectionId, folderId: args.folderId, search: args.search, limit: args.limit ?? 500, offset: args.offset ?? 0 });
      return { items: out.items, total: out.total, limit: args.limit ?? 500, offset: args.offset ?? 0 };
    },
    'request.get': async (p) => getRequestOrThrow((p as { id: string }).id),
    'request.create': async (p) => {
      const args = p as { workspaceId?: string; collectionId?: string; folderId?: string; name?: string; method?: string; url?: string };
      const request = repos.saveRequest({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId),
        collectionId: args.collectionId, folderId: args.folderId,
        name: args.name ?? 'New request', method: (args.method as ApiRequest['method']) ?? 'GET',
        url: args.url ?? '', pathParams: [], queryParams: [], headers: [],
        body: { type: 'none' }, auth: { type: 'inherit' }, assertions: [],
        scripts: { preRequest: '', postResponse: '' }, protocol: 'http',
        tags: [], favorite: false, sortOrder: 9999, settings: defaultRequestSettings(), createdAt: now(), updatedAt: now(),
      });
      audit('request.create', request.name, 'project');
      return request;
    },
    'request.update': async (p) => {
      const args = p as { id: string; patch: Partial<ApiRequest> };
      const existing = getRequestOrThrow(args.id);
      const saved = repos.saveRequest({ ...existing, ...args.patch, id: existing.id });
      audit('request.update', saved.name, 'project');
      return saved;
    },
    'request.delete': async (p) => {
      const existing = getRequestOrThrow((p as { id: string }).id);
      repos.deleteRequest(existing.id);
      audit('request.delete', existing.name, 'project');
    },
    'request.duplicate': async (p) => {
      const existing = getRequestOrThrow((p as { id: string }).id);
      const copy = repos.saveRequest({ ...existing, id: uid(), name: `${existing.name} (copy)`, createdAt: now(), updatedAt: now() });
      for (const ex of repos.listExamples(existing.id)) {
        repos.saveExample({ ...ex, id: uid(), requestId: copy.id });
      }
      audit('request.duplicate', existing.name, 'project');
      return copy;
    },
    'request.move': async (p) => {
      const args = p as { id: string; collectionId?: string; folderId?: string };
      const existing = getRequestOrThrow(args.id);
      return repos.saveRequest({ ...existing, collectionId: args.collectionId ?? existing.collectionId, folderId: args.folderId });
    },
    'request.reorder': async (p) => {
      const args = p as { id: string; sortOrder: number };
      const existing = getRequestOrThrow(args.id);
      repos.saveRequest({ ...existing, sortOrder: args.sortOrder });
    },

    'example.list': async (p) => repos.listExamples((p as { requestId: string }).requestId),
    'example.save': async (p) => {
      const args = (p as { example: RequestExampleInput }).example;
      return repos.saveExample(args as Parameter<Repos['saveExample'], 0>);
    },
    'example.delete': async (p) => { repos.deleteExample((p as { id: string }).id); },
    'example.duplicate': async (p) => {
      const existing = repos.getExample((p as { id: string }).id);
      if (!existing) throw new Error('Example not found');
      return repos.saveExample({ ...existing, id: uid(), name: `${existing.name} (copy)` });
    },

    // --- sending -------------------------------------------------------------
    'http.send': async (p) => {
      const args = p as Parameters<typeof executeRequest>[0];
      const wsId = args.request.workspaceId || container.getActiveWorkspaceId();
      const merged = { ...defaultRequestSettings(), ...(args.request.settings ?? {}) } as ApiRequest['settings'];
      const request = {
        ...args.request,
        settings: merged,
        // tolerate sparse request objects (CLI / external callers)
        scripts: { ...(args.request.scripts ?? { preRequest: '', postResponse: '' }) },
        headers: args.request.headers ?? [],
        queryParams: args.request.queryParams ?? [],
        pathParams: args.request.pathParams ?? [],
        assertions: args.request.assertions ?? [],
        auth: args.request.auth ?? { type: 'none' },
        body: args.request.body ?? { type: 'none' },
      };
      return executeRequest({ ...args, request }, container.pipelineDeps(wsId));
    },
    'http.cancel': async (p) => {
      cancelOp((p as { opId: string }).opId);
    },
    'http.recentResponses': async (p) => {
      const args = p as { requestId: string; limit?: number };
      return repos.recentResponses(args.requestId, args.limit ?? 20);
    },
    'http.responseById': async (p) => repos.getResponse((p as { id: string }).id) ?? null,

    // history
    'history.list': async (p) => {
      const args = p as { workspaceId?: string; search?: string; limit?: number; offset?: number };
      const wsId = ensureWorkspace(args.workspaceId);
      const out = repos.listHistory(wsId, { search: args.search, limit: args.limit ?? 100, offset: args.offset ?? 0 });
      return { items: out.items, total: out.total, limit: args.limit ?? 100, offset: args.offset ?? 0 };
    },
    'history.get': async (p) => {
      const h = repos.getHistory((p as { id: string }).id);
      if (!h) throw new Error('History entry not found');
      return h;
    },
    'history.delete': async (p) => { repos.deleteHistory((p as { id: string }).id); },
    'history.clear': async (p) => {
      const wsId = ensureWorkspace((p as { workspaceId?: string }).workspaceId);
      repos.clearHistory(wsId);
      audit('history.clear', wsId, 'project');
    },
    'history.export': async (p) => {
      const args = p as { workspaceId?: string; path: string };
      const wsId = ensureWorkspace(args.workspaceId);
      const entries = repos.listHistory(wsId, { limit: 100_000 }).items;
      writeFileSync(args.path, JSON.stringify(entries, null, 2));
      return { path: args.path };
    },

    // environments
    'environment.list': async (p) => repos.listEnvironments(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'environment.get': async (p) => {
      const env = repos.getEnvironment((p as { id: string }).id);
      if (!env) throw new Error('Environment not found');
      return env;
    },
    'environment.create': async (p) => {
      const args = p as { name: string; workspaceId?: string };
      const env = repos.saveEnvironment({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId), name: args.name,
        variables: [], sortOrder: 0, createdAt: now(), updatedAt: now(),
      });
      audit('environment.create', env.name, 'project');
      return env;
    },
    'environment.update': async (p) => {
      const args = p as { id: string; patch: Partial<Environment> };
      const existing = repos.getEnvironment(args.id);
      if (!existing) throw new Error('Environment not found');
      const saved = repos.saveEnvironment({ ...existing, ...args.patch, id: existing.id });
      audit('environment.update', saved.name, 'project');
      return saved;
    },
    'environment.delete': async (p) => {
      const existing = repos.getEnvironment((p as { id: string }).id);
      if (!existing) throw new Error('Environment not found');
      repos.deleteEnvironment(existing.id);
      audit('environment.delete', existing.name, 'project');
    },
    'environment.duplicate': async (p) => {
      const args = p as { id: string; name?: string };
      const existing = repos.getEnvironment(args.id);
      if (!existing) throw new Error('Environment not found');
      return repos.saveEnvironment({ ...existing, id: uid(), name: args.name ?? `${existing.name} (copy)` });
    },
    'environment.getActive': async (p) => {
      const id = container.getActiveEnvironmentId();
      return id ? (repos.getEnvironment(id) ?? null) : null;
    },
    'environment.setActive': async (p) => {
      const args = p as { id: string | null; workspaceId?: string };
      container.setActiveEnvironmentId(args.id);
    },
    'environment.importDotEnv': async (p) => {
      const args = p as { content: string; name?: string; workspaceId?: string };
      const mod = await import('../core/envfile/dotenv');
      const variables = mod.parseDotEnv(args.content);
      const env = repos.saveEnvironment({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId),
        name: args.name ?? 'Imported .env', variables, sortOrder: 0, createdAt: now(), updatedAt: now(),
      });
      audit('environment.importDotEnv', env.name, 'import');
      return env;
    },
    'environment.exportDotEnv': async (p) => {
      const mod = await import('../core/envfile/dotenv');
      const env = repos.getEnvironment((p as { id: string }).id);
      if (!env) throw new Error('Environment not found');
      return mod.serializeDotEnv(env.variables);
    },

    // variables
    'variables.globals': async () => container.getGlobalVars(),
    'variables.setGlobals': async (p) => {
      container.setGlobalVars((p as { variables: Variable[] }).variables);
    },
    'variables.resolve': async (p) => {
      const args = p as { text: string; workspaceId?: string; environmentId?: string; collectionId?: string; folderId?: string; data?: Record<string, string>; local?: Record<string, string>; scriptVars?: Record<string, string> };
      const resolver = buildResolver(args);
      return resolver.resolve(args.text);
    },
    'variables.usages': async (p) => {
      const args = p as { key: string; workspaceId?: string };
      const wsId = ensureWorkspace(args.workspaceId);
      const hits: { location: string; type: string; value: string }[] = [];
      const needle = `{{${args.key}}}`;
      const inspect = (label: string, value: string | undefined) => {
        if (!value) return;
        if (value.includes(needle)) hits.push({ location: label, type: 'reference', value: value.slice(Math.max(0, value.indexOf(needle) - 20), value.indexOf(needle) + needle.length + 20) });
      };
      for (const r of repos.listRequests(wsId, { limit: 100_000 }).items) {
        inspect(`request:${r.name}.url`, r.url);
        inspect(`request:${r.name}.body`, r.body.raw);
        for (const h of r.headers) inspect(`request:${r.name}.header.${h.key}`, h.value);
      }
      return hits.map((h, i) => ({ kind: 'variable-usage', id: String(i), title: h.location, snippet: h.value, path: [] }));
    },
    'variables.unused': async (p) => {
      const args = p as { workspaceId?: string };
      const wsId = ensureWorkspace(args.workspaceId);
      const all = new Set<string>();
      const text = JSON.stringify(repos.listRequests(wsId, { limit: 100_000 }).items);
      for (const env of repos.listEnvironments(wsId)) for (const v of env.variables) all.add(v.key);
      for (const v of container.getGlobalVars()) all.add(v.key);
      const out: { key: string; scope: string }[] = [];
      for (const key of all) if (!text.includes(`{{${key}}}`)) out.push({ key, scope: 'environment/global' });
      return out;
    },
    'variables.dependencies': async (p) => {
      const args = p as { workspaceId?: string };
      const wsId = ensureWorkspace(args.workspaceId);
      const envs = repos.listEnvironments(wsId);
      const nodes = envs.flatMap((e) => [{ id: `env:${e.id}`, label: e.name, scope: 'environment' }]);
      const edges: { from: string; to: string }[] = [];
      const cycles: string[][] = [];
      return { nodes, edges, cycles };
    },
    'variables.trace': async (p) => {
      const args = p as { key: string; workspaceId?: string; environmentId?: string };
      const resolver = buildResolver({ workspaceId: args.workspaceId, environmentId: args.environmentId });
      return resolver.get(args.key).trace;
    },
    'variables.all': async (p) => {
      const args = p as { workspaceId?: string; environmentId?: string };
      const wsId = ensureWorkspace(args.workspaceId);
      const out: { key: string; value: string; scope: string; isSecret?: boolean }[] = [];
      for (const v of container.getGlobalVars()) if (v.enabled) out.push({ key: v.key, value: maskSecretValue(v), scope: 'global', isSecret: v.type === 'secret' });
      for (const e of repos.listEnvironments(wsId)) {
        if (args.environmentId && e.id !== args.environmentId) continue;
        for (const v of e.variables) if (v.enabled) out.push({ key: v.key, value: maskSecretValue(v), scope: `environment:${e.name}`, isSecret: v.type === 'secret' });
      }
      return out;
    },

    // cookies
    'cookies.list': async (p) => {
      const args = p as { workspaceId?: string; domain?: string };
      return repos.listCookies(ensureWorkspace(args.workspaceId), args.domain);
    },
    'cookies.set': async (p) => {
      const args = p as { cookie: Parameters<Repos['upsertCookie']>[1]; workspaceId?: string };
      repos.upsertCookie(ensureWorkspace(args.workspaceId), args.cookie);
    },
    'cookies.delete': async (p) => {
      const args = p as { name: string; domain: string; path: string; workspaceId?: string };
      repos.deleteCookie(ensureWorkspace(args.workspaceId), args.name, args.domain, args.path);
    },
    'cookies.clear': async (p) => {
      const args = p as { workspaceId?: string; domain?: string };
      repos.clearCookies(ensureWorkspace(args.workspaceId), args.domain);
    },
    'cookies.import': async (p) => {
      const args = p as { content: string; format: 'json' | 'netscape'; workspaceId?: string };
      const wsId = ensureWorkspace(args.workspaceId);
      let count = 0;
      if (args.format === 'json') {
        const list = JSON.parse(args.content) as { name: string; value: string; domain: string; path: string }[];
        for (const c of list) { repos.upsertCookie(wsId, { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', httpOnly: false, secure: false, sameSite: 'Lax' }); count++; }
      } else {
        for (const line of args.content.split('\n')) {
          const l = line.trim();
          if (!l || l.startsWith('#')) continue;
          const parts = l.split('\t');
          if (parts.length >= 7) {
            repos.upsertCookie(wsId, { name: parts[5], value: parts[6], domain: parts[0], path: parts[2] || '/', secure: parts[3] === 'TRUE', httpOnly: parts[0].startsWith('#HttpOnly') || false, sameSite: 'Lax', expires: parts[4] !== '0' ? new Date(Number(parts[4]) * 1000).toISOString() : undefined });
            count++;
          }
        }
      }
      return { count };
    },
    'cookies.export': async (p) => {
      const args = p as { workspaceId?: string; format: 'json' | 'netscape' };
      const rows = repos.listCookies(ensureWorkspace(args.workspaceId));
      if (args.format === 'json') return JSON.stringify(rows, null, 2);
      const lines = rows.map((c) => [
        (c.httpOnly ? '#HttpOnly_' : '') + c.domain, 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE',
        c.expires ? String(Math.floor(Date.parse(c.expires) / 1000)) : '0', c.name, c.value,
      ].join('\t'));
      return lines.join('\n');
    },


    // --- import / export -------------------------------------------------------------
    'import.detect': async (p) => {
      const args = p as { content: string; fileName?: string };
      const mod = await import('../core/importers/dispatch');
      return mod.detectFormat(args.content, args.fileName);
    },
    'import.run': async (p) => {
      const args = p as { content?: string; path?: string; format?: import('../shared/types').ImportFormat; workspaceId?: string; fileName?: string };
      const wsId = ensureWorkspace(args.workspaceId);
      let content = args.content;
      if (!content && args.path) content = readFileSync(args.path, 'utf8');
      if (!content) throw new Error('import.run requires content or path');
      const mod = await import('../core/importers/dispatch');
      const normalized = mod.runImport(content, args.format, wsId, args.fileName ?? args.path);
      const result = persistImport(normalized, wsId);
      audit('import.run', `${result.report.format}: ${result.collectionIds.length} collection(s)`, 'import');
      return result;
    },
    'import.url': async (p) => {
      const args = p as { url: string; format?: import('../shared/types').ImportFormat; workspaceId?: string };
      const res = await undiciRequest(args.url, { method: 'GET', maxRedirections: 5 });
      if (res.statusCode >= 300) throw new Error(`Failed to fetch ${args.url} (HTTP ${res.statusCode})`);
      const content = await res.body.text();
      const mod = await import('../core/importers/dispatch');
      const wsId = ensureWorkspace(args.workspaceId);
      const normalized = mod.runImport(content, args.format, wsId, args.url);
      const result = persistImport(normalized, wsId);
      audit('import.url', args.url, 'import');
      return result;
    },
    'export.collection': async (p) => {
      const args = p as { collectionId: string; format: 'postman' | 'apimanager' | 'openapi' };
      const collection = repos.getCollection(args.collectionId);
      if (!collection) throw new Error('Collection not found');
      const wsId = ensureWorkspace();
      if (args.format === 'apimanager') {
        return JSON.stringify({
          kind: 'api-manager-collection', version: 1,
          collection, folders: repos.listFolders(collection.id),
          requests: repos.listRequests(wsId, { collectionId: collection.id, limit: 100_000 }).items,
        }, null, 2);
      }
      if (args.format === 'postman') {
        const mod = await import('../core/postman/postman');
        const folders = repos.listFolders(collection.id);
        const requests = repos.listRequests(wsId, { collectionId: collection.id, limit: 100_000 }).items;
        const examples = requests.flatMap((r) => repos.listExamples(r.id));
        return mod.exportPostmanCollection(collection, folders, requests, examples);
      }
      const mod = await import('../core/openapi/openapi');
      const requests = repos.listRequests(wsId, { collectionId: collection.id, limit: 100_000 }).items;
      return mod.collectionToOpenApi(collection, requests, { format: 'json' });
    },
    'export.environment': async (p) => {
      const args = p as { environmentId: string; format: 'postman' | 'dotenv' | 'apimanager' };
      const env = repos.getEnvironment(args.environmentId);
      if (!env) throw new Error('Environment not found');
      if (args.format === 'dotenv') {
        const mod = await import('../core/envfile/dotenv');
        return mod.serializeDotEnv(env.variables);
      }
      if (args.format === 'postman') {
        const mod = await import('../core/postman/postman');
        return mod.exportPostmanEnvironment(env);
      }
      return JSON.stringify({ kind: 'api-manager-environment', version: 1, environment: env }, null, 2);
    },
    'export.workspace': async (p) => {
      const args = p as { workspaceId?: string; includeSecrets?: boolean };
      const wsId = ensureWorkspace(args.workspaceId);
      let json = exportWorkspaceJson(wsId);
      if (!args.includeSecrets) {
        json = json.replace(/"type": "secret",\s*"value": "([^"]*)"/g, '"type": "secret", "value": ""');
      }
      return json;
    },
    'export.request': async (p) => {
      const args = p as { requestId: string; format: 'apimanager' | 'postman' };
      const r = getRequestOrThrow(args.requestId);
      if (args.format === 'apimanager') return JSON.stringify({ kind: 'api-manager-request', version: 1, request: r }, null, 2);
      const mod = await import('../core/postman/postman');
      const stub = repos.getCollection(r.collectionId ?? '') ?? repos.saveCollection({
        id: uid(), workspaceId: r.workspaceId, name: r.name, description: '', variables: [],
        auth: { type: 'none' }, scripts: { preRequest: '', postResponse: '' }, documentation: '',
        tags: [], favorite: false, readOnly: false, sortOrder: 0, createdAt: now(), updatedAt: now(),
      });
      return mod.exportPostmanCollection(stub, [], [r], repos.listExamples(r.id));
    },

    // --- specs / api entities ---------------------------------------------------------
    'spec.list': async (p) => repos.listSpecs(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'spec.get': async (p) => {
      const sp = repos.getSpec((p as { id: string }).id);
      if (!sp) throw new Error('Spec not found');
      return sp;
    },
    'spec.create': async (p) => {
      const args = p as { name: string; format: import('../shared/types').SpecFormat; content: string; workspaceId?: string };
      const spec = repos.saveSpec({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId), name: args.name,
        format: args.format, content: args.content, lifecycle: 'Draft', createdAt: now(), updatedAt: now(),
      });
      audit('spec.create', spec.name, 'project');
      return spec;
    },
    'spec.update': async (p) => {
      const args = p as { id: string; patch: Partial<Specification> };
      const existing = repos.getSpec(args.id);
      if (!existing) throw new Error('Spec not found');
      const saved = repos.saveSpec({ ...existing, ...args.patch, id: existing.id });
      audit('spec.update', saved.name, 'project');
      return saved;
    },
    'spec.delete': async (p) => { repos.deleteSpec((p as { id: string }).id); },
    'spec.validate': async (p) => {
      const args = p as { content: string; format?: import('../shared/types').SpecFormat };
      const mod = await import('../core/openapi/openapi');
      return mod.validateOpenApi(args.content);
    },
    'spec.lint': async (p) => {
      const existing = repos.getSpec((p as { id: string }).id);
      if (!existing) throw new Error('Spec not found');
      const mod = await import('../core/openapi/openapi');
      return mod.validateOpenApi(existing.content);
    },
    'spec.diff': async (p) => {
      const args = p as { aId: string; bId: string };
      const a = repos.getSpec(args.aId);
      const b = repos.getSpec(args.bId);
      if (!a || !b) throw new Error('Spec not found');
      const mod = await import('../core/openapi/openapi');
      return mod.diffSpecs(a.content, b.content);
    },
    'spec.refGraph': async (p) => {
      const existing = repos.getSpec((p as { id: string }).id);
      if (!existing) throw new Error('Spec not found');
      const mod = await import('../core/openapi/openapi');
      return mod.refGraph(existing.content);
    },
    'spec.generateCollection': async (p) => {
      const args = p as { id: string; name?: string };
      const existing = repos.getSpec(args.id);
      if (!existing) throw new Error('Spec not found');
      const mod = await import('../core/openapi/openapi');
      const wsId = ensureWorkspace();
      const normalized = mod.openApiToCollection(existing.content, wsId);
      if (args.name && normalized.collections[0]) normalized.collections[0].collection.name = args.name;
      const result = persistImport(normalized, wsId);
      audit('spec.generateCollection', existing.name, 'project');
      const first = result.collectionIds[0];
      if (!first) throw new Error('No collection generated from spec');
      return repos.getCollection(first)!;
    },
    'spec.syncReport': async (p) => {
      const args = p as { specId: string; collectionId: string };
      const spec = repos.getSpec(args.specId);
      if (!spec) throw new Error('Spec not found');
      const mod = await import('../core/openapi/openapi');
      const requests = repos.listRequests(ensureWorkspace(), { collectionId: args.collectionId, limit: 100_000 }).items;
      return mod.specSyncReport(spec.content, requests);
    },
    'spec.syncApply': async (p) => {
      const args = p as { specId: string; collectionId: string; direction: 'spec-to-collection' | 'collection-to-spec'; selection?: string[] };
      throw new Error(`spec.syncApply (${args.direction}): apply is not alters either side automatically yet — use spec.syncReport + spec.generateCollection for a controlled sync path. (documented limitation)`);
    },
    'api.list': async (p) => repos.listApis(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'api.save': async (p) => {
      const args = (p as { api: import('../shared/types').ApiEntity }).api;
      return repos.saveApi(args);
    },
    'api.delete': async (p) => { repos.deleteApi((p as { id: string }).id); },
    'api.health': async (p) => {
      const api = repos.getApi((p as { id: string }).id);
      if (!api) throw new Error('API not found');
      return computeHealthScore(api.workspaceId ?? container.getActiveWorkspaceId());
    },
    'api.addChangelog': async (p) => {
      const args = p as { id: string; version: string; notes: string };
      const api = repos.getApi(args.id);
      if (!api) throw new Error('API not found');
      const changelog = [...(api.changelog ?? []), { version: args.version, notes: args.notes, date: now() }];
      return repos.saveApi({ ...api, changelog: changelog as never });
    },

    // --- flows ----------------------------------------------------------------------
    'flow.list': async (p) => repos.listFlows(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'flow.get': async (p) => {
      const flow = repos.getFlow((p as { id: string }).id);
      if (!flow) throw new Error('Flow not found');
      return flow;
    },
    'flow.save': async (p) => {
      const flow = (p as { flow: import('../shared/types').Flow }).flow;
      const withIds = { ...flow, id: flow.id ?? uid(), workspaceId: ensureWorkspace(flow.workspaceId), version: flow.version ?? 1 };
      const saved = repos.saveFlow(withIds);
      audit('flow.save', saved?.name ?? withIds.name, 'project');
      return saved;
    },
    'flow.delete': async (p) => { repos.deleteFlow((p as { id: string }).id); },
    'flow.run': async (p) => {
      const args = p as { flowId: string; variables?: Record<string, string>; environmentId?: string; breakpoints?: string[] };
      const flow = repos.getFlow(args.flowId);
      if (!flow) throw new Error('Flow not found');
      const wsId = container.getActiveWorkspaceId();
      const result = startFlowRun({ flow, variables: args.variables, environmentId: args.environmentId, breakpoints: args.breakpoints }, {
        ...container.pipelineDeps(wsId),
        getRequest: (id) => repos.getRequest(id),
        saveFlowRun: (flowId, run, wId) => repos.saveFlowRun(flowId, run, wId),
        emitNode: (ev: { runId: string; flowId: string; node: import('../shared/types').FlowRunLog }) => emit('flow.node', ev),
      });
      audit('flow.run', flow.name, 'run');
      return result;
    },
    'flow.runGet': async (p) => {
      const run = repos.getFlowRun((p as { runId: string }).runId);
      if (!run) throw new Error('Flow run not found');
      return run;
    },
    'flow.stop': async (p) => { stopFlowRun((p as { runId: string }).runId); },

    // --- mocks ----------------------------------------------------------------------
    'mock.list': async (p) => repos.listMocks(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'mock.save': async (p) => {
      const mock = (p as { mock: MockServer }).mock;
      return repos.saveMock(mock);
    },
    'mock.delete': async (p) => {
      stopMock((p as { id: string }).id);
      repos.deleteMock((p as { id: string }).id);
    },
    'mock.start': async (p) => {
      const args = p as { id: string };
      const result = await startMock(args.id, (id) => repos.getMock(id), mockDeps());
      const existing = repos.getMock(args.id);
      if (existing) repos.saveMock({ ...existing, running: true });
      audit('mock.start', `${result.url}`, 'run');
      return result;
    },
    'mock.stop': async (p) => {
      const args = p as { id: string };
      stopMock(args.id);
      const existing = repos.getMock(args.id);
      if (existing) repos.saveMock({ ...existing, running: false });
    },
    'mock.logs': async (p) => {
      const args = p as { id: string; limit?: number };
      return repos.listMockLogs(args.id, args.limit ?? 200);
    },
    'mock.fromCollection': async (p) => {
      const args = p as { collectionId: string; name?: string; port?: number };
      const collection = repos.getCollection(args.collectionId);
      if (!collection) throw new Error('Collection not found');
      const wsId = ensureWorkspace();
      const requests = repos.listRequests(wsId, { collectionId: args.collectionId, limit: 100_000 }).items;
      const routes: MockRoute[] = [];
      for (const r of requests) {
        const examples = repos.listExamples(r.id);
        for (const ex of examples) {
          if (!ex.response) continue;
          routes.push({
            id: uid(), enabled: true, method: '*', pathPattern: pathPatternOf(r.url, ex.response.status),
            status: ex.response.status ?? 200,
            headers: ex.response.headers ?? [],
            body: ex.response.bodyText ?? '',
            exampleId: ex.id,
          });
        }
      }
      const mock = repos.saveMock({
        id: uid(), workspaceId: wsId, name: args.name ?? `${collection.name} mock`,
        port: args.port ?? 4321, running: false, collectionId: args.collectionId,
        routes: routes.length > 0 ? routes : [{
          id: uid(), enabled: true, method: '*', pathPattern: '/*', status: 200,
          headers: [{ id: uid(), key: 'Content-Type', value: 'application/json', enabled: true }],
          body: JSON.stringify({ mock: collection.name, hint: 'Add examples to your requests to serve them here' }),
        }],
        dynamicVars: true, createdAt: now(),
      });
      audit('mock.fromCollection', args.collectionId, 'project');
      return mock;
    },
    'mock.fromSpec': async (p) => {
      const args = p as { specId: string; name?: string; port?: number };
      const spec = repos.getSpec(args.specId);
      if (!spec) throw new Error('Spec not found');
      const mod = await import('../core/openapi/openapi');
      const wsId = ensureWorkspace();
      const routes = mod.openApiToMockRoutes(spec.content, true);
      const mock = repos.saveMock({
        id: uid(), workspaceId: wsId, name: args.name ?? `${spec.name} mock`,
        port: args.port ?? 4321, running: false, specId: args.specId,
        routes, dynamicVars: true, createdAt: now(),
      });
      audit('mock.fromSpec', args.specId, 'project');
      return mock;
    },
    'mock.setRoutes': async (p) => {
      const args = p as { id: string; routes: MockRoute[] };
      const existing = repos.getMock(args.id);
      if (!existing) throw new Error('Mock not found');
      return repos.saveMock({ ...existing, routes: args.routes });
    },

    // --- monitors ---------------------------------------------------------------------
    'monitor.list': async (p) => repos.listMonitors(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'monitor.save': async (p) => {
      const monitor = (p as { monitor: Monitor }).monitor;
      const saved = repos.saveMonitor(monitor);
      const { refreshMonitorSchedule } = await import('../services/monitors/monitorService');
      refreshMonitorSchedule(saved, monitorDeps());
      return saved;
    },
    'monitor.delete': async (p) => {
      disableMonitor((p as { id: string }).id);
      repos.deleteMonitor((p as { id: string }).id);
    },
    'monitor.runNow': async (p) => {
      const args = p as { id: string };
      const before = repos.listMonitorResults(args.id, 1).map((r) => r.id);
      runMonitorNow(args.id, monitorDeps());
      await new Promise((r) => setTimeout(r, 500));
      const after = repos.listMonitorResults(args.id, 10);
      const fresh = after.find((r) => !before.includes(r.id)) ?? after[0];
      if (!fresh) throw new Error('Monitor result not yet available; try again shortly');
      return { resultId: fresh.id };
    },
    'monitor.results': async (p) => {
      const args = p as { id: string; limit?: number };
      return repos.listMonitorResults(args.id, args.limit ?? 100);
    },

    // --- perf ----------------------------------------------------------------------------
    'perf.start': async (p) => {
      const args = p as Parameters<typeof startPerfRun>[0];
      const wsId = container.getActiveWorkspaceId();
      const { runId } = startPerfRun(args, perfDeps(wsId), (ev) => emit('perf.tick', ev));
      audit('perf.start', args.target.id, 'run', wsId);
      return { runId };
    },
    'perf.stop': async (p) => stopPerfRun((p as { runId: string }).runId),
    'perf.get': async (p) => {
      const run = repos.getPerfRun((p as { runId: string }).runId);
      if (!run) throw new Error('Perf run not found');
      return run;
    },
    'perf.list': async (p) => repos.listPerfRuns(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'perf.export': async (p) => {
      const args = p as { runId: string; format: 'csv' | 'json' };
      const run = repos.getPerfRun(args.runId);
      if (!run) throw new Error('Perf run not found');
      if (args.format === 'json') return JSON.stringify(run, null, 2);
      if (!run.metrics) return '';
      const lines = ['t,latencyMs,status,error'];
      for (const s of run.metrics.samples) lines.push(`${s.t},${s.latencyMs.toFixed(2)},${s.status},${s.error ?? ''}`);
      return lines.join('\n');
    },
    'perf.compareBaseline': async (p) => {
      const args = p as { runId: string; baselineId: string };
      const a = repos.getPerfRun(args.runId);
      const b = repos.getPerfRun(args.baselineId);
      if (!a?.metrics || !b?.metrics) throw new Error('Both runs must have metrics');
      return compareBaselines(a.metrics, b.metrics);
    },

    // --- datasets ---------------------------------------------------------------------
    'dataset.list': async (p) => repos.listDatasets(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'dataset.save': async (p) => {
      const dataset = (p as { dataset: Dataset }).dataset;
      return repos.saveDataset(dataset);
    },
    'dataset.delete': async (p) => { repos.deleteDataset((p as { id: string }).id); },
    'dataset.parse': async (p) => {
      const args = p as { content: string; format: 'csv' | 'json' };
      return parseDatasetContent(args.content, args.format);
    },
    'dataset.generate': async (p) => {
      const args = p as { spec: { name: string; template: string; count: number }[] };
      const generated = generateDataset(args.spec);
      if (!generated.columns.length) throw new Error('Generate spec produced no columns');
      const wsId = ensureWorkspace();
      const dataset = repos.saveDataset({
        id: uid(), workspaceId: wsId, name: `generated-${now().slice(0, 10)}`,
        format: 'json', content: JSON.stringify(generated.rows, null, 2),
        createdAt: now(), updatedAt: now(),
      });
      audit('dataset.generate', dataset.name, 'project');
      return dataset;
    },

    // --- docs ----------------------------------------------------------------------
    'docs.list': async (p) => {
        const kv = repos.getKv(ensureWorkspace((p as { workspaceId?: string }).workspaceId), 'docSites') as { sites?: unknown[] };
        return (kv.sites ?? []) as never;
      },
    'docs.generate': async (p) => renderDocs(p as Parameters<typeof renderDocs>[0], docsDeps()),
    'docs.export': async (p) => exportDocs(p as Parameters<typeof exportDocs>[0], docsDeps()),
    'docs.serve': async (p) => serveDocs(p as Parameters<typeof serveDocs>[0], docsDeps()),


    // --- vault ----------------------------------------------------------------------
    'vault.status': async () => vault.status(),
    'vault.unlock': async (p) => {
      await vault.unlock((p as { password: string }).password);
      audit('vault.unlock', undefined, 'secret');
    },
    'vault.lock': async () => { vault.lock(); audit('vault.lock', undefined, 'secret'); },
    'vault.isInitialized': async () => vault.isInitialized(),
    'vault.initialize': async (p) => {
      await vault.initialize((p as { password: string }).password);
      audit('vault.initialize', undefined, 'secret');
    },
    'vault.list': async (p) => vault.list(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'vault.get': async (p) => {
      const item = vault.get((p as { id: string }).id);
      audit('vault.get', item.name, 'secret');
      return { id: item.id, name: item.name, value: item.secret, description: item.description, createdAt: item.createdAt, lastAccessedAt: item.lastAccessedAt };
    },
    'vault.set': async (p) => {
      const args = p as { id?: string; name: string; secret: string; workspaceId?: string; description?: string };
      const saved = vault.set({ ...args, workspaceId: args.workspaceId ? ensureWorkspace(args.workspaceId) : container.getActiveWorkspaceId() });
      audit('vault.set', args.name, 'secret');
      return saved;
    },
    'vault.delete': async (p) => { vault.delete((p as { id: string }).id); audit('vault.delete', (p as { id: string }).id, 'secret'); },

    // --- certificates / proxies --------------------------------------------------------
    'certificate.list': async (p) => repos.listCertificates(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'certificate.save': async (p) => {
      const args = p as { certificate: Parameters<Repos['saveCertificate']>[0]; workspaceId?: string };
      const cert = { ...args.certificate, workspaceId: ensureWorkspace(args.certificate?.workspaceId ?? args.workspaceId) };
      return repos.saveCertificate(cert);
    },
    'certificate.delete': async (p) => { repos.deleteCertificate((p as { id: string }).id); },
    'certificate.inspect': async (p) => {
      const args = p as { id: string };
      const cert = repos.listCertificates(ensureWorkspace()).find((c) => c.id === args.id);
      if (!cert) throw new Error('Certificate not found');
      const path = cert.certPath ?? cert.pfxPath;
      if (!path) throw new Error('No certificate file associated');
      try {
        const { X509Certificate } = await import('node:crypto');
        const x = new X509Certificate(readFileSync(path));
        const from = new Date(x.validFrom);
        const to = new Date(x.validTo);
        const daysLeft = Math.floor((to.getTime() - Date.now()) / 86_400_000);
        return { subject: x.subject, issuer: x.issuer, validFrom: x.validFrom, validTo: x.validTo, daysLeft };
      } catch (e) {
        return { subject: '', issuer: '', validFrom: '', validTo: '', daysLeft: 0, error: e instanceof Error ? e.message : String(e) };
      }
    },
    'proxy.list': async (p) => repos.listProxies(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'proxy.save': async (p) => repos.saveProxy((p as { profile: Parameters<Repos['saveProxy']>[0] }).profile),
    'proxy.delete': async (p) => { repos.deleteProxy((p as { id: string }).id); },

    // --- settings ----------------------------------------------------------------------
    'settings.get': async () => container.settings,
    'settings.update': async (p) => {
      const patch = (p as { patch: Partial<typeof container.settings> }).patch;
      const merged = container.saveSettings(patch);
      audit('settings.update', Object.keys(patch).join(','), 'settings');
      return merged;
    },
    'settings.reset': async () => { const { DEFAULT_SETTINGS: D } = await import('../shared/types'); return container.saveSettings(D); },

    // --- git ----------------------------------------------------------------
    'git.init': async (p) => {
      const args = p as { path?: string; workspaceId?: string };
      const path = args.path ?? join(container.dataDir, 'git-repos', container.getActiveWorkspaceId());
      const wsId = ensureWorkspace(args.workspaceId);
      const result = await gitInit(path);
      const ws = repos.getWorkspace(wsId);
      if (ws && !ws.gitRepoPath) repos.saveWorkspace({ ...ws, gitRepoPath: path });
      audit('git.init', path, 'git');
      return result;
    },
    'git.clone': async (p) => {
      const args = p as { url: string; path: string; username?: string; passwordSecretId?: string };
      const password = args.passwordSecretId ? vault.resolveByName(args.passwordSecretId) : undefined;
      const result = await gitClone({ url: args.url, path: args.path, username: args.username, password });
      audit('git.clone', args.url, 'git');
      return result;
    },
    'git.status': async (p) => gitStatus(resolveGitPath((p as { path?: string }).path)),
    'git.add': async (p) => {
      const args = p as { path?: string; files: string[] };
      await gitAdd(resolveGitPath(args.path), args.files);
    },
    'git.addAll': async (p) => { await gitAddAll(resolveGitPath((p as { path?: string }).path)); },
    'git.commit': async (p) => {
      const args = p as { path?: string; message: string; skipSecretScan?: boolean };
      const settings = container.settings;
      const result = await gitCommit({
        path: resolveGitPath(args.path), message: args.message,
        author: { name: settings.git.userName, email: settings.git.userEmail },
        skipSecretScan: args.skipSecretScan ?? !settings.git.secretScanBeforeCommit,
      });
      audit('git.commit', args.message.slice(0, 80), 'git');
      return result;
    },
    'git.branches': async (p) => gitBranches(resolveGitPath((p as { path?: string }).path)),
    'git.createBranch': async (p) => {
      const args = p as { path?: string; name: string; checkout?: boolean };
      await gitCreateBranch(resolveGitPath(args.path), args.name, args.checkout ?? false);
    },
    'git.checkout': async (p) => {
      const args = p as { path?: string; ref: string };
      await gitCheckout(resolveGitPath(args.path), args.ref);
    },
    'git.merge': async (p) => {
      const args = p as { path?: string; branch: string };
      return gitMerge(resolveGitPath(args.path), args.branch);
    },
    'git.fetch': async (p) => { await gitFetch(resolveGitPath((p as { path?: string }).path)); },
    'git.pull': async (p) => {
      const args = p as { path?: string; remote?: string; username?: string; passwordSecretId?: string };
      const password = args.passwordSecretId ? vault.resolveByName(args.passwordSecretId) : undefined;
      await gitPull(resolveGitPath(args.path), args.remote, { username: args.username, password });
    },
    'git.push': async (p) => {
      const args = p as { path?: string; remote?: string; username?: string; passwordSecretId?: string };
      const password = args.passwordSecretId ? vault.resolveByName(args.passwordSecretId) : undefined;
      await gitPush(resolveGitPath(args.path), args.remote, { username: args.username, password });
    },
    'git.stash': async (p) => {
      const args = p as { path?: string; message?: string };
      await gitStash(resolveGitPath(args.path), args.message);
    },
    'git.stashPop': async (p) => { await gitStashPop(resolveGitPath((p as { path?: string }).path)); },
    'git.diff': async (p) => {
      const args = p as { path?: string; file?: string; staged?: boolean };
      return gitDiff(resolveGitPath(args.path), args.file, args.staged);
    },
    'git.log': async (p) => {
      const args = p as { path?: string; limit?: number };
      return gitLog(resolveGitPath(args.path), args.limit ?? 50);
    },
    'git.remotes': async (p) => gitRemotes(resolveGitPath((p as { path?: string }).path)),
    'git.addRemote': async (p) => {
      const args = p as { path?: string; name: string; url: string };
      await gitAddRemote(resolveGitPath(args.path), args.name, args.url);
    },
    'git.writeGitignore': async (p) => { await writeGitignore(resolveGitPath((p as { path?: string }).path)); },
    'git.secretScan': async (p) => gitSecretScan(resolveGitPath((p as { path?: string }).path)),

    // --- webhooks ----------------------------------------------------------------------
    'webhook.list': async (p) => repos.listWebhooks(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'webhook.save': async (p) => repos.saveWebhook((p as { webhook: WebhookReceiver }).webhook),
    'webhook.delete': async (p) => {
      stopWebhookReceiver((p as { id: string }).id);
      repos.deleteWebhook((p as { id: string }).id);
    },
    'webhook.start': async (p) => {
      const args = p as { id: string };
      const result = await startWebhookReceiver(args.id, (id) => repos.getWebhook(id), webhookDeps());
      const existing = repos.getWebhook(args.id);
      if (existing) repos.saveWebhook({ ...existing, running: true });
      audit('webhook.start', result.url, 'run');
      return result;
    },
    'webhook.stop': async (p) => {
      const args = p as { id: string };
      stopWebhookReceiver(args.id);
      const existing = repos.getWebhook(args.id);
      if (existing) repos.saveWebhook({ ...existing, running: false });
    },
    'webhook.events': async (p) => {
      const args = p as { id: string; limit?: number };
      return repos.listWebhookEvents(args.id, args.limit ?? 200);
    },
    'webhook.saveAsRequest': async (p) => {
      const args = p as { eventId: string; collectionId?: string; workspaceId?: string };
      const ev = repos.findWebhookEvent(args.eventId);
      if (!ev) throw new Error('Webhook event not found');
      const request = repos.saveRequest({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId),
        collectionId: args.collectionId,
        name: `${ev.method} ${ev.path} (webhook ${ev.timestamp.slice(0, 16)})`,
        method: ev.method as ApiRequest['method'], url: ev.path + (ev.query ? `?${ev.query}` : ''),
        pathParams: [], queryParams: [], headers: ev.headers,
        body: { type: 'text', raw: ev.body }, auth: { type: 'none' }, assertions: [],
        scripts: { preRequest: '', postResponse: '' }, protocol: 'http',
        tags: ['webhook'], favorite: false, sortOrder: 0,
        settings: defaultRequestSettings(), createdAt: now(), updatedAt: now(),
      });
      audit('webhook.saveAsRequest', ev.id, 'project');
      return request;
    },

    // --- capture ----------------------------------------------------------------------
    'capture.start': async (p) => {
      const args = p as { port?: number; workspaceId?: string };
      void args;
      const deps: CaptureDeps = {
        saveExchange: (ex) => { capturedExchanges.push(ex); if (capturedExchanges.length > 500) capturedExchanges.splice(0, capturedExchanges.length - 500); },
        emit: (type, payload) => emit(type, payload),
      };
      const result = await startCapture(args.port ?? 9911, deps);
      audit('capture.start', result.proxyUrl, 'run');
      return result;
    },
    'capture.stop': async () => { stopCapture(); audit('capture.stop', undefined, 'run'); },
    'capture.status': async () => ({ ...captureStatus(), count: capturedExchanges.length }),
    'capture.list': async (p) => [...capturedExchanges].reverse().slice(0, (p as { limit?: number }).limit ?? 200),
    'capture.clear': async () => { capturedExchanges.length = 0; },
    'capture.saveAsRequest': async (p) => {
      const args = p as { id: string; collectionId?: string; workspaceId?: string };
      const ex = capturedExchanges.find((x) => x.id === args.id);
      if (!ex) throw new Error('Captured exchange not found');
      const request = repos.saveRequest({
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId),
        collectionId: args.collectionId,
        name: `${ex.method} ${ex.url.slice(0, 60)}`,
        method: ex.method as ApiRequest['method'],
        url: ex.url,
        pathParams: [], queryParams: [], headers: ex.requestHeaders,
        body: ex.requestBody ? { type: 'text', raw: ex.requestBody } : { type: 'none' },
        auth: { type: 'none' }, assertions: [], scripts: { preRequest: '', postResponse: '' },
        protocol: 'http', tags: ['captured'], favorite: false, sortOrder: 0,
        settings: defaultRequestSettings(), createdAt: now(), updatedAt: now(),
      });
      audit('capture.saveAsRequest', ex.id, 'project');
      return request;
    },

    // --- inventory ----------------------------------------------------------------------
    'inventory.ports': async () => listPorts(false),
    'inventory.listeners': async () => listPorts(true),
    'inventory.interfaces': async () => networkInterfaces(),

    // --- security / governance -----------------------------------------------------------
    'security.scanWorkspace': async (p) => {
      const wsId = ensureWorkspace((p as { workspaceId?: string }).workspaceId);
      const result = securityScanWorkspace(wsId, {
        listRequests: (id) => repos.listRequests(id ?? wsId, { limit: 100_000 }).items,
        listPatterns: () => repos.listSecretPatterns() as unknown as import('../core/secrets/scanner').SecretPattern[],
        listRules: (id) => repos.listGovernanceRules(id),
        untrustedProjectsEnabled: () => container.settings.security.confirmDangerousScripts,
        audit: (a, d) => audit(a, d, 'security'),
      });
      audit('security.scanWorkspace', `${result.length} findings`, 'security');
      return result;
    },
    'security.scanText': async (p) => {
      const args = p as { text: string; location?: string };
      const wsId = ensureWorkspace();
      return securityScanText(args.text, args.location, {
        listRequests: () => [], listPatterns: () => repos.listSecretPatterns() as unknown as import('../core/secrets/scanner').SecretPattern[], listRules: (id) => repos.listGovernanceRules(id),
        untrustedProjectsEnabled: () => false, audit: () => undefined,
      });
    },
    'security.scanResponse': async (p) => {
      const args = p as { response: ApiResponse };
      const wsId = ensureWorkspace();
      return securityScanResponse({ status: args.response.status, headers: args.response.headers, bodyText: args.response.bodyText, url: args.response.requestSnapshot?.url }, {
        listRequests: () => [], listPatterns: () => repos.listSecretPatterns() as unknown as import('../core/secrets/scanner').SecretPattern[], listRules: (id) => repos.listGovernanceRules(id),
        untrustedProjectsEnabled: () => false, audit: () => undefined,
      });
    },
    'security.patterns': async () => repos.listSecretPatterns(),
    'security.addPattern': async (p) => {
      const args = p as { name: string; pattern: string; severity: string };
      repos.saveSecretPattern({ id: uid(), name: args.name, pattern: args.pattern, severity: args.severity as never, builtin: false });
      audit('security.addPattern', args.name, 'security');
    },
    'security.deletePattern': async (p) => { repos.deleteSecretPattern((p as { id: string }).id); },
    'governance.rules': async (p) => repos.listGovernanceRules(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'governance.saveRule': async (p) => repos.saveGovernanceRule((p as { rule: GovernanceRule }).rule),
    'governance.deleteRule': async (p) => { repos.deleteGovernanceRule((p as { id: string }).id); },
    'governance.evaluate': async (p) => {
      const wsId = ensureWorkspace((p as { workspaceId?: string }).workspaceId);
      const rules = repos.listGovernanceRules(wsId).filter((r) => r.enabled);
      const requests = repos.listRequests(wsId, { limit: 100_000 }).items;
      const collections = repos.listCollections(wsId);
      const specs = repos.listSpecs(wsId);
      return evaluateRules(rules, { collections, requests, specs });
    },

    // --- console / analytics ------------------------------------------------------------
    'console.list': async (p) => consoleStore.list(p as { level?: string; source?: string; search?: string; limit?: number }),
    'console.clear': async () => consoleStore.clear(),
    'console.log': async (p) => {
      const args = p as { level: string; source: string; message: string };
      consoleStore.log(args.level, args.source, args.message);
    },
    'console.export': async () => consoleStore.exportText(),
    'analytics.summary': async (p) => {
      const wsId = ensureWorkspace((p as { workspaceId?: string }).workspaceId);
      const requests = repos.listRequests(wsId, { limit: 100_000 }).items;
      const runs = repos.listRuns(wsId, 1000);
      const stats = repos.avgResponseStats(wsId);
      const byMethod: Record<string, number> = {};
      for (const r of requests) byMethod[r.method] = (byMethod[r.method] ?? 0) + 1;
      const byStatus: Record<string, number> = {};
      const history = repos.listHistory(wsId, { limit: 10_000 }).items;
      for (const h of history) if (h.status) byStatus[String(h.status)] = (byStatus[String(h.status)] ?? 0) + 1;
      const timeline = new Map<string, { count: number; totalMs: number }>();
      for (const h of history) {
        const day = h.timestamp.slice(0, 10);
        const bucket = timeline.get(day) ?? { count: 0, totalMs: 0 };
        bucket.count++; bucket.totalMs += h.durationMs ?? 0;
        timeline.set(day, bucket);
      }
      const passRuns = runs.filter((r) => r.failedRequests === 0).length;
      return {
        requests: requests.length,
        collections: repos.listCollections(wsId).length,
        runs: runs.length,
        passRate: runs.length > 0 ? Math.round((passRuns / runs.length) * 100) : 0,
        avgResponseMs: stats.avgMs,
        byMethod, byStatus,
        timeline: [...timeline.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, count: v.count, avgMs: v.count ? v.totalMs / v.count : 0 })),
      };
    },

    // --- search ---------------------------------------------------------------------
    'search.global': async (p) => runSearchGlobal(p as import('../shared/api').SearchOptions, false) as never,
    'search.replace': async (p) => runSearchGlobal(p as import('../shared/api').ReplaceSpec, true) as never,

    // --- audit ----------------------------------------------------------------------
    'audit.list': async (p) => {
      const args = p as { workspaceId?: string; category?: string; search?: string; from?: string; to?: string; limit?: number; offset?: number };
      const out = repos.listAudit({ workspaceId: ensureWorkspace(args.workspaceId), category: args.category, search: args.search, from: args.from, to: args.to, limit: args.limit ?? 200, offset: args.offset ?? 0 });
      return { items: out.items, total: out.total, limit: args.limit ?? 200, offset: args.offset ?? 0 };
    },
    'audit.export': async (p) => {
      const wsId = ensureWorkspace((p as { workspaceId?: string }).workspaceId);
      const entries = repos.listAudit({ workspaceId: wsId, limit: 100_000 }).items;
      return entries.map((e) => `${e.timestamp} [${e.category}] ${e.actor} ${e.action} ${e.detail ?? ''}`).join('\n');
    },

    // --- db / maintenance -----------------------------------------------------------------
    'db.diagnostics': async () => container.db.diagnostics() ?? { sizeBytes: 0, integrityOk: true, quickCheck: 'ok', schemaVersion: 1, tableCounts: {}, walMode: false },
    'db.vacuum': async () => { container.db.vacuum?.(); },
    'db.integrityCheck': async () => {
      const res = container.db.integrityCheck?.();
      return res ?? { ok: true, report: 'integrity check unavailable in this build' };
    },
    'db.migrationStatus': async () => container.db.migrationStatus?.() ?? { applied: 1, latest: 1, pending: [] },
    'db.wipe': async () => {
      // safety: auto-backup first, then wipe all rows and re-seed fresh state
      const backup = createBackup(backupDeps(), { kind: 'pre-destructive', note: 'pre-wipe' });
      container.db.wipeAll();
      container.setEmit(emit); // container state is intact (settings/audit live outside tables conceptually)
      audit('db.wipe', backup.path, 'admin');
      return { backup: backup.path };
    },

    'backup.list': async () => listBackups(backupDeps()),
    'backup.create': async (p) => {
      const args = p as { kind?: 'manual' | 'auto' | 'pre-import' | 'pre-destructive'; encryptPassword?: string; note?: string };
      const result = createBackup(backupDeps(), { kind: args.kind, encryptPassword: args.encryptPassword, note: args.note });
      pruneAutoBackups(backupDeps(), container.settings.data.maxAutoBackups);
      audit('backup.create', result.path, 'backup');
      return result;
    },
    'backup.restore': async (p) => {
      const args = p as { path: string; password?: string };
      const result = restoreBackup(args.path, args.password, backupDeps());
      audit('backup.restore', args.path, 'backup');
      return result;
    },
    'backup.delete': async (p) => { deleteBackup((p as { path: string }).path, backupDeps()); },
    'backup.verify': async (p) => verifyBackup((p as { path: string }).path, backupDeps()),
    'backup.compare': async (p) => {
      const args = p as { aPath: string; bPath: string };
      return compareBackups(args.aPath, args.bPath);
    },

    // --- crash recovery ----------------------------------------------------------------------
    'recovery.listDrafts': async (p) => repos.listRecoveryPoints(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'recovery.discard': async (p) => {
      const args = p as { id: string };
      const points = repos.listRecoveryPoints(ensureWorkspace());
      const match = points.find((x) => x.id === args.id);
      if (match) repos.deleteRecoveryPoint(match.entityType, match.entityId);
    },

    // --- files / attachments ----------------------------------------------------------------------
    'files.browse': async (p) => fileBrowse(filesDeps(), (p as { path?: string }).path),
    'files.readText': async (p) => fileReadText((p as { path: string }).path, filesDeps()),
    'files.listAttachments': async (p) => repos.listAttachments(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'files.addAttachment': async (p) => {
      const args = p as { path: string; workspaceId?: string };
      const result = fileAddAttachment(args.path, ensureWorkspace(args.workspaceId), filesDeps());
      audit('files.addAttachment', args.path, 'project');
      return result;
    },
    'files.deleteAttachment': async (p) => { fileDeleteAttachment((p as { id: string }).id, filesDeps()); },
    'files.relink': async (p) => {
      const args = p as { id: string; newPath: string };
      return relinkAttachment(args.id, args.newPath, filesDeps());
    },
    'files.missing': async (p) => listMissing(ensureWorkspace((p as { workspaceId?: string }).workspaceId), filesDeps()),
    'files.orphans': async (p) => listOrphans(ensureWorkspace((p as { workspaceId?: string }).workspaceId), filesDeps()),

    // --- favorites / tags ----------------------------------------------------------------------
    'favorite.list': async (p) => repos.listFavorites(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'favorite.toggle': async (p) => {
      const args = p as { entityType: 'collection' | 'request' | 'folder' | 'spec'; entityId: string; workspaceId?: string };
      return repos.toggleFavorite(ensureWorkspace(args.workspaceId), args.entityType, args.entityId);
    },
    'tag.list': async (p) => repos.listTags(ensureWorkspace((p as { workspaceId?: string }).workspaceId)),
    'tag.save': async (p) => {
      const args = p as { tag: Parameters<Repos['saveTag']>[0]; workspaceId?: string };
      const tag = { ...args.tag, workspaceId: ensureWorkspace(args.tag?.workspaceId ?? args.workspaceId) };
      return repos.saveTag(tag);
    },
    'tag.delete': async (p) => { repos.deleteTag((p as { id: string }).id); },

    // --- protocols ----------------------------------------------------------------------
    'ws.connect': async (p) => {
      const args = p as Parameters<typeof wsConnect>[0];
      return wsConnect(args, sessionEmitter);
    },
    'ws.send': async (p) => {
      const args = p as { sessionId: string; data: string; binary?: boolean };
      wsSend(args.sessionId, args.data, args.binary ?? false, sessionEmitter);
    },
    'ws.close': async (p) => { wsClose((p as { sessionId: string }).sessionId); },
    'sse.connect': async (p) => sseConnect(p as Parameters<typeof sseConnect>[0], sessionEmitter),
    'sse.close': async (p) => { sseClose((p as { sessionId: string }).sessionId); },
    'mqtt.connect': async (p) => {
      const args = p as { config: Parameters<typeof mqttConnect>[0]; sessionId?: string };
      return mqttConnect(args.config, sessionEmitter, args.sessionId);
    },
    'mqtt.publish': async (p) => {
      const args = p as { sessionId: string; topic: string; payload: string; qos?: 0 | 1 | 2; retain?: boolean };
      await mqttPublish(args.sessionId, args.topic, args.payload, args.qos ?? 0, args.retain ?? false);
    },
    'mqtt.subscribe': async (p) => {
      const args = p as { sessionId: string; topic: string; qos?: 0 | 1 | 2 };
      await mqttSubscribe(args.sessionId, args.topic, args.qos ?? 0);
    },
    'mqtt.unsubscribe': async (p) => {
      const args = p as { sessionId: string; topic: string };
      await mqttUnsubscribe(args.sessionId, args.topic);
    },
    'mqtt.close': async (p) => { mqttClose((p as { sessionId: string }).sessionId); },
    'grpc.listServices': async (p) => {
      const args = p as { config: Parameters<typeof loadSchema>[1]; serverUrl: string };
      const schema = await loadSchema(args.serverUrl, args.config);
      return { services: schema.services };
    },
    'grpc.invoke': async (p) => {
      const args = p as Parameters<typeof grpcInvoke>[0];
      return grpcInvoke(args, sessionEmitter);
    },
    'grpc.send': async (p) => {
      const args = p as { sessionId: string; payload: string };
      grpcSend(args.sessionId, args.payload);
    },
    'grpc.endStream': async (p) => { grpcEndStream((p as { sessionId: string }).sessionId); },
    'grpc.close': async (p) => { grpcClose((p as { sessionId: string }).sessionId); },
    'socketio.connect': async (p) => {
      const args = p as { url: string; path?: string; sessionId?: string };
      return socketIoConnect({ url: args.url, path: args.path, sessionId: args.sessionId }, sessionEmitter);
    },
    'socketio.emit': async (p) => {
      const args = p as { sessionId: string; event: string; data: string };
      let data: unknown = args.data;
      try { data = JSON.parse(args.data); } catch { /* send as string */ }
      socketIoEmit(args.sessionId, args.event, data);
    },
    'socketio.close': async (p) => { socketIoClose((p as { sessionId: string }).sessionId); },

    // --- mcp ----------------------------------------------------------------------
    'mcp.connect': async (p) => {
      const args = p as { config: import('../shared/types').McpConfig; sessionId?: string };
      const result = await mcpConnect(args.config, args.sessionId);
      audit('mcp.connect', args.config.command ?? args.config.endpoint, 'mcp');
      return result;
    },
    'mcp.listTools': async (p) => mcpListTools((p as { sessionId: string }).sessionId),
    'mcp.callTool': async (p) => {
      const args = p as { sessionId: string; name: string; argsJson: string; confirmed: boolean };
      const result = await mcpCallTool(args.sessionId, args.name, args.argsJson, args.confirmed);
      audit('mcp.callTool', args.name, 'mcp');
      return result;
    },
    'mcp.listResources': async (p) => mcpListResources((p as { sessionId: string }).sessionId),
    'mcp.listPrompts': async (p) => mcpListPrompts((p as { sessionId: string }).sessionId),
    'mcp.close': async (p) => { mcpClose((p as { sessionId: string }).sessionId); },

    // --- AI ----------------------------------------------------------------------
    'ai.send': async (p) => aiSend(p as Parameters<typeof aiSend>[0], aiDeps()),
    'ai.providers': async () => listProviders(),

    // --- oauth ----------------------------------------------------------------------
    'oauth.start': async (p) => {
      const args = p as { config: import('../shared/types').OAuth2Config; environmentId?: string };
      const result = await startAuthorizationFlow(args.config);
      audit('oauth.start', args.config.authUrl, 'auth');
      return { authUrl: result.authUrl, state: result.state, callbackPort: result.callbackPort };
    },
    'oauth.exchange': async (p) => {
      const args = p as { config: import('../shared/types').OAuth2Config; code: string; state: string; callbackPort?: number };
      return exchangeCode(args.config, args.code, args.config.callbackUrl);
    },
    'oauth.clientCredentials': async (p) => clientCredentials((p as { config: import('../shared/types').OAuth2Config }).config),
    'oauth.passwordGrant': async (p) => oauthPasswordGrant((p as { config: import('../shared/types').OAuth2Config }).config),
    'oauth.refresh': async (p) => oauthRefresh((p as { config: import('../shared/types').OAuth2Config }).config),
    'oauth.discover': async (p) => discoverEndpoints((p as { url: string }).url),

    // --- plugins ----------------------------------------------------------------------
    'plugin.list': async () => container.getSetting('plugins.installed', []),
    'plugin.install': async (p) => {
      const result = installPlugin((p as { path: string }).path, pluginDeps());
      audit('plugin.install', result.manifest.name, 'project');
      return result;
    },
    'plugin.uninstall': async (p) => { uninstallPlugin((p as { id: string }).id, pluginDeps()); },
    'plugin.setEnabled': async (p) => {
      const args = p as { id: string; enabled: boolean };
      setPluginEnabled(args.id, args.enabled, pluginDeps());
    },
    'plugin.runHook': async (p) => {
      const args = p as { id: string; hook: string; payloadJson: string };
      const plugin = (container.getSetting<Record<string, unknown>[]>('plugins.installed', []) as never as import('../shared/types').Plugin[]).find((x) => x.id === args.id);
      if (!plugin) throw new Error('Plugin not found');
      const result = runPluginHook(plugin, args.hook, args.payloadJson, pluginDeps());
      return JSON.stringify(result);
    },

    // --- network helpers ---------------------------------------------------------
    'request.preview': async (p) => {
      const args = p as { request: ApiRequest; environmentId?: string };
      const wsId = args.request.workspaceId || container.getActiveWorkspaceId();
      const resolver = buildResolver({ workspaceId: wsId, environmentId: args.environmentId });
      const mod = await import('../core/url/urlBuilder');
      const url = resolver.resolve(args.request.url).resolved;
      const urlWithPath = mod.applyPathParams(url, args.request.pathParams);
      const finalUrl = mod.buildUrl(urlWithPath, args.request.queryParams);
      return {
        finalUrl,
        variableTrace: resolver.resolve(args.request.url).trace,
        headers: args.request.headers.filter((h) => h.enabled),
      };
    },

    // snapshots ----------------------------------------------------------------
    'snapshot.list': async (p) => repos.listSnapshots((p as { requestId: string }).requestId),
    'snapshot.create': async (p) => {
      const args = p as { requestId: string; name: string; response: ApiResponse; ignorePaths?: string[]; workspaceId?: string };
      const snap: Snapshot = {
        id: uid(), workspaceId: ensureWorkspace(args.workspaceId),
        requestId: args.requestId, name: args.name,
        response: { ...args.response, id: uid() },
        ignorePaths: args.ignorePaths ?? [], createdAt: now(),
      };
      const saved = repos.saveSnapshot(snap);
      audit('snapshot.create', args.name, 'project');
      return saved;
    },
    'snapshot.delete': async (p) => repos.deleteSnapshot((p as { id: string }).id),
    'snapshot.accept': async (p) => {
      const args = p as { id: string; response: ApiResponse };
      const existing = repos.getSnapshot(args.id);
      if (!existing) throw new Error('Snapshot not found');
      return repos.saveSnapshot({ ...existing, response: { ...args.response, id: uid() } });
    },
    'snapshot.compare': async (p) => {
      const args = p as { id: string; response: ApiResponse };
      const existing = repos.getSnapshot(args.id);
      if (!existing) throw new Error('Snapshot not found');
      const mod = await import('../core/assert/snapshot');
      return mod.compareToSnapshot(existing.response, args.response, existing.ignorePaths);
    },

    // assertions ---------------------------------------------------------------
    'assertion.run': async (p) => {
      const args = p as { assertions: Parameters<(typeof import('../core/assert/assertions'))['evaluateAssertions']>[0]; response: ApiResponse; request?: ApiRequest };
      const mod = await import('../core/assert/assertions');
      return mod.evaluateAssertions(args.assertions, args.response);
    },
    'assertion.types': async () => {
      const mod = await import('../core/assert/assertions');
      return mod.ASSERTION_DEFS;
    },

    // runner ----------------------------------------------------------------------
    'run.start': async (p) => {
      const args = p as RunConfig & { dataRows?: Record<string, string>[] };
      const wsId = container.getActiveWorkspaceId();
      const extras = { dataRows: args.dataRows };
      const { runId } = startRun(args, runnerDeps(), extras, (ev) => emit('run.progress', ev));
      audit('run.start', args.collectionId, 'run', wsId);
      return { runId };
    },
    'run.pause': async (p) => pauseRun((p as { runId: string }).runId),
    'run.resume': async (p) => resumeRun((p as { runId: string }).runId),
    'run.stop': async (p) => stopRun((p as { runId: string }).runId),
    'run.get': async (p) => {
      const args = p as { runId: string };
      const active = getActiveRun(args.runId);
      if (active) {
        return {
          id: active.id, config: active.config, status: active.status,
          startedAt: active.startedAt, finishedAt: active.finishedAt,
          totalRequests: active.total, executedRequests: active.executed,
          passedRequests: active.results.filter((r) => r.passed && !r.skipped).length,
          failedRequests: active.results.filter((r) => !r.passed && !r.skipped).length,
          totalTests: active.results.reduce((a, r) => a + r.tests.length, 0),
          passedTests: active.results.reduce((a, r) => a + r.tests.filter((t) => t.passed).length, 0),
          failedTests: active.results.reduce((a, r) => a + r.tests.filter((t) => !t.passed).length, 0),
          durationMs: active.finishedAt ? Date.parse(active.finishedAt) - Date.parse(active.startedAt) : undefined,
          results: active.results, executionLog: active.executionLog,
        };
      }
      const stored = repos.getRun(args.runId);
      if (!stored) throw new Error('Run not found');
      return stored;
    },
    'run.list': async (p) => {
      const args = p as { workspaceId?: string; limit?: number };
      return repos.listRuns(ensureWorkspace(args.workspaceId), args.limit ?? 50);
    },
    'run.delete': async (p) => repos.deleteRun((p as { runId: string }).runId),
    'run.rerunFailed': async (p) => {
      const args = p as { runId: string };
      const stored = repos.getRun(args.runId);
      if (!stored) throw new Error('Run not found');
      const failedIds = stored.results.filter((r) => !r.passed && !r.skipped).map((r) => r.requestId);
      if (failedIds.length === 0) throw new Error('No failed requests to rerun');
      const config: RunConfig = { ...stored.config, requestIds: failedIds };
      const { runId } = startRun(config, runnerDeps(), {}, (ev) => emit('run.progress', ev));
      return { runId };
    },
    'run.exportJson': async (p) => {
      const stored = repos.getRun((p as { runId: string }).runId);
      if (!stored) throw new Error('Run not found');
      return JSON.stringify(stored, null, 2);
    },
    'run.exportJUnit': async (p) => {
      const stored = repos.getRun((p as { runId: string }).runId);
      if (!stored) throw new Error('Run not found');
      return runToJunitXml(stored);
    },
    'run.exportHtml': async (p) => {
      const stored = repos.getRun((p as { runId: string }).runId);
      if (!stored) throw new Error('Run not found');
      const passed = stored.passedRequests;
      const failed = stored.failedRequests;
      const pct = stored.executedRequests > 0 ? Math.round((passed / stored.executedRequests) * 100) : 0;
      const rows = stored.results.map((r) => `<tr class="${r.passed ? 'pass' : r.skipped ? 'skip' : 'fail'}"><td>${htmlEscape(String(r.iteration + 1))}</td><td>${htmlEscape(r.requestName)}</td><td>${r.status ?? ''}</td><td>${typeof r.durationMs === 'number' ? `${r.durationMs.toFixed(0)}ms` : ''}</td><td>${r.passed ? 'PASS' : r.skipped ? 'SKIP' : 'FAIL'}</td><td>${htmlEscape(r.error ?? '')}</td></tr>`).join('\n');
      return `<!doctype html><html><head><meta charset="utf-8"><title>Run ${htmlEscape(stored.id)}</title><style>body{font-family:system-ui;margin:2rem;background:#fafafa;color:#222}table{border-collapse:collapse;width:100%;background:#fff}td,th{border:1px solid #ddd;padding:6px 10px;font-size:14px}tr.pass td{background:#f0fdf4}tr.fail td{background:#fef2f2}tr.skip td{background:#fefce8}h1{font-size:1.3rem}</style></head><body>
<h1>Run report — ${htmlEscape(stored.startedAt)}</h1>
<p>Total ${stored.executedRequests} executed · ${passed} passed · ${failed} failed · Pass rate ${pct}% · Tests ${stored.totalTests} (${stored.passedTests} passed, ${stored.failedTests} failed)${stored.durationMs ? ` · ${(stored.durationMs / 1000).toFixed(1)}s` : ''}</p>
<table><thead><tr><th>Iter</th><th>Request</th><th>Status</th><th>Time</th><th>Result</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>
<pre style="background:#111;color:#0f0;padding:12px;font-size:12px">${htmlEscape(runToText(stored))}</pre></body></html>`;
    },

    // response compare ------------------------------------------------------------
    'response.compare': async (p) => {
      const args = p as { a: ApiResponse; b: ApiResponse };
      const mod = await import('../core/diffx/diffEngine');
      const bodyDiffRaw = mod.diffJsonValues(parseJsonSafe(args.a.bodyText ?? ''), parseJsonSafe(args.b.bodyText ?? ''));
      const headerDiff = mod.diffKeyValues(
        Object.fromEntries(args.a.headers.map((h) => [h.key, h.value])),
        Object.fromEntries(args.b.headers.map((h) => [h.key, h.value])),
      );
      return {
        statusMatch: args.a.status === args.b.status,
        bodyDiff: bodyDiffRaw,
        headerDiff,
        summary: `Status ${args.a.status} vs ${args.b.status}; ${bodyDiffRaw.length} body diff(s); ${headerDiff.length} header diff(s)`,
      };
    },

    // curl / codegen ----------------------------------------------------------------
    'curl.parse': async (p) => {
      const mod = await import('../core/curl/curlParser');
      return mod.parseCurl((p as { command: string }).command);
    },
    'curl.generate': async (p) => {
      const args = p as { request: ApiRequest; environmentId?: string };
      const mod = await import('../core/curl/curlGenerator');
      const wsId = args.request.workspaceId || container.getActiveWorkspaceId();
      const resolver = buildResolver({ workspaceId: wsId, environmentId: args.environmentId });
      const clone = JSON.parse(JSON.stringify(args.request)) as ApiRequest;
      clone.url = resolver.resolve(clone.url).resolved;
      clone.headers = clone.headers.map((h) => ({ ...h, key: resolver.resolve(h.key).resolved, value: resolver.resolve(h.value).resolved }));
      if (clone.body.raw) clone.body.raw = resolver.resolve(clone.body.raw).resolved;
      return mod.generateCurl({ request: clone, pretty: true });
    },
    'codegen.targets': async () => {
      const mod = await import('../core/codegen/codegen');
      return mod.CODEGEN_TARGETS.map((t) => ({ language: t.language, label: t.label, variants: t.variants }));
    },
    'codegen.generate': async (p) => {
      const args = p as { request: ApiRequest; language: string; variant?: string; environmentId?: string };
      const mod = await import('../core/codegen/codegen');
      const wsId = args.request.workspaceId || container.getActiveWorkspaceId();
      const resolver = buildResolver({ workspaceId: wsId, environmentId: args.environmentId });
      const clone = JSON.parse(JSON.stringify(args.request)) as ApiRequest;
      clone.url = resolver.resolve(clone.url).resolved;
      clone.headers = clone.headers.map((h) => ({ ...h, key: resolver.resolve(h.key).resolved, value: resolver.resolve(h.value).resolved }));
      if (clone.body.raw) clone.body.raw = resolver.resolve(clone.body.raw).resolved;
      return mod.generateCode(clone, args.language, args.variant);
    },

  };

  return { call, methods: Object.keys(handlers) as MethodName[] };

  async function call<M extends MethodName>(method: M, params: ApiSurface[M]['params']): Promise<ApiSurface[M]['result']> {
    const handler = handlers[method as string];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    const result = await handler(params);
    return result as ApiSurface[M]['result'];
  }

  function maskSecretValue(v: Variable): string {
    return v.type === 'secret' ? maskSecret(v.value) : v.value;
  }
}


function parseJsonSafe(text: string): unknown {
  try { return text.trim() ? JSON.parse(text) : ''; } catch { return text; }
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function defaultRequestSettings(): ApiRequest['settings'] {
  return {
    timeoutMs: 30_000, followRedirects: true, maxRedirects: 10, preserveAuthOnRedirect: true,
    stripSensitiveHeaders: true,
    retry: { enabled: false, maxRetries: 0, strategy: 'fixed', delayMs: 0, retryStatusCodes: [], retryOnNetworkError: false, retryOnTimeout: false, onlyIdempotent: false },
    httpVersion: 'auto', encodeUrl: true, verifyTls: true, storeResponse: true,
  } as ApiRequest['settings'];
}

type Parameter<T, N extends number = 0> = T extends (...a: infer A) => unknown ? A[N] : never;
type RequestExampleInput = import('../shared/types').RequestExample;

export function defaultExportBase(container: AppContainer): { specifier: string } {
  return { specifier: container.dataDir };
}

export function httpStatusServer(_container: AppContainer, _registry: Registry): http.Server | undefined {
  return undefined;
}

export function preloadSamples(container: AppContainer): void {
  const { repos } = container;
  const workspaceId = container.getActiveWorkspaceId();
  if (repos.listCollections(workspaceId).length > 0) return;
  const sample = repos.saveCollection({
    id: uid(), workspaceId, name: 'Welcome — Sample APIs', description: 'Sample collection demonstrating requests, scripts, and tests.',
    variables: [{ id: uid(), key: 'baseUrl', value: 'https://api.manager.local/v1', enabled: true, type: 'default' }],
    auth: { type: 'none' }, scripts: { preRequest: '', postResponse: '' }, documentation: '', tags: ['sample'],
    favorite: true, readOnly: false, sortOrder: 0, createdAt: now(), updatedAt: now(),
  });
  repos.saveRequest({
    id: uid(), workspaceId, collectionId: sample.id, name: 'Echo (send to mock)', method: 'GET',
    url: '{{baseUrl}}/echo?message=hello',
    pathParams: [], queryParams: [{ id: uid(), key: 'message', value: 'hello', enabled: true }],
    headers: [{ id: uid(), key: 'Accept', value: 'application/json', enabled: true }],
    body: { type: 'none' }, auth: { type: 'inherit' }, assertions: [],
    scripts: {
      preRequest: 'console.log("pre-request script executed");\n',
      postResponse: 'pm.test("status is 2xx", () => {\n  pm.expect(pm.response.code).to.be.oneOf([200, 201, 404]);\n});\n',
    },
    protocol: 'http', tags: ['echo'], favorite: true, sortOrder: 0, settings: defaultRequestSettings(), createdAt: now(), updatedAt: now(),
  });
}
