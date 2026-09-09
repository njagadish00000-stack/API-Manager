/**
 * WSDL → collection conversion (§40): services → folders, operations →
 * requests with generated sample bodies + endpoint configuration.
 */
import type { Folder } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { kv } from '../url/urlBuilder';
import { emptyImport, freshCollection, freshFolder, freshRequest, NormalizedImport } from '../importers/model';
import { parseWsdl, sampleBodyForOperation, ParsedWsdl, WsdlOperation } from './wsdl';

export function wsdlToCollection(wsdlXml: string, workspaceId: string, sourceName?: string): NormalizedImport {
  const out = emptyImport('wsdl');
  let wsdl: ParsedWsdl;
  try { wsdl = parseWsdl(wsdlXml); } catch (e) {
    out.report.warnings.push(`WSDL parse error: ${e instanceof Error ? e.message : e}`);
    return out;
  }
  const name = wsdl.name || sourceName || 'WSDL Service';
  const collection = freshCollection(workspaceId, name);
  collection.description = `Generated from WSDL${sourceName ? ` (${sourceName})` : ''}. Target namespace: ${wsdl.targetNamespace}`;
  collection.variables = [{ id: uid(), key: 'endpoint', value: firstEndpoint(wsdl), initialValue: firstEndpoint(wsdl), type: 'default', enabled: true, description: 'Default SOAP endpoint' }];

  // store the raw WSDL as a specification
  out.specifications.push({
    id: uid(), workspaceId, name: `${name}.wsdl`, format: 'wsdl', content: wsdlXml,
    lifecycle: 'Active', linkedCollectionId: collection.id, createdAt: now(), updatedAt: now(),
  });

  const folders: Folder[] = [];
  const requests: NormalizedImport['collections'][number]['requests'] = [];
  let opCount = 0;
  for (const service of wsdl.services) {
    for (const port of service.ports) {
      const folder = freshFolder(collection.id, `${service.name} / ${port.name}`);
      folder.description = [port.address ? `Endpoint: ${port.address}` : '', `SOAP ${port.soapVersion}, binding ${port.binding}`].filter(Boolean).join(' · ');
      folders.push(folder);
      for (const op of port.operations) {
        const req = operationToRequest(wsdl, op, port.address ?? '{{endpoint}}', port.soapVersion);
        req.collectionId = collection.id;
        req.folderId = folder.id;
        requests.push(req);
        out.report.converted.push({ kind: 'operation', name: op.name, note: op.soapAction ? `SOAPAction ${op.soapAction}` : undefined });
        opCount++;
      }
    }
  }
  if (opCount === 0) out.report.warnings.push('WSDL contains no operations to import.');
  out.collections.push({ collection, folders, requests, examples: [] });
  out.report.imported.push({ kind: 'collection', name: collection.name, id: collection.id });
  out.report.finishedAt = now();
  return out;
}

function firstEndpoint(wsdl: ParsedWsdl): string {
  for (const s of wsdl.services) for (const p of s.ports) if (p.address) return p.address;
  return '';
}

export function operationToRequest(wsdl: ParsedWsdl, op: WsdlOperation, endpoint: string, soapVersion: '1.1' | '1.2'): ReturnType<typeof freshRequest> {
  const req = freshRequest('', op.name);
  req.protocol = 'soap';
  req.method = 'POST';
  req.url = endpoint || '{{endpoint}}';
  const { body } = sampleBodyForOperation(wsdl, op);
  req.body = { type: 'xml', raw: body };
  req.description = op.documentation ?? '';
  req.headers = [
    kv('Content-Type', soapVersion === '1.2' ? `application/soap+xml; charset=utf-8${op.soapAction ? `; action="${op.soapAction}"` : ''}` : 'text/xml; charset=utf-8'),
  ];
  if (soapVersion === '1.1') req.headers.push(kv('SOAPAction', op.soapAction ?? ''));
  req.protocolData = {
    soap: {
      version: soapVersion, action: op.soapAction, endpoint,
      wsdlOperation: op.name,
      wsAddressing: undefined, wsSecurity: undefined,
    },
  };
  req.assertions = [
    { id: uid(), type: 'soapFault', enabled: true, name: 'No SOAP Fault' },
    { id: uid(), type: 'statusCode', enabled: true, name: 'HTTP 200', operator: 'eq', expected: '200' },
  ];
  return req;
}
