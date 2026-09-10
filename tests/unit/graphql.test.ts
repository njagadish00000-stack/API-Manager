import { describe, it, expect } from 'vitest';
import {
  parseGraphQLOperations, validateGraphQL, prettifyGraphQL,
  buildGraphQLBody, makeGraphQLRequestUrl, applyGraphQL, parseIntrospection,
  sampleQueryFromSchema, INTROSPECTION_QUERY,
} from '../../src/core/graphqlx/graphql';
import type { ApiRequest } from '../../src/shared/types';

const gqlRequest = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  id: 'g1', workspaceId: 'w1', name: 'G', method: 'POST', url: 'https://gql.example/graphql',
  pathParams: [], queryParams: [], headers: [],
  body: { type: 'graphql', graphql: { query: '{ me { name } }', variables: '{}' } },
  auth: { type: 'none' }, assertions: [], scripts: {}, protocol: 'http',
  tags: [], favorite: false, sortOrder: 0, settings: {},
  createdAt: '', updatedAt: '', ...overrides,
} as unknown as ApiRequest);

describe('GraphQL operation parsing (§39)', () => {
  it('parses named queries, mutations, and subscriptions', () => {
    const ops = parseGraphQLOperations(`
      query GetUser($id: ID!) { user(id: $id) { name } }
      mutation CreateUser($n: String!) { create(name: $n) { id } }
      subscription OnUpdate { updated { id } }
    `);
    expect(ops.map((o) => `${o.type}:${o.name}`)).toEqual([
      'query:GetUser', 'mutation:CreateUser', 'subscription:OnUpdate',
    ]);
  });

  it('treats a shorthand brace document as an anonymous query', () => {
    const ops = parseGraphQLOperations('{ me { name email } }');
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('query');
  });

  it('ignores operation-like words inside comments', () => {
    const ops = parseGraphQLOperations('# mutation of records described here\nquery Q { x }');
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('query');
  });
});

describe('GraphQL validation', () => {
  it('accepts empty and balanced documents', () => {
    expect(validateGraphQL('').ok).toBe(true);
    expect(validateGraphQL('query Q { user(id: [1, 2]) { name } }').ok).toBe(true);
  });

  it('rejects unbalanced delimiters', () => {
    expect(validateGraphQL('query Q { user(').ok).toBe(false);
    expect(validateGraphQL('query Q { user } }').errors.length).toBeGreaterThan(0);
  });

  it('does not count braces inside strings', () => {
    expect(validateGraphqlSafe('{ q(filter: "{}}") { id } }')).toBe(true);
  });
});

function validateGraphqlSafe(q: string): boolean {
  return validateGraphQL(q).ok;
}

describe('GraphQL prettifier', () => {
  it('indents nested selection sets', () => {
    const out = prettifyGraphQL('query Q { user { profile { name } } }');
    expect(out).toBe([
      'query Q {',
      '  user {',
      '    profile {',
      '      name',
      '    }',
      '  }',
      '}',
    ].join('\n'));
  });

  it('collapses extra blank lines and trims', () => {
    const out = prettifyGraphQL('\n\n{ x }\n\n');
    expect(out).toBe('{\n  x\n}');
  });
});

describe('GraphQL body / transport', () => {
  it('builds a JSON body with parsed variables and operation name', () => {
    const body = JSON.parse(buildGraphQLBody('query Q { x }', '{"a":1}', 'Q'));
    expect(body).toEqual({ query: 'query Q { x }', variables: { a: 1 }, operationName: 'Q' });
  });

  it('falls back to empty variables object when variables text is invalid JSON', () => {
    const body = JSON.parse(buildGraphQLBody('{ x }', 'not-json'));
    expect(body.variables).toEqual({});
    expect(body.operationName).toBeUndefined();
  });

  it('encodes GET requests with query/variables in the URL', () => {
    const r = makeGraphQLRequestUrl('https://gql.example/graphql', 'GET', '{ x }', '{"a":1}');
    expect(r.method).toBe('GET');
    expect(r.url).toContain('query=');
    expect(r.url).toContain('variables=');
  });

  it('leaves POST URLs untouched', () => {
    const r = makeGraphQLRequestUrl('https://gql.example/graphql', 'POST', '{ x }', '');
    expect(r).toEqual({ method: 'POST', url: 'https://gql.example/graphql' });
  });

  it('applyGraphQL on POST produces a json request with Content-Type', () => {
    const out = applyGraphQL(gqlRequest());
    expect(out.method).toBe('POST');
    expect(out.body.type).toBe('json');
    const parsed = JSON.parse(out.body.raw ?? '{}');
    expect(parsed.query).toBe('{ me { name } }');
    expect(out.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value).toBe('application/json');
  });

  it('applyGraphQL does not duplicate an existing Content-Type header', () => {
    const out = applyGraphQL(gqlRequest({
      headers: [{ id: 'h', key: 'Content-Type', value: 'application/json', enabled: true }],
    }));
    expect(out.headers.filter((h) => h.key.toLowerCase() === 'content-type')).toHaveLength(1);
  });

  it('applyGraphQL on GET encodes the query into the URL', () => {
    const out = applyGraphQL(gqlRequest({ method: 'GET' }));
    expect(out.method).toBe('GET');
    expect(out.url).toContain('?query=');
  });
});

describe('GraphQL introspection', () => {
  it('the introspection query requests types/fields/enums', () => {
    expect(INTROSPECTION_QUERY).toContain('__schema');
    expect(INTROSPECTION_QUERY).toContain('inputFields');
    expect(INTROSPECTION_QUERY).toContain('enumValues');
  });

  it('parses an introspection response and filters built-in __ types', () => {
    const res = {
      data: {
        __schema: {
          queryType: { name: 'Query' },
          mutationType: { name: 'Mutation' },
          subscriptionType: null,
          types: [
            { kind: 'OBJECT', name: 'Query', fields: [{ name: 'me', args: [] }, { name: 'users', args: [] }] },
            { kind: 'SCALAR', name: '__Schema' },
          ],
        },
      },
    };
    const parsed = parseIntrospection(res);
    expect(parsed?.queryType).toBe('Query');
    expect(parsed?.mutationType).toBe('Mutation');
    expect(parsed?.types.map((t) => t.name)).toEqual(['Query']);
  });

  it('returns null when the response is not an introspection result', () => {
    expect(parseIntrospection({ errors: [{ message: 'bad' }] })).toBeNull();
  });

  it('generates a sample query from root fields', () => {
    const parsed = parseIntrospection({
      data: { __schema: { queryType: { name: 'Query' }, types: [
        { kind: 'OBJECT', name: 'Query', fields: [{ name: 'me', args: [] }] },
      ] } },
    })!;
    const sample = sampleQueryFromSchema(parsed);
    expect(sample).toContain('query SampleQuery');
    expect(sample).toContain('me');
  });
});
