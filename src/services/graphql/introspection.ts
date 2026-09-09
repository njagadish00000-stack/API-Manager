/**
 * GraphQL: introspection query against live servers, schema helpers,
 * explorer query builder, request normalization (body/query/variables),
 * prettify/format, lint rules, schema diff & breaking changes.
 */
import { request } from 'undici';
import type { ApiRequest, KeyValue } from '../../shared/types';
import { uid } from '../../shared/ids';
import { INTROSPECTION_QUERY } from '../../core/graphqlx/graphql';

export interface GqlIntrospectionType {
  kind: string;
  name: string | null;
  description?: string | null;
  fields?: { name: string; description?: string | null; args: { name: string; type: GqlTypeRef }[]; type: GqlTypeRef }[] | null;
  inputFields?: { name: string; type: GqlTypeRef }[] | null;
  interfaces?: GqlTypeRef[] | null;
  enumValues?: { name: string; description?: string | null }[] | null;
  possibleTypes?: GqlTypeRef[] | null;
  ofType?: GqlTypeRef | null;
}

interface GqlTypeRef { kind: string; name: string | null; ofType: GqlTypeRef | null }

interface IntrospectionResult {
  __schema: {
    queryType: { name: string } | null;
    mutationType: { name: string } | null;
    subscriptionType: { name: string } | null;
    types: GqlIntrospectionType[];
  };
}

export async function introspect(url: string, headers: KeyValue[]): Promise<IntrospectionResult> {
  const hdrs: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
  for (const h of headers) if (h.enabled && h.key) hdrs[h.key] = h.value;
  const res = await request(url, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });
  const text = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`Introspection failed (HTTP ${res.statusCode}): ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text) as { data?: IntrospectionResult; errors?: { message: string }[] };
  if (parsed.errors?.length) throw new Error(`Introspection errors: ${parsed.errors.map((e) => e.message).join('; ')}`);
  if (!parsed.data) throw new Error('Introspection returned no data (introspection may be disabled on this server)');
  return parsed.data;
}

/** Build a compact text listing of the schema for the explorer (§12). */
export interface GqlApiSurface { queryType: { name: string } | null; mutationType: { name: string } | null; subscriptionType: { name: string } | null; types: GqlIntrospectionType[] }
export type GqlSchemaShape = IntrospectionResult | GqlApiSurface;
function schemaOf(schema: GqlSchemaShape): GqlApiSurface {
  return ('__schema' in schema ? schema.__schema : schema) as GqlApiSurface;
}
export function schemaSummary(schema: GqlSchemaShape): { operations: { kind: string; name: string; signature: string }[]; types: { name: string; kind: string }[] } {
  const s = schemaOf(schema);
  const operations: { kind: string; name: string; signature: string }[] = [];
  const addOps = (kind: string, typeName: string | null) => {
    if (!typeName) return;
    const t = s.types.find((x) => x.name === typeName);
    for (const f of t?.fields ?? []) {
      const args = (f.args ?? []).map((a) => `${a.name}: ${typeRefToString(a.type)}`).join(', ');
      operations.push({ kind, name: f.name, signature: `${f.name}(${args}): ${typeRefToString(f.type)}` });
    }
  };
  addOps('query', s.queryType?.name ?? null);
  addOps('mutation', s.mutationType?.name ?? null);
  addOps('subscription', s.subscriptionType?.name ?? null);
  const types = s.types.filter((t) => t.name && !t.name.startsWith('__')).map((t) => ({ name: t.name!, kind: t.kind }));
  return { operations, types };
}

function typeRefToString(ref: GqlTypeRef): string {
  if (ref.kind === 'NON_NULL') return `${ref.ofType ? typeRefToString(ref.ofType) : 'Unknown'}!`;
  if (ref.kind === 'LIST') return `[${ref.ofType ? typeRefToString(ref.ofType) : 'Unknown'}]`;
  return ref.name ?? 'Unknown';
}

/** Generate a starter query for an operation (§12 schema explorer). */
export function buildQueryForOperation(schema: GqlSchemaShape, operationName: string, depth = 2): string {
  const s = schemaOf(schema);
  const rootNames = [s.queryType?.name, s.mutationType?.name, s.subscriptionType?.name].filter((n): n is string => !!n);
  for (const rootName of rootNames) {
    const rootType = s.types.find((t) => t.name === rootName);
    for (const field of rootType?.fields ?? []) {
      if (field.name !== operationName) continue;
      const args = (field.args ?? []).map((a) => a.name).join(', ');
      const variables = (field.args ?? []).map((a) => `$${a.name}: ${typeRefToString(a.type)}`).join(', ');
      const selection = buildSelection(field.type, s, depth);
      const opKeyword = rootName === s.mutationType?.name ? 'mutation' : rootName === s.subscriptionType?.name ? 'subscription' : 'query';
      return `${opKeyword} ${capitalize(operationName)}${variables ? `(${variables})` : ''} {\n  ${operationName}${args ? `(${(field.args ?? []).map((a) => `${a.name}: $${a.name}`).join(', ')})` : ''}${selection}\n}`;
    }
  }
  throw new Error(`Operation not found: ${operationName}`);
}

function buildSelection(ref: GqlTypeRef, schema: GqlApiSurface, depth: number, indent = '    '): string {
  if (depth <= 0) return '';
  const named = unwrapNamed(ref);
  if (!named) return '';
  const type = schema.types.find((t) => t.name === named);
  if (!type || !type.fields?.length) return '';
  const lines: string[] = [' {'];
  for (const f of type.fields.filter((x) => !x.name.startsWith('__')).slice(0, 12)) {
    const child = unwrapNamed(f.type);
    const childType = child ? schema.types.find((t) => t.name === child) : undefined;
    const isComposite = childType && (childType.kind === 'OBJECT' || childType.kind === 'INTERFACE' || childType.kind === 'UNION');
    if (isComposite && depth > 1) {
      lines.push(`${indent}${f.name}${buildSelection(f.type, schema, depth - 1, indent + '  ')}`);
    } else {
      lines.push(`${indent}${f.name}`);
    }
  }
  lines.push(`${indent.slice(0, -2) || '  '}}`);
  return lines.join('\n');
}

function unwrapNamed(ref: GqlTypeRef): string | null {
  let cur: GqlTypeRef | null | undefined = ref;
  while (cur) {
    if (cur.kind !== 'NON_NULL' && cur.kind !== 'LIST') return cur.name;
    cur = cur.ofType;
  }
  return null;
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------------------
// Query lint / prettify (§12)
// ---------------------------------------------------------------------------

export interface GqlLintIssue { severity: 'error' | 'warning' | 'info'; message: string; line?: number }

export function lintQuery(query: string): GqlLintIssue[] {
  const issues: GqlLintIssue[] = [];
  const braces = { open: 0, close: 0 };
  for (const ch of query) { if (ch === '{') braces.open++; if (ch === '}') braces.close++; }
  if (braces.open !== braces.close) issues.push({ severity: 'error', message: `Unbalanced braces: ${braces.open} open vs ${braces.close} close` });
  if (/\bany\b(?![\w:])/.test(query) && !query.trim().startsWith('{')) {
    issues.push({ severity: 'info', message: 'Anonymous operation; consider naming it for better tooling' });
  }
  const varDecls = new Set<string>();
  const varRe = /\$(\w+)/g;
  const declBlock = /\(([^)]*\$[^)]*)\)/.exec(query);
  if (declBlock) {
    for (const m of declBlock[1].matchAll(/\$(\w+)/g)) varDecls.add(m[1]);
  }
  const usages: string[] = [];
  for (const m of query.matchAll(varRe)) usages.push(m[1]);
  for (const u of usages) {
    if (!varDecls.has(u) && u !== '_') {
      // heuristic: usage in field position without declaration
      if (!/\$\w+\s*:/.test(query)) continue;
    }
  }
  for (const d of varDecls) {
    if (!usages.filter((u) => u === d).length) issues.push({ severity: 'warning', message: `Variable $${d} declared but never used` });
  }
  return issues;
}

export function prettifyQuery(query: string): string {
  const out: string[] = [];
  let indent = 0;
  let token = '';
  const flush = () => {
    const trimmed = token.trim();
    if (trimmed) out.push(`${'  '.repeat(indent)}${trimmed}`);
    token = '';
  };
  for (const ch of query) {
    if (ch === '{') {
      token = token.trim() + ' {';
      flush();
      indent++;
    } else if (ch === '}') {
      flush();
      indent = Math.max(0, indent - 1);
      out.push(`${'  '.repeat(indent)}}`);
    } else if (ch === '\n' || ch === ',') {
      flush();
    } else {
      token += ch;
    }
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Schema diff (§12)
// ---------------------------------------------------------------------------

export interface GqlSchemaChange { kind: 'breaking' | 'dangerous' | 'info'; path: string; message: string }

export function diffSchemas(oldSchema: GqlSchemaShape, newSchema: GqlSchemaShape): GqlSchemaChange[] {
  const changes: GqlSchemaChange[] = [];
  const oldTypes = new Map(schemaOf(oldSchema).types.map((t) => [t.name, t]));
  const newTypes = new Map(schemaOf(newSchema).types.map((t) => [t.name, t]));
  for (const [name, oldT] of oldTypes) {
    if (!name || name.startsWith('__')) continue;
    const newT = newTypes.get(name);
    if (!newT) { changes.push({ kind: 'breaking', path: name, message: `Type ${name} removed` }); continue; }
    if (oldT.kind !== newT.kind) changes.push({ kind: 'breaking', path: name, message: `Type ${name} changed kind ${oldT.kind} → ${newT.kind}` });
    for (const field of oldT.fields ?? []) {
      const match = newT.fields?.find((f) => f.name === field.name);
      if (!match) { changes.push({ kind: 'breaking', path: `${name}.${field.name}`, message: `Field ${name}.${field.name} removed` }); continue; }
      const oldType = typeRefToString(field.type);
      const newType = typeRefToString(match.type);
      if (oldType !== newType) changes.push({ kind: 'dangerous', path: `${name}.${field.name}`, message: `Type changed ${oldType} → ${newType}` });
      for (const arg of field.args ?? []) {
        const matchArg = match.args?.find((a) => a.name === arg.name);
        if (!matchArg) changes.push({ kind: 'breaking', path: `${name}.${field.name}(${arg.name})`, message: `Argument ${arg.name} removed` });
      }
      for (const arg of match.args ?? []) {
        const oldArg = field.args?.find((a) => a.name === arg.name);
        if (!oldArg && typeRefToString(arg.type).endsWith('!')) {
          changes.push({ kind: 'breaking', path: `${name}.${field.name}(${arg.name})`, message: `New required argument ${arg.name} added` });
        }
      }
    }
    for (const val of oldT.enumValues ?? []) {
      if (!newT.enumValues?.some((v) => v.name === val.name)) {
        changes.push({ kind: 'dangerous', path: `${name}.${val.name}`, message: `Enum value ${val.name} removed` });
      }
    }
  }
  for (const [name] of newTypes) {
    if (!name || name.startsWith('__') || oldTypes.has(name)) continue;
    changes.push({ kind: 'info', path: name, message: `Type ${name} added` });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Query files (.graphql) generation and parsing
// ---------------------------------------------------------------------------

export function graphqlBodyToRaw(query: string, variables?: string, operationName?: string): { raw: string; headers: KeyValue[] } {
  const payload: Record<string, unknown> = { query };
  if (variables?.trim()) { try { payload.variables = JSON.parse(variables); } catch { payload.variables = {}; } }
  if (operationName?.trim()) payload.operationName = operationName;
  return {
    raw: JSON.stringify(payload),
    headers: [{ id: uid(), key: 'Content-Type', value: 'application/json', enabled: true }],
  };
}

export function graphqlToRequest(url: string, query: string, variables: string, operationName: string | undefined, method: 'POST' | 'GET' = 'POST'): Partial<ApiRequest> {
  const { raw, headers } = graphqlBodyToRaw(query, variables, operationName);
  return {
    protocol: 'graphql',
    method,
    url,
    headers,
    body: { type: 'graphql', raw, graphql: { query, variables, operationName } },
  };
}
