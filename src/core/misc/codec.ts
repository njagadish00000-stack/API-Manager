/** Cross-platform base64 / hex helpers (pure JS fallbacks, no Node imports). */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : NaN, b2 = i + 2 < bytes.length ? bytes[i + 2] : NaN;
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (isNaN(b1) ? 0 : b1 >> 4)];
    out += isNaN(b1) ? '=' : B64[((b1 & 15) << 2) | (isNaN(b2) ? 0 : b2 >> 6)];
    out += isNaN(b2) ? '=' : B64[b2 & 63];
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = clean.length;
  const out = new Uint8Array(Math.floor(len * 3 / 4));
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64.indexOf(clean[i]), c1 = B64.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] === '=' ? 0 : B64.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === '=' ? 0 : B64.indexOf(clean[i + 3]);
    out[p++] = (c0 << 2) | (c1 >> 4);
    if (clean[i + 2] !== '=') out[p++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (clean[i + 3] !== '=') out[p++] = ((c2 & 3) << 6) | c3;
  }
  return out.slice(0, p);
}

export function utf8ToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function textToBase64(text: string): string { return bytesToBase64(utf8ToBytes(text)); }
export function base64ToText(b64: string): string { return bytesToUtf8(base64ToBytes(b64)); }

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** base64url */
export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function base64UrlDecode(s: string): Uint8Array {
  return base64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/'));
}

export function looksLikeBase64(s: string): boolean {
  return /^[A-Za-z0-9+/=\r\n]+$/.test(s) && s.length % 4 === 0;
}

/** Detect whether bytes are probably binary (contain NUL or many control chars). */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  let control = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 7 || (b > 13 && b < 32)) control++;
  }
  return n > 0 && control / n > 0.05;
}
