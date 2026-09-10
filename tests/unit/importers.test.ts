import { describe, it, expect } from 'vitest';
import { detectFormat, runImport } from '../../src/core/importers/dispatch';
import { parseDotEnv } from '../../src/core/envfile/dotenv';

const WS = 'ws-test';

describe('import format detection (§46)', () => {
  it('detects a cURL command', () => {
    expect(detectFormat("curl -X POST https://x.test/a -d '{}'").format).toBe('curl');
  });

  it('detects a raw HTTP message', () => {
    const raw = 'GET /users HTTP/1.1\r\nHost: x.test\r\nAccept: application/json\r\n\r\n';
    const d = detectFormat(raw);
    expect(d.format).toBe('raw-http');
    expect(d.confidence).toBe('high');
  });

  it('detects a Postman v2.1 collection', () => {
    const json = JSON.stringify({
      info: { name: 'C', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [],
    });
    expect(detectFormat(json).format).toBe('postman-collection');
  });

  it('detects a Postman environment', () => {
    const json = JSON.stringify({ name: 'env', values: [{ key: 'a', value: '1', enabled: true }] });
    expect(detectFormat(json).format).toBe('postman-environment');
  });

  it('detects an OpenAPI 3 document (json and yaml)', () => {
    const json = JSON.stringify({ openapi: '3.0.0', info: { title: 'T', version: '1' }, paths: {} });
    expect(detectFormat(json).format).toBe('openapi');
    const yaml = 'openapi: 3.0.0\ninfo:\n  title: T\n  version: "1"\npaths: {}\n';
    expect(detectFormat(yaml).format).toBe('openapi');
  });

  it('detects a Swagger 2 document', () => {
    const json = JSON.stringify({ swagger: '2.0', info: { title: 'T', version: '1' }, paths: {} });
    expect(detectFormat(json).format).toBe('openapi');
  });

  it('detects WSDL from a .wsdl filename and definitions element', () => {
    const wsdl = '<?xml version="1.0"?><definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:xs="http://www.w3.org/2001/XMLSchema"><types/></definitions>';
    expect(detectFormat(wsdl, 'svc.wsdl').format).toBe('wsdl');
  });

  it('detects a SOAPUI project xml', () => {
    const xml = '<con:soapui-project xmlns:con="http://eviware.com/soapui/config"></con:soapui-project>';
    expect(detectFormat(xml).format).toBe('soapui');
  });

  it('detects a .env file', () => {
    const env = 'BASE_URL=https://x.test\nTOKEN=abc123\n# comment\n';
    expect(detectFormat(env, '.env').format).toBe('dotenv');
    const dotVars = Object.fromEntries(parseDotEnv(env).map((v) => [v.key, v.value]));
    expect(dotVars).toMatchObject({ BASE_URL: 'https://x.test', TOKEN: 'abc123' });
  });

  it('detects Insomnia export', () => {
    const json = JSON.stringify({ _type: 'export', __export_format: 4, resources: [{ _type: 'workspace' }] });
    expect(detectFormat(json).format).toBe('insomnia');
  });
});

describe('import runs produce normalized collections/requests', () => {
  it('imports a Postman collection with a nested request', () => {
    const doc = {
      info: { name: 'PM Col', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [{
        name: 'Get users',
        request: { method: 'GET', url: { raw: 'https://x.test/users?limit=10', query: [{ key: 'limit', value: '10' }] }, header: [{ key: 'Accept', value: 'application/json' }] },
      }, {
        name: 'Folder',
        item: [{
          name: 'Create',
          request: { method: 'POST', header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
            url: { raw: 'https://x.test/items' } },
        }],
      }],
    };
    const out = runImport(JSON.stringify(doc), 'postman-collection', WS);
    expect(out.collections).toHaveLength(1);
    expect(out.collections[0].collection.name).toBe('PM Col');
    const all = out.collections[0].requests;
    expect(all.map((r) => r.name)).toContain('Get users');
    const get = all.find((r) => r.name === 'Get users')!;
    expect(get.method).toBe('GET');
    // raw URL is preserved, and the query string is also split into queryParams
    expect(get.url).toBe('https://x.test/users?limit=10');
    expect(get.queryParams?.find((p) => p.key === 'limit')?.value).toBe('10');
    const post = all.find((r) => r.name === 'Create')!;
    expect(post.method).toBe('POST');
    expect(post.body.type).toBe('json');
    expect(post.body.raw).toBe('{"a":1}');
    // collection lands in imported; converted requests are itemized in converted
    expect(out.report.imported.some((i) => i.kind === 'collection')).toBe(true);
    expect(out.report.converted.filter((i) => i.kind === 'request')).toHaveLength(2);
  });

  it('imports a Postman environment into environments', () => {
    const doc = { name: 'QA', values: [
      { key: 'HOST', value: 'qa.x.test', enabled: true },
      { key: 'OFF', value: 'x', enabled: false },
    ] };
    const out = runImport(JSON.stringify(doc), 'postman-environment', WS);
    expect(out.environments).toHaveLength(1);
    expect(out.environments[0].name).toBe('QA');
    const vars = out.environments[0].variables;
    expect(vars.find((v) => v.key === 'HOST')?.value).toBe('qa.x.test');
    expect(vars.find((v) => v.key === 'HOST')?.enabled).toBe(true);
    expect(vars.find((v) => v.key === 'OFF')?.enabled).toBe(false);
  });

  it('imports an OpenAPI spec into a collection with operations', () => {
    const spec = JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'Pets API', version: '1.0' },
      paths: {
        '/pets': {
          get: { operationId: 'listPets', summary: 'List', responses: { 200: { description: 'ok' } } },
          post: { operationId: 'createPet', responses: { 201: { description: 'created' } } },
        },
        '/pets/{petId}': {
          get: { operationId: 'getPet', parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } },
        },
      },
    });
    const out = runImport(spec, 'openapi', WS);
    expect(out.collections).toHaveLength(1);
    expect(out.collections[0].collection.name).toBe('Pets API');
    const methods = out.collections[0].requests.map((r) => `${r.method} ${r.url}`);
    expect(methods.some((m) => m.startsWith('GET'))).toBe(true);
    expect(methods.some((m) => m.startsWith('POST'))).toBe(true);
  });

  it('imports a cURL command as a standalone request', () => {
    const out = runImport("curl -X PUT https://x.test/items/1 -H 'Content-Type: application/json' -d '{\"n\":2}'", 'curl', WS);
    expect(out.requests).toHaveLength(1);
    const r = out.requests[0];
    expect(r.method).toBe('PUT');
    expect(r.url).toBe('https://x.test/items/1');
    expect(r.body.type).toBe('json');
    expect(r.workspaceId).toBe(WS);
  });

  it('imports raw HTTP text as a request preserving method, path and headers', () => {
    const raw = [
      'POST /submit HTTP/1.1',
      'Host: forms.test',
      'Content-Type: application/x-www-form-urlencoded',
      '',
      'name=ada&age=36',
    ].join('\r\n');
    const out = runImport(raw, 'raw-http', WS);
    expect(out.requests.length).toBeGreaterThan(0);
    const r = out.requests[0];
    expect(r.method).toBe('POST');
    expect(r.url).toContain('forms.test');
    expect(r.url).toContain('/submit');
    expect(r.headers.some((h) => h.key.toLowerCase() === 'content-type')).toBe(true);
  });

  it('imports a .env file as an environment', () => {
    const out = runImport('A=1\nB=two\n', 'dotenv', WS, 'production.env');
    expect(out.environments).toHaveLength(1);
    expect(out.environments[0].name).toBe('production');
    const v = Object.fromEntries(out.environments[0].variables.map((x) => [x.key, x.value]));
    expect(v).toEqual({ A: '1', B: 'two' });
  });

  it('reports imported counts in the migration report', () => {
    const spec = JSON.stringify({
      openapi: '3.0.0', info: { title: 'R', version: '1' },
      servers: [{ url: 'https://api.x.test' }],
      paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } },
    });
    const out = runImport(spec, 'openapi', WS);
    expect(out.report.imported.length).toBeGreaterThan(0);
    expect(out.report.startedAt).toBeTruthy();
    expect(out.report.finishedAt).toBeTruthy();
  });
});
