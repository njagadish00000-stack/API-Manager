/** GraphQL helpers (§39): build bodies, lightweight validation, introspection. */
import type { ApiRequest } from '../../shared/types';

export interface GraphQLOperation { type: 'query' | 'mutation' | 'subscription'; name?: string; body: string }

export function parseGraphQLOperations(query: string): GraphQLOperation[] {
  const ops: GraphQLOperation[] = [];
  const re = /(query|mutation|subscription)\s*([A-Za-z_][A-Za-z0-9_]*)?/g;
  // crude strip of comments and block strings
  const cleaned = query.replace(/#[^\n]*/g, '').replace(/"""[\s\S]*?"""/g, '');
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    const before = cleaned.slice(0, m.index).trimEnd();
    if (before.endsWith('.') || before.endsWith('__')) continue;
    ops.push({ type: m[1] as GraphQLOperation['type'], name: m[2], body: query });
    if (!m[0]) re.lastIndex++;
  }
  if (ops.length === 0 && cleaned.trim().startsWith('{')) ops.push({ type: 'query', body: query });
  return ops;
}

export function validateGraphQL(query: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!query.trim()) return { ok: true, errors };
  // balanced braces/parens/brackets outside strings
  const stripped = query.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/#[^\n]*/g, '');
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  for (const ch of stripped) {
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (['}', ')', ']'].includes(ch)) {
      if (stack.pop() !== ch) { errors.push(`Unbalanced "${ch}"`); break; }
    }
  }
  if (errors.length === 0 && stack.length > 0) {
    errors.push(`Unbalanced: missing ${stack.reverse().join('')}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  if (!/query|mutation|subscription|\{/.test(stripped)) errors.push('Document contains no operation');
  return { ok: errors.length === 0, errors };
}

/** Indent/pretty-print a GraphQL query (offline, no parser dependency). */
export function prettifyGraphQL(query: string): string {
  const out: string[] = [];
  let indent = 0;
  let token = '';
  const flush = (): void => {
    const trimmed = token.trim();
    if (trimmed) out.push(`${'  '.repeat(indent)}${trimmed}`);
    token = '';
  };
  for (const ch of query) {
    if (ch === '{') {
      token = token.trim() + ' {';
      flush();
      indent += 1;
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

export function buildGraphQLBody(query: string, variables: string, operationName?: string): string {
  let vars: unknown = {};
  try { if (variables.trim()) vars = JSON.parse(variables); } catch { vars = {}; }
  return JSON.stringify({ query, variables: vars, ...(operationName ? { operationName } : {}) });
}

export function makeGraphQLRequestUrl(url: string, method: 'GET' | 'POST', query: string, variables: string): { method: string; url: string } {
  if (method === 'GET') {
    const sep = url.includes('?') ? '&' : '?';
    return { method: 'GET', url: `${url}${sep}query=${encodeURIComponent(query)}${variables.trim() ? `&variables=${encodeURIComponent(variables)}` : ''}` };
  }
  return { method: 'POST', url };
}

/** Apply GraphQL request semantics onto an ApiRequest (mutates a copy). */
export function applyGraphQL(request: ApiRequest): ApiRequest {
  const copy: ApiRequest = JSON.parse(JSON.stringify(request));
  const query = copy.body.graphql?.query ?? '';
  const variables = copy.body.graphql?.variables ?? '';
  if (copy.method === 'GET') {
    const res = makeGraphQLRequestUrl(copy.url, 'GET', query, variables);
    copy.url = res.url;
  } else {
    copy.method = 'POST';
    copy.body = { type: 'json', raw: buildGraphQLBody(query, variables, copy.body.graphql?.operationName) };
    const hasCt = copy.headers.some((h) => h.key.toLowerCase() === 'content-type');
    if (!hasCt) copy.headers.push({ id: 'gql_ct', key: 'Content-Type', value: 'application/json', enabled: true });
  }
  return copy;
}

export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      kind
      name
      description
      fields(includeDeprecated: true) {
        name
        description
        args { name description type { ...TypeRef } defaultValue }
        type { ...TypeRef }
        isDeprecated
        deprecationReason
      }
      inputFields { name description type { ...TypeRef } defaultValue }
      interfaces { ...TypeRef }
      enumValues(includeDeprecated: true) { name description isDeprecated deprecationReason }
      possibleTypes { ...TypeRef }
    }
    directives { name description locations args { ...InputValue } }
  }
}
fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name }
      }
    }
  }
}
fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}`;

export interface IntrospectedType {
  kind: string; name: string | null; description?: string | null;
  fields?: { name: string; description?: string | null; args: { name: string; description?: string | null; type: unknown; defaultValue?: string | null }[]; type: unknown; isDeprecated?: boolean; deprecationReason?: string | null }[] | null;
  inputFields?: { name: string; description?: string | null; type: unknown; defaultValue?: string | null }[] | null;
  enumValues?: { name: string; description?: string | null }[] | null;
}

export interface IntrospectionResult {
  queryType?: string; mutationType?: string; subscriptionType?: string;
  types: IntrospectedType[];
}

export function parseIntrospection(responseJson: unknown): IntrospectionResult | null {
  const d = responseJson as { data?: { __schema?: { queryType?: { name?: string }; mutationType?: { name?: string }; subscriptionType?: { name?: string }; types?: IntrospectedType[] } } };
  const schema = d?.data?.__schema;
  if (!schema) return null;
  return {
    queryType: schema.queryType?.name, mutationType: schema.mutationType?.name, subscriptionType: schema.subscriptionType?.name,
    types: (schema.types ?? []).filter((t) => t.name && !t.name.startsWith('__')),
  };
}

/** Generate a sample query document from introspection types. */
export function sampleQueryFromSchema(introspection: IntrospectionResult, depth = 2): string {
  const rootName = introspection.queryType ?? 'Query';
  const root = introspection.types.find((t) => t.name === rootName);
  if (!root?.fields?.length) return `query {\n  __typename\n}`;
  const lines: string[] = ['query SampleQuery {'];
  for (const field of root.fields.slice(0, 5)) {
    lines.push(`  ${field.name}${field.args.length ? `(${field.args.map((a) => `${a.name}: null`).join(', ')})` : ''}`);
    if (depth > 1) lines[lines.length - 1] += ` {\n    __typename\n  }`;
  }
  lines.push('}');
  return lines.join('\n');
}
