/**
 * Typed IPC surface. Every frontend→backend call is a named method with typed
 * params/result. The hub validates params with zod before dispatch (§101).
 */
import type {
  ApiEntity, ApiRequest, ApiResponse, AppSettings, Assertion, AssertionType,
  Attachment, AuditEvent, BackupInfo, CapturedExchange, Certificate, Collection, ConsoleLogEntry, Dataset,
  Environment, Flow, FlowRun, Folder, GovernanceRule, HistoryEntry, ImportFormat,
  ImportResult, MigrationReport, MockRequestLog, MockRoute, MockServer, Monitor, MonitorResult,
  NetworkPortInfo, Paginated, PerfConfig, PerfRun, Plugin, ProxyProfile,
  RequestExample, RunConfig, RunResult, ScriptLibraryEntry, SecretMeta,
  SecurityFinding, Snapshot, Specification, StoredCookie, Tag, TestResult,
  Variable, VariableLookup, WebhookEvent, WebhookReceiver, Workspace, SpecFormat,
  FlowNode, ResolutionTraceEntry, ResolveResult, RunRequestResult,
} from './types';

export interface BridgeError { code: string; message: string; detail?: string; suggestion?: string; }
export interface BridgeCall { id: string; method: string; params?: unknown; }
export interface BridgeReply { id: string; ok: boolean; result?: unknown; error?: BridgeError; }

export interface ListQuery { workspaceId?: string; limit?: number; offset?: number; search?: string; }
export interface SearchOptions { query: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; scope?: 'all' | 'collections' | 'requests' | 'specs' | 'docs' | 'variables' | 'scripts'; workspaceId?: string; limit?: number; }
export interface SearchHit { kind: string; id: string; parentId?: string; title: string; snippet: string; path: string[]; }
export interface ReplaceSpec extends SearchOptions { replace: string; dryRun?: boolean; }

export interface SendOptions {
  request: ApiRequest;
  environmentId?: string;
  overrides?: Record<string, string>;
  disableScripts?: boolean;
  /** provided by UI when debugging scripts */
  debug?: { breakpoints: number[]; script: 'pre' | 'post' };
}

export interface SendResult {
  response?: ApiResponse;
  error?: string;
  preTestResults: TestResult[];
  postTestResults: TestResult[];
  assertionResults: TestResult[];
  resolvedUrl: string;
  variableTrace: ResolutionTraceEntry[];
  consoleLogs: { level: string; args: unknown[]; script: string }[];
  skippedByScript?: boolean;
  nextRequestId?: string;
}

export interface GitStatusInfo { branch: string; ahead: number; behind: number; staged: string[]; modified: string[]; untracked: string[]; conflicted: string[]; }
export interface GitLogEntry { oid: string; message: string; author: string; date: string; }

export interface HealthScore { total: number; breakdown: Record<string, number>; }

export interface BackupCompareResult { added: string[]; removed: string[]; changed: string[]; }

export interface DbDiagnostics { sizeBytes: number; integrityOk: boolean; quickCheck: string; schemaVersion: number; tableCounts: Record<string, number>; walMode: boolean; }

export interface CodegenRequest { language: string; variant?: string; }
export interface CodegenTarget { language: string; label: string; variants: { id: string; label: string }[]; }

export interface OAuthStartResult { authUrl: string; state: string; callbackPort: number; }
export interface OAuthTokens { accessToken: string; refreshToken?: string; idToken?: string; tokenType?: string; expiresIn?: number; scope?: string; raw?: string; }

export interface SpecValidation { format: SpecFormat | 'unknown'; ok: boolean; errors: { message: string; path?: string; severity: 'error' | 'warning' }[]; stats?: Record<string, number>; }
export interface SpecSyncReport {
  missingInCollection: { method: string; path: string }[];
  missingInSpec: { method: string; path: string; requestId: string }[];
  methodMismatch: { path: string; specMethods: string[]; collectionMethods: string[] }[];
  parameterMismatch: { method: string; path: string; detail: string }[];
  schemaMismatch: { method: string; path: string; detail: string }[];
}
export interface BreakingChange { kind: string; message: string; path?: string; severity: 'breaking' | 'dangerous' | 'info'; }

export interface ApiSurface {
  // --- app / shell ---------------------------------------------------------
  'app.info': { params: void; result: { name: string; version: string; build: string; author: string; mode: 'desktop' | 'hub'; platform: string; dataDir: string; node: string } };
  'app.ping': { params: void; result: { pong: number } };
  'shell.openExternal': { params: { url: string }; result: void };
  'shell.showItemInFolder': { params: { path: string }; result: void };
  'dialog.openFile': { params: { filters?: { name: string; extensions: string[] }[]; multiple?: boolean }; result: string[] };
  'dialog.saveFile': { params: { defaultName: string; filters?: { name: string; extensions: string[] }[]; contentBase64?: string; contentText?: string }; result: { path: string } | null };
  'clipboard.write': { params: { text: string }; result: void };
  'clipboard.read': { params: void; result: string };

  // --- workspaces ----------------------------------------------------------
  'workspace.list': { params: void; result: Workspace[] };
  'workspace.create': { params: { name: string; description?: string }; result: Workspace };
  'workspace.update': { params: { id: string; patch: Partial<Workspace> }; result: Workspace };
  'workspace.delete': { params: { id: string }; result: void };
  'workspace.getActive': { params: void; result: Workspace | null };
  'workspace.setActive': { params: { id: string }; result: Workspace };
  'workspace.health': { params: { id: string }; result: HealthScore };
  'workspace.portabilityCheck': { params: { id: string }; result: { warnings: string[]; absolutePaths: string[]; missingFiles: string[]; secrets: number } };
  'workspace.makePortable': { params: { id: string }; result: { rewritten: number } };
  'workspace.encrypt': { params: { id: string; password: string }; result: void };

  // --- collections / folders / requests ------------------------------------
  'collection.list': { params: { workspaceId?: string }; result: Collection[] };
  'collection.get': { params: { id: string }; result: Collection };
  'collection.create': { params: { name: string; workspaceId?: string; description?: string }; result: Collection };
  'collection.update': { params: { id: string; patch: Partial<Collection> }; result: Collection };
  'collection.delete': { params: { id: string }; result: void };
  'collection.duplicate': { params: { id: string }; result: Collection };
  'collection.stats': { params: { id: string }; result: { requests: number; folders: number; examples: number; tests: number; scripts: number } };
  'collection.changelog': { params: { id: string }; result: AuditEvent[] };
  'collection.applyTemplate': { params: { template: string; name?: string; workspaceId?: string }; result: Collection };

  'folder.list': { params: { collectionId: string }; result: Folder[] };
  'folder.create': { params: { collectionId: string; name: string; parentFolderId?: string }; result: Folder };
  'folder.update': { params: { id: string; patch: Partial<Folder> }; result: Folder };
  'folder.delete': { params: { id: string }; result: void };
  'folder.move': { params: { id: string; parentFolderId?: string }; result: Folder };

  'request.list': { params: { workspaceId?: string; collectionId?: string; folderId?: string; search?: string; limit?: number; offset?: number }; result: Paginated<ApiRequest> };
  'request.get': { params: { id: string }; result: ApiRequest };
  'request.create': { params: { workspaceId?: string; collectionId?: string; folderId?: string; name?: string; method?: string; url?: string }; result: ApiRequest };
  'request.update': { params: { id: string; patch: Partial<ApiRequest> }; result: ApiRequest };
  'request.delete': { params: { id: string }; result: void };
  'request.duplicate': { params: { id: string }; result: ApiRequest };
  'request.move': { params: { id: string; collectionId?: string; folderId?: string }; result: ApiRequest };
  'request.reorder': { params: { id: string; sortOrder: number }; result: void };

  'example.list': { params: { requestId: string }; result: RequestExample[] };
  'example.save': { params: { example: RequestExample }; result: RequestExample };
  'example.delete': { params: { id: string }; result: void };
  'example.duplicate': { params: { id: string }; result: RequestExample };

  // --- sending ---------------------------------------------------------------
  'http.send': { params: SendOptions; result: SendResult };
  'http.cancel': { params: { opId: string }; result: void };
  'http.recentResponses': { params: { requestId: string; limit?: number }; result: ApiResponse[] };
  'http.responseById': { params: { id: string }; result: ApiResponse | null };

  // --- history ---------------------------------------------------------------
  'history.list': { params: { workspaceId?: string; search?: string; limit?: number; offset?: number }; result: Paginated<HistoryEntry> };
  'history.get': { params: { id: string }; result: HistoryEntry };
  'history.delete': { params: { id: string }; result: void };
  'history.clear': { params: { workspaceId?: string }; result: void };
  'history.export': { params: { workspaceId?: string; path: string }; result: { path: string } };

  // --- environments / variables ----------------------------------------------
  'environment.list': { params: { workspaceId?: string }; result: Environment[] };
  'environment.get': { params: { id: string }; result: Environment };
  'environment.create': { params: { name: string; workspaceId?: string }; result: Environment };
  'environment.update': { params: { id: string; patch: Partial<Environment> }; result: Environment };
  'environment.delete': { params: { id: string }; result: void };
  'environment.duplicate': { params: { id: string; name?: string }; result: Environment };
  'environment.getActive': { params: { workspaceId?: string }; result: Environment | null };
  'environment.setActive': { params: { id: string | null; workspaceId?: string }; result: void };
  'environment.importDotEnv': { params: { content: string; name?: string; workspaceId?: string }; result: Environment };
  'environment.exportDotEnv': { params: { id: string }; result: string };

  'variables.globals': { params: { workspaceId?: string }; result: Variable[] };
  'variables.setGlobals': { params: { variables: Variable[]; workspaceId?: string }; result: void };
  'variables.resolve': { params: { text: string; workspaceId?: string; environmentId?: string; collectionId?: string; folderId?: string; requestId?: string; data?: Record<string, string>; local?: Record<string, string>; scriptVars?: Record<string, string> }; result: ResolveResult };
  'variables.usages': { params: { key: string; workspaceId?: string }; result: SearchHit[] };
  'variables.unused': { params: { workspaceId?: string }; result: { key: string; scope: string }[] };
  'variables.dependencies': { params: { workspaceId?: string }; result: { nodes: { id: string; label: string; scope: string }[]; edges: { from: string; to: string }[]; cycles: string[][] } };
  'variables.trace': { params: { key: string; workspaceId?: string; environmentId?: string }; result: ResolutionTraceEntry[] };
  'variables.all': { params: { workspaceId?: string; environmentId?: string }; result: VariableLookup[] };

  // --- cookies -----------------------------------------------------------------
  'cookies.list': { params: { workspaceId?: string; domain?: string }; result: StoredCookie[] };
  'cookies.set': { params: { cookie: StoredCookie; workspaceId?: string }; result: void };
  'cookies.delete': { params: { name: string; domain: string; path: string; workspaceId?: string }; result: void };
  'cookies.clear': { params: { workspaceId?: string; domain?: string }; result: void };
  'cookies.import': { params: { content: string; format: 'json' | 'netscape'; workspaceId?: string }; result: { count: number } };
  'cookies.export': { params: { workspaceId?: string; format: 'json' | 'netscape' }; result: string };

  // --- scripting / tests -------------------------------------------------------
  'script.runTests': { params: { script: string; response: ApiResponse; request: ApiRequest; workspaceId?: string; environmentId?: string }; result: { tests: TestResult[]; logs: { level: string; args: unknown[] }[] } };
  'scriptLibrary.list': { params: { workspaceId?: string; search?: string }; result: ScriptLibraryEntry[] };
  'scriptLibrary.save': { params: { entry: ScriptLibraryEntry }; result: ScriptLibraryEntry };
  'scriptLibrary.delete': { params: { id: string }; result: void };
  'scriptLibrary.export': { params: { id: string }; result: string };
  'scriptLibrary.import': { params: { content: string; workspaceId?: string }; result: ScriptLibraryEntry };

  'assertion.run': { params: { assertions: Assertion[]; response: ApiResponse; request?: ApiRequest }; result: TestResult[] };
  'assertion.types': { params: void; result: { type: AssertionType; label: string; params: string[] }[] };

  'snapshot.list': { params: { requestId: string }; result: Snapshot[] };
  'snapshot.create': { params: { requestId: string; name: string; response: ApiResponse; ignorePaths?: string[]; workspaceId?: string }; result: Snapshot };
  'snapshot.delete': { params: { id: string }; result: void };
  'snapshot.accept': { params: { id: string; response: ApiResponse }; result: Snapshot };
  'snapshot.compare': { params: { id: string; response: ApiResponse }; result: { match: boolean; differences: { path: string; expected: string; actual: string }[] } };

  // --- runner ------------------------------------------------------------------
  'run.start': { params: RunConfig; result: { runId: string } };
  'run.pause': { params: { runId: string }; result: void };
  'run.resume': { params: { runId: string }; result: void };
  'run.stop': { params: { runId: string }; result: void };
  'run.get': { params: { runId: string }; result: RunResult };
  'run.list': { params: { workspaceId?: string; limit?: number }; result: RunResult[] };
  'run.delete': { params: { runId: string }; result: void };
  'run.rerunFailed': { params: { runId: string }; result: { runId: string } };
  'run.exportJson': { params: { runId: string }; result: string };
  'run.exportJUnit': { params: { runId: string }; result: string };
  'run.exportHtml': { params: { runId: string }; result: string };

  // --- response comparison -------------------------------------------------------
  'response.compare': { params: { a: ApiResponse; b: ApiResponse }; result: { statusMatch: boolean; bodyDiff: { kind: 'added' | 'removed' | 'modified'; path: string; a?: string; b?: string }[]; headerDiff: { kind: string; name: string }[]; summary: string } };

  // --- import/export --------------------------------------------------------------
  'import.detect': { params: { content: string; fileName?: string }; result: { format: ImportFormat; confidence: 'high' | 'medium' | 'low'; detail?: string } };
  'import.run': { params: { content?: string; path?: string; format?: ImportFormat; workspaceId?: string; fileName?: string }; result: ImportResult };
  'import.url': { params: { url: string; format?: ImportFormat; workspaceId?: string }; result: ImportResult };
  'export.collection': { params: { collectionId: string; format: 'postman' | 'apimanager' | 'openapi'; };

    result: string };
  'export.environment': { params: { environmentId: string; format: 'postman' | 'dotenv' | 'apimanager' }; result: string };
  'export.workspace': { params: { workspaceId?: string; includeSecrets?: boolean }; result: string };
  'export.request': { params: { requestId: string; format: 'apimanager' | 'postman' }; result: string };

  // --- curl / codegen ---------------------------------------------------------------
  'curl.parse': { params: { command: string }; result: { request: Partial<ApiRequest>; warnings: string[] } };
  'curl.generate': { params: { request: ApiRequest; environmentId?: string }; result: string };
  'codegen.targets': { params: void; result: CodegenTarget[] };
  'codegen.generate': { params: { request: ApiRequest; language: string; variant?: string; environmentId?: string }; result: string };

  // --- specifications / api design ----------------------------------------------------
  'spec.list': { params: { workspaceId?: string }; result: Specification[] };
  'spec.get': { params: { id: string }; result: Specification };
  'spec.create': { params: { name: string; format: SpecFormat; content: string; workspaceId?: string }; result: Specification };
  'spec.update': { params: { id: string; patch: Partial<Specification> }; result: Specification };
  'spec.delete': { params: { id: string }; result: void };
  'spec.validate': { params: { content: string; format?: SpecFormat }; result: SpecValidation };
  'spec.lint': { params: { id: string }; result: SpecValidation };
  'spec.diff': { params: { aId: string; bId: string }; result: BreakingChange[] };
  'spec.refGraph': { params: { id: string }; result: { nodes: { id: string }[]; edges: { from: string; to: string }[] } };
  'spec.generateCollection': { params: { id: string; name?: string }; result: Collection };
  'spec.syncReport': { params: { specId: string; collectionId: string }; result: SpecSyncReport };
  'spec.syncApply': { params: { specId: string; collectionId: string; direction: 'spec-to-collection' | 'collection-to-spec'; selection?: string[] }; result: { applied: number } };

  'api.list': { params: { workspaceId?: string }; result: ApiEntity[] };
  'api.save': { params: { api: ApiEntity }; result: ApiEntity };
  'api.delete': { params: { id: string }; result: void };
  'api.health': { params: { id: string }; result: HealthScore };
  'api.addChangelog': { params: { id: string; version: string; notes: string }; result: ApiEntity };

  // --- flows ---------------------------------------------------------------------------
  'flow.list': { params: { workspaceId?: string }; result: Flow[] };
  'flow.get': { params: { id: string }; result: Flow };
  'flow.save': { params: { flow: Flow }; result: Flow };
  'flow.delete': { params: { id: string }; result: void };
  'flow.run': { params: { flowId: string; variables?: Record<string, string>; environmentId?: string; breakpoints?: string[] }; result: { runId: string } };
  'flow.runGet': { params: { runId: string }; result: FlowRun };
  'flow.stop': { params: { runId: string }; result: void };

  // --- mocks ---------------------------------------------------------------------------
  'mock.list': { params: { workspaceId?: string }; result: MockServer[] };
  'mock.save': { params: { mock: MockServer }; result: MockServer };
  'mock.delete': { params: { id: string }; result: void };
  'mock.start': { params: { id: string }; result: { url: string; port: number } };
  'mock.stop': { params: { id: string }; result: void };
  'mock.logs': { params: { id: string; limit?: number }; result: MockRequestLog[] };
  'mock.fromCollection': { params: { collectionId: string; name?: string; port?: number }; result: MockServer };
  'mock.fromSpec': { params: { specId: string; name?: string; port?: number }; result: MockServer };
  'mock.setRoutes': { params: { id: string; routes: MockRoute[] }; result: MockServer };

  // --- monitors --------------------------------------------------------------------------
  'monitor.list': { params: { workspaceId?: string }; result: Monitor[] };
  'monitor.save': { params: { monitor: Monitor }; result: Monitor };
  'monitor.delete': { params: { id: string }; result: void };
  'monitor.runNow': { params: { id: string }; result: { resultId: string } };
  'monitor.results': { params: { id: string; limit?: number }; result: MonitorResult[] };

  // --- performance ------------------------------------------------------------------------
  'perf.start': { params: PerfConfig; result: { runId: string } };
  'perf.stop': { params: { runId: string }; result: void };
  'perf.get': { params: { runId: string }; result: PerfRun };
  'perf.list': { params: { workspaceId?: string }; result: PerfRun[] };
  'perf.export': { params: { runId: string; format: 'csv' | 'json' }; result: string };
  'perf.compareBaseline': { params: { runId: string; baselineId: string }; result: { latencyDeltaPct: number; throughputDeltaPct: number; errorDeltaPct: number } };

  // --- datasets ----------------------------------------------------------------------------
  'dataset.list': { params: { workspaceId?: string }; result: Dataset[] };
  'dataset.save': { params: { dataset: Dataset }; result: Dataset };
  'dataset.delete': { params: { id: string }; result: void };
  'dataset.parse': { params: { content: string; format: 'csv' | 'json' }; result: { columns: string[]; rows: Record<string, string>[] } };
  'dataset.generate': { params: { spec: { name: string; template: string; count: number }[] }; result: Dataset };

  // --- documentation ------------------------------------------------------------------------
  'docs.list': { params: { workspaceId?: string }; result: import('./types').DocSite[] };
  'docs.generate': { params: { collectionId?: string; specId?: string; theme?: 'light' | 'dark'; workspaceId?: string }; result: { html: string } };
  'docs.export': { params: { collectionId?: string; specId?: string; path: string; workspaceId?: string }; result: { path: string } };
  'docs.serve': { params: { collectionId?: string; specId?: string; port?: number }; result: { url: string } };

  // --- vault ----------------------------------------------------------------------------------
  'vault.status': { params: void; result: { locked: boolean; itemCount: number; autoLockMinutes: number } };
  'vault.unlock': { params: { password: string }; result: void };
  'vault.lock': { params: void; result: void };
  'vault.isInitialized': { params: void; result: boolean };
  'vault.initialize': { params: { password: string }; result: void };
  'vault.list': { params: { workspaceId?: string }; result: SecretMeta[] };
  'vault.get': { params: { id: string }; result: SecretItemView };
  'vault.set': { params: { id?: string; name: string; secret: string; workspaceId?: string; description?: string }; result: SecretMeta };
  'vault.delete': { params: { id: string }; result: void };

  // --- certificates / proxies -------------------------------------------------------------------
  'certificate.list': { params: { workspaceId?: string }; result: Certificate[] };
  'certificate.save': { params: { certificate: Certificate }; result: Certificate };
  'certificate.delete': { params: { id: string }; result: void };
  'certificate.inspect': { params: { id: string }; result: { subject: string; issuer: string; validFrom: string; validTo: string; daysLeft: number; error?: string } };
  'proxy.list': { params: { workspaceId?: string }; result: ProxyProfile[] };
  'proxy.save': { params: { profile: ProxyProfile }; result: ProxyProfile };
  'proxy.delete': { params: { id: string }; result: void };

  // --- settings ----------------------------------------------------------------------------------
  'settings.get': { params: void; result: AppSettings };
  'settings.update': { params: { patch: Partial<AppSettings> }; result: AppSettings };
  'settings.reset': { params: void; result: AppSettings };

  // --- git -----------------------------------------------------------------------------------------
  'git.init': { params: { path?: string; workspaceId?: string }; result: { path: string } };
  'git.clone': { params: { url: string; path: string; username?: string; passwordSecretId?: string }; result: { path: string } };
  'git.status': { params: { path?: string }; result: GitStatusInfo };
  'git.add': { params: { path?: string; files: string[] }; result: void };
  'git.addAll': { params: { path?: string }; result: void };
  'git.commit': { params: { path?: string; message: string; skipSecretScan?: boolean }; result: { oid: string; findings: SecurityFinding[] } };
  'git.branches': { params: { path?: string }; result: string[] };
  'git.createBranch': { params: { path?: string; name: string; checkout?: boolean }; result: void };
  'git.checkout': { params: { path?: string; ref: string }; result: void };
  'git.merge': { params: { path?: string; branch: string }; result: { merged: boolean; conflicts: string[] } };
  'git.fetch': { params: { path?: string; remote?: string }; result: void };
  'git.pull': { params: { path?: string; remote?: string; username?: string; passwordSecretId?: string }; result: void };
  'git.push': { params: { path?: string; remote?: string; username?: string; passwordSecretId?: string }; result: void };
  'git.stash': { params: { path?: string; message?: string }; result: void };
  'git.stashPop': { params: { path?: string }; result: void };
  'git.diff': { params: { path?: string; file?: string; staged?: boolean }; result: string };
  'git.log': { params: { path?: string; limit?: number }; result: GitLogEntry[] };
  'git.remotes': { params: { path?: string }; result: { name: string; url: string }[] };
  'git.addRemote': { params: { path?: string; name: string; url: string }; result: void };
  'git.writeGitignore': { params: { path?: string }; result: void };
  'git.secretScan': { params: { path?: string }; result: SecurityFinding[] };

  // --- webhooks -------------------------------------------------------------------------------------
  'webhook.list': { params: { workspaceId?: string }; result: WebhookReceiver[] };
  'webhook.save': { params: { webhook: WebhookReceiver }; result: WebhookReceiver };
  'webhook.delete': { params: { id: string }; result: void };
  'webhook.start': { params: { id: string }; result: { url: string } };
  'webhook.stop': { params: { id: string }; result: void };
  'webhook.events': { params: { id: string; limit?: number }; result: WebhookEvent[] };
  'webhook.saveAsRequest': { params: { eventId: string; collectionId?: string; workspaceId?: string }; result: ApiRequest };

  // --- traffic capture --------------------------------------------------------------------------------
  'capture.start': { params: { port?: number; workspaceId?: string }; result: { port: number; proxyUrl: string } };
  'capture.stop': { params: void; result: void };
  'capture.status': { params: void; result: { running: boolean; port?: number; count: number } };
  'capture.list': { params: { limit?: number }; result: CapturedExchange[] };
  'capture.clear': { params: void; result: void };
  'capture.saveAsRequest': { params: { id: string; collectionId?: string; workspaceId?: string }; result: ApiRequest };

  // --- network inventory ------------------------------------------------------------------------------
  'inventory.ports': { params: void; result: NetworkPortInfo[] };
  'inventory.listeners': { params: void; result: NetworkPortInfo[] };
  'inventory.interfaces': { params: void; result: { name: string; addresses: string[] }[] };

  // --- security / governance ---------------------------------------------------------------------------
  'security.scanWorkspace': { params: { workspaceId?: string }; result: SecurityFinding[] };
  'security.scanText': { params: { text: string; location?: string }; result: SecurityFinding[] };
  'security.scanResponse': { params: { response: ApiResponse }; result: SecurityFinding[] };
  'security.patterns': { params: void; result: { id: string; name: string; pattern: string; severity: string; builtin: boolean }[] };
  'security.addPattern': { params: { name: string; pattern: string; severity: string }; result: void };
  'security.deletePattern': { params: { id: string }; result: void };
  'governance.rules': { params: { workspaceId?: string }; result: GovernanceRule[] };
  'governance.saveRule': { params: { rule: GovernanceRule }; result: GovernanceRule };
  'governance.deleteRule': { params: { id: string }; result: void };
  'governance.evaluate': { params: { workspaceId?: string }; result: { rule: string; kind: string; passed: boolean; violations: { message: string; location: string }[] }[] };

  // --- console / analytics ------------------------------------------------------------------------------
  'console.list': { params: { level?: string; source?: string; search?: string; limit?: number }; result: ConsoleLogEntry[] };
  'console.clear': { params: void; result: void };
  'console.log': { params: { level: string; source: string; message: string }; result: void };
  'console.export': { params: void; result: string };
  'analytics.summary': { params: { workspaceId?: string }; result: { requests: number; collections: number; runs: number; passRate: number; avgResponseMs: number; byMethod: Record<string, number>; byStatus: Record<string, number>; timeline: { date: string; count: number; avgMs: number }[] } };

  // --- search ----------------------------------------------------------------------------------------------
  'search.global': { params: SearchOptions; result: SearchHit[] };
  'search.replace': { params: ReplaceSpec; result: { replaced: number; hits: SearchHit[] } };

  // --- audit -------------------------------------------------------------------------------------------------
  'audit.list': { params: { workspaceId?: string; category?: string; search?: string; from?: string; to?: string; limit?: number; offset?: number }; result: Paginated<AuditEvent> };
  'audit.export': { params: { workspaceId?: string }; result: string };

  // --- db / backup ----------------------------------------------------------------------------------------------
  'db.diagnostics': { params: void; result: DbDiagnostics };
  'db.vacuum': { params: void; result: void };
  'db.integrityCheck': { params: void; result: { ok: boolean; report: string } };
  'db.migrationStatus': { params: void; result: { applied: number; latest: number; pending: string[] } };
  'db.wipe': { params: void; result: { truth?: never } | { backup: string } };
  'backup.list': { params: void; result: BackupInfo[] };
  'backup.create': { params: { kind?: 'manual' | 'auto' | 'pre-import' | 'pre-destructive'; encryptPassword?: string; note?: string }; result: BackupInfo };
  'backup.restore': { params: { path: string; password?: string }; result: { restored: boolean } };
  'backup.delete': { params: { path: string }; result: void };
  'backup.verify': { params: { path: string }; result: { ok: boolean; sha256: string } };
  'backup.compare': { params: { aPath: string; bPath: string }; result: BackupCompareResult };

  // --- crash recovery ----------------------------------------------------------------------------------------------
  'recovery.listDrafts': { params: { workspaceId?: string }; result: { id: string; entityType: string; entityId: string; savedAt: string }[] };
  'recovery.discard': { params: { id: string }; result: void };

  // --- files / attachments ------------------------------------------------------------------------------------------
  'files.browse': { params: { path?: string }; result: { name: string; path: string; isDir: boolean; size: number }[] };
  'files.readText': { params: { path: string }; result: string };
  'files.listAttachments': { params: { workspaceId?: string }; result: Attachment[] };
  'files.addAttachment': { params: { path: string; workspaceId?: string }; result: Attachment };
  'files.deleteAttachment': { params: { id: string }; result: void };
  'files.relink': { params: { id: string; newPath: string }; result: Attachment };
  'files.missing': { params: { workspaceId?: string }; result: Attachment[] };
  'files.orphans': { params: { workspaceId?: string }; result: Attachment[] };

  // --- favorites / tags ----------------------------------------------------------------------------------------------
  'favorite.list': { params: { workspaceId?: string }; result: import('./types').Favorite[] };
  'favorite.toggle': { params: { entityType: 'collection' | 'request' | 'folder' | 'spec'; entityId: string; workspaceId?: string }; result: boolean };
  'tag.list': { params: { workspaceId?: string }; result: Tag[] };
  'tag.save': { params: { tag: Tag }; result: Tag };
  'tag.delete': { params: { id: string }; result: void };

  // --- protocols: websocket / sse / mqtt / grpc / socketio --------------------------------------------------------------
  'ws.connect': { params: { url: string; headers?: KeyValueInput[]; subprotocols?: string[]; sessionId?: string }; result: { sessionId: string } };
  'ws.send': { params: { sessionId: string; data: string; binary?: boolean }; result: void };
  'ws.close': { params: { sessionId: string }; result: void };
  'sse.connect': { params: { url: string; headers?: KeyValueInput[]; lastEventId?: string; sessionId?: string }; result: { sessionId: string } };
  'sse.close': { params: { sessionId: string }; result: void };
  'mqtt.connect': { params: { config: import('./types').MqttConfig; sessionId?: string }; result: { sessionId: string } };
  'mqtt.publish': { params: { sessionId: string; topic: string; payload: string; qos?: 0 | 1 | 2; retain?: boolean }; result: void };
  'mqtt.subscribe': { params: { sessionId: string; topic: string; qos?: 0 | 1 | 2 }; result: void };
  'mqtt.unsubscribe': { params: { sessionId: string; topic: string }; result: void };
  'mqtt.close': { params: { sessionId: string }; result: void };
  'grpc.listServices': { params: { config: import('./types').GrpcConfig; serverUrl: string }; result: { services: { name: string; methods: { name: string; inputType: string; outputType: string; clientStreaming: boolean; serverStreaming: boolean }[] }[] } };
  'grpc.invoke': { params: { serverUrl: string; config: import('./types').GrpcConfig; method: string; payload: string; sessionId?: string }; result: { sessionId: string; initial?: string; unary?: boolean; result?: string } };
  'grpc.send': { params: { sessionId: string; payload: string }; result: void };
  'grpc.endStream': { params: { sessionId: string }; result: void };
  'grpc.close': { params: { sessionId: string }; result: void };
  'socketio.connect': { params: { url: string; path?: string; sessionId?: string }; result: { sessionId: string } };
  'socketio.emit': { params: { sessionId: string; event: string; data: string }; result: void };
  'socketio.close': { params: { sessionId: string }; result: void };

  // --- MCP --------------------------------------------------------------------------------------------------------------
  'mcp.connect': { params: { config: import('./types').McpConfig; sessionId?: string }; result: { sessionId: string } };
  'mcp.listTools': { params: { sessionId: string }; result: { tools: { name: string; description?: string; schema?: string }[] } };
  'mcp.callTool': { params: { sessionId: string; name: string; argsJson: string; confirmed: boolean }; result: { content: string } };
  'mcp.listResources': { params: { sessionId: string }; result: { resources: { uri: string; name?: string }[] } };
  'mcp.listPrompts': { params: { sessionId: string }; result: { prompts: { name: string; description?: string }[] } };
  'mcp.close': { params: { sessionId: string }; result: void };

  // --- AI ------------------------------------------------------------------------------------------------------------------
  'ai.send': { params: { config: import('./types').AiConfig; messages: { role: string; content: string }[]; sessionId?: string; environmentId?: string }; result: { sessionId: string; content: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } } };
  'ai.providers': { params: void; result: { id: string; label: string; baseUrl: string }[] };

  // --- oauth flow ------------------------------------------------------------------------------------------------------------
  'oauth.start': { params: { config: import('./types').OAuth2Config; environmentId?: string }; result: OAuthStartResult };
  'oauth.exchange': { params: { config: import('./types').OAuth2Config; code: string; state: string; callbackPort?: number }; result: OAuthTokens };
  'oauth.clientCredentials': { params: { config: import('./types').OAuth2Config }; result: OAuthTokens };
  'oauth.passwordGrant': { params: { config: import('./types').OAuth2Config }; result: OAuthTokens };
  'oauth.refresh': { params: { config: import('./types').OAuth2Config }; result: OAuthTokens };
  'oauth.discover': { params: { url: string }; result: { authorizationEndpoint?: string; tokenEndpoint?: string; issuer?: string; raw?: string } };

  // --- plugins -------------------------------------------------------------------------------------------------------------------
  'plugin.list': { params: void; result: Plugin[] };
  'plugin.install': { params: { path: string }; result: Plugin };
  'plugin.uninstall': { params: { id: string }; result: void };
  'plugin.setEnabled': { params: { id: string; enabled: boolean }; result: void };
  'plugin.runHook': { params: { id: string; hook: string; payloadJson: string }; result: string };
}

export interface SecretItemView { id: string; name: string; value: string; description?: string; createdAt: string; lastAccessedAt?: string; }
export interface KeyValueInput { key: string; value: string; enabled?: boolean; description?: string; }

export type ApiMethod = keyof ApiSurface;
export type ParamsOf<M extends ApiMethod> = ApiSurface[M]['params'];
export type ResultOf<M extends ApiMethod> = ApiSurface[M]['result'];
