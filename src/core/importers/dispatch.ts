/**
 * Import format detection + dispatch (§46). Every successful import produces
 * a migration report (§50).
 */
import type { ImportFormat, ImportResult } from '../../shared/types';
import { parse as parseYaml } from 'yaml';
import { NormalizedImport, emptyImport } from './model';
import { detectPostman, importPostmanCollection, importPostmanEnvironment, importPostmanGlobals } from '../postman/postman';
import { parseOpenApi, openApiToCollection, validateOpenApi } from '../openapi/openapi';
import { detectWsdl, parseWsdl } from '../wsdl/wsdl';
import { wsdlToCollection } from '../wsdl/wsdlImport';
import { detectSoapUiProject, importSoapUiProject } from '../soapui/soapui';
import { detectInsomnia, importInsomnia } from './insomnia';
import { detectHoppscotch, importHoppscotch } from './hoppscotch';
import { detectThunder, importThunder } from './thunder';
import { looksLikeRawHttp, importRawHttp } from './rawHttp';
import { looksLikeCurl, parseCurl } from '../curl/curlParser';
import { parseDotEnv } from '../envfile/dotenv';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { freshRequest } from './model';

export interface Detection { format: ImportFormat; confidence: 'high' | 'medium' | 'low'; detail?: string }

export function detectFormat(content: string, fileName?: string): Detection {
  const trimmed = content.trim();
  const lower = trimmed.slice(0, 4000).toLowerCase();
  const name = (fileName ?? '').toLowerCase();

  if (looksLikeCurl(trimmed)) return { format: 'curl', confidence: 'high' };
  if (looksLikeRawHttp(trimmed)) return { format: 'raw-http', confidence: 'high' };
  if (detectSoapUiProject(trimmed)) return { format: 'soapui', confidence: 'high' };

  if (trimmed.startsWith('<') || name.endsWith('.wsdl') || name.endsWith('.xml')) {
    if (detectWsdl(trimmed)) return { format: 'wsdl', confidence: 'high' };
    if (lower.includes('project') && lower.includes('eviware')) return { format: 'soapui', confidence: 'medium' };
    if (name.endsWith('.wsdl')) return { format: 'wsdl', confidence: 'medium' };
  }

  if (name.endsWith('.proto') || /syntax\s*=\s*"proto[23]"/.test(trimmed)) return { format: 'protobuf', confidence: 'high' };
  if (name.endsWith('.smithy') || lower.includes('namespace ') && lower.includes('smithy')) return { format: 'smithy', confidence: 'medium' };
  if (name.endsWith('.graphql') || name.endsWith('.graphqls') || name.endsWith('.gql')) {
    if (/^(type|schema|query|mutation|subscription|interface|enum|input|union|scalar)/m.test(trimmed)) return { format: 'graphql-schema', confidence: 'high' };
  }

  // JSON/YAML structured formats
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch {
    try { parsed = parseYaml(trimmed); } catch { parsed = undefined; }
  }
  if (parsed !== undefined) {
    if (parseOpenApi(trimmed)) {
      const v = validateOpenApi(trimmed);
      return { format: 'openapi', confidence: 'high', detail: `${v.stats?.operations ?? 0} operations` };
    }
    const pm = detectPostman(parsed);
    if (pm === 'collection') return { format: 'postman-collection', confidence: 'high' };
    if (pm === 'environment') return { format: 'postman-environment', confidence: 'high' };
    if (pm === 'globals') return { format: 'postman-globals', confidence: 'high' };
    if (pm === 'dump') return { format: 'postman-dump', confidence: 'high' };
    if (typeof parsed === 'object' && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      if (p.asyncapi) return { format: 'asyncapi', confidence: 'high' };
      if (detectInsomnia(trimmed)) return { format: 'insomnia', confidence: 'high' };
      if (detectThunder(trimmed)) return { format: 'thunder', confidence: 'medium' };
      if (detectHoppscotch(trimmed)) return { format: 'hoppscotch', confidence: 'medium' };
      if (p.format === 'apimanager' || p._apimanager) return { format: 'apimanager', confidence: 'high' };
    }
  }

  if (/^\s*[A-Za-z_][A-Za-z0-9_.]*\s*=/.test(trimmed) && !trimmed.includes('{')) {
    return { format: 'dotenv', confidence: name.endsWith('.env') ? 'high' : 'medium' };
  }
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return { format: 'yaml', confidence: 'low' };
  if (name.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) return { format: 'json', confidence: 'low' };
  return { format: 'raw-http', confidence: 'low', detail: 'Unrecognized format' };
}

export function runImport(content: string, format: ImportFormat | undefined, workspaceId: string, fileName?: string): NormalizedImport {
  const detected = format ?? detectFormat(content, fileName).format;
  switch (detected) {
    case 'postman-collection': return importPostmanCollection(content, workspaceId);
    case 'postman-environment': return importPostmanEnvironment(content, workspaceId);
    case 'postman-globals': return importPostmanGlobals(content);
    case 'postman-dump': {
      const parsed = JSON.parse(content);
      const combined = emptyImport('postman-dump');
      for (const c of parsed.collections ?? []) {
        const sub = importPostmanCollection(JSON.stringify(c), workspaceId);
        combined.collections.push(...sub.collections);
        mergeReport(combined, sub);
      }
      for (const e of parsed.environments ?? []) {
        const sub = importPostmanEnvironment(JSON.stringify(e), workspaceId);
        combined.environments.push(...sub.environments);
        mergeReport(combined, sub);
      }
      if (parsed.globals) {
        const sub = importPostmanGlobals(JSON.stringify(parsed.globals));
        combined.globals.push(...sub.globals);
        mergeReport(combined, sub);
      }
      combined.report.finishedAt = now();
      return combined;
    }
    case 'openapi': case 'swagger': return openApiToCollection(content, workspaceId);
    case 'wsdl': return wsdlToCollection(content, workspaceId, fileName);
    case 'soapui': return importSoapUiProject(content, workspaceId);
    case 'insomnia': return importInsomnia(content, workspaceId);
    case 'hoppscotch': return importHoppscotch(content, workspaceId);
    case 'thunder': return importThunder(content, workspaceId);
    case 'curl': {
      const out = emptyImport('curl');
      const { request, warnings } = parseCurl(content);
      const req = freshRequest(workspaceId, request.name ?? 'Imported cURL');
      Object.assign(req, request, { id: req.id, workspaceId });
      req.settings = { ...freshRequest(workspaceId, '').settings, ...(request.settings ?? {}) } as typeof req.settings;
      out.requests.push(req);
      out.report.warnings.push(...warnings);
      out.report.imported.push({ kind: 'request', name: req.name, id: req.id });
      out.report.finishedAt = now();
      return out;
    }
    case 'raw-http': return importRawHttp(content, workspaceId);
    case 'dotenv': {
      const out = emptyImport('dotenv');
      out.environments.push({
        id: uid(), workspaceId, name: fileName?.replace(/\.env$/, '') || 'Imported .env',
        variables: parseDotEnv(content), sortOrder: 0, createdAt: now(), updatedAt: now(),
      });
      out.report.imported.push({ kind: 'environment', name: fileName ?? '.env', id: 'env' });
      out.report.finishedAt = now();
      return out;
    }
    case 'graphql-schema': case 'protobuf': case 'smithy': case 'asyncapi': case 'json': case 'yaml': {
      const out = emptyImport(detected);
      out.specifications.push({
        id: uid(), workspaceId, name: fileName ?? `import-${uid().slice(0, 8)}`,
        format: detected === 'json' || detected === 'yaml' ? 'openapi3' : (detected === 'graphql-schema' ? 'graphql' : detected) as never,
        content, lifecycle: 'Draft', createdAt: now(), updatedAt: now(),
      });
      out.report.imported.push({ kind: 'specification', name: fileName ?? detected, id: 'spec' });
      out.report.finishedAt = now();
      return out;
    }
    default: {
      const out = emptyImport(detected);
      out.report.warnings.push(`Importer for format "${detected}" is not available.`);
      return out;
    }
  }
}

function mergeReport(into: NormalizedImport, from: NormalizedImport): void {
  const a = into.report, b = from.report;
  a.imported.push(...b.imported);
  a.converted.push(...b.converted);
  a.skipped.push(...b.skipped);
  a.unsupported.push(...b.unsupported);
  a.warnings.push(...b.warnings);
  a.secretsDetected.push(...b.secretsDetected);
  a.filesMissing.push(...b.filesMissing);
  a.scriptsRequiringReview.push(...b.scriptsRequiringReview);
}

export function toImportResult(n: NormalizedImport): ImportResult {
  return {
    report: n.report,
    collectionIds: n.collections.map((c) => c.collection.id),
    environmentIds: n.environments.map((e) => e.id),
    specIds: n.specifications.map((s) => s.id),
    requestIds: [...n.requests.map((r) => r.id), ...n.collections.flatMap((c) => c.requests.map((r) => r.id))],
  };
}
