/**
 * Security service: workspace / text / response scanning (§secrets),
 * governance-rule evaluation (§governance dashboard), project-trust checks
 * (untrusted project flag), and assertion-rule aggregations for the red team
 * dashboard. Secret masking in all outputs.
 */
import type { ApiRequest, GovernanceRule, SecurityFinding } from '../../shared/types';
import { scanTextForSecrets, scanResponseForIssues, SecretPattern } from '../../core/secrets/scanner';
import { evaluateRules } from '../../core/governance/governance';

export interface SecurityDeps {
  listRequests: (workspaceId?: string) => ApiRequest[];
  listPatterns: () => SecretPattern[];
  listRules: (workspaceId?: string) => GovernanceRule[];
  untrustedProjectsEnabled: () => boolean;
  audit: (action: string, detail?: string) => void;
}

export function scanWorkspace(workspaceId: string | undefined, deps: SecurityDeps): SecurityFinding[] {
  const requests = deps.listRequests(workspaceId);
  const patterns = deps.listPatterns();
  const findings: SecurityFinding[] = [];
  for (const req of requests) {
    const text = [
      req.url,
      ...req.headers.map((h) => `${h.key}: ${h.value}`),
      req.body.raw ?? '',
      ...(req.body.urlencoded ?? []).map((p) => `${p.key}=${p.value}`),
      ...(req.body.formData ?? []).map((p) => `${p.key}=${p.value}`),
      JSON.stringify(req.auth),
      req.scripts.preRequest, req.scripts.postResponse,
    ].join('\n');
    const hits = scanTextForSecrets(text, `request:${req.name} (${req.id})`, patterns);
    findings.push(...hits);
    if (req.url.startsWith('http://') && !req.url.includes('localhost') && !req.url.includes('127.0.0.1')) {
      findings.push({
        id: `insecure-${req.id}`, severity: 'Medium', category: 'insecure-transport',
        message: `Request "${req.name}" uses plain HTTP`, location: `request:${req.name}`,
        snippet: req.url.slice(0, 80), recommendation: 'Use HTTPS where possible.',
      });
    }
  }
  return findings;
}

export function scanText(text: string, location: string | undefined, deps: SecurityDeps): SecurityFinding[] {
  return scanTextForSecrets(text, location ?? 'ad-hoc', deps.listPatterns());
}

export function scanResponse(response: { status: number; headers: { key: string; value: string }[]; bodyText?: string; url?: string }, deps: SecurityDeps): SecurityFinding[] {
  const findings = scanResponseForIssues({
    status: response.status,
    headers: response.headers.map((h) => ({ key: h.key, value: h.value })),
    bodyText: response.bodyText,
  }, response.url ?? 'unknown');
  findings.push(...scanTextForSecrets(response.bodyText ?? '', 'response body', deps.listPatterns()).slice(0, 25));
  return findings;
}

export function evaluateWorkspaceRules(workspaceId: string | undefined, deps: SecurityDeps & { listCollections: () => { description?: string }[]; listSpecs: () => { format: string; lifecycle?: string; name: string }[] }): { passed: number; failed: number; findings: SecurityFinding[] } {
  const rules = deps.listRules(workspaceId).filter((r) => r.enabled);
  const requests = deps.listRequests(workspaceId);
  const ruleResults = evaluateRules(rules, { collections: deps.listCollections() as never, requests, specs: deps.listSpecs() as never });
  const findings: SecurityFinding[] = [];
  let passed = 0;
  let failed = 0;
  for (const rr of ruleResults) {
    if (rr.passed) { passed++; continue; }
    failed++;
    for (const v of rr.violations) {
      findings.push({
        id: `${rr.kind}:${v.location}`.slice(0, 120), severity: 'Low', category: `governance:${rr.kind}`,
        message: v.message, location: v.location, recommendation: rr.rule,
      });
    }
  }
  return { passed, failed, findings };
}

/**
 * Project trust: warns when a workspace/collection has scripts or config
 * from an untrusted source (imported but not yet trusted).
 */
export function assessProjectTrust(meta: { importedFrom?: string; importedAt?: string; scriptsCount: number }, deps: SecurityDeps): { trusted: boolean; reasons: string[] } {
  if (!deps.untrustedProjectsEnabled()) return { trusted: true, reasons: [] };
  const reasons: string[] = [];
  if (meta.importedFrom) reasons.push(`Imported from: ${meta.importedFrom}`);
  if (meta.scriptsCount > 0) reasons.push(`Contains ${meta.scriptsCount} script(s) that run on send`);
  return { trusted: reasons.length === 0, reasons };
}

export function maskSecret(value: string): string {
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 2)}•••${value.slice(-2)}`;
}

export function ruleTemplates(): { kind: GovernanceRule['kind']; label: string; defaultConfig?: Record<string, string> }[] {
  return [
    { kind: 'https-required', label: 'require HTTPS for all requests' },
    { kind: 'auth-required', label: 'require authentication on requests' },
    { kind: 'no-hardcoded-secrets', label: 'block hardcoded secrets' },
    { kind: 'response-time-threshold', label: 'response time threshold', defaultConfig: { maxMs: '2000' } },
    { kind: 'documentation-required', label: 'documentation required on collections' },
    { kind: 'tests-required', label: 'require tests on requests' },
    { kind: 'openapi-validation', label: 'validate against OpenAPI contract' },
    { kind: 'naming-convention', label: 'request naming convention', defaultConfig: { pattern: '^[A-Z][A-Za-z0-9 ]*$' } },
  ];
}
