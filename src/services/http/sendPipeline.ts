/**
 * Send pipeline: the full lifecycle of executing an ApiRequest —
 * scope collection, variable resolution, script execution order
 * (collection pre → folder pre → request pre → SEND → request post →
 * folder post → collection post), auth, body building, cookies, retry,
 * assertions, history + response persistence (§7, §32, §35).
 */
import type {
  ApiRequest, ApiResponse, AuthConfig, Certificate, Collection, Environment,
  Folder, KeyValue, RequestBody, TestResult, Variable,
} from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { VariableResolver, ScopeSource } from '../../core/vars/resolver';
import { buildUrl, applyPathParams } from '../../core/url/urlBuilder';
import { applyGraphQL } from '../../core/graphqlx/graphql';
import { buildSoapMessage } from '../../core/soap/envelope';
import { evaluateAssertions } from '../../core/assert/assertions';
import { createHash, randomBytes, createHmac } from 'node:crypto';
import { bytesToBase64, base64ToBytes, utf8ToBytes } from '../../core/misc/codec';
import { applyAuth, SignedResult } from '../auth/signers';
import { sendHttp, EngineResult, ProxyConfig, TlsMaterial, cancelOp } from './engine';
import { runScript, makeMemoryStore, wrapStore, RunScriptOutcome } from '../scripts/sandbox';
import type { ScopeStore, ScriptOutcome } from '../../core/scripting/pmApi';
import type { SendOptions, SendResult } from '../../shared/api';
import type { RequestProgressEvent } from '../../shared/events';
import { resolve as resolvePath } from 'node:path';
import { readFileSync } from 'node:fs';
import { lookup as mimeLookup } from 'mime-types';
import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

export interface PipelineDeps {
  getEnvironment: (id?: string) => Environment | undefined;
  getActiveEnvironmentId: () => string | undefined;
  getCollection: (id?: string) => Collection | undefined;
  getFolderChain: (folderId?: string) => Folder[];  // root → leaf order
  getGlobalVars: () => Variable[];
  getWorkspaceVars: () => Variable[];
  getCollectionParents: (collectionId?: string) => { collection?: Collection };
  resolveSecretRef: (value: string) => string;    // {{vault:name}} support
  getCookieHeader: (url: string) => string;
  storeCookies: (workspaceId: string, url: string, cookies: { name: string; value: string; domain: string; path: string; raw: string }[]) => void;
  loadCertificate: (id?: string, host?: string) => TlsMaterial | undefined;
  resolveProxy: (request: ApiRequest) => ProxyConfig | null;
  onConsole: (level: string, source: string, message: string) => void;
  onProgress?: (ev: RequestProgressEvent) => void;
  persistHistory: (entry: { request: ApiRequest; response?: ApiResponse; error?: string }) => void;
  persistResponse: (workspaceId: string, response: ApiResponse) => void;
  audit: (action: string, detail?: string, category?: string) => void;
  /** Persist script-driven scope mutations (pm.environment.set / pm.globals.set / pm.collectionVariables.set). Optional: flowRunner re-implements. */
  applyVariableChanges?: (changes: {
    environment?: { id: string; name: string; vars: Record<string, string | undefined> };
    globals?: Record<string, string | undefined>;
    collection?: { id: string; name: string; vars: Record<string, string | undefined> };
  }) => void;
  maxBodyBytes: number;
  dataRow?: Record<string, string>;
}

function varsToScope(vars: Variable[] | undefined, scope: ScopeSource['scope'], sourceId?: string, sourceName?: string): ScopeSource {
  return {
    scope, sourceId, sourceName,
    vars: Object.fromEntries((vars ?? []).filter((v) => v.enabled).map((v) => [v.key, { value: v.value, isSecret: v.type === 'secret' }])),
  };
}

function makeDbBackedStore(get: () => Record<string, string>, set: (key: string, value?: string) => void, backing?: Record<string, string>): ScopeStore {
  return {
    get: (k) => get()[k],
    set: (k, v) => set(k, v),
    has: (k) => k in (backing ?? get()),
    unset: (k) => set(k, undefined),
    toObject: () => get(),
  };
}

export interface PipelineResult extends SendResult { opId: string }

export async function executeRequest(opts: SendOptions, deps: PipelineDeps): Promise<PipelineResult> {
  const opId = uid();
  const request = opts.request;
  const workspaceId = request.workspaceId;
  const consoleLogs: SendResult['consoleLogs'] = [];
  const log = (level: string, source: string, args: unknown[]) => {
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    consoleLogs.push({ level, args, script: source });
    deps.onConsole(level, `script:${source}`, message);
  };
  const timeoutMs = 10_000;

  const env = deps.getEnvironment(opts.environmentId ?? deps.getActiveEnvironmentId());
  const collection = deps.getCollection(request.collectionId);
  const folderChain = deps.getFolderChain(request.folderId);
  const globals = deps.getGlobalVars();
  const workspaceVars = deps.getWorkspaceVars();

  // Certificates + proxy resolution against the raw request URL
  let host = '';
  try { host = new URL(resolveEarly(request.url, env)).hostname; } catch { /* ignore */ }
  const tls = deps.loadCertificate(request.settings.certificateId, host);
  const proxy = deps.resolveProxy(request);

  // --- scope stores (script mutations captured and persisted by orchestrator)
  const envChanges: Record<string, string | undefined> = {};
  const globalChanges: Record<string, string | undefined> = {};
  const collectionChanges: Record<string, string | undefined> = {};
  const envBacking = Object.fromEntries((env?.variables ?? []).filter((v) => v.enabled).map((v) => [v.key, v.value]));
  const globalsBacking = Object.fromEntries(globals.filter((v) => v.enabled).map((v) => [v.key, v.value]));
  const collBacking = Object.fromEntries((collection?.variables ?? []).filter((v) => v.enabled).map((v) => [v.key, v.value]));
  const envStore = makeDbBackedStore(() => ({ ...envBacking, ...defined(envChanges) }), (k, v) => { envChanges[k] = v; });
  const globalStore = makeDbBackedStore(() => ({ ...globalsBacking, ...defined(globalChanges) }), (k, v) => { globalChanges[k] = v; });
  const collStore = makeDbBackedStore(() => ({ ...collBacking, ...defined(collectionChanges) }), (k, v) => { collectionChanges[k] = v; });
  const localStore = makeMemoryStore({});
  const dataStore = opts.overrides || deps.dataRow ? makeMemoryStore({ ...(deps.dataRow ?? {}), ...(opts.overrides ?? {}) }) : undefined;

  const scopeSources: ScopeSource[] = [
    varsToScope(globals, 'global', undefined, 'Globals'),
    varsToScope(workspaceVars, 'workspace'),
    varsToScope(env?.variables, 'environment', env?.id, env?.name),
    varsToScope(collection?.variables, 'collection', collection?.id, collection?.name),
  ];
  for (const folder of folderChain) {
    scopeSources.push(varsToScope((folder as unknown as { variables?: Variable[] }).variables, 'folder', folder.id, folder.name));
  }
  scopeSources.push({
    scope: 'script',
    vars: new Proxy({}, {
      get: (_t, prop) => ({ value: String(localStore.get(String(prop)) ?? ''), enabled: true }),
    }) as unknown as ScopeSource['vars'],
  });

  const resolverFor = (extraLocal?: Record<string, string>) => new VariableResolver([
    ...scopeSources.slice(0, -1),
    ...(deps.dataRow ? [{ scope: 'data' as const, vars: Object.fromEntries(Object.entries(deps.dataRow).map(([k, v]) => [k, { value: v }])), sourceName: 'iteration data' }] : []),
    ...(opts.overrides ? [{ scope: 'local' as const, vars: Object.fromEntries(Object.entries(opts.overrides).map(([k, v]) => [k, { value: v }])), sourceName: 'overrides' }] : []),
    ...(extraLocal ? [{ scope: 'local' as const, vars: Object.fromEntries(Object.entries(extraLocal).map(([k, v]) => [k, { value: v }])), sourceName: 'script local' }] : []),
    {
      scope: 'script' as const,
      vars: {},
    },
  ]);

  const contextForScripts = () => ({
    environment: envStore,
    globals: globalStore,
    collectionVariables: collStore,
    localVariables: localStore,
    iterationData: dataStore,
    variablesResolver: (name: string) => {
      const r = new VariableResolver([
        varsToScope(globals, 'global'), varsToScope(workspaceVars, 'workspace'),
        varsToScope(env?.variables, 'environment', env?.id, env?.name),
        varsToScope(collection?.variables, 'collection'),
        { scope: 'local', vars: Object.fromEntries(Object.entries(localStore.toObject()).map(([k, v]) => [k, { value: v }])) },
      ]);
      return r.get(name).value;
    },
  });

  const scriptResults: { label: string; result: RunScriptOutcome }[] = [];
  const runOne = async (code: string, label: string, phase: 'prerequest' | 'test', req: ApiRequest, res?: ApiResponse): Promise<RunScriptOutcome | undefined> => {
    if (!code.trim()) return undefined;
    const sendRequestFn = makeSendRequestFn(deps, opts, log, proxy, tls);
    const outcome = await runScript({
      code, eventName: phase, request: req, response: res,
      stores: contextForScripts(),
      sendRequest: sendRequestFn,
      timeoutMs,
      consoleTarget: (entry) => log(entry.level, label, entry.args),
      scriptLabel: label,
    });
    scriptResults.push({ label, result: outcome });
    return outcome;
  };

  const preResults: TestResult[] = [];
  const postResults: TestResult[] = [];
  let assertionResults: TestResult[] = [];
  let variableTrace: SendResult['variableTrace'] = [];
  let resolvedUrl = request.url;
  let response: ApiResponse | undefined;
  let error: string | undefined;
  let nextRequestId: string | undefined;
  let skipRequested = false;

  try {
    // Clone request so scripts can mutate their working copy
    let working: ApiRequest = JSON.parse(JSON.stringify(request));

    // PRE: collection → folders → request
    const preScripts: { code: string; label: string }[] = [];
    if (collection?.scripts.preRequest.trim()) preScripts.push({ code: collection.scripts.preRequest, label: `collection:${collection.name}` });
    for (const f of folderChain) if (f.scripts.preRequest.trim()) preScripts.push({ code: f.scripts.preRequest, label: `folder:${f.name}` });
    if (working.scripts.preRequest.trim()) preScripts.push({ code: working.scripts.preRequest, label: `request:${working.name}` });

    let inheritedAuth = resolveAuthChain(working, folderChain, collection);
    working.auth = inheritedAuth;

    for (const ps of preScripts) {
      const out = await runOne(ps.code, ps.label, 'prerequest', working);
      if (out?.outcome.skipRequested) { skipRequested = true; break; }
      if (out?.outcome.nextRequest) nextRequestId = out.outcome.nextRequest;
    }

    // Apply local variable mutations when resolving the actual request
    const resolver = resolverFor(localStore.toObject());
    working = resolveAllFields(working, resolver, deps.resolveSecretRef);
    const urlResolution = resolver.resolve(`${applyPathParams(working.url, working.pathParams)}`);
    resolvedUrl = urlResolution.resolved;
    variableTrace = urlResolution.trace;
    if (urlResolution.unresolved.length > 0) {
      deps.onConsole('warn', 'send', `Unresolved variables in URL: ${urlResolution.unresolved.join(', ')}`);
    }

    for (const ps of preResultsVoid(scriptResults)) preResults.push(...ps);

    if (skipRequested) {
      deps.onConsole('info', 'send', `Request "${working.name}" skipped by script`);
      return finalize({ opId, request: working, response: undefined, error: undefined, preResults, postResults, assertionResults, resolvedUrl, variableTrace, consoleLogs, skipped: true, nextRequestId });
    }

    // Protocol adaptation
    let materialized = working;
    if (working.protocol === 'graphql') materialized = applyGraphQL(working);
    if (working.protocol === 'soap') materialized = materializeSoap(working);
    materialized.url = resolvedUrl;
    materialized.queryParams = materialized.queryParams.map((p) => ({ ...p, key: resolver.resolve(p.key).resolved, value: resolver.resolve(p.value).resolved }));
    resolvedUrl = buildUrl(resolvedUrl, materialized.queryParams, materialized.settings.encodeUrl !== false);
    if (working.protocol === 'graphql' && working.method === 'GET') {
      // query/variables already normalized into URL by applyGraphQL via body; rebuild
      materialized.url = resolvedUrl;
    }

    // Final headers (auth applied)
    const sendResult = await materializeAndSend({ request: materialized, resolvedUrl, deps, proxy, tls, opId, auth: working.auth });
    response = sendResult.response;
    response.requestId = request.id;

    // POST scripts: request → folders → collection
    const postScripts: { code: string; label: string }[] = [];
    if (working.scripts.postResponse.trim()) postScripts.push({ code: working.scripts.postResponse, label: `request:${working.name}` });
    for (const f of [...folderChain].reverse()) if (f.scripts.postResponse.trim()) postScripts.push({ code: f.scripts.postResponse, label: `folder:${f.name}` });
    if (collection?.scripts.postResponse.trim()) postScripts.push({ code: collection.scripts.postResponse, label: `collection:${collection.name}` });
    for (const ps of postScripts) {
      const out = await runOne(ps.code, ps.label, 'test', working, response);
      if (out) postResults.push(...out.outcome.tests);
      if (out?.outcome.nextRequest) nextRequestId = out.outcome.nextRequest;
    }

    // Declarative assertions
    assertionResults = evaluateAssertions(working.assertions, response, (schema, data) => {
      try {
        const validate = ajv.compile(JSON.parse(schema));
        const ok = validate(data);
        return ok ? true : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`).join('; ');
      } catch (e) { return `schema error: ${e instanceof Error ? e.message : e}`; }
    });

    // Persist cookies returned
    deps.storeCookies(workspaceId, sendResult.finalUrl, sendResult.setCookies);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    deps.onConsole('error', 'send', `Request failed: ${error}`);
  }

  // Persist script-driven scope mutations (Postman parity: pm.environment.set / pm.globals.set / pm.collectionVariables.set persist after the request)
  try {
    const hasEnv = !!env && Object.keys(envChanges).length > 0;
    const hasGlobal = Object.keys(globalChanges).length > 0;
    const hasColl = !!collection && Object.keys(collectionChanges).length > 0;
    if ((hasEnv || hasGlobal || hasColl) && deps.applyVariableChanges) {
      deps.applyVariableChanges({
        environment: hasEnv ? { id: env!.id, name: env!.name, vars: envChanges } : undefined,
        globals: hasGlobal ? globalChanges : undefined,
        collection: hasColl ? { id: collection!.id, name: collection!.name, vars: collectionChanges } : undefined,
      });
    }
  } catch (e) {
    deps.onConsole('warn', 'send', `Failed to persist variable changes: ${e instanceof Error ? e.message : e}`);
  }

  // persist history + response
  try {
    deps.persistHistory({ request, response, error });
    if (response && !error) deps.persistResponse(workspaceId, response);
  } catch (persistErr) {
    deps.onConsole('warn', 'persistence', `Failed to persist history/response: ${persistErr instanceof Error ? persistErr.message : persistErr}`);
  }

  return finalize({ opId, request, response, error, preResults, postResults, assertionResults, resolvedUrl, variableTrace, consoleLogs, skipped: skipRequested, nextRequestId });
}

function preResultsVoid(scriptResults: { label: string; result: RunScriptOutcome }[]): TestResult[][] {
  return scriptResults.filter((s) => s.result.outcome.tests.length > 0).map((s) => s.result.outcome.tests);
}

function defined(rec: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) if (v !== undefined) out[k] = v;
  return out;
}

function finalize(x: {
  opId: string; request: ApiRequest; response?: ApiResponse; error?: string;
  preResults: TestResult[]; postResults: TestResult[]; assertionResults: TestResult[];
  resolvedUrl: string; variableTrace: SendResult['variableTrace'];
  consoleLogs: SendResult['consoleLogs']; skipped: boolean; nextRequestId?: string;
}): PipelineResult {
  return {
    opId: x.opId,
    response: x.response,
    error: x.error,
    preTestResults: x.preResults,
    postTestResults: x.postResults,
    assertionResults: x.assertionResults,
    resolvedUrl: x.resolvedUrl,
    variableTrace: x.variableTrace ?? [],
    consoleLogs: x.consoleLogs,
    skippedByScript: x.skipped || undefined,
    nextRequestId: x.nextRequestId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function resolveAllFields(req: ApiRequest, resolver: VariableResolver, resolveSecret: (v: string) => string): ApiRequest {
  const r: ApiRequest = JSON.parse(JSON.stringify(req));
  const res = (s?: string) => (s === undefined ? s : resolver.resolve(s).resolved);
  const resKv = (list: KeyValue[]) => list.map((kv2) => ({ ...kv2, key: res(kv2.key) ?? kv2.key, value: res(kv2.value) ?? kv2.value }));
  r.url = res(r.url) ?? r.url;
  r.pathParams = resKv(r.pathParams);
  r.queryParams = resKv(r.queryParams);
  r.headers = resKv(r.headers);
  if (r.body.raw) r.body.raw = res(r.body.raw);
  if (r.body.graphql) {
    r.body.graphql = { ...r.body.graphql, query: res(r.body.graphql.query) ?? '', variables: res(r.body.graphql.variables) ?? '' };
  }
  if (r.body.urlencoded) r.body.urlencoded = resKv(r.body.urlencoded);
  if (r.body.formData) r.body.formData = r.body.formData.map((f) => ({ ...f, key: res(f.key) ?? f.key, value: res(f.value) ?? f.value }));
  r.auth = resolveAuthFields(r.auth, resolver, resolveSecret);
  return r;
}

function resolveAuthFields(auth: AuthConfig, resolver: VariableResolver, resolveSecret: (v: string) => string): AuthConfig {
  const a: AuthConfig = JSON.parse(JSON.stringify(auth ?? { type: 'none' }));
  const res = (s?: string) => (s === undefined ? s : resolveSecret(resolver.resolve(s).resolved));
  switch (a.type) {
    case 'basic': if (a.basic) { a.basic.username = res(a.basic.username) ?? ''; a.basic.password = res(a.basic.password) ?? ''; } break;
    case 'bearer': if (a.bearer) a.bearer.token = res(a.bearer.token) ?? ''; break;
    case 'apikey': if (a.apikey) { a.apikey.key = res(a.apikey.key) ?? ''; a.apikey.value = res(a.apikey.value) ?? ''; } break;
    case 'digest': if (a.digest) { a.digest.username = res(a.digest.username) ?? ''; a.digest.password = res(a.digest.password) ?? ''; } break;
    case 'oauth1': if (a.oauth1) { a.oauth1.consumerKey = res(a.oauth1.consumerKey) ?? ''; a.oauth1.consumerSecret = res(a.oauth1.consumerSecret) ?? ''; a.oauth1.token = res(a.oauth1.token); a.oauth1.tokenSecret = res(a.oauth1.tokenSecret); } break;
    case 'oauth2': if (a.oauth2) { a.oauth2.accessToken = res(a.oauth2.accessToken); a.oauth2.clientId = res(a.oauth2.clientId); a.oauth2.clientSecret = res(a.oauth2.clientSecret); } break;
    case 'jwt': if (a.jwt) { a.jwt.token = res(a.jwt.token); a.jwt.secret = res(a.jwt.secret); } break;
    case 'aws4': if (a.aws4) { a.aws4.accessKey = res(a.aws4.accessKey) ?? ''; a.aws4.secretKey = res(a.aws4.secretKey) ?? ''; a.aws4.sessionToken = res(a.aws4.sessionToken); a.aws4.region = res(a.aws4.region) ?? ''; a.aws4.service = res(a.aws4.service) ?? ''; } break;
    case 'hawk': if (a.hawk) { a.hawk.authId = res(a.hawk.authId) ?? ''; a.hawk.authKey = res(a.hawk.authKey) ?? ''; } break;
    case 'ntlm': if (a.ntlm) { a.ntlm.username = res(a.ntlm.username) ?? ''; a.ntlm.password = res(a.ntlm.password) ?? ''; a.ntlm.domain = res(a.ntlm.domain); } break;
    case 'custom': if (a.custom) { a.custom.expression = res(a.custom.expression); } break;
  }
  return a;
}

function resolveAuthChain(request: ApiRequest, folderChain: Folder[], collection?: Collection): AuthConfig {
  if (request.auth.type !== 'inherit') return request.auth;
  for (let i = folderChain.length - 1; i >= 0; i--) {
    const auth = folderChain[i].auth;
    if (auth && auth.type !== 'inherit' && auth.type !== 'none') return auth;
  }
  if (collection?.auth && collection.auth.type !== 'inherit' && collection.auth.type !== 'none') return collection.auth;
  return { type: 'none' };
}

function resolveEarly(url: string, env?: Environment): string {
  if (!env) return url;
  let out = url;
  for (const v of env.variables) out = out.replace(new RegExp(`\\{\\{\\s*${v.key}\\s*\\}\\}`, 'g'), v.value);
  return out;
}

// ---------------------------------------------------------------------------
// SOAP materialization
// ---------------------------------------------------------------------------

function materializeSoap(req: ApiRequest): ApiRequest {
  const copy: ApiRequest = JSON.parse(JSON.stringify(req));
  const soapConfig = copy.protocolData?.soap ?? { version: '1.1' as const };
  const customHeaders = copy.headers.filter((h) => {
    const lk = h.key.toLowerCase();
    return h.enabled && lk !== 'content-type' && lk !== 'soapaction';
  });
  const digestProvider = (nonceB64: string, created: string, password: string) => {
    const sha1 = createHash('sha1').update(Buffer.concat([base64ToBytes(nonceB64) as never, utf8ToBytes(created) as never, utf8ToBytes(password) as never])).digest();
    return sha1.toString('base64');
  };
  const built = buildSoapMessage({ config: soapConfig, bodyXml: copy.body.raw ?? '', targetNamespace: undefined, digestProvider });
  copy.body = { type: 'xml', raw: built.body };
  const headers: KeyValue[] = [
    { id: uid(), key: 'Content-Type', value: built.contentType, enabled: true },
    ...built.headers.map((h) => ({ id: uid(), key: h.key, value: h.value, enabled: true })),
  ];
  if (built.soapAction) headers.push({ id: uid(), key: 'SOAPAction', value: built.soapAction.startsWith('"') ? built.soapAction : `"${built.soapAction}"`, enabled: true });
  copy.headers = [...headers, ...customHeaders];
  return copy;
}

// ---------------------------------------------------------------------------
// Materialization + send
// ---------------------------------------------------------------------------

async function materializeAndSend(args: {
  request: ApiRequest; resolvedUrl: string; deps: PipelineDeps; proxy: ProxyConfig | null; tls?: TlsMaterial; opId: string; auth: AuthConfig;
}): Promise<EngineResult & { response: ApiResponse; finalUrl: string }> {
  const { request, resolvedUrl, deps, proxy, tls, opId } = args;
  const body = await buildBody(request.body, resolvedUrl);
  let headers = request.headers.filter((h) => h.enabled && h.key);
  // content-type suggestion when not present
  const hasCt = headers.some((h) => h.key.toLowerCase() === 'content-type');
  if (!hasCt && body.suggestedContentType) headers.push({ id: uid(), key: 'Content-Type', value: body.suggestedContentType, enabled: true });
  if (!headers.some((h) => h.key.toLowerCase() === 'user-agent')) headers.push({ id: uid(), key: 'User-Agent', value: 'API-Manager/1.0', enabled: true });
  if (!headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push({ id: uid(), key: 'Accept', value: '*/*', enabled: true });
  if (!headers.some((h) => h.key.toLowerCase() === 'accept-encoding')) headers.push({ id: uid(), key: 'Accept-Encoding', value: 'gzip, deflate, br', enabled: true });

  // auth
  const warnings: string[] = [];
  if (request.auth && request.auth.type !== 'none') {
    const signed: SignedResult = applyAuth(request.auth, { method: request.method, url: resolvedUrl, body: body.body ?? undefined, existingHeaders: headers });
    warnings.push(...signed.warnings);
    for (const h of signed.headers) replaceOrAdd(headers, h.key, h.value);
    if (signed.query.length > 0) {
      const extra = signed.query.map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`).join('&');
      args.resolvedUrl = `${resolvedUrl}${resolvedUrl.includes('?') ? '&' : '?'}${extra}`;
    }
  }
  for (const w of warnings) deps.onConsole('warn', 'auth', w);

  const cookieHeader = deps.getCookieHeader(args.resolvedUrl);
  const result = await sendHttp({
    method: request.method, url: args.resolvedUrl, headers, body: body.body ?? null,
    settings: request.settings, auth: request.auth, tls, proxy,
    cookieHeader: cookieHeader || undefined,
    maxBodyBytes: deps.maxBodyBytes,
  }, { opId, onProgress: deps.onProgress });

  return { ...result, response: { ...result.response, id: uid() } as ApiResponse, finalUrl: args.resolvedUrl };
}

function replaceOrAdd(headers: KeyValue[], key: string, value: string): void {
  const idx = headers.findIndex((h) => h.key.toLowerCase() === key.toLowerCase());
  if (idx >= 0) headers[idx] = { ...headers[idx], value };
  else headers.push({ id: uid(), key, value, enabled: true });
}

async function buildBody(body: RequestBody, _url: string): Promise<{ body?: Buffer; suggestedContentType?: string }> {
  if (!body) return {};
  switch (body.type) {
    case 'none': return {};
    case 'json': return { body: Buffer.from(body.raw ?? '', 'utf8'), suggestedContentType: body.contentTypeOverride ?? 'application/json' };
    case 'xml': return { body: Buffer.from(body.raw ?? '', 'utf8'), suggestedContentType: body.contentTypeOverride ?? 'application/xml' };
    case 'html': return { body: Buffer.from(body.raw ?? '', 'utf8'), suggestedContentType: body.contentTypeOverride ?? 'text/html' };
    case 'javascript': return { body: Buffer.from(body.raw ?? '', 'utf8'), suggestedContentType: body.contentTypeOverride ?? 'application/javascript' };
    case 'text': return { body: Buffer.from(body.raw ?? '', 'utf8'), suggestedContentType: body.contentTypeOverride ?? 'text/plain' };
    case 'graphql': {
      const raw = JSON.stringify({ query: body.graphql?.query ?? '', variables: tryJson(body.graphql?.variables ?? ''), operationName: body.graphql?.operationName });
      return { body: Buffer.from(raw, 'utf8'), suggestedContentType: 'application/json' };
    }
    case 'urlencoded': {
      const encoded = (body.urlencoded ?? []).filter((p) => p.enabled && p.key)
        .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
      return { body: Buffer.from(encoded, 'utf8'), suggestedContentType: body.contentTypeOverride ?? 'application/x-www-form-urlencoded' };
    }
    case 'form-data': {
      const boundary = `----ApiManagerBoundary${randomBytes(12).toString('hex')}`;
      const chunks: Buffer[] = [];
      for (const field of body.formData ?? []) {
        if (!field.enabled || !field.key) continue;
        if (field.fieldType === 'file') {
          const paths = field.filePaths?.length ? field.filePaths : [field.filePath ?? field.value];
          for (const rawPath of paths) {
            const path = resolvePath(rawPath ?? '');
            let content: Buffer;
            try { content = readFileSync(path); } catch (e) {
              throw new Error(`Form file "${field.key}" not found: ${path} (${e instanceof Error ? e.message : e})`);
            }
            const fileName = field.fileName ?? path.split(/[\\/]/).pop() ?? 'file';
            const mime = field.mimeType ?? (mimeLookup(fileName) || 'application/octet-stream');
            chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(field.key)}"; filename="${escapeQuotes(fileName)}"\r\nContent-Type: ${mime}\r\n\r\n`));
            chunks.push(content);
            chunks.push(Buffer.from('\r\n'));
          }
        } else {
          chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuotes(field.key)}"\r\n\r\n${field.value}\r\n`));
        }
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`));
      return { body: Buffer.concat(chunks), suggestedContentType: body.contentTypeOverride ?? `multipart/form-data; boundary=${boundary}` };
    }
    case 'binary': case 'file': {
      if (!body.binaryFilePath) return {};
      const path = resolvePath(body.binaryFilePath);
      let content: Buffer;
      try { content = readFileSync(path); } catch (e) {
        throw new Error(`Binary file not found: ${path} (${e instanceof Error ? e.message : e})`);
      }
      return { body: content, suggestedContentType: body.contentTypeOverride ?? (mimeLookup(path) || 'application/octet-stream') };
    }
    default: return {};
  }
}

function escapeQuotes(s: string): string { return s.replace(/"/g, '\\"'); }
function tryJson(s: string): unknown { try { return s.trim() ? JSON.parse(s) : {}; } catch { return {}; } }

function makeSendRequestFn(deps: PipelineDeps, opts: SendOptions, log: (level: string, source: string, args: unknown[]) => void, proxy: ProxyConfig | null, tls?: TlsMaterial) {
  return async (req: string | { url: string; method?: string; header?: Record<string, string> | KeyValue[]; body?: string | { raw?: string } }): Promise<ApiResponse> => {
    const normalized = typeof req === 'string' ? { url: req } : req;
    const url = normalized.url;
    if (!url) throw new Error('pm.sendRequest requires a URL');
    const headers: KeyValue[] = normalized.header
      ? Array.isArray(normalized.header)
        ? normalized.header.map((h) => ({ ...h, id: uid(), enabled: true }))
        : Object.entries(normalized.header).map(([key, value]) => ({ id: uid(), key, value: String(value), enabled: true }))
      : [];
    const bodyRaw = typeof normalized.body === 'string' ? normalized.body : normalized.body?.raw;
    log('info', 'pm.sendRequest', [`${normalized.method ?? 'GET'} ${url}`]);
    const env = deps.getEnvironment(opts.environmentId ?? deps.getActiveEnvironmentId());
    const resolver = new VariableResolver([
      varsToScope(deps.getGlobalVars(), 'global'),
      varsToScope(deps.getWorkspaceVars(), 'workspace'),
      varsToScope(env?.variables, 'environment', env?.id, env?.name),
    ]);
    const resolved = resolver.resolve(url).resolved;
    const result = await sendHttp({
      method: (normalized.method ?? 'GET').toUpperCase(),
      url: resolved,
      headers: headers.map((h) => ({ ...h, key: resolver.resolve(h.key).resolved, value: resolver.resolve(h.value).resolved })),
      body: bodyRaw ? Buffer.from(bodyRaw, 'utf8') : null,
      settings: {
        timeoutMs: 30000, followRedirects: true, maxRedirects: 5, preserveAuthOnRedirect: true,
        stripSensitiveHeaders: true, retry: { enabled: false, maxRetries: 0, strategy: 'fixed', delayMs: 0, retryStatusCodes: [], retryOnNetworkError: false, retryOnTimeout: false, onlyIdempotent: false },
        httpVersion: 'auto', encodeUrl: true, verifyTls: true, storeResponse: false,
      },
      proxy,
      tls,
      cookieHeader: deps.getCookieHeader(resolved) || undefined,
      maxBodyBytes: deps.maxBodyBytes,
    }, {});
    return { ...result.response, id: uid() };
  };
}

export { cancelOp };
