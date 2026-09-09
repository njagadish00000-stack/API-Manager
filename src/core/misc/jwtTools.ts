/** JWT decode/inspect utilities (§26). Decoding is unverified by design. */
import { base64UrlDecode, bytesToUtf8 } from './codec';

export interface JwtInspection {
  header?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  signature?: string;
  valid: boolean;
  error?: string;
  issuedAt?: string;
  expiresAt?: string;
  notBefore?: string;
  expired?: boolean;
  secondsRemaining?: number;
  claims: { name: string; value: string }[];
}

export function inspectJwt(token: string): JwtInspection {
  const t = token.trim().replace(/^Bearer\s+/i, '');
  const parts = t.split('.');
  if (parts.length !== 3) return { valid: false, error: 'Not a compact JWT (expected 3 parts)', claims: [] };
  try {
    const header = JSON.parse(bytesToUtf8(base64UrlDecode(parts[0]))) as Record<string, unknown>;
    const payload = JSON.parse(bytesToUtf8(base64UrlDecode(parts[1]))) as Record<string, unknown>;
    const result: JwtInspection = { header, payload, signature: parts[2], valid: true, claims: [] };
    const toDate = (n: unknown) => (typeof n === 'number' ? new Date(n * 1000).toISOString() : undefined);
    result.issuedAt = toDate(payload.iat);
    result.expiresAt = toDate(payload.exp);
    result.notBefore = toDate(payload.nbf);
    if (typeof payload.exp === 'number') {
      const remaining = payload.exp - Math.floor(Date.now() / 1000);
      result.expired = remaining < 0;
      result.secondsRemaining = remaining;
    }
    for (const [k, v] of Object.entries(payload)) {
      result.claims.push({ name: k, value: typeof v === 'string' ? v : JSON.stringify(v) });
    }
    return result;
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : String(e), claims: [] };
  }
}
