/** Governance rules evaluation (§71). */
import type { ApiRequest, Collection, GovernanceRule, Specification } from '../../shared/types';
import { scanTextForSecrets } from '../secrets/scanner';

export interface GovernanceViolation { message: string; location: string }
export interface RuleResult { rule: string; kind: GovernanceRule['kind']; passed: boolean; violations: GovernanceViolation[] }

export function evaluateRules(
  rules: GovernanceRule[],
  ctx: { collections: Collection[]; requests: ApiRequest[]; specs: Specification[] },
): RuleResult[] {
  const results: RuleResult[] = [];
  for (const rule of rules.filter((r) => r.enabled)) {
    const violations: GovernanceViolation[] = [];
    switch (rule.kind) {
      case 'https-required': {
        for (const r of ctx.requests) {
          if (r.url.startsWith('http://') && !r.url.startsWith('http://localhost') && !r.url.startsWith('http://127.0.0.1')) {
            violations.push({ message: `Request "${r.name}" uses plaintext HTTP`, location: r.url });
          }
        }
        break;
      }
      case 'auth-required': {
        for (const r of ctx.requests) {
          if ((!r.auth || r.auth.type === 'none') && !r.headers.some((h) => h.key.toLowerCase() === 'authorization')) {
            violations.push({ message: `Request "${r.name}" has no authentication`, location: r.url });
          }
        }
        break;
      }
      case 'no-hardcoded-secrets': {
        const report = scanTextForSecrets(JSON.stringify(ctx.requests.map((r) => ({ url: r.url, headers: r.headers, body: r.body.raw ?? '' }))), 'workspace requests');
        for (const f of report) violations.push({ message: f.message, location: f.location });
        break;
      }
      case 'response-time-threshold': {
        const threshold = Number(rule.config?.thresholdMs ?? 2000);
        for (const r of ctx.requests) {
          const results = r.assertions.filter((a) => a.type === 'responseTime');
          const enforced = results.some((a) => a.operator === 'lte' && Number(a.expected) <= threshold);
          if (!enforced) violations.push({ message: `Request "${r.name}" has no response-time assertion ≤ ${threshold}ms`, location: r.url });
        }
        break;
      }
      case 'documentation-required': {
        for (const r of ctx.requests) {
          if (!r.description?.trim() && !r.documentation?.trim()) violations.push({ message: `Request "${r.name}" lacks documentation`, location: r.url });
        }
        for (const c of ctx.collections) {
          if (!c.description?.trim()) violations.push({ message: `Collection "${c.name}" lacks a description`, location: c.name });
        }
        break;
      }
      case 'tests-required': {
        for (const r of ctx.requests) {
          if (!r.scripts.postResponse?.trim() && r.assertions.filter((a) => a.enabled).length === 0) {
            violations.push({ message: `Request "${r.name}" has no tests or assertions`, location: r.url });
          }
        }
        break;
      }
      case 'openapi-validation': {
        for (const s of ctx.specs) {
          if (s.format === 'openapi3' || s.format === 'swagger2') {
            // validation performed by spec module; here check it exists + has lifecycle
            if (s.lifecycle === 'Draft') violations.push({ message: `Spec "${s.name}" is still Draft`, location: s.name });
          }
        }
        break;
      }
      case 'naming-convention': {
        const pattern = rule.config?.pattern ?? '^[A-Za-z0-9][A-Za-z0-9 _-]{2,80}$';
        let re: RegExp;
        try { re = new RegExp(pattern); } catch { re = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,80}$/; }
        for (const r of ctx.requests) if (!re.test(r.name)) violations.push({ message: `Request name "${r.name}" violates convention ${pattern}`, location: r.url });
        break;
      }
    }
    results.push({ rule: rule.name, kind: rule.kind, passed: violations.length === 0, violations });
  }
  return results;
}

export function defaultRules(workspaceId?: string): GovernanceRule[] {
  const mk = (kind: GovernanceRule['kind'], name: string, config?: Record<string, string>): GovernanceRule =>
    ({ id: crypto.randomUUID(), workspaceId, name, kind, enabled: true, config });
  return [
    mk('https-required', 'HTTPS Required'),
    mk('auth-required', 'Authentication Required'),
    mk('no-hardcoded-secrets', 'No Hardcoded Secrets'),
    mk('response-time-threshold', 'Response Time Threshold', { thresholdMs: '2000' }),
    mk('documentation-required', 'Documentation Required'),
    mk('tests-required', 'Tests Required'),
    mk('naming-convention', 'Naming Convention'),
  ];
}
