/** ID generation usable in both Node and the browser without deps. */

export function uid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback (should not happen on Node >= 19 / modern browsers)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function shortId(size = 8): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const bytes = new Uint8Array(size);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < size; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < size; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function opId(): string { return `op_${shortId(12)}`; }
