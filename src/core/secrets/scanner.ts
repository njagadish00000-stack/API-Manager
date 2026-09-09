/**
 * Secret scanner (§70). Detects API keys, JWTs, passwords, tokens, private
 * keys, cloud credentials. Supports user-defined patterns (services-side).
 */
import type { SecurityFinding } from '../../shared/types';
import { maskSecret } from '../vars/resolver';
import { uid } from '../../shared/ids';

export interface SecretPattern {
  id: string;
  name: string;
  pattern: string;
  severity: SecurityFinding['severity'];
  builtin: boolean;
}

export const BUILTIN_PATTERNS: SecretPattern[] = [
  { id: 'aws-access-key', name: 'AWS Access Key ID', pattern: '\\b(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\\b', severity: 'Critical', builtin: true },
  { id: 'aws-secret-key', name: 'AWS Secret Access Key', pattern: '(?i)aws(.{0,20})?(secret|private)?(.{0,20})?[\'"][0-9a-zA-Z/+=]{40}[\'"]', severity: 'Critical', builtin: true },
  { id: 'gcp-api-key', name: 'Google API Key', pattern: '\\bAIza[0-9A-Za-z\\-_]{35}\\b', severity: 'High', builtin: true },
  { id: 'github-token', name: 'GitHub Token', pattern: '\\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{22,}\\b', severity: 'Critical', builtin: true },
  { id: 'gitlab-token', name: 'GitLab Token', pattern: '\\bglpat-[A-Za-z0-9\\-_]{20,}\\b', severity: 'Critical', builtin: true },
  { id: 'slack-token', name: 'Slack Token', pattern: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b', severity: 'High', builtin: true },
  { id: 'stripe-key', name: 'Stripe Key', pattern: '\\b(sk|pk)_(live|test)_[0-9a-zA-Z]{16,}\\b', severity: 'Critical', builtin: true },
  { id: 'twilio-key', name: 'Twilio API Key', pattern: '\\bSK[0-9a-fA-F]{32}\\b', severity: 'High', builtin: true },
  { id: 'sendgrid-key', name: 'SendGrid API Key', pattern: '\\bSG\\.[A-Za-z0-9_\\-]{22}\\.[A-Za-z0-9_\\-]{43}\\b', severity: 'Critical', builtin: true },
  { id: 'jwt', name: 'JSON Web Token', pattern: '\\beyJ[A-Za-z0-9_\\-=]{10,}\\.[A-Za-z0-9_\\-=]{10,}\\.[A-Za-z0-9_\\-+/=]{8,}\\b', severity: 'High', builtin: true },
  { id: 'private-key', name: 'Private Key', pattern: '-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----', severity: 'Critical', builtin: true },
  { id: 'bearer-token', name: 'Hardcoded Bearer Token', pattern: '(?i)authorization["\'\\s:=]+bearer\\s+[A-Za-z0-9_\\-.~+/]{20,}=*', severity: 'High', builtin: true },
  { id: 'basic-auth-inline', name: 'Inline Basic Auth', pattern: '[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s/@:]+:[^\\s/@]+@', severity: 'High', builtin: true },
  { id: 'password-field', name: 'Hardcoded Password', pattern: '(?i)(password|passwd|pwd)["\'\\s:=]{1,6}["\'][^"\'\\s]{6,}["\']', severity: 'Medium', builtin: true },
  { id: 'api-key-field', name: 'Hardcoded API Key', pattern: '(?i)(api[_-]?key|apikey|x-api-key|access[_-]?token|client[_-]?secret|auth[_-]?token|secret[_-]?key)["\'\\s:=]{1,6}["\'({]?[A-Za-z0-9_\\-.~+/]{16,}', severity: 'High', builtin: true },
  { id: 'azure-conn-string', name: 'Azure Connection String', pattern: 'DefaultEndpointsProtocol=https?;AccountName=[^;]+;AccountKey=[A-Za-z0-9+/=]{20,}', severity: 'Critical', builtin: true },
  { id: 'postgres-uri', name: 'Database URI with credentials', pattern: '(postgres|mysql|mongodb|redis)://[^\\s:@]+:[^\\s@]+@', severity: 'High', builtin: true },
  { id: 'npm-token', name: 'NPM Token', pattern: '\\bnpm_[A-Za-z0-9]{36}\\b', severity: 'High', builtin: true },
  { id: 'openai-key', name: 'OpenAI API Key', pattern: '\\bsk-[A-Za-z0-9_-]{20,}\\b', severity: 'High', builtin: true },
  { id: 'hex-secret-40', name: 'Possible hex secret', pattern: '(?i)(secret|token|key)["\'\\s:=]{1,6}["\'({]?[0-9a-f]{32,64}["\')]?', severity: 'Low', builtin: true },
];

export function scanTextForSecrets(text: string, location: string, customPatterns: SecretPattern[] = []): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const patterns = [...BUILTIN_PATTERNS, ...customPatterns];
  for (const p of patterns) {
    let re: RegExp;
    try { re = new RegExp(p.pattern, 'g'); } catch { continue; }
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 200) {
      const snippet = m[0];
      findings.push({
        id: uid(),
        severity: p.severity,
        category: p.name,
        message: `Possible secret detected (${p.name})`,
        location,
        snippet: maskSecret(snippet),
        recommendation: 'Move the value into the Secret Vault or an environment variable and reference it via {{variables}}.',
      });
      if (m[0] === '') re.lastIndex++;
    }
  }
  return findings;
}

/** Response-oriented checks (§69). */
export function scanResponseForIssues(
  response: { status: number; headers: { key: string; value: string }[]; bodyText?: string },
  url: string,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const h = (name: string) => response.headers.find((x) => x.key.toLowerCase() === name)?.value;
  const loc = `Response ${url}`;
  if (url.startsWith('http://')) {
    findings.push({ id: uid(), severity: 'High', category: 'Insecure Transport', message: 'Request/response over plaintext HTTP', location: loc, recommendation: 'Use HTTPS.' });
  }
  for (const [name, severity] of [['strict-transport-security', 'Low'], ['content-security-policy', 'Info'], ['x-content-type-options', 'Info'], ['x-frame-options', 'Info']] as const) {
    if (!h(name) && !url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
      findings.push({ id: uid(), severity: severity as SecurityFinding['severity'], category: 'Missing Security Header', message: `Response is missing ${name}`, location: loc });
    }
  }
  const server = h('server');
  if (server && /\d/.test(server)) {
    findings.push({ id: uid(), severity: 'Info', category: 'Information Disclosure', message: `Server header leaks version: ${server}`, location: loc });
  }
  const setCookies = response.headers.filter((x) => x.key.toLowerCase() === 'set-cookie').map((x) => x.value);
  for (const sc of setCookies) {
    const lower = sc.toLowerCase();
    const name = sc.split('=')[0];
    if (!lower.includes('httponly')) findings.push({ id: uid(), severity: 'Medium', category: 'Insecure Cookie', message: `Cookie "${name}" missing HttpOnly`, location: loc });
    if (!lower.includes('secure')) findings.push({ id: uid(), severity: 'Medium', category: 'Insecure Cookie', message: `Cookie "${name}" missing Secure`, location: loc });
    if (!lower.includes('samesite')) findings.push({ id: uid(), severity: 'Low', category: 'Insecure Cookie', message: `Cookie "${name}" missing SameSite`, location: loc });
  }
  if (response.bodyText) {
    const bodyFindings = scanTextForSecrets(response.bodyText.slice(0, 200_000), `${loc} body`);
    for (const f of bodyFindings) findings.push({ ...f, message: `${f.message} in response body` });
  }
  return findings;
}
