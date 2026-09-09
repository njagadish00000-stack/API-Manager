/**
 * API Manager — shared domain model.
 * These types cross the IPC bridge and are also used by the CLI, so they must
 * remain serializable (plain JSON-compatible objects).
 */

export type UUID = string;

// ---------------------------------------------------------------------------
// Common building blocks
// ---------------------------------------------------------------------------

export interface KeyValue {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  description?: string;
}

/** Loose key/value used by transport-layer inputs (id optional). */
export interface KeyValueInput { key: string; value: string; enabled?: boolean }

export interface FormDataField extends KeyValue {
  fieldType: 'text' | 'file';
  /** For file fields. May be relative to the workspace for portability. */
  filePath?: string;
  mimeType?: string;
  fileName?: string;
  /** Multiple file selection */
  filePaths?: string[];
}

export type HttpMethod =
  | 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE' | 'CONNECT'
  | (string & {});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export type AuthType =
  | 'inherit' | 'none' | 'basic' | 'bearer' | 'apikey' | 'digest'
  | 'oauth1' | 'oauth2' | 'jwt' | 'aws4' | 'hawk' | 'ntlm' | 'custom';

export interface BasicAuthConfig { username: string; password: string; }
export interface BearerAuthConfig { token: string; prefix?: string; }
export interface ApiKeyAuthConfig { key: string; value: string; addTo: 'header' | 'query'; }
export interface DigestAuthConfig { username: string; password: string; realm?: string; nonce?: string; uri?: string; opaque?: string; algorithm?: 'MD5' | 'MD5-sess' | 'SHA-256' | 'SHA-256-sess' | 'SHA-512-256' | 'SHA-512-256-sess'; qop?: 'auth' | 'auth-int'; nc?: string; cnonce?: string; }
export interface OAuth1Config { consumerKey: string; consumerSecret: string; token?: string; tokenSecret?: string; signatureMethod: 'HMAC-SHA1' | 'PLAINTEXT' | 'RSA-SHA1'; callback?: string; verifier?: string; realm?: string; timestamp?: string; nonce?: string; version?: string; addTo: 'header' | 'query'; }
export interface OAuth2Config {
  grantType: 'authorization_code' | 'authorization_code_pkce' | 'client_credentials' | 'password' | 'implicit';
  authUrl?: string; accessTokenUrl?: string; clientId?: string; clientSecret?: string;
  scope?: string; state?: string; nonce?: string; callbackUrl?: string;
  pkceMethod?: 'S256' | 'plain'; audience?: string; resource?: string;
  username?: string; password?: string;
  clientAuth?: 'header' | 'body';
  useDiscovery?: boolean; discoveryUrl?: string;
  /** Cached tokens (may reference vault secrets) */
  accessToken?: string; refreshToken?: string; idToken?: string;
  expiresAt?: string; tokenType?: string; obtainedAt?: string;
  autoRefresh?: boolean; headerPrefix?: string; addTo?: 'header' | 'query';
}
export interface JwtAuthConfig { token?: string; secret?: string; algorithm?: string; headerPrefix?: string; addTo?: 'header' | 'query' | 'variable'; payload?: string; header?: string; }
export interface Aws4AuthConfig { accessKey: string; secretKey: string; sessionToken?: string; region: string; service: string; addTo?: 'header' | 'query'; }
export interface HawkAuthConfig { authId: string; authKey: string; algorithm: 'sha256' | 'sha1'; nonce?: string; timestamp?: string; ext?: string; app?: string; dlg?: string; }
export interface NtlmAuthConfig { username: string; password: string; domain?: string; workstation?: string; }
export interface CustomAuthConfig { expression?: string; headerName?: string; queryName?: string; }
export interface ClientCertRef { certificateId?: string; }

export interface AuthConfig {
  type: AuthType;
  basic?: BasicAuthConfig;
  bearer?: BearerAuthConfig;
  apikey?: ApiKeyAuthConfig;
  digest?: DigestAuthConfig;
  oauth1?: OAuth1Config;
  oauth2?: OAuth2Config;
  jwt?: JwtAuthConfig;
  aws4?: Aws4AuthConfig;
  hawk?: HawkAuthConfig;
  ntlm?: NtlmAuthConfig;
  custom?: CustomAuthConfig;
  clientCertificate?: ClientCertRef;
}

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

export type BodyType =
  | 'none' | 'json' | 'xml' | 'html' | 'javascript' | 'graphql' | 'text'
  | 'form-data' | 'urlencoded' | 'binary' | 'file';

export interface GraphQLBody { query: string; variables: string; operationName?: string; }

export interface RequestBody {
  type: BodyType;
  raw?: string;
  graphql?: GraphQLBody;
  formData?: FormDataField[];
  urlencoded?: KeyValue[];
  binaryFilePath?: string;
  /** Manual Content-Type override; when absent one is suggested from type. */
  contentTypeOverride?: string;
  jsonSchema?: string;
}

// ---------------------------------------------------------------------------
// Scripts & assertions
// ---------------------------------------------------------------------------

export interface Scripts {
  preRequest: string;
  postResponse: string;
}

export type AssertionType =
  | 'statusCode' | 'statusText' | 'headerExists' | 'headerValue' | 'bodyContains'
  | 'bodyNotContains' | 'jsonProperty' | 'jsonPath' | 'xpath' | 'regex' | 'schema'
  | 'responseTime' | 'responseSize' | 'contentType' | 'arrayLength' | 'valueEquals'
  | 'soapFault' | 'soapAction';

export interface Assertion {
  id: string;
  type: AssertionType;
  enabled: boolean;
  name?: string;
  /** type-specific parameters */
  property?: string;   // json path / header name
  expected?: string;
  operator?: 'eq' | 'neq' | 'contains' | 'notContains' | 'lt' | 'lte' | 'gt' | 'gte' | 'matches' | 'exists' | 'notExists';
  schema?: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  durationMs?: number;
  source?: 'script' | 'assertion';
}

// ---------------------------------------------------------------------------
// Request model
// ---------------------------------------------------------------------------

export type Protocol =
  | 'http' | 'graphql' | 'websocket' | 'socketio' | 'sse' | 'mqtt' | 'grpc' | 'soap' | 'ai' | 'mcp';

export interface RetryConfig {
  enabled: boolean;
  maxRetries: number;
  strategy: 'fixed' | 'exponential';
  delayMs: number;
  retryStatusCodes: number[];
  retryOnNetworkError: boolean;
  retryOnTimeout: boolean;
  onlyIdempotent: boolean;
  confirmNonIdempotent?: boolean;
}

export interface ProxyRef {
  /** 'system' | 'none' | 'profile' */
  mode: 'system' | 'none' | 'profile' | 'custom';
  profileId?: string;
  customUrl?: string;
}

export interface RequestSettings {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  preserveAuthOnRedirect: boolean;
  stripSensitiveHeaders: boolean;
  retry: RetryConfig;
  proxy?: ProxyRef;
  certificateId?: string;
  httpVersion: 'auto' | 'http1' | 'http2';
  encodeUrl: boolean;
  verifyTls: boolean;
  storeResponse: boolean;
  maxResponseBytes?: number;
}

export interface SoapConfig {
  version: '1.1' | '1.2';
  action?: string;
  endpoint?: string;
  wsdlUrl?: string;
  wsdlService?: string;
  wsdlPort?: string;
  wsdlOperation?: string;
  wsAddressing?: { action?: string; to?: string; messageId?: string; replyTo?: string; };
  wsSecurity?: { username?: string; password?: string; passwordType?: 'PasswordText' | 'PasswordDigest'; addTimestamp?: boolean; mustUnderstand?: boolean; };
  mtom?: boolean;
}

export interface GrpcConfig {
  protoFiles: string[];
  service?: string;
  method?: string;
  metadata: KeyValue[];
  useReflection: boolean;
  useTls: boolean;
  authority?: string;
}

export interface MqttConfig {
  host: string; port: number; clientId?: string; username?: string; password?: string;
  useTls: boolean; topic?: string; subscribeTopics?: string[]; qos?: 0 | 1 | 2; retain?: boolean;
  keepAlive?: number; clean?: boolean;
}

export interface WebSocketConfig {
  subprotocols?: string[];
  handshakeTimeoutMs?: number;
  pingIntervalMs?: number;
}

export interface SseConfig { lastEventId?: string; retryMs?: number; }

export interface AiConfig {
  provider: string;
  baseUrl: string;
  apiKeySecretId?: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface McpConfig {
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  endpoint?: string;
  allowlisted?: boolean;
}

export interface ProtocolData {
  soap?: SoapConfig;
  grpc?: GrpcConfig;
  mqtt?: MqttConfig;
  websocket?: WebSocketConfig;
  sse?: SseConfig;
  ai?: AiConfig;
  mcp?: McpConfig;
}

export interface ApiRequest {
  id: UUID;
  workspaceId: UUID;
  collectionId?: UUID;
  folderId?: UUID;
  name: string;
  description?: string;
  method: HttpMethod;
  url: string;
  protocol: Protocol;
  protocolData?: ProtocolData;
  pathParams: KeyValue[];
  queryParams: KeyValue[];
  headers: KeyValue[];
  auth: AuthConfig;
  body: RequestBody;
  scripts: Scripts;
  assertions: Assertion[];
  settings: RequestSettings;
  documentation?: string;
  tags: string[];
  favorite: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface RequestExample {
  id: UUID;
  requestId: UUID;
  name: string;
  description?: string;
  request: Partial<ApiRequest>;
  response?: ApiResponse;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface TimingBreakdown {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  uploadMs?: number;
  serverMs?: number;
  downloadMs?: number;
  totalMs: number;
  queueMs?: number;
}

export interface RedirectHop {
  url: string;
  status: number;
  statusText: string;
  headers: KeyValue[];
  durationMs: number;
}

export interface RetryAttempt {
  attempt: number;
  status?: number;
  error?: string;
  durationMs: number;
  timestamp: string;
}

export interface StoredCookie {
  name: string; value: string; domain: string; path: string;
  expires?: string; secure: boolean; httpOnly: boolean; sameSite?: string;
  hostOnly?: boolean; session?: boolean;
}

export interface ApiResponse {
  id: string;
  status: number;
  statusText: string;
  httpVersion: string;
  headers: KeyValue[];
  cookies: StoredCookie[];
  /** UTF-8 text when textual, otherwise omitted */
  bodyText?: string;
  /** base64 for binary bodies */
  bodyBase64?: string;
  bodyIsBinary: boolean;
  bodySize: number;
  requestSize?: number;
  timing: TimingBreakdown;
  redirects: RedirectHop[];
  retryAttempts: RetryAttempt[];
  remoteAddress?: string;
  contentType?: string;
  timestamp: string;
  error?: string;
  /** ID of the request definition this was a response for */
  requestId?: string;
  requestSnapshot?: {
    method: string; url: string; headers: KeyValue[]; body?: string;
  };
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export interface Workspace {
  id: UUID;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  isDefault?: boolean;
  encrypted?: boolean;
  readOnly?: boolean;
  gitRepoPath?: string;
  settings?: Record<string, string>;
}

export interface Collection {
  id: UUID;
  workspaceId: UUID;
  name: string;
  description?: string;
  variables: Variable[];
  auth: AuthConfig;
  scripts: Scripts;
  documentation?: string;
  tags: string[];
  favorite: boolean;
  readOnly?: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface Folder {
  id: UUID;
  collectionId: UUID;
  parentFolderId?: UUID;
  name: string;
  description?: string;
  auth: AuthConfig;
  scripts: Scripts;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type EnvironmentVariableType = 'default' | 'secret';

export interface Variable {
  id: string;
  key: string;
  value: string;
  /** initial/default value shared across machines */
  initialValue?: string;
  type: EnvironmentVariableType;
  enabled: boolean;
  description?: string;
}

export interface Environment {
  id: UUID;
  workspaceId: UUID;
  name: string;
  variables: Variable[];
  color?: string;
  extendsEnvironmentId?: UUID;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

export type VariableScope =
  | 'script' | 'data' | 'local' | 'request' | 'folder' | 'collection'
  | 'environment' | 'workspace' | 'global' | 'dynamic';

export interface ResolutionTraceEntry {
  variable: string;
  scope: VariableScope;
  sourceId?: string;
  sourceName?: string;
  valueMasked: string;
  found: boolean;
}

export interface ResolveResult {
  resolved: string;
  trace: ResolutionTraceEntry[];
  unresolved: string[];
  cycles: string[];
  dynamicUsed: Record<string, string>;
}

export interface VariableLookup {
  key: string;
  value: string;
  scope: VariableScope;
  sourceId?: string;
  sourceName?: string;
  isSecret?: boolean;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunConfig {
  collectionId: string;
  folderId?: string;
  requestIds?: string[];
  environmentId?: string;
  iterations: number;
  delayMs: number;
  dataFileId?: string;
  stopOnFailure: boolean;
  variableOverrides?: Record<string, string>;
  timeoutMs?: number;
}

export interface RunRequestResult {
  requestId: string;
  requestName: string;
  iteration: number;
  status?: number;
  durationMs?: number;
  passed: boolean;
  failedTests: number;
  passedTests: number;
  tests: TestResult[];
  error?: string;
  response?: ApiResponse;
  skipped?: boolean;
  skipReason?: string;
}

export interface RunResult {
  id: UUID;
  config: RunConfig;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  startedAt: string;
  finishedAt?: string;
  totalRequests: number;
  executedRequests: number;
  passedRequests: number;
  failedRequests: number;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  durationMs?: number;
  results: RunRequestResult[];
  /** execution order overrides produced by setNextRequest */
  executionLog: string[];
}

// ---------------------------------------------------------------------------
// Misc entities
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: UUID;
  workspaceId: UUID;
  requestId?: string;
  name: string;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  timestamp: string;
  request: ApiRequest;
  response?: ApiResponse;
}

export interface Certificate {
  id: UUID;
  workspaceId: UUID;
  name: string;
  hosts: string[];
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  pfxPath?: string;
  passphraseSecretId?: string;
  expiresAt?: string;
  subject?: string;
  issuer?: string;
  createdAt: string;
}

export interface ProxyProfile {
  id: UUID;
  workspaceId?: UUID;
  name: string;
  type: 'http' | 'https' | 'socks4' | 'socks5' | 'system' | 'none';
  host?: string;
  port?: number;
  username?: string;
  passwordSecretId?: string;
  noProxy: string[];
  createdAt: string;
}

export interface SecretItem {
  id: UUID;
  workspaceId: UUID;
  name: string;
  /** stored encrypted at rest; never logged */
  secret: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}

export interface SecretMeta {
  id: UUID;
  workspaceId: UUID;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
}

export interface Attachment {
  id: UUID;
  workspaceId: UUID;
  relativePath: string;
  fileName: string;
  mimeType?: string;
  size: number;
  sha256?: string;
  missing?: boolean;
  references: string[];
  createdAt: string;
}

export interface Dataset {
  id: UUID;
  workspaceId: UUID;
  name: string;
  format: 'csv' | 'json';
  content: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MockServer {
  id: UUID;
  workspaceId: UUID;
  name: string;
  port: number;
  running: boolean;
  collectionId?: string;
  specId?: string;
  /** conditional routes */
  routes: MockRoute[];
  dynamicVars: boolean;
  latencyMs?: number;
  createdAt: string;
}

export interface MockRoute {
  id: string;
  method: string;
  pathPattern: string;
  status: number;
  headers: KeyValue[];
  body: string;
  conditionScript?: string;
  sequence?: { status: number; body: string }[];
  exampleId?: string;
  enabled: boolean;
}

export interface MockRequestLog {
  id: string;
  mockId: string;
  timestamp: string;
  method: string;
  path: string;
  status: number;
}

export interface Monitor {
  id: UUID;
  workspaceId: UUID;
  name: string;
  collectionId: string;
  environmentId?: string;
  intervalMinutes: number;
  enabled: boolean;
  failureThreshold: number;
  notifyWebhooks: string[];
  notifyEmail?: string;
  lastRunAt?: string;
  lastStatus?: string;
  consecutiveFailures: number;
  uptimePct?: number;
  createdAt: string;
}

export interface MonitorResult {
  id: UUID;
  monitorId: string;
  timestamp: string;
  status: 'up' | 'down' | 'degraded';
  passedTests: number;
  failedTests: number;
  durationMs: number;
  error?: string;
}

export interface WebhookReceiver {
  id: UUID;
  workspaceId: UUID;
  name: string;
  path: string;
  port: number;
  running: boolean;
  secret?: string;
  hmacHeader?: string;
  hmacAlgorithm?: 'sha1' | 'sha256' | 'sha512';
  responseStatus: number;
  responseBody: string;
  responseHeaders: KeyValue[];
  createdAt: string;
}

export interface WebhookEvent {
  id: string;
  webhookId: string;
  timestamp: string;
  method: string;
  path: string;
  query: string;
  headers: KeyValue[];
  body: string;
  signatureValid?: boolean;
}

export interface Flow {
  id: UUID;
  workspaceId: UUID;
  name: string;
  description?: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
  variables: Variable[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type FlowNodeType =
  | 'request' | 'condition' | 'loop' | 'variable' | 'transform' | 'script'
  | 'delay' | 'retry' | 'assertion' | 'branch' | 'merge' | 'output' | 'webhook' | 'database' | 'file' | 'subflow';

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  label: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
}

export interface FlowEdge { id: string; source: string; target: string; label?: string; sourceHandle?: string; }

export interface FlowRunLog {
  nodeId: string;
  status: 'success' | 'failed' | 'skipped';
  startedAt: string;
  durationMs: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  log?: string[];
}

export interface FlowRun {
  id: UUID;
  flowId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  nodeLogs: FlowRunLog[];
  variables: Record<string, string>;
}

export type SpecFormat = 'openapi3' | 'swagger2' | 'asyncapi' | 'graphql' | 'protobuf' | 'smithy' | 'wsdl' | 'wsdlproject' | 'soapui';

export interface Specification {
  id: UUID;
  workspaceId: UUID;
  name: string;
  format: SpecFormat;
  content: string;
  /** collected validation messages */
  version?: string;
  lifecycle: 'Draft' | 'Active' | 'Deprecated' | 'Retired';
  owner?: string;
  linkedCollectionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiEntity {
  id: UUID;
  workspaceId: UUID;
  name: string;
  description?: string;
  lifecycle: 'Draft' | 'Active' | 'Deprecated' | 'Retired';
  version: string;
  owner?: string;
  specId?: string;
  collectionId?: string;
  changelog: { version: string; date: string; notes: string }[];
  healthScore?: number;
  createdAt: string;
  updatedAt: string;
}

export interface GitRepo {
  id: UUID;
  workspaceId: UUID;
  path: string;
  remoteUrl?: string;
  createdAt: string;
}

export interface AuditEvent {
  id: UUID;
  workspaceId?: UUID;
  timestamp: string;
  category: 'project' | 'import' | 'export' | 'secret' | 'script' | 'mcp' | 'git' | 'security' | 'settings' | 'destructive' | 'run' | 'backup' | 'auth';
  action: string;
  detail?: string;
  actor?: string;
  severity?: 'info' | 'warning' | 'critical';
}

export interface ScriptLibraryEntry {
  id: UUID;
  workspaceId?: UUID;
  name: string;
  description?: string;
  code: string;
  version: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Snapshot {
  id: UUID;
  workspaceId: UUID;
  requestId: string;
  name: string;
  response: ApiResponse;
  ignorePaths: string[];
  createdAt: string;
}

export interface SecretPattern {
  id: string;
  name: string;
  pattern: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  builtin: boolean;
}

export interface SecurityFinding {
  id: string;
  severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Info';
  category: string;
  message: string;
  location: string;
  /** masked snippet (never the full secret) */
  snippet?: string;
  recommendation?: string;
}

export interface GovernanceRule {
  id: UUID;
  workspaceId?: UUID;
  name: string;
  kind: 'https-required' | 'auth-required' | 'no-hardcoded-secrets' | 'response-time-threshold' | 'documentation-required' | 'tests-required' | 'openapi-validation' | 'naming-convention';
  enabled: boolean;
  config?: Record<string, string>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  permissions: string[];
  entry: string;
}

export interface Plugin {
  id: UUID;
  manifest: PluginManifest;
  enabled: boolean;
  installedAt: string;
  path: string;
}

export interface Favorite { id: UUID; workspaceId: UUID; entityType: 'collection' | 'request' | 'folder' | 'spec'; entityId: string; sortOrder: number; }
export interface Tag { id: UUID; workspaceId: UUID; name: string; color?: string; }

export interface ConsoleLogEntry {
  id: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
  timestamp: string;
  data?: unknown;
}

export interface DocSite {
  id: UUID;
  workspaceId: UUID;
  name: string;
  collectionId?: string;
  theme: 'light' | 'dark';
  customCss?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Import/export
// ---------------------------------------------------------------------------

export interface MigrationReport {
  format: string;
  startedAt: string;
  finishedAt?: string;
  imported: { kind: string; name: string; id: string }[];
  converted: { kind: string; name: string; note?: string }[];
  skipped: { kind: string; name: string; reason: string }[];
  unsupported: { kind: string; name: string; detail: string }[];
  warnings: string[];
  secretsDetected: { location: string; masked: string }[];
  filesMissing: string[];
  scriptsRequiringReview: { location: string; reason: string }[];
}

export type ImportFormat =
  | 'postman-collection' | 'postman-environment' | 'postman-globals' | 'postman-dump'
  | 'openapi' | 'swagger' | 'asyncapi' | 'graphql-schema' | 'protobuf' | 'smithy'
  | 'wsdl' | 'soapui' | 'curl' | 'raw-http' | 'insomnia' | 'hoppscotch' | 'thunder'
  | 'dotenv' | 'json' | 'yaml' | 'apimanager';

export interface ImportResult {
  report: MigrationReport;
  collectionIds: string[];
  environmentIds: string[];
  specIds: string[];
  requestIds: string[];
}

// ---------------------------------------------------------------------------
// Performance testing
// ---------------------------------------------------------------------------

export interface PerfConfig {
  target: { kind: 'request' | 'collection'; id: string };
  environmentId?: string;
  concurrency: number;
  /** requests per second (0 = unlimited) */
  ratePerSecond: number;
  durationSec: number;
  iterations?: number;
  rampUpSec: number;
  rampDownSec: number;
  timeoutMs: number;
}

export interface PerfMetrics {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  errorRate: number;
  throughputPerSec: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50: number; p75: number; p90: number; p95: number; p99: number;
  totalBytes: number;
  avgBytes: number;
  samples: { t: number; latencyMs: number; status: number; error?: string }[];
  timeline: { t: number; concurrency: number; rps: number; avgMs: number; errors: number }[];
}

export interface PerfRun {
  id: UUID;
  workspaceId: UUID;
  config: PerfConfig;
  metrics?: PerfMetrics;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  startedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Traffic capture / network inventory
// ---------------------------------------------------------------------------

export interface CapturedExchange {
  id: string;
  timestamp: string;
  client: string;
  method: string;
  url: string;
  requestHeaders: KeyValue[];
  requestBody?: string;
  status?: number;
  responseHeaders?: KeyValue[];
  responseBody?: string;
  durationMs?: number;
}

export interface NetworkPortInfo {
  protocol: 'tcp' | 'udp' | 'tcp6' | 'udp6';
  localAddress: string;
  localPort: number;
  state: string;
  process?: string;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export interface BackupInfo {
  id: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  encrypted: boolean;
  sha256: string;
  kind: 'auto' | 'manual' | 'pre-import' | 'pre-destructive';
  note?: string;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  general: {
    theme: 'dark' | 'light' | 'system';
    density: 'compact' | 'comfortable';
    autosave: boolean;
    autosaveIntervalMs: number;
    crashRecovery: boolean;
    reopenLastWorkspace: boolean;
    restoreTabs: boolean;
    language: string;
  };
  editor: {
    fontFamily: string;
    fontSize: number;
    tabSize: number;
    insertSpaces: boolean;
    wordWrap: boolean;
    minimap: boolean;
    lineNumbers: boolean;
    responseZoom: number;
    requestZoom: number;
    scriptZoom: number;
    bracketMatching: boolean;
  };
  network: {
    timeoutMs: number;
    followRedirects: boolean;
    maxRedirects: number;
    verifyTls: boolean;
    proxyMode: 'system' | 'none' | 'custom';
    proxyUrl?: string;
    noProxy: string[];
    httpVersion: 'auto' | 'http1' | 'http2';
    maxRedirectsDefault: number;
  };
  security: {
    vaultAutoLockMinutes: number;
    maskSecrets: boolean;
    encryptDatabase: boolean;
    scriptSandbox: boolean;
    confirmDangerousScripts: boolean;
    redactSecretsInLogs: boolean;
  };
  data: {
    historyRetentionDays: number;
    responseRetentionDays: number;
    consoleRetentionHours: number;
    auditRetentionDays: number;
    maxResponseBodyBytes: number;
    autoBackup: boolean;
    autoBackupIntervalHours: number;
    maxAutoBackups: number;
    dataDir?: string;
  };
  runner: {
    defaultDelayMs: number;
    defaultTimeoutMs: number;
    stopOnFailure: boolean;
    persistResponses: boolean;
    maxConcurrency: number;
  };
  git: {
    userName: string;
    userEmail: string;
    defaultBranch: string;
    secretScanBeforeCommit: boolean;
    autoGenerateGitignore: boolean;
  };
  shortcuts: Record<string, string>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    theme: 'dark', density: 'comfortable', autosave: true, autosaveIntervalMs: 5000,
    crashRecovery: true, reopenLastWorkspace: true, restoreTabs: true, language: 'en',
  },
  editor: {
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace', fontSize: 13, tabSize: 2,
    insertSpaces: true, wordWrap: false, minimap: false, lineNumbers: true,
    responseZoom: 1, requestZoom: 1, scriptZoom: 1, bracketMatching: true,
  },
  network: {
    timeoutMs: 30000, followRedirects: true, maxRedirects: 10, verifyTls: true,
    proxyMode: 'none', noProxy: [], httpVersion: 'auto', maxRedirectsDefault: 10,
  },
  security: {
    vaultAutoLockMinutes: 15, maskSecrets: true, encryptDatabase: false, scriptSandbox: true,
    confirmDangerousScripts: true, redactSecretsInLogs: true,
  },
  data: {
    historyRetentionDays: 30, responseRetentionDays: 30, consoleRetentionHours: 24,
    auditRetentionDays: 365, maxResponseBodyBytes: 50 * 1024 * 1024,
    autoBackup: true, autoBackupIntervalHours: 6, maxAutoBackups: 12,
  },
  runner: { defaultDelayMs: 0, defaultTimeoutMs: 30000, stopOnFailure: false, persistResponses: true, maxConcurrency: 4 },
  git: { userName: 'API Manager User', userEmail: 'user@api-manager.local', defaultBranch: 'main', secretScanBeforeCommit: true, autoGenerateGitignore: true },
  shortcuts: {},
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export interface Paginated<T> { items: T[]; total: number; }

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export function now(): string { return new Date().toISOString(); }

export function defaultRetry(): RetryConfig {
  return { enabled: false, maxRetries: 2, strategy: 'exponential', delayMs: 500, retryStatusCodes: [429, 502, 503, 504], retryOnNetworkError: true, retryOnTimeout: true, onlyIdempotent: false };
}

export function defaultRequestSettings(): RequestSettings {
  return {
    timeoutMs: 30000, followRedirects: true, maxRedirects: 10,
    preserveAuthOnRedirect: true, stripSensitiveHeaders: true,
    retry: defaultRetry(), httpVersion: 'auto', encodeUrl: true, verifyTls: true, storeResponse: true,
  };
}

export function emptyAuth(): AuthConfig { return { type: 'none' }; }
