/**
 * Normalized import model — all importers produce this; the storage layer
 * persists it. Guarantees importers stay pure and testable.
 */
import type {
  ApiRequest, Collection, Environment, Folder, MigrationReport, RequestExample, Specification, Variable,
} from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';

export interface NormalizedImport {
  collections: { collection: Collection; folders: Folder[]; requests: ApiRequest[]; examples: RequestExample[] }[];
  environments: Environment[];
  globals: Variable[];
  specifications: Specification[];
  requests: ApiRequest[]; // standalone requests (not in a collection)
  report: MigrationReport;
}

export function newReport(format: string): MigrationReport {
  return {
    format, startedAt: now(),
    imported: [], converted: [], skipped: [], unsupported: [],
    warnings: [], secretsDetected: [], filesMissing: [], scriptsRequiringReview: [],
  };
}

export function emptyImport(format: string): NormalizedImport {
  return { collections: [], environments: [], globals: [], specifications: [], requests: [], report: newReport(format) };
}

export function freshCollection(workspaceId: string, name: string): Collection {
  return {
    id: uid(), workspaceId, name, variables: [], auth: { type: 'none' },
    scripts: { preRequest: '', postResponse: '' }, tags: [], favorite: false, sortOrder: 0,
    createdAt: now(), updatedAt: now(),
  };
}

export function freshFolder(collectionId: string, name: string, parentFolderId?: string): Folder {
  return {
    id: uid(), collectionId, name, parentFolderId, auth: { type: 'none' },
    scripts: { preRequest: '', postResponse: '' }, sortOrder: 0, createdAt: now(), updatedAt: now(),
  };
}

export function freshRequest(workspaceId: string, name: string, collectionId?: string, folderId?: string): ApiRequest {
  return {
    id: uid(), workspaceId, collectionId, folderId, name, method: 'GET', url: '', protocol: 'http',
    pathParams: [], queryParams: [], headers: [], auth: { type: 'none' },
    body: { type: 'none' }, scripts: { preRequest: '', postResponse: '' }, assertions: [],
    settings: {
      timeoutMs: 30000, followRedirects: true, maxRedirects: 10, preserveAuthOnRedirect: true,
      stripSensitiveHeaders: true, retry: { enabled: false, maxRetries: 0, strategy: 'fixed', delayMs: 0, retryStatusCodes: [], retryOnNetworkError: false, retryOnTimeout: false, onlyIdempotent: false },
      httpVersion: 'auto', encodeUrl: true, verifyTls: true, storeResponse: true,
    },
    tags: [], favorite: false, sortOrder: 0, createdAt: now(), updatedAt: now(),
  };
}
