import { describe, it, expect } from 'vitest';
import { VariableResolver, findVariables, dependencies } from '../../src/core/vars/resolver';
import { evalDynamic } from '../../src/core/vars/dynamic';

describe('variable resolver', () => {
  it('extracts variables', () => {
    expect(findVariables('GET {{host}}/{{ path }}')).toEqual(['host', 'path']);
    expect(findVariables('none')).toEqual([]);
  });

  it('resolves with scope precedence (highest wins)', () => {
    const r = new VariableResolver([
      { scope: 'global', vars: { host: { value: 'global.example.com' }, region: { value: 'us' } } },
      { scope: 'environment', vars: { host: { value: 'env.example.com' } } },
      { scope: 'request', vars: { host: { value: 'request.example.com' } } },
    ]);
    expect(r.resolve('https://{{host}}/{{region}}').resolved).toBe('https://request.example.com/us');
  });

  it('resolves nested variables and detects cycles', () => {
    const r = new VariableResolver([
      { scope: 'global', vars: { base: { value: 'http://{{host}}' }, host: { value: 'api.test' } } },
    ]);
    expect(r.resolve('{{base}}/v1').resolved).toBe('http://api.test/v1');

    const cyc = new VariableResolver([
      { scope: 'global', vars: { a: { value: '{{b}}' }, b: { value: '{{a}}' } } },
    ]);
    expect(cyc.resolve('{{a}}').cycles.length).toBeGreaterThan(0);
  });

  it('reports unresolved variables and traces the source', () => {
    const r = new VariableResolver([
      { scope: 'environment', sourceName: 'staging', vars: { token: { value: 'abc123', isSecret: true } } },
    ]);
    const out = r.resolve('{{token}} {{missing}}');
    expect(out.unresolved).toEqual(['missing']);
    const tokenTrace = out.trace.find((t) => t.variable === 'token');
    expect(tokenTrace?.found).toBe(true);
    expect(tokenTrace?.scope).toBe('environment');
    expect(tokenTrace?.valueMasked).not.toContain('abc123');
  });

  it('resolves dynamic variables', () => {
    expect(evalDynamic('$randomInt')).toMatch(/^\d+$/);
    expect(evalDynamic('$timestamp')).toMatch(/^\d{9,11}$/);
    const r = new VariableResolver([]);
    const out = r.resolve('{{$randomBoolean}}');
    expect(['true', 'false']).toContain(out.resolved);
  });

  it('builds dependency graph with cycles', () => {
    const g = dependencies({ a: '{{b}}', b: '{{a}}', c: 'x' });
    expect(g.edges).toContainEqual({ from: 'a', to: 'b' });
    expect(g.cycles.length).toBeGreaterThan(0);
  });
});
