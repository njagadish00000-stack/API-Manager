import { describe, it, expect } from 'vitest';
import { generateCurl, generateCurlCmd, generateCurlPowerShell } from '../../src/core/curl/curlGenerator';
import { generateCode, CODEGEN_TARGETS } from '../../src/core/codegen/codegen';
import type { ApiRequest } from '../../src/shared/types';

const req = (overrides: Partial<ApiRequest> = {}): ApiRequest => ({
  id: 'c1', workspaceId: 'w1', name: 'C', method: 'POST', url: 'https://api.example.com/items',
  pathParams: [], queryParams: [],
  headers: [{ id: 'h1', key: 'Content-Type', value: 'application/json', enabled: true }],
  body: { type: 'json', raw: '{"name":"test"}' },
  auth: { type: 'none' }, assertions: [], scripts: {}, protocol: 'http',
  tags: [], favorite: false, sortOrder: 0, settings: {},
  createdAt: '', updatedAt: '', ...overrides,
} as unknown as ApiRequest);

describe('cURL three-platform generation (§24)', () => {
  it('registers bash/cmd/powershell variants in codegen targets', () => {
    const curl = CODEGEN_TARGETS.find((t) => t.language === 'curl');
    expect(curl?.variants.map((v) => v.id)).toEqual(['bash', 'cmd', 'powershell']);
  });

  it('generates POSIX bash cURL with single quotes and backslash continuations', () => {
    const out = generateCurl({ request: req(), pretty: true });
    expect(out).toContain("curl -X POST 'https://api.example.com/items'");
    expect(out).toContain("-H 'Content-Type: application/json'");
    expect(out).toContain("-d '{\"name\":\"test\"}'");
    expect(out).toContain(' \\\n');
  });

  it('generates Windows CMD cURL with double quotes, %% escaping, and caret continuations', () => {
    const out = generateCurlCmd({ request: req() });
    expect(out).toContain('curl -X "POST" "https://api.example.com/items"');
    expect(out).toContain('-H "Content-Type: application/json"');
    expect(out).toContain('--data-raw "{""name"":""test""}"');
    expect(out).toContain(' ^\n');
  });

  it('escapes percent signs for CMD variable expansion safety', () => {
    const out = generateCurlCmd({ request: req({ url: 'https://x.test/p?q=100%done' }) });
    expect(out).toContain('100%%done');
  });

  it('generates PowerShell cURL via curl.exe with single-quote escaping and backtick continuations', () => {
    const out = generateCurlPowerShell({ request: req({
      headers: [{ id: 'h', key: 'X-Note', value: "it's fine", enabled: true }],
    }) });
    expect(out.startsWith('curl.exe -X')).toBe(true);
    expect(out).toContain("-H 'X-Note: it''s fine'");
    expect(out).toContain(' `\n');
  });

  it('all three platforms render bearer auth as an Authorization header', () => {
    const r = req({ auth: { type: 'bearer', bearer: { token: 'abc', prefix: 'Bearer' } } as ApiRequest['auth'] });
    expect(generateCurl({ request: r })).toContain("Authorization: Bearer abc");
    expect(generateCurlCmd({ request: r })).toContain('Authorization: Bearer abc');
    expect(generateCurlPowerShell({ request: r })).toContain('Authorization: Bearer abc');
  });

  it('all three platforms render basic auth with -u', () => {
    const r = req({ auth: { type: 'basic', basic: { username: 'user', password: 'p@ss' } } as ApiRequest['auth'] });
    expect(generateCurl({ request: r })).toContain("-u 'user:p@ss'");
    expect(generateCurlCmd({ request: r })).toContain('-u "user:p@ss"');
    expect(generateCurlPowerShell({ request: r })).toContain("-u 'user:p@ss'");
  });

  it('all three platforms render multipart -F fields', () => {
    const r = req({ body: { type: 'form-data', formData: [
      { id: 'f1', key: 'file', value: '', fieldType: 'file', filePath: 'C:/tmp/a.bin', enabled: true },
      { id: 'f2', key: 'note', value: 'hi', fieldType: 'text', enabled: true },
    ] } as ApiRequest['body'] });
    for (const out of [generateCurl({ request: r }), generateCurlCmd({ request: r }), generateCurlPowerShell({ request: r })]) {
      expect(out).toContain('@C:/tmp/a.bin');
      expect(out).toContain('note=hi');
      expect(out).toMatch(/-F/);
    }
  });

  it('codegen.generate dispatches the requested variant', () => {
    expect(generateCode(req(), 'curl', 'cmd')).toContain('curl -X "POST"');
    expect(generateCode(req(), 'curl', 'powershell')).toContain('curl.exe -X');
    expect(generateCode(req(), 'curl', 'bash')).toContain("curl -X POST '");
    expect(generateCode(req(), 'curl')).toContain("curl -X POST '");
  });
});
