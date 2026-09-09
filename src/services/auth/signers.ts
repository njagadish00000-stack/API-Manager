/**
 * Authentication header computation (Node-side). Supports Basic, Bearer,
 * API key, Digest (RFC 7616), OAuth 1.0a (HMAC-SHA1/PLAINTEXT/RSA-SHA1),
 * JWT, AWS Signature V4, Hawk, NTLM (Type 1/3, NTLMv2).
 */
import { createHash, createHmac, randomBytes, createPrivateKey, sign as cryptoSign } from 'node:crypto';
import type { AuthConfig, Aws4AuthConfig, DigestAuthConfig, HawkAuthConfig, KeyValue, NtlmAuthConfig, OAuth1Config } from '../../shared/types';
import { utf8ToBytes, bytesToBase64, bytesToHex } from '../../core/misc/codec';

export interface SignedResult {
  headers: KeyValue[];
  query: KeyValue[];
  warnings: string[];
}

let kvId = 0;
const mk = (key: string, value: string): KeyValue => ({ id: `auth_${++kvId}`, key, value, enabled: true });

export function applyAuth(
  auth: AuthConfig,
  ctx: { method: string; url: string; body?: Buffer; existingHeaders: KeyValue[] },
): SignedResult {
  const headers: KeyValue[] = [];
  const query: KeyValue[] = [];
  const warnings: string[] = [];
  if (!auth || auth.type === 'none' || auth.type === 'inherit') return { headers, query, warnings };

  switch (auth.type) {
    case 'basic': {
      const b = auth.basic!;
      headers.push(mk('Authorization', `Basic ${bytesToBase64(utf8ToBytes(`${b.username}:${b.password}`))}`));
      break;
    }
    case 'bearer': {
      const b = auth.bearer!;
      if (b.token) headers.push(mk('Authorization', `${b.prefix ?? 'Bearer'} ${b.token}`));
      break;
    }
    case 'apikey': {
      const a = auth.apikey!;
      if (a.addTo === 'query') query.push(mk(a.key, a.value)); else headers.push(mk(a.key, a.value));
      break;
    }
    case 'digest': {
      // Initial request sends nothing extra; engine retries after 401 with computeDigestAuthorization.
      break;
    }
    case 'oauth1': {
      const { headerAuth, queryAuth } = signOAuth1(auth.oauth1!, ctx);
      if (auth.oauth1!.addTo === 'query') query.push(...queryAuth.map(([k, v]) => mk(k, v)));
      else headers.push(mk('Authorization', headerAuth));
      break;
    }
    case 'oauth2': {
      const o = auth.oauth2!;
      if (o.accessToken) {
        const value = `${o.headerPrefix ?? 'Bearer'} ${o.accessToken}`;
        if (o.addTo === 'query') query.push(mk('access_token', o.accessToken)); else headers.push(mk('Authorization', value));
      }
      break;
    }
    case 'jwt': {
      const j = auth.jwt!;
      const token = j.token ?? (j.secret ? signJwtSync(j.header, j.payload, j.secret, j.algorithm ?? 'HS256', warnings) : '');
      if (!token) warnings.push('JWT auth configured without token or secret.');
      const prefix = j.headerPrefix ?? 'Bearer';
      if (j.addTo === 'query') query.push(mk(j.headerPrefix ?? 'token', token));
      else if (j.addTo === 'variable') { /* engine stores it */ }
      else headers.push(mk('Authorization', `${prefix} ${token}`));
      break;
    }
    case 'aws4': {
      const signed = signAwsV4(auth.aws4!, ctx);
      for (const [k, v] of Object.entries(signed)) {
        if (k === 'Authorization') headers.push(mk(k, v));
      }
      if (auth.aws4!.addTo === 'query') {
        for (const [k, v] of Object.entries(signed)) if (k !== 'Authorization') query.push(mk(k, v));
      } else {
        for (const [k, v] of Object.entries(signed)) if (k !== 'Authorization') headers.push(mk(k, v));
      }
      break;
    }
    case 'hawk': {
      const h = auth.hawk!;
      headers.push(mk('Authorization', hawkAuthorization(h, ctx)));
      break;
    }
    case 'ntlm': {
      // Handshake handled by engine via ntlm.ts
      break;
    }
    case 'custom': {
      const c = auth.custom!;
      if (c.headerName && c.expression) headers.push(mk(c.headerName, c.expression));
      if (c.queryName && c.expression) query.push(mk(c.queryName, c.expression));
      break;
    }
  }
  return { headers, query, warnings };
}

// ---------------------------------------------------------------------------
// Digest (RFC 7616)
// ---------------------------------------------------------------------------

export function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = header.match(/^\s*Digest\s+(.*)$/i);
  if (!m) return out;
  const re = /([a-zA-Z]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[1])) !== null) out[mm[1].toLowerCase()] = mm[2] !== undefined ? mm[2].replace(/\\"/g, '"') : mm[3];
  return out;
}

export function computeDigestAuthorization(
  cfg: DigestAuthConfig,
  challenge: Record<string, string>,
  ctx: { method: string; uri: string; body?: Buffer },
): string {
  const realm = challenge.realm ?? cfg.realm ?? '';
  const nonce = challenge.nonce ?? cfg.nonce ?? '';
  const opaque = challenge.opaque ?? cfg.opaque;
  const algorithm = (challenge.algorithm ?? cfg.algorithm ?? 'MD5').toUpperCase();
  const qopList = (challenge.qop ?? '').split(',').map((s) => s.trim());
  const qop = qopList.includes('auth') ? 'auth' : qopList.includes('auth-int') ? 'auth-int' : (cfg.qop ?? (qopList[0] || undefined));
  const nc = cfg.nc ?? '00000001';
  const cnonce = cfg.cnonce ?? randomBytes(8).toString('hex');

  const hashAlg = algorithm.startsWith('SHA-512-256') ? 'sha512-256' : algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const H = (s: string | Buffer) => createHash(hashAlg).update(s).digest('hex');
  const sess = algorithm.endsWith('-sess');
  const a1 = sess
    ? `${H(`${cfg.username}:${realm}:${cfg.password}`)}:${nonce}:${cnonce}`
    : `${cfg.username}:${realm}:${cfg.password}`;
  const ha1 = H(a1);
  const a2 = qop === 'auth-int'
    ? `${ctx.method}:${ctx.uri}:${H(ctx.body ?? Buffer.alloc(0))}`
    : `${ctx.method}:${ctx.uri}`;
  const ha2 = H(a2);
  const response = qop
    ? H(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : H(`${ha1}:${nonce}:${ha2}`);

  const parts: string[] = [
    `username="${cfg.username}"`, `realm="${realm}"`, `nonce="${nonce}"`,
    `uri="${ctx.uri}"`, `response="${response}"`,
  ];
  if (opaque) parts.push(`opaque="${opaque}"`);
  parts.push(`algorithm=${algorithm}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// OAuth 1.0a
// ---------------------------------------------------------------------------

function pct(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function signOAuth1(o: OAuth1Config, ctx: { method: string; url: string; existingHeaders: KeyValue[]; bodyParams?: [string, string][] }): { headerAuth: string; queryAuth: [string, string][] } {
  const u = new URL(ctx.url);
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const params: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) params.push([k, v]);
  // urlencoded body params count toward signature
  const ct = ctx.existingHeaders.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  if (ct.includes('application/x-www-form-urlencoded') && ctx.bodyParams) params.push(...ctx.bodyParams);

  const oauthParams: [string, string][] = [
    ['oauth_consumer_key', o.consumerKey],
    ['oauth_nonce', o.nonce ?? randomBytes(16).toString('hex')],
    ['oauth_signature_method', o.signatureMethod],
    ['oauth_timestamp', o.timestamp ?? Math.floor(Date.now() / 1000).toString()],
    ['oauth_version', o.version ?? '1.0'],
  ];
  if (o.token) oauthParams.push(['oauth_token', o.token]);
  if (o.callback) oauthParams.push(['oauth_callback', o.callback]);
  if (o.verifier) oauthParams.push(['oauth_verifier', o.verifier]);

  const all = [...params, ...oauthParams.filter(([k]) => k !== 'oauth_signature')];
  all.sort((a, b) => pct(a[0]) === pct(b[0]) ? (pct(a[1]) < pct(b[1]) ? -1 : 1) : (pct(a[0]) < pct(b[0]) ? -1 : 1));
  const paramString = all.map(([k, v]) => `${pct(k)}=${pct(v)}`).join('&');
  const baseString = `${ctx.method.toUpperCase()}&${pct(baseUrl)}&${pct(paramString)}`;
  const signingKey = `${pct(o.consumerSecret)}&${pct(o.tokenSecret ?? '')}`;

  let signature: string;
  if (o.signatureMethod === 'PLAINTEXT') signature = signingKey;
  else if (o.signatureMethod === 'RSA-SHA1') {
    signature = cryptoSign('RSA-SHA1', utf8ToBytes(baseString), createPrivateKey(o.consumerSecret)).toString('base64');
  } else {
    signature = createHmac('sha1', signingKey).update(baseString).digest('base64');
  }
  const withSig: [string, string][] = [...oauthParams, ['oauth_signature', signature]];
  const headerAuth = `OAuth ${withSig.map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ')}`;
  return { headerAuth, queryAuth: withSig };
}

// ---------------------------------------------------------------------------
// JWT (HS*)
// ---------------------------------------------------------------------------

function b64url(s: string | Buffer): string {
  return bytesToBase64(typeof s === 'string' ? utf8ToBytes(s) : s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function signJwtSync(headerJson: string | undefined, payloadJson: string | undefined, secret: string, algorithm: string, warnings: string[]): string {
  let header = { alg: algorithm, typ: 'JWT' };
  try { if (headerJson) header = { ...header, ...JSON.parse(headerJson) }; } catch { warnings.push('JWT header JSON invalid; using default.'); }
  let payload = '{}';
  try { JSON.parse(payloadJson ?? '{}'); payload = payloadJson ?? '{}'; } catch { warnings.push('JWT payload JSON invalid; using empty object.'); }
  const algMap: Record<string, string> = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
  const hs = algMap[algorithm];
  if (!hs) { warnings.push(`JWT algorithm ${algorithm} not supported for local signing (use HS256/384/512).`); return ''; }
  const data = `${b64url(JSON.stringify(header))}.${b64url(payload)}`;
  return `${data}.${b64url(createHmac(hs, secret).update(data).digest())}`;
}

// ---------------------------------------------------------------------------
// AWS Signature V4
// ---------------------------------------------------------------------------

export function signAwsV4(cfg: Aws4AuthConfig, ctx: { method: string; url: string; body?: Buffer; existingHeaders: KeyValue[] }): Record<string, string> {
  const u = new URL(ctx.url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash('sha256').update(ctx.body ?? Buffer.alloc(0)).digest('hex');

  const headers: Record<string, string> = { host: u.host };
  for (const h of ctx.existingHeaders) if (h.enabled) headers[h.key.toLowerCase()] = h.value;
  headers['x-amz-date'] = amzDate;
  if (cfg.sessionToken) headers['x-amz-security-token'] = cfg.sessionToken;
  headers['x-amz-content-sha256'] = payloadHash;

  if (cfg.addTo === 'query') {
    const credential = `${cfg.accessKey}/${dateStamp}/${cfg.region}/${cfg.service}/aws4_request`;
    const qp = new URLSearchParams(u.searchParams);
    qp.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256-CREDENTIAL');
    qp.set('X-Amz-Credential', credential);
    qp.set('X-Amz-Date', amzDate);
    qp.set('X-Amz-SignedHeaders', 'host');
    if (cfg.sessionToken) qp.set('X-Amz-Security-Token', cfg.sessionToken);
    const canonicalRequest = [ctx.method.toUpperCase(), u.pathname, canonicalQuery(qp), `host:${u.host}\n`, 'host', payloadHash].join('\n');
    const sig = awsSignature(cfg.secretKey, dateStamp, cfg.region, cfg.service, canonicalRequest);
    qp.set('X-Amz-Signature', sig);
    return Object.fromEntries(qp.entries());
  }

  const signedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderKeys.map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const canonicalRequest = [
    ctx.method.toUpperCase(), u.pathname || '/', canonicalQuery(u.searchParams),
    canonicalHeaders, signedHeaderKeys.join(';'), payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${cfg.region}/${cfg.service}/aws4_request`;
  const signature = awsSignature(cfg.secretKey, dateStamp, cfg.region, cfg.service, canonicalRequest);
  return {
    'X-Amz-Date': amzDate,
    ...(cfg.sessionToken ? { 'X-Amz-Security-Token': cfg.sessionToken } : {}),
    ...(cfg.service === 's3' ? { 'x-amz-content-sha256': payloadHash } : {}),
    Authorization: `AWS4-HMAC-SHA256-CREDENTIAL Credential=${cfg.accessKey}/${credentialScope}, SignedHeaders=${signedHeaderKeys.join(';')}, Signature=${signature}`,
  };
}

function canonicalQuery(sp: URLSearchParams): string {
  const pairs = Array.from(sp.entries()).map(([k, v]) => [pct(k), pct(v)] as const);
  pairs.sort();
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function awsSignature(secret: string, date: string, region: string, service: string, canonicalRequest: string): string {
  const stringToSign = `AWS4-HMAC-SHA256-REQUEST\n${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}\n${date}/${region}/${service}/aws4_request\n${createHash('sha256').update(canonicalRequest).digest('hex')}`;
  const kDate = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  const kRegion = createHmac('sha256', kDate).update(region).digest();
  const kService = createHmac('sha256', kRegion).update(service).digest();
  const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
  return createHmac('sha256', kSigning).update(stringToSign).digest('hex');
}

// ---------------------------------------------------------------------------
// Hawk
// ---------------------------------------------------------------------------

export function hawkAuthorization(h: HawkAuthConfig, ctx: { method: string; url: string; body?: Buffer; contentType?: string }): string {
  const u = new URL(ctx.url);
  const ts = h.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = h.nonce ?? randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  let payloadHash = '';
  if (ctx.body && ctx.body.length > 0) {
    const ct = (ctx.contentType ?? '').split(';')[0].trim();
    const payloadString = `hawk.1.payload\n${ct}\n${ctx.body.toString('utf8')}\n`;
    payloadHash = createHash(h.algorithm).update(payloadString).digest('base64');
  }
  const macBaseString = [
    'hawk.1.header', ts, nonce, ctx.method.toUpperCase(), u.pathname + u.search,
    u.hostname, u.port || (u.protocol === 'https:' ? '443' : '80'), payloadHash, h.ext ?? '', '', '',
  ].join('\n') + '\n';
  const mac = createHmac(h.algorithm, h.authKey).update(macBaseString).digest('base64');
  const parts = [`id="${h.authId}"`, `ts="${ts}"`, `nonce="${nonce}"`, `mac="${mac}"`];
  if (payloadHash) parts.push(`hash="${payloadHash}"`);
  if (h.ext) parts.push(`ext="${h.ext}"`);
  if (h.app) parts.push(`app="${h.app}"`);
  if (h.dlg) parts.push(`dlg="${h.dlg}"`);
  return `Hawk ${parts.join(', ')}`;
}

// ---------------------------------------------------------------------------
// NTLM (NTLMv2 Type1/Type3) — pure-JS where OpenSSL algorithms are missing.
// ---------------------------------------------------------------------------

// Minimal MD4 implementation (not available in OpenSSL 3 providers).
export function md4(data: Buffer | string): Buffer {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const msg: number[] = Array.from(buf);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 0; i < 8; i++) msg.push((bitLen >>> (i * 8)) & 0xff);

  let A = 0x67452301, B = 0xefcdab89, C = 0x98badcfe, D = 0x10325476;
  const rol = (x: number, s: number) => ((x << s) | (x >>> (32 - s))) >>> 0;
  for (let i = 0; i < msg.length; i += 64) {
    const X: number[] = [];
    for (let j = 0; j < 16; j++) X[j] = msg[i + j * 4] | (msg[i + j * 4 + 1] << 8) | (msg[i + j * 4 + 2] << 16) | (msg[i + j * 4 + 3] << 24);
    let a = A, b = B, c = C, d = D;
    const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
    const Gf = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
    const Hf = (x: number, y: number, z: number) => x ^ y ^ z;
    const r1 = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
    const r2 = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15];
    const r3 = [0, 2, 1, 3, 4, 6, 5, 7, 8, 10, 9, 11, 12, 14, 13, 15];
    for (let j = 0; j < 16; j++) {
      const rot = [3, 7, 11, 19][j % 4];
      const tmp = rol((a + F(b, c, d) + X[r1[j]]) >>> 0, rot);
      a = d; d = c; c = b; b = tmp;
    }
    for (let j = 0; j < 16; j++) {
      const rot = [3, 5, 9, 13][j % 4];
      const tmp = rol((a + Gf(b, c, d) + X[r2[j]] + 0x5a827999) >>> 0, rot);
      a = d; d = c; c = b; b = tmp;
    }
    for (let j = 0; j < 16; j++) {
      const rot = [3, 9, 11, 15][j % 4];
      const tmp = rol((a + Hf(b, c, d) + X[r3[j]] + 0x6ed9eba1) >>> 0, rot);
      a = d; d = c; c = b; b = tmp;
    }
    A = (A + a) >>> 0; B = (B + b) >>> 0; C = (C + c) >>> 0; D = (D + d) >>> 0;
  }
  const out = Buffer.alloc(16);
  out.writeUInt32LE(A, 0); out.writeUInt32LE(B, 4); out.writeUInt32LE(C, 8); out.writeUInt32LE(D, 12);
  return out;
}

const NEGOTIATE_FLAGS = 0x00000200 | 0x00000800 | 0x00080000 | 0x00004000 | 0x00000200 | 0x02000000 | 0x00000010 | 0x00000001;

export function ntlmType1(cfg: NtlmAuthConfig): Buffer {
  const domain = cfg.domain ?? '';
  const workstation = cfg.workstation ?? 'WORKSTATION';
  const domainBuf = Buffer.from(domain, 'ascii');
  const wsBuf = Buffer.from(workstation, 'ascii');
  const headerSize = 32;
  const buf = Buffer.alloc(headerSize + domainBuf.length + wsBuf.length);
  buf.write('NTLMSSP\0', 0, 'ascii');
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(NEGOTIATE_FLAGS, 12);
  buf.writeUInt16LE(domainBuf.length, 16); buf.writeUInt16LE(domainBuf.length, 18); buf.writeUInt32LE(headerSize, 20);
  buf.writeUInt16LE(wsBuf.length, 24); buf.writeUInt16LE(wsBuf.length, 26); buf.writeUInt32LE(headerSize + domainBuf.length, 28);
  domainBuf.copy(buf, headerSize);
  wsBuf.copy(buf, headerSize + domainBuf.length);
  return buf;
}

export interface NtlmChallenge { targetName: Buffer; serverChallenge: Buffer; targetInfo: Buffer; flags: number; }

export function ntlmParseType2(msg: Buffer): NtlmChallenge {
  if (msg.toString('ascii', 0, 7) !== 'NTLMSSP' || msg.readUInt32LE(8) !== 2) throw new Error('Not an NTLM Type 2 message');
  const readField = (off: number) => {
    const len = msg.readUInt16LE(off);
    const pos = msg.readUInt32LE(off + 4);
    return msg.subarray(pos, pos + len);
  };
  return {
    targetName: readField(12),
    flags: msg.readUInt32LE(20),
    serverChallenge: msg.subarray(24, 32),
    targetInfo: msg.length > 48 ? readField(40) : Buffer.alloc(0),
  };
}

export function ntlmType3(cfg: NtlmAuthConfig, challenge: NtlmChallenge): Buffer {
  const ntHash = md4(Buffer.from(cfg.password, 'utf16le'));
  const userUpper = cfg.username.toUpperCase();
  const identity = Buffer.from(userUpper + (cfg.domain ?? ''), 'utf16le');
  const ntlmV2Hash = createHmac('md5', ntHash).update(identity).digest();

  // client challenge + blob
  const clientChallenge = randomBytes(8);
  const timestamp = Buffer.alloc(8);
  const ntTime = (BigInt(Math.floor(Date.now() / 1000)) + 11644473600n) * 10000000n;
  timestamp.writeBigUInt64LE(ntTime);
  const blob = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]), timestamp, clientChallenge,
    Buffer.alloc(4), challenge.targetInfo, Buffer.alloc(4),
  ]);
  const ntProof = createHmac('md5', ntlmV2Hash).update(Buffer.concat([challenge.serverChallenge, blob])).digest();
  const ntResponse = Buffer.concat([ntProof, blob]);
  // LMv2
  const lmClient = randomBytes(8);
  const lmResponse = Buffer.concat([createHmac('md5', ntlmV2Hash).update(Buffer.concat([challenge.serverChallenge, lmClient])).digest(), lmClient]);

  const domain = Buffer.from(cfg.domain ?? '', 'utf16le');
  const user = Buffer.from(cfg.username, 'utf16le');
  const ws = Buffer.from(cfg.workstation ?? 'WORKSTATION', 'utf16le');
  const sessionKey = randomBytes(16);

  const headerSize = 72;
  const fields: Buffer[] = [lmResponse, ntResponse, domain, user, ws, sessionKey];
  const buf = Buffer.alloc(headerSize + fields.reduce((s, f) => s + f.length, 0));
  buf.write('NTLMSSP\0', 0, 'ascii');
  buf.writeUInt32LE(3, 8);
  let offset = headerSize;
  let fieldOff = 12;
  for (const f of fields) {
    buf.writeUInt16LE(f.length, fieldOff); buf.writeUInt16LE(f.length, fieldOff + 2); buf.writeUInt32LE(offset, fieldOff + 4);
    f.copy(buf, offset);
    offset += f.length; fieldOff += 8;
  }
  buf.writeUInt32LE(NEGOTIATE_FLAGS, 60);
  buf.write('6.1.0.0', 64, 'ascii'); // version
  return buf;
}

export function ntlmDecodeHeader(header: string): Buffer | null {
  const m = header.match(/NTLM\s+([A-Za-z0-9+/=]+)/i);
  if (!m) return null;
  return Buffer.from(m[1], 'base64');
}

export { bytesToHex };
