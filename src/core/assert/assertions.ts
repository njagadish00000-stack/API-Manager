/**
 * Assertion engine (§35). Declarative assertions evaluated against a response,
 * producing readable TestResults. Reuses soap fault detection for SOAP tests.
 */
import type { ApiResponse, Assertion, TestResult, KeyValue } from '../../shared/types';
import { JSONPath } from 'jsonpath-plus';
import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import { getByPath, parseJson } from '../jsonx/jsonUtils';

export interface AssertionDef { type: Assertion['type']; label: string; params: string[]; }

export const ASSERTION_DEFS: AssertionDef[] = [
  { type: 'statusCode', label: 'Status code', params: ['operator', 'expected'] },
  { type: 'statusText', label: 'Status text', params: ['operator', 'expected'] },
  { type: 'headerExists', label: 'Header exists', params: ['property'] },
  { type: 'headerValue', label: 'Header value', params: ['property', 'operator', 'expected'] },
  { type: 'bodyContains', label: 'Response contains', params: ['expected'] },
  { type: 'bodyNotContains', label: 'Response does not contain', params: ['expected'] },
  { type: 'jsonProperty', label: 'JSON property', params: ['property', 'operator', 'expected'] },
  { type: 'jsonPath', label: 'JSONPath', params: ['property', 'operator', 'expected'] },
  { type: 'xpath', label: 'XPath', params: ['property', 'operator', 'expected'] },
  { type: 'regex', label: 'Body matches regex', params: ['property'] },
  { type: 'schema', label: 'JSON schema', params: ['schema'] },
  { type: 'responseTime', label: 'Response time (ms)', params: ['operator', 'expected'] },
  { type: 'responseSize', label: 'Response size (bytes)', params: ['operator', 'expected'] },
  { type: 'contentType', label: 'Content-Type', params: ['operator', 'expected'] },
  { type: 'arrayLength', label: 'Array length', params: ['property', 'operator', 'expected'] },
  { type: 'valueEquals', label: 'Body equals', params: ['expected'] },
  { type: 'soapFault', label: 'No SOAP Fault', params: [] },
  { type: 'soapAction', label: 'SOAPAction header', params: ['expected'] },
];

function headerOf(headers: KeyValue[], name: string): string | undefined {
  return headers.find((h) => h.key.toLowerCase() === name.toLowerCase())?.value;
}

function compare(actual: unknown, operator: string | undefined, expected: string): { ok: boolean; detail: string } {
  const aStr = actual === undefined || actual === null ? '' : typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  switch (operator ?? 'eq') {
    case 'eq': return { ok: aStr === expected, detail: `expected "${expected}", got "${truncate(aStr)}"` };
    case 'neq': return { ok: aStr !== expected, detail: `expected not "${expected}"` };
    case 'contains': return { ok: aStr.includes(expected), detail: aStr.includes(expected) ? 'found' : `"${truncate(aStr)}" does not contain "${expected}"` };
    case 'notContains': return { ok: !aStr.includes(expected), detail: !aStr.includes(expected) ? 'ok' : `"${truncate(aStr)}" unexpectedly contains "${expected}"` };
    case 'lt': return numCmp(aStr, expected, (a, b) => a < b, '<');
    case 'lte': return numCmp(aStr, expected, (a, b) => a <= b, '<=');
    case 'gt': return numCmp(aStr, expected, (a, b) => a > b, '>');
    case 'gte': return numCmp(aStr, expected, (a, b) => a >= b, '>=');
    case 'matches': {
      try { return { ok: new RegExp(expected).test(aStr), detail: `pattern /${expected}/` }; }
      catch { return { ok: false, detail: `invalid regex /${expected}/` }; }
    }
    case 'exists': return { ok: actual !== undefined && actual !== null, detail: actual !== undefined ? 'exists' : 'missing' };
    case 'notExists': return { ok: actual === undefined || actual === null, detail: '' };
    default: return { ok: false, detail: `unknown operator ${operator}` };
  }
}

function numCmp(a: string, b: string, cmp: (x: number, y: number) => boolean, sym: string): { ok: boolean; detail: string } {
  const na = Number(a), nb = Number(b);
  if (Number.isNaN(na) || Number.isNaN(nb)) return { ok: false, detail: `cannot compare "${a}" ${sym} "${b}" (not numbers)` };
  return { ok: cmp(na, nb), detail: `${na} ${sym} ${nb}` };
}

function truncate(s: string, n = 120): string { return s.length > n ? `${s.slice(0, n)}…` : s; }

export interface AjvLike { validate: (schema: unknown, data: unknown) => boolean; errors?: unknown; }
let ajvInstance: { compile: (s: unknown) => { (d: unknown): boolean; errors?: unknown } } | null | undefined;

async function getAjv() {
  if (ajvInstance !== undefined) return ajvInstance;
  try {
    const mod = await import('ajv');
    ajvInstance = new mod.default({ allErrors: true, strict: false }) as never;
  } catch {
    ajvInstance = null;
  }
  return ajvInstance;
}

export function evaluateAssertion(a: Assertion, response: ApiResponse, schemaValidator?: (schema: string, data: unknown) => string | true): TestResult {
  const name = a.name || `${a.type}${a.property ? ` ${a.property}` : ''}`;
  const t0 = performance.now();
  let result: TestResult;
  try {
    result = evaluate(a, response, schemaValidator);
  } catch (e) {
    result = { name, passed: false, error: e instanceof Error ? e.message : String(e), source: 'assertion' };
  }
  result.durationMs = performance.now() - t0;
  result.name = result.name || name;
  result.source = 'assertion';
  return result;
}

function evaluate(a: Assertion, response: ApiResponse, schemaValidator?: (schema: string, data: unknown) => string | true): TestResult {
  const fail = (detail: string): TestResult => ({ name: '', passed: false, error: detail, source: 'assertion' });
  const pass = (): TestResult => ({ name: '', passed: true, source: 'assertion' });
  const body = response.bodyText ?? '';
  switch (a.type) {
    case 'statusCode': {
      const c = compare(response.status, a.operator ?? 'eq', a.expected ?? '200');
      return c.ok ? pass() : fail(`Status code ${c.detail}`);
    }
    case 'statusText': {
      const c = compare(response.statusText, a.operator ?? 'eq', a.expected ?? '');
      return c.ok ? pass() : fail(`Status text ${c.detail}`);
    }
    case 'headerExists': {
      const found = response.headers.some((h) => h.key.toLowerCase() === (a.property ?? '').toLowerCase());
      return found ? pass() : fail(`Header "${a.property}" not present`);
    }
    case 'headerValue': {
      if (a.property?.toLowerCase() === 'set-cookie') {
        const setCookies = response.headers.filter((h) => h.key.toLowerCase() === 'set-cookie').map((h) => h.value).join('\n');
        const c = compare(setCookies, a.operator ?? 'contains', a.expected ?? '');
        return c.ok ? pass() : fail(`Set-Cookie ${c.detail}`);
      }
      const val = headerOf(response.headers, a.property ?? '');
      if (val === undefined) return fail(`Header "${a.property}" not present`);
      const c = compare(val, a.operator ?? 'eq', a.expected ?? '');
      return c.ok ? pass() : fail(`Header ${a.property}: ${c.detail}`);
    }
    case 'bodyContains': return body.includes(a.expected ?? '') ? pass() : fail(`Body does not contain "${truncate(a.expected ?? '')}"`);
    case 'bodyNotContains': return !body.includes(a.expected ?? '') ? pass() : fail(`Body unexpectedly contains "${truncate(a.expected ?? '')}"`);
    case 'jsonProperty': {
      const p = parseJson(body);
      if (!p.ok) return fail(`Response is not valid JSON: ${p.error}`);
      const val = getByPath(p.value, a.property ?? '');
      const c = compare(val, a.operator ?? 'exists', a.expected ?? '');
      return c.ok ? pass() : fail(`JSON "${a.property}": ${c.detail}`);
    }
    case 'jsonPath': {
      const p = parseJson(body);
      if (!p.ok) return fail(`Response is not valid JSON: ${p.error}`);
      let values: unknown[];
      try {
        values = JSONPath({ path: a.property ?? '$', json: p.value as object, wrap: true }) as unknown[];
      } catch (e) { return fail(`Invalid JSONPath: ${e instanceof Error ? e.message : e}`); }
      if (a.operator === 'exists' || !a.operator && !a.expected) return (values as unknown[]).length > 0 ? pass() : fail(`JSONPath "${a.property}" matched nothing`);
      const val = (values as unknown[])[0];
      const c = compare(val, a.operator ?? 'eq', a.expected ?? '');
      return c.ok ? pass() : fail(`JSONPath "${a.property}": ${c.detail}`);
    }
    case 'xpath': {
      try {
        const doc = new DOMParser().parseFromString(body, 'text/xml');
        const nodes = xpath.select(a.property ?? '/', doc as never) as unknown[];
        if (!a.operator || a.operator === 'exists') return Array.isArray(nodes) && nodes.length > 0 ? pass() : fail(`XPath "${a.property}" matched nothing`);
        const first = nodes[0] as { data?: unknown; toString?: () => string } | undefined;
        const val = first == null ? '' : typeof first === 'object' && 'data' in (first as object) ? String((first as { data: unknown }).data) : String(first as unknown);
        const c = compare(val, a.operator, a.expected ?? '');
        return c.ok ? pass() : fail(`XPath "${a.property}": ${c.detail}`);
      } catch (e) { return fail(`XPath error: ${e instanceof Error ? e.message : e}`); }
    }
    case 'regex': {
      try { return new RegExp(a.property ?? '', 'm').test(body) ? pass() : fail(`Body does not match /${a.property}/`); }
      catch { return fail(`Invalid regex /${a.property}/`); }
    }
    case 'schema': {
      const p = parseJson(body);
      if (!p.ok) return fail(`Response is not valid JSON: ${p.error}`);
      if (!schemaValidator) return fail('Schema validator unavailable');
      const res = schemaValidator(a.schema ?? '{}', p.value);
      return res === true ? pass() : fail(`Schema validation failed: ${res}`);
    }
    case 'responseTime': {
      const c = compare(response.timing.totalMs, a.operator ?? 'lte', a.expected ?? '1000');
      return c.ok ? pass() : fail(`Response time ${c.detail}`);
    }
    case 'responseSize': {
      const c = compare(response.bodySize, a.operator ?? 'lte', a.expected ?? '1048576');
      return c.ok ? pass() : fail(`Response size ${c.detail}`);
    }
    case 'contentType': {
      const ct = response.contentType ?? headerOf(response.headers, 'content-type') ?? '';
      const c = compare(ct, a.operator ?? 'contains', a.expected ?? '');
      return c.ok ? pass() : fail(`Content-Type ${c.detail}`);
    }
    case 'arrayLength': {
      const p = parseJson(body);
      if (!p.ok) return fail('Response is not valid JSON');
      const val = a.property ? getByPath(p.value, a.property) : p.value;
      const len = Array.isArray(val) ? val.length : undefined;
      const c = compare(len, a.operator ?? 'gte', a.expected ?? '1');
      return c.ok ? pass() : fail(`Array length: ${c.detail}`);
    }
    case 'valueEquals': return body === (a.expected ?? '') ? pass() : fail('Body differs from expected value');
    case 'soapFault': {
      const hasFault = /<(\w+:)?Fault[\s>]/.test(body) || body.includes('soap:Fault') || body.includes('env:Fault');
      return hasFault ? fail('SOAP Fault detected in response') : pass();
    }
    case 'soapAction': {
      const val = headerOf(response.headers, 'soapaction');
      const c = compare(val ?? '', a.operator ?? 'contains', a.expected ?? '');
      return c.ok ? pass() : fail(`SOAPAction: ${c.detail}`);
    }
    default:
      return fail(`Unknown assertion type ${a.type}`);
  }
}

export function evaluateAssertions(assertions: Assertion[], response: ApiResponse, schemaValidator?: (schema: string, data: unknown) => string | true): TestResult[] {
  return assertions.filter((a) => a.enabled).map((a) => evaluateAssertion(a, response, schemaValidator));
}

export { getAjv };
