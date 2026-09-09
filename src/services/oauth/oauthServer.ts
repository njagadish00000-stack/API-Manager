/**
 * OAuth2 flows (§auth): authorization code + PKCE with a local loopback
 * callback server, client credentials, password grant, refresh token,
 * and OpenID discovery (.well-known).
 */
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { request } from 'undici';
import type { OAuth2Config } from '../../shared/types';
import type { OAuthStartResult, OAuthTokens } from '../../shared/api';

const PENDING_STATES = new Map<string, { codeVerifier?: string; callbackUrl: string; resolveCode: (code: string) => void; rejectCode: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }>();

function generatePkce(method: 'S256' | 'plain' = 'S256'): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = method === 'S256'
    ? createHash('sha256').update(verifier).digest('base64url')
    : verifier;
  return { verifier, challenge };
}

export async function discoverEndpoints(url: string): Promise<{ authorizationEndpoint?: string; tokenEndpoint?: string; issuer?: string; raw?: string }> {
  const base = url.replace(/\/+$/, '');
  const candidates = base.includes('/.well-known/') ? [base] : [`${base}/.well-known/openid-configuration`];
  for (const candidate of candidates) {
    try {
      const res = await request(candidate, { method: 'GET', headers: { Accept: 'application/json' } });
      if (res.statusCode >= 300) continue;
      const body = await res.body.text();
      const parsed = JSON.parse(body) as {
        authorization_endpoint?: string; token_endpoint?: string; issuer?: string;
      };
      return {
        authorizationEndpoint: parsed.authorization_endpoint,
        tokenEndpoint: parsed.token_endpoint,
        issuer: parsed.issuer,
        raw: body,
      };
    } catch { /* try next */ }
  }
  throw new Error(`OIDC discovery failed for ${url}`);
}

/** Start a loopback callback listener + build the authorization URL. */
export async function startAuthorizationFlow(config: OAuth2Config): Promise<OAuthStartResult & { waitForCode: () => Promise<{ code: string; state: string }> }> {
  if (!config.authUrl) throw new Error('authUrl is required');
  const state = randomBytes(16).toString('base64url');
  const pkce = config.grantType === 'authorization_code_pkce' ? generatePkce(config.pkceMethod ?? 'S256') : undefined;

  const callbackUrl = config.callbackUrl?.trim() ? config.callbackUrl : `http://127.0.0.1:0/callback`;
  let port = 0;
  let waitForCode: () => Promise<{ code: string; state: string }> = () => Promise.reject(new Error('loopback callback not available'));

  let server: http.Server | undefined;
  const usingLoopback = /^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(callbackUrl);
  if (usingLoopback) {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const code = u.searchParams.get('code');
      const inState = u.searchParams.get('state');
      const err = u.searchParams.get('error');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const pending = inState ? PENDING_STATES.get(inState) : undefined;
      if (pending) {
        if (err) pending.rejectCode(new Error(`Authorization failed: ${err} ${u.searchParams.get('error_description') ?? ''}`));
        else if (code) pending.resolveCode(code);
        if (inState) PENDING_STATES.delete(inState);
      }
      res.end('<html><body style="font-family:sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column"><h1>Authorization received</h1><p>You can close this tab and return to API Manager.</p></body></html>');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : 0;

    waitForCode = () => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        PENDING_STATES.delete(state);
        reject(new Error('Timed out waiting for OAuth callback (180s)'));
      }, 180_000);
      PENDING_STATES.set(state, {
        codeVerifier: pkce?.verifier,
        callbackUrl,
        resolveCode: (code) => { clearTimeout(timeout); server?.close(); resolve({ code, state }); },
        rejectCode: (e) => { clearTimeout(timeout); server?.close(); reject(e); },
        timeout,
      });
    });
  }

  const finalCallback = usingLoopback ? `http://127.0.0.1:${port}/callback` : callbackUrl;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId ?? '',
    redirect_uri: finalCallback,
    state,
  });
  if (config.scope) params.set('scope', config.scope);
  if (config.nonce) params.set('nonce', config.nonce);
  if (config.audience) params.set('audience', config.audience);
  if (config.resource) params.set('resource', config.resource);
  if (pkce) {
    params.set('code_challenge', pkce.challenge);
    params.set('code_challenge_method', config.pkceMethod ?? 'S256');
  }
  const sep = config.authUrl.includes('?') ? '&' : '?';
  const authUrl = `${config.authUrl}${sep}${params.toString()}`;

  if (usingLoopback) {
    // register pending entry keyed off final state
    PENDING_STATES.set(state, {
      codeVerifier: pkce?.verifier,
      callbackUrl: finalCallback,
      resolveCode: () => undefined,
      rejectCode: () => undefined,
      timeout: setTimeout(() => PENDING_STATES.delete(state), 180_000),
    });
    waitForCode = () => new Promise((resolve, reject) => {
      const existing = PENDING_STATES.get(state)!;
      const timeout = setTimeout(() => { PENDING_STATES.delete(state); reject(new Error('OAuth callback timeout')); }, 180_000);
      PENDING_STATES.set(state, {
        ...existing,
        resolveCode: (code) => { clearTimeout(timeout); resolve({ code, state }); },
        rejectCode: (e) => { clearTimeout(timeout); reject(e); },
        timeout,
      });
    });
  }

  return { authUrl, state, callbackPort: port, waitForCode };
}

async function tokenRequest(config: OAuth2Config, body: Record<string, string>): Promise<OAuthTokens> {
  const tokenUrl = config.accessTokenUrl
    ?? (config.useDiscovery && config.discoveryUrl ? (await discoverEndpoints(config.discoveryUrl)).tokenEndpoint : undefined);
  if (!tokenUrl) throw new Error('token endpoint is required');
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const form = new URLSearchParams(body);
  if (config.clientAuth !== 'body' && config.clientId) {
    const creds = Buffer.from(`${config.clientId}:${config.clientSecret ?? ''}`).toString('base64');
    headers['Authorization'] = `Basic ${creds}`;
  } else {
    if (config.clientId) form.set('client_id', config.clientId);
    if (config.clientSecret) form.set('client_secret', config.clientSecret);
  }
  const res = await request(tokenUrl, { method: 'POST', headers, body: form.toString() });
  const text = await res.body.text();
  if (res.statusCode >= 300) throw new Error(`Token request failed (${res.statusCode}): ${text.slice(0, 500)}`);
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`Non-JSON token response: ${text.slice(0, 200)}`); }
  if (parsed.error) throw new Error(`OAuth error: ${parsed.error} ${parsed.error_description ?? ''}`);
  return {
    accessToken: String(parsed.access_token ?? ''),
    refreshToken: parsed.refresh_token ? String(parsed.refresh_token) : undefined,
    idToken: parsed.id_token ? String(parsed.id_token) : undefined,
    tokenType: parsed.token_type ? String(parsed.token_type) : undefined,
    expiresIn: parsed.expires_in ? Number(parsed.expires_in) : undefined,
    scope: parsed.scope ? String(parsed.scope) : undefined,
    raw: text,
  };
}

export async function exchangeCode(config: OAuth2Config, code: string, callbackUrl?: string, codeVerifier?: string): Promise<OAuthTokens> {
  const redirect = callbackUrl ?? config.callbackUrl ?? '';
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
  };
  if (!config.clientAuth || config.clientAuth === 'body') {
    if (config.clientId) body.client_id = config.clientId;
    if (config.clientSecret) body.client_secret = config.clientSecret;
  }
  if (codeVerifier) body.code_verifier = codeVerifier;
  return tokenRequest(config, body);
}

export async function clientCredentials(config: OAuth2Config): Promise<OAuthTokens> {
  const body: Record<string, string> = { grant_type: 'client_credentials' };
  if (config.clientAuth === 'body') {
    if (config.clientId) body.client_id = config.clientId;
    if (config.clientSecret) body.client_secret = config.clientSecret;
  }
  if (config.scope) body.scope = config.scope;
  if (config.audience) body.audience = config.audience;
  if (config.resource) body.resource = config.resource;
  return tokenRequest(config, body);
}

export async function passwordGrant(config: OAuth2Config): Promise<OAuthTokens> {
  if (!config.username) throw new Error('username required for password grant');
  const body: Record<string, string> = {
    grant_type: 'password',
    username: config.username,
    password: config.password ?? '',
  };
  if (config.clientAuth === 'body') {
    if (config.clientId) body.client_id = config.clientId;
    if (config.clientSecret) body.client_secret = config.clientSecret;
  }
  if (config.scope) body.scope = config.scope;
  return tokenRequest(config, body);
}

export async function refreshToken(config: OAuth2Config): Promise<OAuthTokens> {
  if (!config.refreshToken) throw new Error('refreshToken required');
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: config.refreshToken,
  };
  if (config.clientAuth === 'body') {
    if (config.clientId) body.client_id = config.clientId;
    if (config.clientSecret) body.client_secret = config.clientSecret;
  }
  return tokenRequest(config, body);
}
