/** Utility converters exposed in the Response Utilities panel (§26). */
import { textToBase64, base64ToText, bytesToHex, hexToBytes } from './codec';
import { inspectJwt } from './jwtTools';

export function urlEncode(s: string): string { return encodeURIComponent(s); }
export function urlDecode(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }
export function base64Encode(s: string): string { return textToBase64(s); }
export function base64Decode(s: string): string { return base64ToText(s.replace(/\s+/g, '')); }

export function timestampToIso(ts: string): string | null {
  const n = Number(ts);
  if (Number.isNaN(n)) {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // seconds vs milliseconds heuristic
  if (n > 1e15) return new Date(n / 1000).toISOString(); // microseconds
  if (n > 1e12) return new Date(n).toISOString();
  return new Date(n * 1000).toISOString();
}

export function isoToTimestamp(iso: string): number | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

export function generateUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function regexTest(pattern: string, text: string, flags = 'gm'): { ok: boolean; matches: { match: string; index: number; groups?: Record<string, string> }[]; error?: string } {
  try {
    const re = new RegExp(pattern, flags);
    const matches: { match: string; index: number; groups?: Record<string, string> }[] = [];
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = re.exec(text)) !== null && guard++ < 1000) {
      matches.push({ match: m[0], index: m.index, groups: m.groups });
      if (!re.global) break;
      if (m[0] === '') re.lastIndex++;
    }
    return { ok: true, matches };
  } catch (e) {
    return { ok: false, matches: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export { inspectJwt, bytesToHex, hexToBytes };
