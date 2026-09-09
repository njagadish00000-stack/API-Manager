import { describe, it, expect } from 'vitest';
import { parseCurl, tokenizeShell } from '../../src/core/curl/curlParser';
import { generateCurl } from '../../src/core/curl/curlGenerator';
import { buildUrl, parseQueryParams, applyPathParams, detectDuplicates, kv } from '../../src/core/url/urlBuilder';

describe('shell tokenizer', () => {
  it('handles quotes, escapes, continuations', () => {
    expect(tokenizeShell("curl -H 'a: b c' http://x")).toEqual(['curl', '-H', 'a: b c', 'http://x']);
    expect(tokenizeShell('curl \\\n  -d \'{"a":1}\' http://x')).toEqual(['curl', '-d', '{"a":1}', 'http://x']);
    expect(tokenizeShell('curl -H "X: $HOME/\\"q\\"" http://x')).toEqual(['curl', '-H', 'X: $HOME/"q"', 'http://x']);
  });
});

describe('curl parser', () => {
  it('parses a simple GET', () => {
    const { request } = parseCurl('curl https://api.example.com/users');
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://api.example.com/users');
  });

  it('parses headers, json body, method inference', () => {
    const { request } = parseCurl(`curl 'https://api.test.com/v1/items' \\
      -H 'Content-Type: application/json' \\
      -H 'Authorization: Bearer tok123' \\
      -d '{"name":"test","n":2}'`);
    expect(request.method).toBe('POST');
    expect(request.body?.type).toBe('json');
    expect(request.body?.raw).toBe('{"name":"test","n":2}');
    expect(request.headers?.find((h) => h.key === 'Authorization')?.value).toBe('Bearer tok123');
  });

  it('parses basic auth and insecure/location flags', () => {
    const { request } = parseCurl('curl -u admin:p@ss -k -L https://secure.test/');
    expect(request.auth?.type).toBe('basic');
    expect(request.auth?.basic?.username).toBe('admin');
    expect(request.auth?.basic?.password).toBe('p@ss');
    expect(request.settings?.verifyTls).toBe(false);
  });

  it('parses multipart form incl. files and mime types', () => {
    const { request } = parseCurl(`curl https://upload.test/f -F 'name=x' -F 'file=@/tmp/a.pdf;type=application/pdf'`);
    expect(request.method).toBe('POST');
    expect(request.body?.type).toBe('form-data');
    const fields = request.body?.formData ?? [];
    expect(fields.find((f) => f.key === 'name')?.value).toBe('x');
    const file = fields.find((f) => f.key === 'file');
    expect(file?.fieldType).toBe('file');
    expect(file?.filePath).toBe('/tmp/a.pdf');
    expect(file?.mimeType).toBe('application/pdf');
  });

  it('parses urlencoded bodies', () => {
    const { request } = parseCurl(`curl https://login.test/token -d 'grant_type=client_credentials&scope=read' -H 'Content-Type: application/x-www-form-urlencoded'`);
    expect(request.body?.type).toBe('urlencoded');
    expect(request.body?.urlencoded?.find((p) => p.key === 'scope')?.value).toBe('read');
  });

  it('detects SOAP requests (§47)', () => {
    const { request, warnings } = parseCurl(`curl 'https://svc.test/ws' -H 'Content-Type: text/xml; charset=utf-8' -H 'SOAPAction: GetPrice' -d '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>'`);
    expect(request.protocol).toBe('soap');
    expect(warnings.some((w) => w.toLowerCase().includes('soap'))).toBe(true);
  });

  it('parses cookies, user-agent, proxy, max-time', () => {
    const { request } = parseCurl(`curl https://x.test -b 'sid=1' -A 'agent/1.0' -m 5 -x http://proxy:3128 --compressed`);
    expect(request.headers?.find((h) => h.key === 'Cookie')?.value).toBe('sid=1');
    expect(request.headers?.find((h) => h.key === 'User-Agent')?.value).toBe('agent/1.0');
    expect(request.settings?.timeoutMs).toBe(5000);
    expect(request.headers?.find((h) => h.key === 'Accept-Encoding')?.value).toContain('gzip');
  });
});

describe('curl generator', () => {
  it('round-trips a POST json request', () => {
    const req = {
      id: '1', workspaceId: 'w', name: 't', method: 'POST', url: 'https://api.test/items', protocol: 'http',
      pathParams: [], queryParams: [kv('q', 'hello world')], headers: [kv('X-Test', '1')],
      auth: { type: 'bearer', bearer: { token: 'abc' } },
      body: { type: 'json', raw: '{"a":true}' }, scripts: { preRequest: '', postResponse: '' },
      assertions: [], settings: { followRedirects: true, verifyTls: false, timeoutMs: 30000, httpVersion: 'auto', encodeUrl: true, maxRedirects: 10, preserveAuthOnRedirect: true, stripSensitiveHeaders: true, retry: { enabled: false, maxRetries: 2, strategy: 'exponential', delayMs: 0, retryStatusCodes: [], retryOnNetworkError: true, retryOnTimeout: true, onlyIdempotent: false }, storeResponse: true },
      tags: [], favorite: false, sortOrder: 0, createdAt: '', updatedAt: '',
    } as const;
    const curl = generateCurl({ request: req as never });
    expect(curl).toContain("curl -X POST 'https://api.test/items?q=hello%20world'");
    expect(curl).toContain("-H 'X-Test: 1'");
    expect(curl).toContain("Authorization: Bearer abc");
    expect(curl).toContain('-k');
    // and it must re-parse
    const reparsed = parseCurl(curl);
    expect(reparsed.request.method).toBe('POST');
    expect(reparsed.request.body?.raw).toBe('{"a":true}');
  });
});

describe('url builder', () => {
  it('parses and builds query params', () => {
    const { base, params } = parseQueryParams('https://h.test/p?a=1&b=hello%20world');
    expect(base).toBe('https://h.test/p');
    expect(params.find((p) => p.key === 'b')?.value).toBe('hello world');
    expect(buildUrl(base, params)).toBe('https://h.test/p?a=1&b=hello%20world');
  });

  it('applies path params and detects duplicates', () => {
    expect(applyPathParams('https://h/users/:id/pets/:petId', [kv('id', '42'), kv('petId', '7')])).toBe('https://h/users/42/pets/7');
    expect(detectDuplicates([kv('a', '1'), kv('a', '2'), kv('b', '3')])).toEqual(['a']);
  });
});
