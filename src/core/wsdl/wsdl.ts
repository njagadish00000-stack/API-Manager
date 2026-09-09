/**
 * WSDL 1.1 parser + XSD type resolution + request template generation (§40).
 * Uses fast-xml-parser; tolerant of real-world WSDL quirks.
 */
import { XMLParser } from 'fast-xml-parser';

export interface WsdlMessage { name: string; parts: { name: string; element?: string; type?: string }[] }
export interface WsdlOperation {
  name: string;
  soapAction?: string;
  style?: 'document' | 'rpc';
  inputMessage?: string;
  outputMessage?: string;
  inputHeaders?: { message?: string; part?: string }[];
  documentation?: string;
}
export interface WsdlPort {
  name: string;
  binding: string;
  address?: string;
  operations: WsdlOperation[];
  soapVersion: '1.1' | '1.2';
}
export interface WsdlService { name: string; ports: WsdlPort[]; documentation?: string }
export interface XsdElement { name: string; type?: string; ref?: string; minOccurs?: string; maxOccurs?: string; children?: XsdElement[]; }
export interface ParsedWsdl {
  name: string;
  targetNamespace: string;
  services: WsdlService[];
  messages: WsdlMessage[];
  /** element name -> tree */
  elements: Map<string, XsdElement>;
  complexTypes: Map<string, XsdElement>;
  namespaces: Record<string, string>;
  raw: string;
}

const NS_SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const NS_SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';

function localName(qname: string): string { return qname.split(':').pop() ?? qname; }
function arrify<T>(v: T | T[] | undefined): T[] { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }

export function parseWsdl(xml: string): ParsedWsdl {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: false,
    parseAttributeValue: false, trimValues: true,
  });
  const doc = parser.parse(xml);
  const defs = doc['wsdl:definitions'] ?? doc['definitions'] ?? doc['wsdl:description'] ?? doc['description'];
  if (!defs) throw new Error('Not a WSDL document (missing wsdl:definitions)');

  const namespaces: Record<string, string> = {};
  let targetNamespace = '';
  for (const [k, v] of Object.entries(defs)) {
    if (k.startsWith('@_xmlns')) namespaces[k.replace('@_xmlns:', '') || 'default'] = String(v);
    if (k === '@_targetNamespace') targetNamespace = String(v);
  }

  // ---- XSD schema collection ----
  const elements = new Map<string, XsdElement>();
  const complexTypes = new Map<string, XsdElement>();
  const typesNode = defs['wsdl:types'] ?? defs['types'];
  const schemas = arrify(typesNode?.['xsd:schema'] ?? typesNode?.['xs:schema'] ?? typesNode?.['s:schema'] ?? typesNode?.schema);
  for (const schema of schemas) {
    if (!schema || typeof schema !== 'object') continue;
    for (const el of arrify(schema['xsd:element'] ?? schema['xs:element'] ?? schema['s:element'])) {
      if (!el) continue;
      const parsed = parseXsdElement(el, 'xsd:', 'xs:', 's:');
      if (parsed.name) elements.set(parsed.name, parsed);
    }
    for (const ct of arrify(schema['xsd:complexType'] ?? schema['xs:complexType'] ?? schema['s:complexType'])) {
      if (!ct) continue;
      const parsed = parseXsdComplexType(ct, 'xsd:', 'xs:', 's:');
      if (parsed.name) complexTypes.set(parsed.name, parsed);
    }
  }

  // ---- messages ----
  const messages: WsdlMessage[] = [];
  for (const msg of arrify(defs['wsdl:message'] ?? defs['message'])) {
    if (!msg) continue;
    const parts = arrify(msg['wsdl:part'] ?? msg['part']).map((p: Record<string, string>) => ({
      name: p['@_name'] ?? '', element: p['@_element'], type: p['@_type'],
    }));
    messages.push({ name: msg['@_name'] ?? '', parts });
  }

  // ---- portTypes / operations ----
  const portTypeOps = new Map<string, WsdlOperation[]>();
  const opDocs = new Map<string, string>();
  for (const pt of arrify(defs['wsdl:portType'] ?? defs['portType'] ?? defs['wsdl:interface'] ?? defs['interface'])) {
    if (!pt) continue;
    const ops: WsdlOperation[] = [];
    for (const op of arrify(pt['wsdl:operation'] ?? pt['operation'])) {
      if (!op) continue;
      const input = op['wsdl:input'] ?? op['input'];
      const output = op['wsdl:output'] ?? op['output'];
      const docNode = op['wsdl:documentation'] ?? op['documentation'];
      ops.push({
        name: op['@_name'] ?? '',
        inputMessage: localName(input?.['@_message'] ?? ''),
        outputMessage: localName(output?.['@_message'] ?? ''),
        documentation: typeof docNode === 'string' ? docNode : docNode?.['#text'],
      });
      if (docNode) opDocs.set(op['@_name'] ?? '', typeof docNode === 'string' ? docNode : docNode['#text'] ?? '');
    }
    portTypeOps.set(pt['@_name'] ?? '', ops);
  }

  // ---- bindings (soapAction etc.) ----
  const bindingInfo = new Map<string, { soapVersion: '1.1' | '1.2'; style?: 'document' | 'rpc'; ops: Map<string, { soapAction?: string; style?: 'document' | 'rpc'; inputHeaders?: { message?: string; part?: string }[] }>; portType?: string }>();
  for (const b of arrify(defs['wsdl:binding'] ?? defs['binding'])) {
    if (!b) continue;
    const info = { soapVersion: '1.1' as '1.1' | '1.2', style: undefined as 'document' | 'rpc' | undefined, ops: new Map<string, { soapAction?: string; style?: 'document' | 'rpc'; inputHeaders?: { message?: string; part?: string }[] }>(), portType: localName(b['@_type'] ?? '') };
    const soapBinding = b['soap:binding'] ?? b['soap12:binding'];
    if (soapBinding) {
      info.soapVersion = b['soap12:binding'] ? '1.2' : '1.1';
      info.style = soapBinding['@_style'];
    }
    for (const op of arrify(b['wsdl:operation'] ?? b['operation'])) {
      if (!op) continue;
      const soapOp = op['soap:operation'] ?? op['soap12:operation'];
      const inputSoap = op['wsdl:input']?.['soap:header'] ?? op['input']?.['soap:header'] ?? op['input']?.['soap12:header'];
      info.ops.set(op['@_name'] ?? '', {
        soapAction: soapOp?.['@_soapAction'],
        style: soapOp?.['@_style'] ?? info.style,
        inputHeaders: arrify(inputSoap).map((h: Record<string, string>) => ({ message: localName(h?.['@_message'] ?? ''), part: h?.['@_part'] })),
      });
    }
    bindingInfo.set(b['@_name'] ?? '', info);
  }

  // ---- services / ports ----
  const services: WsdlService[] = [];
  for (const svc of arrify(defs['wsdl:service'] ?? defs['service'])) {
    if (!svc) continue;
    const ports: WsdlPort[] = [];
    for (const port of arrify(svc['wsdl:port'] ?? svc['port'])) {
      if (!port) continue;
      const bindingName = localName(port['@_binding'] ?? '');
      const binding = bindingInfo.get(bindingName);
      const addressNode = port['soap:address'] ?? port['soap12:address'];
      const portTypeName = binding?.portType ?? '';
      const baseOps = portTypeOps.get(portTypeName) ?? [];
      const ops: WsdlOperation[] = baseOps.map((o) => {
        const bOp = binding?.ops.get(o.name);
        return { ...o, soapAction: bOp?.soapAction ?? o.soapAction, style: bOp?.style ?? o.style ?? binding?.style, inputHeaders: bOp?.inputHeaders, documentation: o.documentation ?? opDocs.get(o.name) };
      });
      ports.push({
        name: port['@_name'] ?? '', binding: bindingName,
        address: addressNode?.['@_location'],
        operations: ops,
        soapVersion: binding?.soapVersion ?? '1.1',
      });
    }
    const svcDoc = svc['wsdl:documentation'] ?? svc['documentation'];
    services.push({ name: svc['@_name'] ?? '', ports, documentation: typeof svcDoc === 'string' ? svcDoc : svcDoc?.['#text'] });
  }

  return {
    name: defs['@_name'] ?? '', targetNamespace, services, messages, elements, complexTypes, namespaces, raw: xml,
  };
}

type V = Record<string, unknown>;
const prefixGet = (node: V, base: string, p1: string, p2: string, p3: string) => node[`${p1}${base}`] ?? node[`${p2}${base}`] ?? node[`${p3}${base}`] ?? node[base];

function parseXsdElement(el: V, p1 = 'xsd:', p2 = 'xs:', p3 = 's:'): XsdElement {
  const out: XsdElement = {
    name: String(el['@_name'] ?? (typeof el['@_ref'] === 'string' ? String(el['@_ref']).split(':').pop() : '') ?? ''),
    type: el['@_type'] as string | undefined,
    minOccurs: el['@_minOccurs'] as string | undefined,
    maxOccurs: el['@_maxOccurs'] as string | undefined,
  };
  complexChildren(el, p1, p2, p3, out);
  return out;
}

function parseXsdComplexType(ct: V, p1 = 'xsd:', p2 = 'xs:', p3 = 's:'): XsdElement {
  const out: XsdElement = { name: String(ct['@_name'] ?? '') };
  complexChildren(ct, p1, p2, p3, out);
  return out;
}

function complexChildren(node: V, p1: string, p2: string, p3: string, out: XsdElement): void {
  const ct = (prefixGet(node, 'complexType', p1, p2, p3) ?? node) as V;
  const containers: V[] = [];
  const seq = prefixGet(ct, 'sequence', p1, p2, p3); if (seq) containers.push(seq as V);
  const all = prefixGet(ct, 'all', p1, p2, p3); if (all) containers.push(all as V);
  const choice = prefixGet(ct, 'choice', p1, p2, p3); if (choice) containers.push(choice as V);
  const cc = prefixGet(ct, 'complexContent', p1, p2, p3) ?? prefixGet(ct, 'simpleContent', p1, p2, p3);
  if (cc) {
    const ext = prefixGet(cc as V, 'extension', p1, p2, p3) ?? prefixGet(cc as V, 'restriction', p1, p2, p3);
    if (ext) containers.push(ext as V);
    if (ext && (ext as V)['@_base']) out.type = (ext as V)['@_base'] as string;
  }
  const children: XsdElement[] = out.children ?? [];
  for (const container of containers) {
    for (const childEl of arrify(prefixGet(container, 'element', p1, p2, p3))) {
      const c = childEl as V;
      const child: XsdElement = {
        name: String(c['@_name'] ?? (typeof c['@_ref'] === 'string' ? localName(c['@_ref'] as string) : '')),
        type: c['@_type'] as string | undefined,
        ref: c['@_ref'] as string | undefined,
        minOccurs: c['@_minOccurs'] as string | undefined,
        maxOccurs: c['@_maxOccurs'] as string | undefined,
      };
      complexChildren(c, p1, p2, p3, child);
      children.push(child);
    }
  }
  if (children.length > 0) out.children = children;
}

// ---------------------------------------------------------------------------
// Sample XML generation for an operation input
// ---------------------------------------------------------------------------

const XSD_BUILTIN_VALUES: Record<string, string> = {
  string: 'string', int: '0', integer: '0', long: '0', short: '0', byte: '0',
  decimal: '0.0', float: '0.0', double: '0.0', boolean: 'true', date: '2024-01-01',
  dateTime: '2024-01-01T00:00:00Z', time: '00:00:00', base64Binary: '', anyType: 'value',
  positiveInteger: '1', nonNegativeInteger: '0', unsignedInt: '0', ID: 'id-1', token: 'token',
};

export function sampleForElement(wsdl: ParsedWsdl, elementName: string, depth = 0, visited: Set<string> = new Set()): string {
  const el = wsdl.elements.get(localName(elementName));
  if (!el) return `<${localName(elementName)}>?</${localName(elementName)}>`;
  return sampleFromXsd(wsdl, el, depth, visited);
}

function sampleFromXsd(wsdl: ParsedWsdl, el: XsdElement, depth: number, visited: Set<string>): string {
  if (depth > 10) return `<${el.name}/>`;
  const typeName = el.type ? localName(el.type) : undefined;
  const isBuiltin = el.type && (el.type.startsWith('xsd:') || el.type.startsWith('xs:') || el.type.startsWith('s:') || XSD_BUILTIN_VALUES[typeName ?? ''] !== undefined && !wsdl.complexTypes.has(typeName ?? ''));
  if (isBuiltin && !el.children?.length) {
    return `<${el.name}>${XSD_BUILTIN_VALUES[typeName ?? 'string'] ?? 'string'}</${el.name}>`;
  }
  let children = el.children;
  if ((!children || children.length === 0) && typeName) {
    if (visited.has(typeName)) return `<${el.name}/>`;
    const ct = wsdl.complexTypes.get(typeName);
    if (ct?.children) children = ct.children;
    if (ct && !ct.children && ct.type) {
      const base = localName(ct.type);
      return `<${el.name}>${XSD_BUILTIN_VALUES[base] ?? 'string'}</${el.name}>`;
    }
  }
  if (!children || children.length === 0) return `<${el.name}>${XSD_BUILTIN_VALUES[typeName ?? ''] ?? 'string'}</${el.name}>`;
  visited.add(typeName ?? el.name);
  const inner = children.map((c) => sampleFromXsd(wsdl, c.ref ? { ...c, name: localName(c.ref), type: wsdl.elements.get(localName(c.ref))?.type ?? c.type, children: wsdl.elements.get(localName(c.ref))?.children } : c, depth + 1, new Set(visited))).join('\n  ');
  return `<${el.name}>\n  ${inner}\n</${el.name}>`;
}

/** Build a complete SOAP body sample for an operation. */
export function sampleBodyForOperation(wsdl: ParsedWsdl, op: WsdlOperation): { body: string; wrapper?: string } {
  const msg = wsdl.messages.find((m) => m.name === localName(op.inputMessage ?? ''));
  const parts = msg?.parts ?? [];
  if (parts.length === 0) {
    return { body: `<${op.name}>?</${op.name}>`, wrapper: op.style === 'rpc' ? op.name : undefined };
  }
  if (op.style === 'rpc') {
    const inner = parts.map((p) => `<${p.name}>${XSD_BUILTIN_VALUES[localName(p.type ?? '')] ?? 'string'}</${p.name}>`).join('\n  ');
    return { body: `<${op.name}>\n  ${inner}\n</${op.name}>`, wrapper: op.name };
  }
  const chunks = parts.map((p) => {
    if (p.element) return sampleForElement(wsdl, p.element);
    return `<${p.name}>${XSD_BUILTIN_VALUES[localName(p.type ?? '')] ?? 'string'}</${p.name}>`;
  });
  const body = chunks.join('\n');
  return { body, wrapper: parts.length > 0 && op.style === undefined && parts[0].element === undefined ? op.name : undefined };
}

export function detectWsdl(xml: string): boolean {
  return /<(\w+:)?definitions[\s>]/.test(xml) || /<(\w+:)?description[\s>][^>]*wsdl/i.test(xml);
}
