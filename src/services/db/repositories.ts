/**
 * Repositories: typed CRUD for every entity (§73). Queryable fields live in
 * columns; rich nested state lives in a `doc` JSON column.
 */
import type { SqliteDb, Row } from './sqlite';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import type {
  ApiEntity, ApiRequest, Attachment, AuditEvent, Certificate, Collection, Dataset,
  Environment, Flow, Folder, GovernanceRule, HistoryEntry, MockServer, Monitor,
  MonitorResult, PerfRun, ProxyProfile, RequestExample, RunResult, ScriptLibraryEntry,
  SecretPattern, Snapshot, Specification, StoredCookie, Tag, Variable, WebhookReceiver,
  WebhookEvent, Workspace, MockRequestLog, Favorite,
} from '../../shared/types';

type Doc = Record<string, unknown>;
const j = (v: unknown): string => JSON.stringify(v ?? {});
const parseDoc = <T>(r: Row | undefined): T => {
  if (!r) return {} as T;
  try { return JSON.parse(String(r.doc ?? '{}')) as T; } catch { return {} as T; }
};

export class Repos {
  constructor(public db: SqliteDb) {}

  // ------------------------------------------------------------------ generic
  private cols(row: Row): string[] { return Object.keys(row); }

  private insert(table: string, row: Row): void {
    const cols = this.cols(row);
    this.db.run(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]));
  }

  private updateRow(table: string, id: string, row: Row): void {
    const cols = this.cols(row).filter((c) => c !== 'id');
    this.db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => row[c]), id]);
  }

  byId<T>(table: string, id: string): T | undefined {
    return this.db.get<T>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  }

  deleteById(table: string, id: string): void {
    this.db.run(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }

  // =============================================================== workspaces
  listWorkspaces(): Workspace[] {
    return this.db.all<Row>('SELECT * FROM workspaces ORDER BY is_default DESC, created_at').map(this.rowToWorkspace);
  }
  getWorkspace(id: string): Workspace | undefined {
    const r = this.byId<Row>('workspaces', id);
    return r ? this.rowToWorkspace(r) : undefined;
  }
  saveWorkspace(w: Workspace): Workspace {
    const existing = this.getWorkspace(w.id);
    const doc: Doc = { settings: w.settings ?? {} };
    const row: Row = {
      id: w.id, name: w.name, description: w.description ?? '', is_default: w.isDefault ? 1 : 0,
      read_only: w.readOnly ? 1 : 0, encrypted: w.encrypted ? 1 : 0, git_repo_path: w.gitRepoPath ?? null,
      doc: j(doc), created_at: existing?.createdAt ?? w.createdAt ?? now(), updated_at: now(),
    };
    if (existing) this.updateRow('workspaces', w.id, row); else this.insert('workspaces', row);
    return { ...w, updatedAt: now() };
  }
  deleteWorkspace(id: string): void { this.deleteById('workspaces', id); }
  private rowToWorkspace(r: Row): Workspace {
    const doc = parseDoc<{ settings?: Record<string, string> }>(r);
    return {
      id: String(r.id), name: String(r.name), description: String(r.description ?? ''),
      isDefault: !!r.is_default, readOnly: !!r.read_only, encrypted: !!r.encrypted,
      gitRepoPath: r.git_repo_path ? String(r.git_repo_path) : undefined,
      settings: doc.settings ?? {}, createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  // =============================================================== collections
  listCollections(workspaceId: string): Collection[] {
    return this.db.all<Row>('SELECT * FROM collections WHERE workspace_id = ? ORDER BY sort_order, name', [workspaceId]).map((r) => this.rowToCollection(r));
  }
  getCollection(id: string): Collection | undefined {
    const r = this.byId<Row>('collections', id);
    return r ? this.rowToCollection(r) : undefined;
  }
  saveCollection(c: Collection): Collection {
    const existing = this.getCollection(c.id);
    const doc: Doc = { variables: c.variables, auth: c.auth, scripts: c.scripts, documentation: c.documentation ?? '', tags: c.tags };
    const row: Row = {
      id: c.id, workspace_id: c.workspaceId, name: c.name, description: c.description ?? '',
      favorite: c.favorite ? 1 : 0, read_only: c.readOnly ? 1 : 0, sort_order: c.sortOrder ?? 0,
      doc: j(doc), created_at: existing?.createdAt ?? c.createdAt ?? now(), updated_at: now(),
    };
    if (existing) this.updateRow('collections', c.id, row); else this.insert('collections', row);
    return { ...c, updatedAt: now() };
  }
  deleteCollection(id: string): void { this.deleteById('collections', id); }
  private rowToCollection(r: Row): Collection {
    const doc = parseDoc<Pick<Collection, 'variables' | 'auth' | 'scripts'> & { documentation?: string; tags?: string[] }>(r);
    return {
      id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name),
      description: String(r.description ?? ''), variables: doc.variables ?? [],
      auth: doc.auth ?? { type: 'none' }, scripts: doc.scripts ?? { preRequest: '', postResponse: '' },
      documentation: doc.documentation, tags: doc.tags ?? [], favorite: !!r.favorite, readOnly: !!r.read_only,
      sortOrder: Number(r.sort_order ?? 0), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  // ================================================================== folders
  listFolders(collectionId: string): Folder[] {
    return this.db.all<Row>('SELECT * FROM folders WHERE collection_id = ? ORDER BY sort_order, name', [collectionId]).map((r) => this.rowToFolder(r));
  }
  getFolder(id: string): Folder | undefined {
    const r = this.byId<Row>('folders', id);
    return r ? this.rowToFolder(r) : undefined;
  }
  saveFolder(f: Folder): Folder {
    const existing = this.getFolder(f.id);
    const doc: Doc = { description: f.description ?? '', auth: f.auth, scripts: f.scripts };
    const row: Row = {
      id: f.id, collection_id: f.collectionId, parent_folder_id: f.parentFolderId ?? null,
      name: f.name, sort_order: f.sortOrder ?? 0, doc: j(doc),
      created_at: existing?.createdAt ?? f.createdAt ?? now(), updated_at: now(),
    };
    if (existing) this.updateRow('folders', f.id, row); else this.insert('folders', row);
    return { ...f, updatedAt: now() };
  }
  deleteFolder(id: string): void { this.deleteById('folders', id); }
  private rowToFolder(r: Row): Folder {
    const doc = parseDoc<{ description?: string; auth?: Folder['auth']; scripts?: Folder['scripts'] }>(r);
    return {
      id: String(r.id), collectionId: String(r.collection_id),
      parentFolderId: r.parent_folder_id ? String(r.parent_folder_id) : undefined,
      name: String(r.name), description: doc.description, auth: doc.auth ?? { type: 'none' },
      scripts: doc.scripts ?? { preRequest: '', postResponse: '' }, sortOrder: Number(r.sort_order ?? 0),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  // ================================================================= requests
  listRequests(workspaceId: string, filter: { collectionId?: string; folderId?: string; search?: string; limit?: number; offset?: number } = {}): { items: ApiRequest[]; total: number } {
    const where: string[] = ['workspace_id = ?'];
    const params: unknown[] = [workspaceId];
    if (filter.collectionId) { where.push('collection_id = ?'); params.push(filter.collectionId); }
    if (filter.folderId) { where.push('folder_id = ?'); params.push(filter.folderId); }
    if (filter.search) { where.push('(name LIKE ? OR url LIKE ?)'); params.push(`%${filter.search}%`, `%${filter.search}%`); }
    const whereSql = where.join(' AND ');
    const total = Number(this.db.scalar(`SELECT COUNT(*) FROM requests WHERE ${whereSql}`, params) ?? 0);
    const rows = this.db.all<Row>(`SELECT * FROM requests WHERE ${whereSql} ORDER BY sort_order, created_at LIMIT ? OFFSET ?`, [...params, filter.limit ?? 1000, filter.offset ?? 0]);
    return { items: rows.map((r) => this.rowToRequest(r)), total };
  }
  allRequests(workspaceId: string): ApiRequest[] {
    return this.db.all<Row>('SELECT * FROM requests WHERE workspace_id = ? ORDER BY sort_order, created_at', [workspaceId]).map((r) => this.rowToRequest(r));
  }
  getRequest(id: string): ApiRequest | undefined {
    const r = this.byId<Row>('requests', id);
    return r ? this.rowToRequest(r) : undefined;
  }
  saveRequest(r: ApiRequest): ApiRequest {
    const existing = this.getRequest(r.id);
    const doc: Doc = {
      description: r.description ?? '', pathParams: r.pathParams, queryParams: r.queryParams,
      headers: r.headers, auth: r.auth, body: r.body, scripts: r.scripts, assertions: r.assertions,
      settings: r.settings, documentation: r.documentation, protocolData: r.protocolData ?? null,
    };
    const row: Row = {
      id: r.id, workspace_id: r.workspaceId, collection_id: r.collectionId ?? null,
      folder_id: r.folderId ?? null, name: r.name, method: r.method, url: r.url,
      protocol: r.protocol, favorite: r.favorite ? 1 : 0, sort_order: r.sortOrder ?? 0,
      tags: JSON.stringify(r.tags ?? []), doc: j(doc),
      created_at: existing?.createdAt ?? r.createdAt ?? now(), updated_at: now(),
    };
    if (existing) this.updateRow('requests', r.id, row); else this.insert('requests', row);
    return { ...r, updatedAt: now() };
  }
  deleteRequest(id: string): void { this.deleteById('requests', id); }
  private rowToRequest(r: Row): ApiRequest {
    const doc = parseDoc<Record<string, never>>(r) as unknown as ApiRequest & { protocolData?: ApiRequest['protocolData'] };
    return {
      id: String(r.id), workspaceId: String(r.workspace_id),
      collectionId: r.collection_id ? String(r.collection_id) : undefined,
      folderId: r.folder_id ? String(r.folder_id) : undefined,
      name: String(r.name), description: doc.description ?? '', method: String(r.method),
      url: String(r.url), protocol: (String(r.protocol) || 'http') as ApiRequest['protocol'],
      protocolData: doc.protocolData ?? undefined,
      pathParams: doc.pathParams ?? [], queryParams: doc.queryParams ?? [], headers: doc.headers ?? [],
      auth: doc.auth ?? { type: 'none' }, body: doc.body ?? { type: 'none' },
      scripts: doc.scripts ?? { preRequest: '', postResponse: '' }, assertions: doc.assertions ?? [],
      settings: doc.settings ?? ({} as ApiRequest['settings']), documentation: doc.documentation,
      tags: safeJsonArray(r.tags), favorite: !!r.favorite, sortOrder: Number(r.sort_order ?? 0),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  // ================================================================= examples
  listExamples(requestId: string): RequestExample[] {
    return this.db.all<Row>('SELECT * FROM examples WHERE request_id = ? ORDER BY created_at', [requestId]).map((r) => ({
      ...(parseDoc<RequestExample>(r)), id: String(r.id), requestId: String(r.request_id), name: String(r.name),
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    }));
  }
  saveExample(e: RequestExample): RequestExample {
    const { id, requestId, name, ...rest } = e;
    const doc = j({ ...rest });
    const existing = this.byId<Row>('examples', id);
    const row: Row = { id, request_id: requestId, name, doc, created_at: existing ? String(existing.created_at) : e.createdAt ?? now(), updated_at: now() };
    if (existing) this.updateRow('examples', id, row); else this.insert('examples', row);
    return { ...e, updatedAt: now() };
  }
  deleteExample(id: string): void { this.deleteById('examples', id); }
  getExample(id: string): RequestExample | undefined {
    const r = this.byId<Row>('examples', id);
    return r ? { ...parseDoc<RequestExample>(r), id: String(r.id), requestId: String(r.request_id), name: String(r.name), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : undefined;
  }

  // ================================================================ responses
  saveResponse(workspaceId: string, response: import('../../shared/types').ApiResponse): void {
    this.insert('responses', {
      id: response.id, workspace_id: workspaceId, request_id: response.requestId ?? null,
      status: response.status, duration_ms: response.timing.totalMs, size: response.bodySize,
      doc: j(response), created_at: response.timestamp,
    });
  }
  getResponse(id: string): import('../../shared/types').ApiResponse | undefined {
    const r = this.byId<Row>('responses', id);
    return r ? parseDoc<import('../../shared/types').ApiResponse>(r) : undefined;
  }
  recentResponses(requestId: string, limit = 20): import('../../shared/types').ApiResponse[] {
    return this.db.all<Row>('SELECT doc FROM responses WHERE request_id = ? ORDER BY created_at DESC LIMIT ?', [requestId, limit])
      .map((r) => parseDoc<import('../../shared/types').ApiResponse>(r));
  }
  pruneResponses(olderThanIso: string): number {
    const before = Number(this.db.scalar('SELECT COUNT(*) FROM responses WHERE created_at < ?', [olderThanIso]) ?? 0);
    this.db.run('DELETE FROM responses WHERE created_at < ?', [olderThanIso]);
    return before;
  }
  countResponses(workspaceId: string): number {
    return Number(this.db.scalar('SELECT COUNT(*) FROM responses WHERE workspace_id = ?', [workspaceId]) ?? 0);
  }
  avgResponseStats(workspaceId: string): { totalSends: number; avgMs: number; errorRate: number } {
    const r = this.db.get<Row>('SELECT COUNT(*) AS c, AVG(duration_ms) AS a, SUM(CASE WHEN status >= 400 OR status IS NULL THEN 1 ELSE 0 END) * 1.0 AS e FROM responses WHERE workspace_id = ?', [workspaceId]);
    const c = Number(r?.c ?? 0);
    return { totalSends: c, avgMs: Number(r?.a ?? 0), errorRate: c > 0 ? Number(r?.e ?? 0) / c : 0 };
  }

  // ============================================================= environments
  listEnvironments(workspaceId: string): Environment[] {
    return this.db.all<Row>('SELECT * FROM environments WHERE workspace_id = ? ORDER BY sort_order, name', [workspaceId]).map((r) => this.rowToEnvironment(r));
  }
  getEnvironment(id: string): Environment | undefined {
    const r = this.byId<Row>('environments', id);
    return r ? this.rowToEnvironment(r) : undefined;
  }
  saveEnvironment(e: Environment): Environment {
    const existing = this.getEnvironment(e.id);
    const row: Row = {
      id: e.id, workspace_id: e.workspaceId, name: e.name, sort_order: e.sortOrder ?? 0,
      doc: j({ variables: e.variables, color: e.color ?? null, extendsEnvironmentId: e.extendsEnvironmentId ?? null }),
      created_at: existing?.createdAt ?? e.createdAt ?? now(), updated_at: now(),
    };
    if (existing) this.updateRow('environments', e.id, row); else this.insert('environments', row);
    return { ...e, updatedAt: now() };
  }
  deleteEnvironment(id: string): void { this.deleteById('environments', id); }
  private rowToEnvironment(r: Row): Environment {
    const doc = parseDoc<{ variables?: Variable[]; color?: string; extendsEnvironmentId?: string }>(r);
    return {
      id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name),
      variables: doc.variables ?? [], color: doc.color, extendsEnvironmentId: doc.extendsEnvironmentId ?? undefined,
      sortOrder: Number(r.sort_order ?? 0), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  // ================================================================= kv_store
  getKv(workspaceId: string, scope: string): Doc {
    const r = this.db.get<Row>('SELECT doc FROM kv_store WHERE workspace_id = ? AND scope = ?', [workspaceId, scope]);
    return parseDoc<Doc>(r);
  }
  setKv(workspaceId: string, scope: string, doc: Doc): void {
    this.db.run('INSERT INTO kv_store (workspace_id, scope, doc, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, scope) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at',
      [workspaceId, scope, j(doc), now()]);
  }

  // =================================================================== cookies
  listCookies(workspaceId: string, domain?: string): StoredCookie[] {
    const rows = domain
      ? this.db.all<Row>('SELECT * FROM cookies WHERE workspace_id = ? AND (domain = ? OR domain LIKE ?)', [workspaceId, domain, `%.${domain}`])
      : this.db.all<Row>('SELECT * FROM cookies WHERE workspace_id = ?', [workspaceId]);
    return rows.map((r) => parseDoc<StoredCookie>(r));
  }
  upsertCookie(workspaceId: string, cookie: StoredCookie): void {
    this.db.run(
      `INSERT INTO cookies (id, workspace_id, name, domain, path, doc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, name, domain, path) DO UPDATE SET doc = excluded.doc`,
      [uid(), workspaceId, cookie.name, cookie.domain, cookie.path || '/', j(cookie), now()],
    );
  }
  deleteCookie(workspaceId: string, name: string, domain: string, path: string): void {
    this.db.run('DELETE FROM cookies WHERE workspace_id = ? AND name = ? AND domain = ? AND path = ?', [workspaceId, name, domain, path || '/']);
  }
  clearCookies(workspaceId: string, domain?: string): void {
    if (domain) this.db.run('DELETE FROM cookies WHERE workspace_id = ? AND (domain = ? OR domain LIKE ?)', [workspaceId, domain, `%.${domain}`]);
    else this.db.run('DELETE FROM cookies WHERE workspace_id = ?', [workspaceId]);
  }

  // =================================================================== history
  addHistory(entry: HistoryEntry): void {
    const { id, workspaceId, ...rest } = entry;
    this.insert('history', {
      id, workspace_id: workspaceId, request_id: entry.requestId ?? null, name: entry.name,
      method: entry.method, url: entry.url, status: entry.status ?? null, duration_ms: entry.durationMs ?? null,
      doc: j(rest), timestamp: entry.timestamp,
    });
  }
  listHistory(workspaceId: string, opts: { search?: string; limit?: number; offset?: number } = {}): { items: HistoryEntry[]; total: number } {
    const params: unknown[] = [workspaceId];
    let where = 'workspace_id = ?';
    if (opts.search) { where += ' AND (name LIKE ? OR url LIKE ?)'; params.push(`%${opts.search}%`, `%${opts.search}%`); }
    const total = Number(this.db.scalar(`SELECT COUNT(*) FROM history WHERE ${where}`, params) ?? 0);
    const rows = this.db.all<Row>(`SELECT * FROM history WHERE ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`, [...params, opts.limit ?? 200, opts.offset ?? 0]);
    const items = rows.map((r) => parseDoc<HistoryEntry & { id: string; workspaceId: string }>(r));
    return { items: items.map((it, i) => ({ ...it, id: String(rows[i].id), workspaceId, timestamp: String(rows[i].timestamp) })), total };
  }
  getHistory(id: string): HistoryEntry | undefined {
    const r = this.byId<Row>('history', id);
    if (!r) return undefined;
    return { ...parseDoc<HistoryEntry>(r), id: String(r.id), workspaceId: String(r.workspace_id), timestamp: String(r.timestamp) };
  }
  deleteHistory(id: string): void { this.deleteById('history', id); }
  clearHistory(workspaceId: string): void { this.db.run('DELETE FROM history WHERE workspace_id = ?', [workspaceId]); }
  pruneHistory(olderThanIso: string): number {
    const c = Number(this.db.scalar('SELECT COUNT(*) FROM history WHERE timestamp < ?', [olderThanIso]) ?? 0);
    this.db.run('DELETE FROM history WHERE timestamp < ?', [olderThanIso]);
    return c;
  }
  countHistory(workspaceId: string): number { return Number(this.db.scalar('SELECT COUNT(*) FROM history WHERE workspace_id = ?', [workspaceId]) ?? 0); }

  // ================================================================= runs
  saveRun(workspaceId: string, run: RunResult): void {
    const existing = this.byId<Row>('runs', run.id);
    const row: Row = { id: run.id, workspace_id: workspaceId, status: run.status, doc: j(run), started_at: run.startedAt, finished_at: run.finishedAt ?? null };
    if (existing) this.updateRow('runs', run.id, row); else this.insert('runs', row);
  }
  getRun(runId: string): RunResult | undefined {
    const r = this.byId<Row>('runs', runId);
    return r ? parseDoc<RunResult>(r) : undefined;
  }
  listRuns(workspaceId: string, limit = 50): RunResult[] {
    return this.db.all<Row>('SELECT doc FROM runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT ?', [workspaceId, limit]).map((r) => parseDoc<RunResult>(r));
  }
  deleteRun(runId: string): void { this.deleteById('runs', runId); }

  // ================================================================= flows
  listFlows(workspaceId: string): Flow[] {
    return this.db.all<Row>('SELECT * FROM flows WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ ...parseDoc<Flow>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), version: Number(r.version ?? 1), createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }
  getFlow(id: string): Flow | undefined {
    const r = this.byId<Row>('flows', id);
    return r ? { ...parseDoc<Flow>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), version: Number(r.version ?? 1), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : undefined;
  }
  saveFlow(f: Flow): Flow {
    const existing = this.byId<Row>('flows', f.id);
    const { id, workspaceId, name, version, ...rest } = f;
    const row: Row = { id, workspace_id: workspaceId, name, version: version ?? 1, doc: j(rest), created_at: existing ? String(existing.created_at) : f.createdAt ?? now(), updated_at: now() };
    if (existing) this.updateRow('flows', id, row); else this.insert('flows', row);
    return { ...f, updatedAt: now() };
  }
  deleteFlow(id: string): void { this.deleteById('flows', id); }
  saveFlowRun(flowId: string, run: import('../../shared/types').FlowRun, workspaceId?: string): void {
    const existing = this.byId<Row>('flow_runs', run.id);
    const row: Row = { id: run.id, flow_id: flowId, workspace_id: workspaceId ?? null, status: run.status, doc: j(run), started_at: run.startedAt, finished_at: run.finishedAt ?? null };
    if (existing) this.updateRow('flow_runs', run.id, row); else this.insert('flow_runs', row);
  }
  getFlowRun(runId: string): import('../../shared/types').FlowRun | undefined {
    const r = this.byId<Row>('flow_runs', runId);
    return r ? parseDoc<import('../../shared/types').FlowRun>(r) : undefined;
  }

  // ================================================================= mocks
  listMocks(workspaceId: string): MockServer[] {
    return this.db.all<Row>('SELECT * FROM mocks WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ ...parseDoc<MockServer>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), port: Number(r.port), running: !!r.running, createdAt: String(r.created_at) }));
  }
  getMock(id: string): MockServer | undefined {
    const r = this.byId<Row>('mocks', id);
    return r ? { ...parseDoc<MockServer>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), port: Number(r.port), running: !!r.running, createdAt: String(r.created_at) } : undefined;
  }
  saveMock(m: MockServer): MockServer {
    const existing = this.byId<Row>('mocks', m.id);
    const { id, workspaceId, name, port, running, ...rest } = m;
    const row: Row = { id, workspace_id: workspaceId, name, port, running: running ? 1 : 0, doc: j(rest), created_at: existing ? String(existing.created_at) : m.createdAt ?? now() };
    if (existing) this.updateRow('mocks', id, row); else this.insert('mocks', row);
    return m;
  }
  deleteMock(id: string): void { this.db.run('DELETE FROM mock_logs WHERE mock_id = ?', [id]); this.deleteById('mocks', id); }
  addMockLog(log: MockRequestLog): void {
    this.insert('mock_logs', { id: log.id, mock_id: log.mockId, timestamp: log.timestamp, doc: j(log) });
    this.db.run('DELETE FROM mock_logs WHERE mock_id = ? AND id NOT IN (SELECT id FROM mock_logs WHERE mock_id = ? ORDER BY timestamp DESC LIMIT 500)', [log.mockId, log.mockId]);
  }
  listMockLogs(mockId: string, limit = 200): MockRequestLog[] {
    return this.db.all<Row>('SELECT doc FROM mock_logs WHERE mock_id = ? ORDER BY timestamp DESC LIMIT ?', [mockId, limit]).map((r) => parseDoc<MockRequestLog>(r));
  }

  // ================================================================ monitors
  listMonitors(workspaceId: string): Monitor[] {
    return this.db.all<Row>('SELECT * FROM monitors WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ ...parseDoc<Monitor>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), enabled: !!r.enabled, createdAt: String(r.created_at) }));
  }
  allEnabledMonitors(): Monitor[] {
    return this.db.all<Row>('SELECT * FROM monitors WHERE enabled = 1').map((r) => ({ ...parseDoc<Monitor>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), enabled: !!r.enabled, createdAt: String(r.created_at) }));
  }
  getMonitor(id: string): Monitor | undefined {
    const r = this.byId<Row>('monitors', id);
    return r ? { ...parseDoc<Monitor>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), enabled: !!r.enabled, createdAt: String(r.created_at) } : undefined;
  }
  saveMonitor(m: Monitor): Monitor {
    const existing = this.byId<Row>('monitors', m.id);
    const { id, workspaceId, name, enabled, ...rest } = m;
    const row: Row = { id, workspace_id: workspaceId, name, enabled: enabled ? 1 : 0, doc: j(rest), created_at: existing ? String(existing.created_at) : m.createdAt ?? now() };
    if (existing) this.updateRow('monitors', id, row); else this.insert('monitors', row);
    return m;
  }
  deleteMonitor(id: string): void { this.db.run('DELETE FROM monitor_results WHERE monitor_id = ?', [id]); this.deleteById('monitors', id); }
  addMonitorResult(result: MonitorResult): void {
    this.insert('monitor_results', { id: result.id, monitor_id: result.monitorId, timestamp: result.timestamp, doc: j(result) });
    this.db.run('DELETE FROM monitor_results WHERE monitor_id = ? AND id NOT IN (SELECT id FROM monitor_results WHERE monitor_id = ? ORDER BY timestamp DESC LIMIT 200)', [result.monitorId, result.monitorId]);
  }
  listMonitorResults(monitorId: string, limit = 100): MonitorResult[] {
    return this.db.all<Row>('SELECT doc FROM monitor_results WHERE monitor_id = ? ORDER BY timestamp DESC LIMIT ?', [monitorId, limit]).map((r) => parseDoc<MonitorResult>(r));
  }

  // ================================================================ datasets
  listDatasets(workspaceId: string): Dataset[] {
    return this.db.all<Row>('SELECT * FROM datasets WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ ...parseDoc<Dataset>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), format: (String(r.format) || 'csv') as Dataset['format'], createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }
  getDataset(id: string): Dataset | undefined {
    const r = this.byId<Row>('datasets', id);
    return r ? { ...parseDoc<Dataset>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), format: (String(r.format) || 'csv') as Dataset['format'], createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : undefined;
  }
  saveDataset(d: Dataset): Dataset {
    const existing = this.byId<Row>('datasets', d.id);
    const { id, workspaceId, name, format, ...rest } = d;
    const row: Row = { id, workspace_id: workspaceId, name, format, doc: j(rest), created_at: existing ? String(existing.created_at) : d.createdAt ?? now(), updated_at: now() };
    if (existing) this.updateRow('datasets', id, row); else this.insert('datasets', row);
    return { ...d, updatedAt: now() };
  }
  deleteDataset(id: string): void { this.deleteById('datasets', id); }

  // ==================================================================== specs
  listSpecs(workspaceId: string): Specification[] {
    return this.db.all<Row>('SELECT * FROM specs WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => this.rowToSpec(r));
  }
  getSpec(id: string): Specification | undefined {
    const r = this.byId<Row>('specs', id);
    return r ? this.rowToSpec(r) : undefined;
  }
  saveSpec(s: Specification): Specification {
    const existing = this.getSpec(s.id);
    const { id, workspaceId, name, format, lifecycle, ...rest } = s;
    const row: Row = { id, workspace_id: workspaceId, name, format, lifecycle, doc: j(rest), created_at: existing?.createdAt ?? s.createdAt ?? now(), updated_at: now() };
    if (existing) this.updateRow('specs', id, row); else this.insert('specs', row);
    return { ...s, updatedAt: now() };
  }
  deleteSpec(id: string): void { this.deleteById('specs', id); }
  private rowToSpec(r: Row): Specification {
    const doc = parseDoc<Omit<Specification, 'id' | 'workspaceId' | 'name' | 'format' | 'lifecycle'>>(r);
    return {
      ...doc, id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name),
      format: String(r.format) as Specification['format'], lifecycle: (String(r.lifecycle) || 'Draft') as Specification['lifecycle'],
      createdAt: String(r.created_at), updatedAt: String(r.updated_at),
    };
  }

  // ===================================================================== apis
  listApis(workspaceId: string): ApiEntity[] {
    return this.db.all<Row>('SELECT * FROM apis WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ ...parseDoc<ApiEntity>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), lifecycle: String(r.lifecycle) as ApiEntity['lifecycle'], version: String(r.version ?? '1.0.0'), createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }
  getApi(id: string): ApiEntity | undefined {
    const r = this.byId<Row>('apis', id);
    return r ? { ...parseDoc<ApiEntity>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), lifecycle: String(r.lifecycle) as ApiEntity['lifecycle'], version: String(r.version ?? '1.0.0'), createdAt: String(r.created_at), updatedAt: String(r.updated_at) } : undefined;
  }
  saveApi(a: ApiEntity): ApiEntity {
    const existing = this.byId<Row>('apis', a.id);
    const { id, workspaceId, name, lifecycle, version, ...rest } = a;
    const row: Row = { id, workspace_id: workspaceId, name, lifecycle, version, doc: j(rest), created_at: existing ? String(existing.created_at) : a.createdAt ?? now(), updated_at: now() };
    if (existing) this.updateRow('apis', id, row); else this.insert('apis', row);
    return { ...a, updatedAt: now() };
  }
  deleteApi(id: string): void { this.deleteById('apis', id); }

  // ================================================================== webhooks
  listWebhooks(workspaceId: string): WebhookReceiver[] {
    return this.db.all<Row>('SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ ...parseDoc<WebhookReceiver>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), port: Number(r.port), running: !!r.running, createdAt: String(r.created_at) }));
  }
  getWebhook(id: string): WebhookReceiver | undefined {
    const r = this.byId<Row>('webhooks', id);
    return r ? { ...parseDoc<WebhookReceiver>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), port: Number(r.port), running: !!r.running, createdAt: String(r.created_at) } : undefined;
  }
  saveWebhook(w: WebhookReceiver): WebhookReceiver {
    const existing = this.byId<Row>('webhooks', w.id);
    const { id, workspaceId, name, port, running, ...rest } = w;
    const row: Row = { id, workspace_id: workspaceId, name, port, running: running ? 1 : 0, doc: j(rest), created_at: existing ? String(existing.created_at) : w.createdAt ?? now() };
    if (existing) this.updateRow('webhooks', id, row); else this.insert('webhooks', row);
    return w;
  }
  deleteWebhook(id: string): void { this.db.run('DELETE FROM webhook_events WHERE webhook_id = ?', [id]); this.deleteById('webhooks', id); }
  addWebhookEvent(ev: WebhookEvent): void {
    this.insert('webhook_events', { id: ev.id, webhook_id: ev.webhookId, timestamp: ev.timestamp, doc: j(ev) });
    this.db.run('DELETE FROM webhook_events WHERE webhook_id = ? AND id NOT IN (SELECT id FROM webhook_events WHERE webhook_id = ? ORDER BY timestamp DESC LIMIT 500)', [ev.webhookId, ev.webhookId]);
  }
  listWebhookEvents(webhookId: string, limit = 200): WebhookEvent[] {
    return this.db.all<Row>('SELECT doc FROM webhook_events WHERE webhook_id = ? ORDER BY timestamp DESC LIMIT ?', [webhookId, limit]).map((r) => parseDoc<WebhookEvent>(r));
  }
  findWebhookEvent(id: string): WebhookEvent | undefined {
    const r = this.db.get<Row>('SELECT doc FROM webhook_events WHERE id = ?', [id]);
    return r ? parseDoc<WebhookEvent>(r) : undefined;
  }

  // ==================================================================== audit
  addAudit(e: AuditEvent): void {
    this.insert('audit_events', { id: e.id, workspace_id: e.workspaceId ?? null, timestamp: e.timestamp, category: e.category, action: e.action, detail: e.detail ?? null, severity: e.severity ?? 'info' });
  }
  listAudit(filter: { workspaceId?: string; category?: string; search?: string; from?: string; to?: string; limit?: number; offset?: number }): { items: AuditEvent[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.workspaceId) { where.push('(workspace_id = ? OR workspace_id IS NULL)'); params.push(filter.workspaceId); }
    if (filter.category) { where.push('category = ?'); params.push(filter.category); }
    if (filter.search) { where.push('(action LIKE ? OR detail LIKE ?)'); params.push(`%${filter.search}%`, `%${filter.search}%`); }
    if (filter.from) { where.push('timestamp >= ?'); params.push(filter.from); }
    if (filter.to) { where.push('timestamp <= ?'); params.push(filter.to); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(this.db.scalar(`SELECT COUNT(*) FROM audit_events ${whereSql}`, params) ?? 0);
    const rows = this.db.all<Row>(`SELECT * FROM audit_events ${whereSql} ORDER BY timestamp DESC LIMIT ? OFFSET ?`, [...params, filter.limit ?? 200, filter.offset ?? 0]);
    return {
      items: rows.map((r) => ({ id: String(r.id), workspaceId: r.workspace_id ? String(r.workspace_id) : undefined, timestamp: String(r.timestamp), category: String(r.category) as AuditEvent['category'], action: String(r.action), detail: r.detail ? String(r.detail) : undefined, severity: (String(r.severity) || 'info') as AuditEvent['severity'] })),
      total,
    };
  }
  pruneAudit(olderThanIso: string): number {
    const c = Number(this.db.scalar('SELECT COUNT(*) FROM audit_events WHERE timestamp < ?', [olderThanIso]) ?? 0);
    this.db.run('DELETE FROM audit_events WHERE timestamp < ?', [olderThanIso]);
    return c;
  }

  // ============================================================ script library
  listScripts(workspaceId?: string, search?: string): ScriptLibraryEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (workspaceId) { where.push('(workspace_id = ? OR workspace_id IS NULL)'); params.push(workspaceId); }
    if (search) { where.push('(name LIKE ? OR doc LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
    const rows = this.db.all<Row>(`SELECT * FROM script_library ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`, params);
    return rows.map((r) => ({ ...parseDoc<ScriptLibraryEntry>(r), id: String(r.id), workspaceId: r.workspace_id ? String(r.workspace_id) : undefined, name: String(r.name), version: Number(r.version ?? 1), tags: safeJsonArray(r.tags), createdAt: String(r.created_at), updatedAt: String(r.updated_at) }));
  }
  saveScript(e: ScriptLibraryEntry): ScriptLibraryEntry {
    const existing = this.byId<Row>('script_library', e.id);
    const { id, workspaceId, name, version, tags, ...rest } = e;
    const row: Row = { id, workspace_id: workspaceId ?? null, name, version: version ?? 1, tags: JSON.stringify(tags ?? []), doc: j(rest), created_at: existing ? String(existing.created_at) : e.createdAt ?? now(), updated_at: now() };
    if (existing) this.updateRow('script_library', id, row); else this.insert('script_library', row);
    return { ...e, updatedAt: now() };
  }
  deleteScript(id: string): void { this.deleteById('script_library', id); }

  // ================================================================ snapshots
  listSnapshots(requestId: string): Snapshot[] {
    return this.db.all<Row>('SELECT * FROM snapshots WHERE request_id = ? ORDER BY created_at DESC', [requestId]).map((r) => ({ ...parseDoc<Snapshot>(r), id: String(r.id), workspaceId: String(r.workspace_id), requestId: String(r.request_id), name: String(r.name), createdAt: String(r.created_at) }));
  }
  saveSnapshot(s: Snapshot): Snapshot {
    const existing = this.byId<Row>('snapshots', s.id);
    const { id, workspaceId, requestId, name, ...rest } = s;
    const row: Row = { id, workspace_id: workspaceId, request_id: requestId, name, doc: j(rest), created_at: existing ? String(existing.created_at) : s.createdAt ?? now() };
    if (existing) this.updateRow('snapshots', id, row); else this.insert('snapshots', row);
    return s;
  }
  deleteSnapshot(id: string): void { this.deleteById('snapshots', id); }
  getSnapshot(id: string): Snapshot | undefined {
    const r = this.byId<Row>('snapshots', id);
    return r ? { ...parseDoc<Snapshot>(r), id: String(r.id), workspaceId: String(r.workspace_id), requestId: String(r.request_id), name: String(r.name), createdAt: String(r.created_at) } : undefined;
  }

  // =========================================== certificates, proxies, misc
  listCertificates(workspaceId: string): Certificate[] {
    return this.db.all<Row>('SELECT * FROM certificates WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ ...parseDoc<Certificate>(r), id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), createdAt: String(r.created_at) }));
  }
  saveCertificate(c: Certificate): Certificate {
    const existing = this.byId<Row>('certificates', c.id);
    const { id, workspaceId, name, ...rest } = c;
    const row: Row = { id, workspace_id: workspaceId, name, doc: j(rest), created_at: existing ? String(existing.created_at) : c.createdAt ?? now() };
    if (existing) this.updateRow('certificates', id, row); else this.insert('certificates', row);
    return c;
  }
  deleteCertificate(id: string): void { this.deleteById('certificates', id); }

  listProxies(workspaceId?: string): ProxyProfile[] {
    const rows = workspaceId
      ? this.db.all<Row>('SELECT * FROM proxies WHERE workspace_id = ? OR workspace_id IS NULL ORDER BY name', [workspaceId])
      : this.db.all<Row>('SELECT * FROM proxies ORDER BY name');
    return rows.map((r) => ({ ...parseDoc<ProxyProfile>(r), id: String(r.id), workspaceId: r.workspace_id ? String(r.workspace_id) : undefined, name: String(r.name), createdAt: String(r.created_at) }));
  }
  saveProxy(p: ProxyProfile): ProxyProfile {
    const existing = this.byId<Row>('proxies', p.id);
    const { id, workspaceId, name, ...rest } = p;
    const row: Row = { id, workspace_id: workspaceId ?? null, name, doc: j(rest), created_at: existing ? String(existing.created_at) : p.createdAt ?? now() };
    if (existing) this.updateRow('proxies', id, row); else this.insert('proxies', row);
    return p;
  }
  deleteProxy(id: string): void { this.deleteById('proxies', id); }

  listAttachments(workspaceId: string): Attachment[] {
    return this.db.all<Row>('SELECT * FROM attachments WHERE workspace_id = ? ORDER BY relative_path', [workspaceId]).map((r) => ({ ...parseDoc<Attachment>(r), id: String(r.id), workspaceId: String(r.workspace_id), relativePath: String(r.relative_path), fileName: String(r.file_name), size: Number(r.size ?? 0), createdAt: String(r.created_at) }));
  }
  saveAttachment(a: Attachment): Attachment {
    this.db.run(
      `INSERT INTO attachments (id, workspace_id, relative_path, file_name, size, doc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, relative_path) DO UPDATE SET file_name = excluded.file_name, size = excluded.size, doc = excluded.doc`,
      [a.id, a.workspaceId, a.relativePath, a.fileName, a.size, j({ mimeType: a.mimeType, sha256: a.sha256, missing: a.missing, references: a.references }), a.createdAt ?? now()],
    );
    return a;
  }
  deleteAttachment(id: string): void { this.deleteById('attachments', id); }

  listGovernanceRules(workspaceId?: string): GovernanceRule[] {
    const rows = workspaceId
      ? this.db.all<Row>('SELECT * FROM governance_rules WHERE workspace_id = ? OR workspace_id IS NULL', [workspaceId])
      : this.db.all<Row>('SELECT * FROM governance_rules');
    return rows.map((r) => ({ ...parseDoc<GovernanceRule>(r), id: String(r.id), workspaceId: r.workspace_id ? String(r.workspace_id) : undefined, kind: String(r.kind) as GovernanceRule['kind'], name: String(r.name), enabled: !!r.enabled }));
  }
  saveGovernanceRule(r: GovernanceRule): GovernanceRule {
    const existing = this.byId<Row>('governance_rules', r.id);
    const { id, workspaceId, kind, name, enabled, config } = r;
    const row: Row = { id, workspace_id: workspaceId ?? null, kind, name, enabled: enabled ? 1 : 0, doc: j({ config: config ?? {} }) };
    if (existing) this.updateRow('governance_rules', id, row); else this.insert('governance_rules', row);
    return r;
  }
  deleteGovernanceRule(id: string): void { this.deleteById('governance_rules', id); }

  listSecretPatterns(): SecretPattern[] {
    return this.db.all<Row>('SELECT * FROM secret_patterns ORDER BY name').map((r) => ({ id: String(r.id), name: String(r.name), pattern: String(r.pattern), severity: String(r.severity) as SecretPattern['severity'], builtin: !!r.builtin }));
  }
  saveSecretPattern(p: SecretPattern): void {
    const existing = this.byId<Row>('secret_patterns', p.id);
    const row: Row = { id: p.id, name: p.name, pattern: p.pattern, severity: p.severity, builtin: p.builtin ? 1 : 0 };
    if (existing) this.updateRow('secret_patterns', p.id, row); else this.insert('secret_patterns', row);
  }
  deleteSecretPattern(id: string): void { this.deleteById('secret_patterns', id); }
  seedSecretPatterns(patterns: SecretPattern[]): void {
    const existing = this.listSecretPatterns();
    if (existing.length > 0) return;
    for (const p of patterns) this.saveSecretPattern(p);
  }

  listFavorites(workspaceId: string): Favorite[] {
    return this.db.all<Row>('SELECT * FROM favorites WHERE workspace_id = ? ORDER BY sort_order', [workspaceId]).map((r) => ({ id: String(r.id), workspaceId: String(r.workspace_id), entityType: String(r.entity_type) as Favorite['entityType'], entityId: String(r.entity_id), sortOrder: Number(r.sort_order ?? 0) }));
  }
  toggleFavorite(workspaceId: string, entityType: Favorite['entityType'], entityId: string): boolean {
    const existing = this.db.get<Row>('SELECT id FROM favorites WHERE workspace_id = ? AND entity_type = ? AND entity_id = ?', [workspaceId, entityType, entityId]);
    if (existing) { this.deleteById('favorites', String(existing.id)); return false; }
    this.insert('favorites', { id: uid(), workspace_id: workspaceId, entity_type: entityType, entity_id: entityId, sort_order: Date.now() });
    return true;
  }

  listTags(workspaceId: string): Tag[] {
    return this.db.all<Row>('SELECT * FROM tags WHERE workspace_id = ? ORDER BY name', [workspaceId]).map((r) => ({ id: String(r.id), workspaceId: String(r.workspace_id), name: String(r.name), color: r.color ? String(r.color) : undefined }));
  }
  saveTag(t: Tag): Tag {
    this.db.run('INSERT INTO tags (id, workspace_id, name, color) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, name) DO UPDATE SET color = excluded.color', [t.id, t.workspaceId, t.name, t.color ?? null]);
    return t;
  }
  deleteTag(id: string): void { this.deleteById('tags', id); }

  // ================================================================== settings
  getSetting(key: string): unknown {
    const r = this.db.get<Row>('SELECT doc FROM settings WHERE key = ?', [key]);
    return r ? JSON.parse(String(r.doc)) : undefined;
  }
  setSetting(key: string, value: unknown): void {
    this.db.run('INSERT INTO settings (key, doc, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at', [key, JSON.stringify(value), now()]);
  }

  // ========================================================== crash recovery
  saveRecoveryPoint(workspaceId: string, entityType: string, entityId: string, doc: unknown): void {
    this.db.run(
      `INSERT INTO crash_recovery (id, workspace_id, entity_type, entity_id, doc, saved_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET doc = excluded.doc, saved_at = excluded.saved_at`,
      [uid(), workspaceId, entityType, entityId, JSON.stringify(doc), now()],
    );
  }
  listRecoveryPoints(workspaceId?: string): { id: string; entityType: string; entityId: string; doc: unknown; savedAt: string }[] {
    const rows = workspaceId
      ? this.db.all<Row>('SELECT * FROM crash_recovery WHERE workspace_id = ? ORDER BY saved_at DESC', [workspaceId])
      : this.db.all<Row>('SELECT * FROM crash_recovery ORDER BY saved_at DESC');
    return rows.map((r) => ({ id: String(r.id), entityType: String(r.entity_type), entityId: String(r.entity_id), doc: JSON.parse(String(r.doc)), savedAt: String(r.saved_at) }));
  }
  deleteRecoveryPoint(entityType: string, entityId: string): void {
    this.db.run('DELETE FROM crash_recovery WHERE entity_type = ? AND entity_id = ?', [entityType, entityId]);
  }

  // ================================================================= perf runs
  savePerfRun(workspaceId: string, run: PerfRun): void {
    const existing = this.byId<Row>('perf_runs', run.id);
    const row: Row = { id: run.id, workspace_id: workspaceId, status: run.status, doc: j(run), started_at: run.startedAt, finished_at: run.finishedAt ?? null };
    if (existing) this.updateRow('perf_runs', run.id, row); else this.insert('perf_runs', row);
  }
  getPerfRun(id: string): PerfRun | undefined {
    const r = this.byId<Row>('perf_runs', id);
    return r ? parseDoc<PerfRun>(r) : undefined;
  }
  listPerfRuns(workspaceId: string): PerfRun[] {
    return this.db.all<Row>('SELECT doc FROM perf_runs WHERE workspace_id = ? ORDER BY started_at DESC LIMIT 100', [workspaceId]).map((r) => parseDoc<PerfRun>(r));
  }

  // =============================================================== misc counts
  counts(workspaceId: string): Record<string, number> {
    return {
      collections: Number(this.db.scalar('SELECT COUNT(*) FROM collections WHERE workspace_id = ?', [workspaceId]) ?? 0),
      requests: Number(this.db.scalar('SELECT COUNT(*) FROM requests WHERE workspace_id = ?', [workspaceId]) ?? 0),
      environments: Number(this.db.scalar('SELECT COUNT(*) FROM environments WHERE workspace_id = ?', [workspaceId]) ?? 0),
      specs: Number(this.db.scalar('SELECT COUNT(*) FROM specs WHERE workspace_id = ?', [workspaceId]) ?? 0),
      history: this.countHistory(workspaceId),
      responses: this.countResponses(workspaceId),
      runs: Number(this.db.scalar('SELECT COUNT(*) FROM runs WHERE workspace_id = ?', [workspaceId]) ?? 0),
    };
  }
}

function safeJsonArray(v: unknown): string[] {
  try { const parsed = JSON.parse(String(v ?? '[]')); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}
