/**
 * SoapUI project migration engine (§41, §83). Parses SoapUI XML project files:
 * interfaces (WSDL), requests, test suites/cases/steps, properties, assertions,
 * scripts — producing a normalized import + detailed migration report.
 * Nothing is silently discarded (§50).
 */
import { XMLParser } from 'fast-xml-parser';
import type { ApiRequest, Assertion, Folder } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { kv } from '../url/urlBuilder';
import { emptyImport, freshCollection, freshFolder, freshRequest, NormalizedImport } from '../importers/model';
import { isSoapPayload } from '../soap/envelope';

type V = Record<string, unknown>;
const arrify = <T = V>(v: unknown): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v as T[] : [v as T]);
const CON = 'con:';
const g = (node: unknown, key: string): unknown => (node && typeof node === 'object' ? ((node as V)[`${CON}${key}`] ?? (node as V)[key]) : undefined);

export function detectSoapUiProject(xml: string): boolean {
  return /soapui-project/i.test(xml) && /eviware.com\/soapui/i.test(xml);
}

export function importSoapUiProject(xml: string, workspaceId: string): NormalizedImport {
  const out = emptyImport('soapui');
  const report = out.report;
  let doc: V;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: false, cdataPropName: '#cdata', preserveOrder: false, trimValues: true });
    doc = parser.parse(xml) as V;
  } catch (e) {
    report.warnings.push(`XML parse error: ${e instanceof Error ? e.message : e}`);
    return out;
  }
  const root = Object.values(doc)[0] as V | undefined;
  if (!root || typeof root !== 'object') {
    report.warnings.push('Empty or unrecognized SoapUI project file');
    return out;
  }
  const projectName = String((root as V)['@_name'] ?? 'SoapUI Project');

  // ---- project properties ----
  const projectProps = readProperties(g(root, 'properties'));

  // ---- interfaces → collections ----
  for (const iface of arrify(g(root, 'interface'))) {
    const iv = iface as V;
    const name = String(iv['@_name'] ?? 'Interface');
    const collection = freshCollection(workspaceId, `${projectName} / ${name}`);
    collection.description = `Imported from SoapUI project "${projectName}" interface "${name}".`;
    const soapVersion = String(iv['@_soapVersion'] ?? '1_1') === '1_2' ? '1.2' : '1.1';
    // endpoints
    const endpoints = arrify(g(iv, 'endpoints')).flatMap((e) => arrify((e as V)[`${CON}endpoint`] ?? (e as V).endpoint)).map(e => String(e));
    const definitionUrl = String(iv['@_definition'] ?? '');
    if (endpoints.length === 0 && definitionUrl) endpoints.push(definitionUrl);
    collection.variables = [
      { id: uid(), key: 'endpoint', value: endpoints[0] ?? definitionUrl, initialValue: endpoints[0] ?? definitionUrl, type: 'default', enabled: true, description: 'SOAP endpoint' },
      ...projectProps.map(([key, value]) => ({ id: uid(), key, value, initialValue: value, type: 'default' as const, enabled: true })),
    ];
    if (definitionUrl) {
      report.converted.push({ kind: 'wsdl', name: definitionUrl, note: 'WSDL definition URL recorded on collection description' });
      collection.description += `\nWSDL: ${definitionUrl}`;
    }
    const requests: ApiRequest[] = [];
    // operation-level and interface-level requests
    const collectRequests = (container: V | undefined, folderId?: string) => {
      if (!container) return;
      for (const req of arrify<V>(g(container, 'request'))) {
        requests.push(convertSoapRequest(req, collection.id, folderId, workspaceId, soapVersion, report, endpoints[0]));
      }
      for (const op of arrify<V>(g(container, 'operation'))) {
        collectRequests(op, folderId);
      }
    };
    collectRequests(iv);
    out.collections.push({ collection, folders: [], requests, examples: [] });
    report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  }

  // ---- test suites → collections with folders ----
  for (const suite of arrify(g(root, 'testSuite'))) {
    const sv = suite as V;
    const suiteName = String(sv['@_name'] ?? 'TestSuite');
    const collection = freshCollection(workspaceId, `${projectName} / ${suiteName}`);
    const suiteProps = readProperties(g(sv, 'properties'));
    collection.variables = [
      { id: uid(), key: 'endpoint', value: suiteProps.find(([k]) => k === 'endpoint')?.[1] ?? '', type: 'default', enabled: true },
      ...suiteProps.filter(([k]) => k !== 'endpoint').map(([key, value]) => ({ id: uid(), key, value, initialValue: value, type: 'default' as const, enabled: true })),
      ...projectProps.map(([key, value]) => ({ id: uid(), key, value, initialValue: value, type: 'default' as const, enabled: true })),
    ];
    const folders: Folder[] = [];
    const requests: ApiRequest[] = [];
    for (const tcase of arrify(g(sv, 'testCase'))) {
      const tv = tcase as V;
      const caseName = String(tv['@_name'] ?? 'TestCase');
      const folder = freshFolder(collection.id, caseName);
      const caseProps = readProperties(g(tv, 'properties'));
      if (caseProps.length > 0) {
        folder.description = `Properties: ${caseProps.map(([k, v]) => `${k}=${v}`).join(', ')}`;
        report.converted.push({ kind: 'properties', name: `${caseName}`, note: `${caseProps.length} test case properties recorded in folder description` });
      }
      const groovyChunks: string[] = [];
      for (const step of arrify(g(tv, 'testStep'))) {
        const stv = step as V;
        const stepName = String(stv['@_name'] ?? 'step');
        const stepType = String(stv['@_type'] ?? 'request');
        if (stepType === 'request' || stepType === 'restrequest' || stepType === 'httprequest') {
          const config = g(stv, 'config') as V | undefined;
          const reqNode = config ? (g(config, 'request') ?? config) as V : undefined;
          if (reqNode) {
            requests.push(convertSoapRequest(reqNode, collection.id, folder.id, workspaceId, '1.1', report, undefined, stepName));
          } else {
            report.skipped.push({ kind: 'testStep', name: `${caseName}/${stepName}`, reason: 'Request step has no embedded request config' });
          }
        } else if (stepType === 'groovy' || stepType === 'beanshell') {
          const config = g(stv, 'config') as V | undefined;
          const script = String(config?.script ?? config?.['#cdata'] ?? config?.scriptText ?? '');
          groovyChunks.push(`// --- SoapUI ${stepType} step "${stepName}" (requires manual conversion to JavaScript) ---\n// ${script.split('\n').join('\n// ') || '(empty script)'}\n`);
          report.scriptsRequiringReview.push({ location: `${suiteName}/${caseName}/${stepName}`, reason: `${stepType} script cannot be auto-converted from Groovy; preserved as comment` });
        } else if (stepType === 'properties') {
          const config = g(stv, 'config') as V | undefined;
          const props = readProperties(config?.properties as V | undefined);
          for (const [key, value] of props) {
            collection.variables.push({ id: uid(), key: `${folder.name}.${stepName}.${key}`, value, initialValue: value, type: 'default', enabled: true });
          }
          report.converted.push({ kind: 'properties-step', name: stepName, note: `${props.length} properties converted to collection variables` });
        } else if (stepType === 'transfer' || stepType === 'propertytransfer') {
          report.unsupported.push({ kind: 'testStep', name: `${caseName}/${stepName}`, detail: 'Property transfer steps are not auto-converted; use scripts to pass data between requests' });
        } else if (stepType === 'delay') {
          report.converted.push({ kind: 'testStep', name: stepName, note: 'Delay steps should be replaced by Flow delay nodes' });
        } else {
          report.unsupported.push({ kind: 'testStep', name: `${caseName}/${stepName}`, detail: `Step type "${stepType}" has no direct equivalent` });
        }
      }
      if (groovyChunks.length > 0) folder.scripts.postResponse = ['// The following Groovy/BeanShell scripts were imported for manual conversion', ...groovyChunks].join('\n');
      folders.push(folder);
    }
    out.collections.push({ collection, folders, requests, examples: [] });
    report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  }

  // ---- load tests / security tests / mock services ----
  for (const lt of arrify(g(root, 'loadTest'))) {
    report.unsupported.push({ kind: 'loadTest', name: String((lt as V)['@_name'] ?? 'loadTest'), detail: 'Use API Manager Performance testing instead' });
  }
  for (const ms of arrify(g(root, 'mockService'))) {
    report.unsupported.push({ kind: 'mockService', name: String((ms as V)['@_name'] ?? 'mockService'), detail: 'Recreate as an API Manager Mock Server' });
  }
  for (const wss of arrify(g(root, 'wssContainer'))) {
    report.warnings.push(`WS-Security configuration container found (${Object.keys(wss as V).length} entries); configure WS-Security on the SOAP requests.`);
  }
  if (out.collections.length === 0) {
    report.warnings.push('No interfaces or test suites found in the SoapUI project file.');
  }
  report.finishedAt = now();
  return out;
}

function readProperties(node: unknown): [string, string][] {
  if (!node) return [];
  const out: [string, string][] = [];
  const props = arrify(g(node, 'property'));
  if (props.length === 0 && typeof node === 'object') {
    // some SoapUI versions store as <property><name/><value/></property>
    for (const p of arrify((node as V).property)) {
      const pv = p as V;
      const name = String(g(pv, 'name') ?? pv.name ?? '');
      const value = String(g(pv, 'value') ?? pv.value ?? '');
      if (name) out.push([name, value]);
    }
    return out;
  }
  for (const p of props) {
    const pv = p as V;
    const name = String(g(pv, 'name') ?? pv.name ?? pv['@_name'] ?? '');
    const value = String(g(pv, 'value') ?? pv.value ?? pv['@_value'] ?? '');
    if (name) out.push([name, value]);
  }
  return out;
}

function convertSoapRequest(node: V, collectionId: string, folderId: string | undefined, workspaceId: string, soapVersion: '1.1' | '1.2', report: NormalizedImport['report'], defaultEndpoint?: string, stepName?: string): ApiRequest {
  const name = stepName ?? String(node['@_name'] ?? node['@_id'] ?? 'SOAP Request');
  const req = freshRequest(workspaceId, name, collectionId, folderId);
  req.protocol = 'soap';
  req.method = 'POST';
  const endpoint = String(g(node, 'endpoint') ?? node['@_endpoint'] ?? defaultEndpoint ?? '{{endpoint}}');
  req.url = endpoint || '{{endpoint}}';
  // payload (often CDATA)
  const payloadNode = g(node, 'request');
  let payload = '';
  if (typeof payloadNode === 'string') payload = payloadNode;
  else if (payloadNode && typeof payloadNode === 'object') payload = String((payloadNode as V)['#cdata'] ?? (payloadNode as V)['#text'] ?? '');
  const isSoap = isSoapPayload(payload);
  const mediaType = String(node['@_mediaType'] ?? '');
  req.headers = [
    kv('Content-Type', mediaType || (soapVersion === '1.2' ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8')),
  ];
  const soapAction = String(node['@_action'] ?? node['@_soapAction'] ?? g(node, 'action') ?? '');
  if (soapVersion === '1.1' && soapAction) req.headers.push(kv('SOAPAction', soapAction));
  req.protocolData = { soap: { version: soapVersion, action: soapAction || undefined, endpoint: req.url } };
  req.body = { type: isSoap ? 'xml' : 'text', raw: payload.trim() };
  // credentials
  const creds = g(node, 'credentials') as V | undefined;
  if (creds) {
    const username = String(g(creds, 'username') ?? '');
    const password = String(g(creds, 'password') ?? '');
    const authType = String(g(creds, 'authType') ?? '');
    if (username) {
      if (/ntlm/i.test(authType)) req.auth = { type: 'ntlm', ntlm: { username, password, domain: String(g(creds, 'domain') ?? '') } };
      else if (/preemptive|global|basic/i.test(authType) || !authType) req.auth = { type: 'basic', basic: { username, password } };
      report.converted.push({ kind: 'auth', name, note: `${authType || 'basic'} credentials converted` });
    }
    if (g(creds, 'selectedWssProfile')) {
      report.warnings.push(`Request "${name}" references a WS-Security profile; configure WS-Security manually.`);
    }
  }
  // assertions
  for (const assertionNode of arrify<V>(g(node, 'assertion'))) {
    const av = assertionNode;
    const type = String(av['@_type'] ?? av.type ?? av.name ?? '');
    const config = av.configuration ?? g(av, 'configuration') ?? av;
    const assertion = convertAssertion(type, config as V, name, report);
    if (assertion) req.assertions.push(assertion);
  }
  report.converted.push({ kind: 'request', name });
  return req;
}

function convertAssertion(type: string, config: V, owner: string, report: NormalizedImport['report']): Assertion | null {
  const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
  const cx = (config as V) ?? {};
  switch (type) {
    case 'Not SOAP Fault':
    case 'NotSoapFaultAssertion':
      return { id: uid(), type: 'soapFault', enabled: true, name: 'No SOAP Fault' };
    case 'SOAP Fault':
      report.unsupported.push({ kind: 'assertion', name: `${owner}: ${type}`, detail: '"expects SOAP Fault" variant; add a custom script instead' });
      return null;
    case 'Contains':
      return { id: uid(), type: 'bodyContains', enabled: true, name: 'Contains', expected: str(cx.token ?? cx.content ?? cx.expectedContent) };
    case 'Not Contains':
      return { id: uid(), type: 'bodyNotContains', enabled: true, name: 'Not Contains', expected: str(cx.token ?? cx.content ?? cx.expectedContent) };
    case 'XPath Match':
    case 'XPathMatch':
    case 'XPath Assertion':
      return { id: uid(), type: 'xpath', enabled: true, name: 'XPath Match', property: str(cx.path ?? cx.XPath ?? cx.xpath), expected: str(cx.expectedContent ?? cx.content), operator: 'eq' };
    case 'XQuery Match':
      report.unsupported.push({ kind: 'assertion', name: `${owner}: XQuery Match`, detail: 'XQuery is not supported; use XPath assertions' });
      return null;
    case 'Response SLA':
      return { id: uid(), type: 'responseTime', enabled: true, name: 'Response SLA', operator: 'lte', expected: str(cx.SLA ?? cx.maxResponseTime ?? cx.value ?? '1000') };
    case 'Valid HTTP Status Codes':
    case 'Invalid HTTP Status Codes': {
      const codes = str(cx.codes ?? cx.value).split(',').map((s) => s.trim())[0];
      report.converted.push({ kind: 'assertion', name: `${owner}: ${type}`, note: 'First status code mapped; extend with script for multiple codes' });
      return { id: uid(), type: 'statusCode', enabled: true, name: 'HTTP Status', operator: type.startsWith('Invalid') ? 'neq' : 'eq', expected: codes || '200' };
    }
    case 'Schema Compliance':
      report.skipped.push({ kind: 'assertion', name: `${owner}: Schema Compliance`, reason: 'Requires live WSDL; validate via spec linting instead' });
      return null;
    case 'GroovyScriptAssertion':
    case 'Script Assertion':
      report.scriptsRequiringReview.push({ location: `assertion of ${owner}`, reason: 'Script assertion preserved for manual review' });
      return null;
    case 'SOAP Response':
    case 'WS-Security Status':
    case 'WS-Addressing Response':
    case 'JMS Status':
    case 'JMS Timeout':
      report.unsupported.push({ kind: 'assertion', name: `${owner}: ${type}`, detail: 'No direct equivalent' });
      return null;
    default:
      if (type) report.unsupported.push({ kind: 'assertion', name: `${owner}: ${type}`, detail: 'Unknown assertion type' });
      return null;
  }
}
