/**
 * Protocol pages: unified Sessions console (WebSocket / SSE / MQTT / gRPC / Socket.IO),
 * OAuth helper (PKCE + grants), MCP client, AI assistant.
 */
import React, { useEffect, useRef, useState } from 'react';
import { call, onEventType } from './bridge';
import { useApp } from './state';
import { CodeArea, Modal, SubTabs, ts } from './components';
import type { OAuth2Config, GrpcConfig, McpConfig, AiConfig } from '../shared/types';
import type { OAuthTokens } from '../shared/api';
import type { WsMessageEvent, MqttMessageEvent, SseFrameEvent, GrpcStreamEvent } from '../shared/events';

// ---------------------------------------------------------------------------
// helpers
function hexToBase64(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

type Proto = 'ws' | 'sse' | 'mqtt' | 'grpc' | 'socketio';

const PROTOCOLS: { id: Proto; label: string; placeholder: string; hint: string }[] = [
  { id: 'ws', label: 'WebSocket', placeholder: 'ws://localhost:8080', hint: 'full-duplex messages, binary shout out via hex' },
  { id: 'sse', label: 'SSE', placeholder: 'http://localhost:8080/events', hint: 'server-sent events stream' },
  { id: 'mqtt', label: 'MQTT', placeholder: 'mqtt://localhost:1883', hint: 'broker pub/sub — host:port' },
  { id: 'grpc', label: 'gRPC', placeholder: 'localhost:50051', hint: 'reflection or local .proto files' },
  { id: 'socketio', label: 'Socket.IO', placeholder: 'http://localhost:3000', hint: 'evented websockets' },
];

interface ConsoleEntry { dir: 'in' | 'out' | 'sys'; text: string; ts: string }

export function SessionsPage(): React.ReactElement {
  const s = useApp();
  const [proto, setProto] = useState<Proto>('ws');
  const [url, setUrl] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [messages, setMessages] = useState<ConsoleEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [topic, setTopic] = useState('');
  const [eventName, setEventName] = useState('message');
  const [wsBinaryHex, setWsBinaryHex] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const now = (): string => new Date().toLocaleTimeString();

  const push = (m: ConsoleEntry): void => {
    setMessages((prev) => [...prev.slice(-499), m]);
    requestAnimationFrame(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; });
  };

  useEffect(() => {
    const matches = (sid: string | undefined): boolean => !!sid && sid === sessionId;
    const offs = [
      onEventType<WsMessageEvent>('ws.message', (p) => {
        if (!matches(p.sessionId)) return;
        push({ dir: p.direction === 'out' ? 'out' : p.direction === 'sys' ? 'sys' : 'in', text: p.binary ? `[binary] ${p.data}` : p.data, ts: now() });
      }),
      onEventType<SseFrameEvent>('sse.frame', (p) => {
        if (!matches(p.sessionId)) return;
        push({ dir: 'in', text: `[event ${p.event ?? 'message'}] ${p.data}`, ts: now() });
      }),
      onEventType<MqttMessageEvent>('mqtt.message', (p) => {
        if (!matches(p.sessionId)) return;
        push({ dir: 'in', text: `[${p.topic}] ${p.payload}`, ts: now() });
      }),
      onEventType<GrpcStreamEvent>('grpc.stream', (p) => {
        if (!matches(p.sessionId)) return;
        push({ dir: p.direction === 'out' ? 'out' : 'in', text: p.data, ts: now() });
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [sessionId]);

  const connect = async (): Promise<void> => {
    setConnecting(true);
    try {
      let r: { sessionId: string };
      if (proto === 'ws') r = await call('ws.connect', { url });
      else if (proto === 'sse') r = await call('sse.connect', { url });
      else if (proto === 'socketio') r = await call('socketio.connect', { url });
      else if (proto === 'mqtt') {
        const u = new URL(url.replace('mqtt://', 'mqtt://') || 'mqtt://localhost:1883');
        r = await call('mqtt.connect', { config: { host: u.hostname, port: Number(u.port || 1883), useTls: u.protocol === 'mqtts:', clean: true } });
      } else return;
      setSessionId(r.sessionId);
      push({ dir: 'sys', text: `✓ connected (session ${r.sessionId.slice(0, 8)})`, ts: now() });
      s.toast('ok', 'Connected');
    } catch (e) {
      s.toast('err', String(e instanceof Error ? e.message : e));
    } finally { setConnecting(false); }
  };

  const disconnect = async (): Promise<void> => {
    if (!sessionId) return;
    const close: Record<Proto, string> = { ws: 'ws.close', sse: 'sse.close', mqtt: 'mqtt.close', grpc: 'grpc.close', socketio: 'socketio.close' };
    try { await call(close[proto], { sessionId }); } catch { /* session may already be gone */ }
    push({ dir: 'sys', text: '✕ closed', ts: now() });
    setSessionId(null);
  };

  const send = async (): Promise<void> => {
    if (!sessionId || !draft) return;
    try {
      if (proto === 'ws') {
        const data = wsBinaryHex ? hexToBase64(draft) : draft;
        await call('ws.send', { sessionId, data, binary: wsBinaryHex });
        push({ dir: 'out', text: draft, ts: now() });
      } else if (proto === 'mqtt') {
        if (!topic) { s.toast('warn', 'Set a topic to publish'); return; }
        await call('mqtt.publish', { sessionId, topic, payload: draft });
        push({ dir: 'out', text: `[${topic}] ${draft}`, ts: now() });
      } else if (proto === 'socketio') {
        await call('socketio.emit', { sessionId, event: eventName, data: draft });
        push({ dir: 'out', text: `${eventName}: ${draft}`, ts: now() });
      }
      setDraft('');
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  return (
    <div className="pad" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {PROTOCOLS.map((p) => (
          <button key={p.id} className={`btn sm ${proto === p.id ? 'primary' : ''}`} onClick={() => { setProto(p.id); setMessages([]); setDraft(''); }}>
            {p.label}
          </button>
        ))}
        <span className="muted">{PROTOCOLS.find((p) => p.id === proto)?.hint}</span>
        <span className="spacer" />
        {sessionId && <span className="badge-pill green">● live</span>}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <input className="input mono" placeholder={PROTOCOLS.find((p) => p.id === proto)?.placeholder} value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
        {proto !== 'grpc' && (sessionId
          ? <button className="btn danger" onClick={() => void disconnect()}>Disconnect</button>
          : <button className="btn primary" onClick={() => void connect()} disabled={!url || connecting}>Connect</button>)}
      </div>
      {proto === 'grpc' && <GrpcConsole url={url} push={push as never} sessionId={sessionId} setSessionId={setSessionId} toast={(k, t) => s.toast(k, t)} />}

      <div className="card" style={{ marginTop: 12, flex: 1, overflow: 'auto', minHeight: 180 }} ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className="mono" style={{ padding: '2px 0', color: m.dir === 'out' ? 'var(--blue)' : m.dir === 'sys' ? 'var(--dim)' : 'var(--green)' }}>
            <span className="dim">{m.ts} </span>{m.dir === 'in' ? '← ' : m.dir === 'out' ? '→ ' : '  '}{m.text}
          </div>
        ))}
        {messages.length === 0 && <div className="muted pad">Connect and exchange; traffic appears here live.</div>}
      </div>

      {proto === 'ws' && (
        <div className="row" style={{ marginTop: 8 }}>
          <label className="checkbox" title="Treat draft as hex; sent as binary"><input type="checkbox" checked={wsBinaryHex} onChange={(e) => setWsBinaryHex(e.target.checked)} /> binary (hex)</label>
          <input className="input mono" placeholder={wsBinaryHex ? '48 65 6c 6c 6f' : 'message…'} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
          <button className="btn primary" onClick={() => void send()} disabled={!sessionId}>Send</button>
        </div>
      )}
      {proto === 'mqtt' && (
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input mono" style={{ width: 220 }} placeholder="topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <button className="btn" onClick={() => sessionId && void call('mqtt.subscribe', { sessionId, topic }).then(() => push({ dir: 'sys', text: `subscribed ${topic}`, ts: now() }))} disabled={!sessionId || !topic}>Subscribe</button>
          <button className="btn" onClick={() => sessionId && void call('mqtt.unsubscribe', { sessionId, topic }).then(() => push({ dir: 'sys', text: `unsubscribed ${topic}`, ts: now() }))} disabled={!sessionId || !topic}>Unsub</button>
          <input className="input mono" placeholder="payload…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
          <button className="btn primary" onClick={() => void send()} disabled={!sessionId}>Publish</button>
        </div>
      )}
      {proto === 'socketio' && (
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input sm" style={{ width: 160 }} placeholder="event name" value={eventName} onChange={(e) => setEventName(e.target.value)} />
          <input className="input mono" placeholder="JSON payload…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
          <button className="btn primary" onClick={() => void send()} disabled={!sessionId}>Emit</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// gRPC console in a small panel
function GrpcConsole(props: {
  url: string;
  sessionId: string | null;
  setSessionId: (v: string | null) => void;
  toast: (kind: 'info' | 'warn' | 'ok' | 'err', text: string) => void;
  push: (m: ConsoleEntry) => void;
}): React.ReactElement {
  const [protoFiles, setProtoFiles] = useState('');
  const [useReflection, setUseReflection] = useState(true);
  const [useTls, setUseTls] = useState(false);
  const [service, setService] = useState('');
  const [services, setServices] = useState<{ name: string; methods: { name: string; inputType: string; outputType: string; clientStreaming: boolean; serverStreaming: boolean }[] }[]>([]);
  const [method, setMethod] = useState('');
  const [payload, setPayload] = useState('{\n  \n}');
  const [streamPayload, setStreamPayload] = useState('');

  const cfg = (): GrpcConfig => ({
    protoFiles: protoFiles.split('\n').map((x) => x.trim()).filter(Boolean),
    service: service || undefined, method: method || undefined,
    metadata: [], useReflection, useTls,
  });

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="checkbox"><input type="checkbox" checked={useReflection} onChange={(e) => setUseReflection(e.target.checked)} /> server reflection</label>
        <label className="checkbox"><input type="checkbox" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} /> TLS</label>
        <button className="btn sm primary" onClick={() => {
          void call<typeof services>('grpc.listServices', { config: cfg(), serverUrl: props.url }).then((r) => {
            setServices(r); props.toast('ok', `Found ${r.length} service(s)`);
          }).catch((e) => props.toast('err', String(e instanceof Error ? e.message : e)));
        }}>List services</button>
        <input className="input sm mono" style={{ flex: 1 }} placeholder="/abs/path/to/service.proto (one per line if reflection off)" value={protoFiles} onChange={(e) => setProtoFiles(e.target.value)} />
      </div>
      {services.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <select className="input sm" style={{ width: 260 }} value={service} onChange={(e) => { setService(e.target.value); setMethod(''); }}>
            <option value="">— service —</option>
            {services.map((svc) => <option key={svc.name} value={svc.name}>{svc.name}</option>)}
          </select>
          <select className="input sm" style={{ width: 320 }} value={method} onChange={(e) => { setMethod(e.target.value); setPayload('{\n  \n}'); }}>
            <option value="">— method —</option>
            {services.find((svc) => svc.name === service)?.methods.map((m) => (
              <option key={m.name} value={m.name}>{m.name}({m.inputType})→{m.outputType}{m.clientStreaming ? ' [client-stream]' : ''}{m.serverStreaming ? ' [server-stream]' : ''}</option>
            ))}
          </select>
        </div>
      )}
      {service && method && (
        <div style={{ marginTop: 8 }}>
          <CodeArea minRows={5} value={payload} onChange={setPayload} />
          <div className="row" style={{ marginTop: 6 }}>
            {props.sessionId ? (
              <>
                <input className="input mono" style={{ flex: 1 }} placeholder="stream payload json…" value={streamPayload} onChange={(e) => setStreamPayload(e.target.value)} />
                <button className="btn sm" onClick={() => props.sessionId && void call('grpc.send', { sessionId: props.sessionId, payload: streamPayload })}>send</button>
                <button className="btn sm" onClick={() => props.sessionId && void call('grpc.endStream', { sessionId: props.sessionId }).then(() => { props.push({ dir: 'sys', text: 'endStream', ts: ts(new Date().toISOString()) }); })}>endStream</button>
                <button className="btn sm danger" onClick={() => props.sessionId && void call('grpc.close', { sessionId: props.sessionId }).then(() => props.setSessionId(null))}>close</button>
              </>
            ) : (
              <button className="btn primary" onClick={() => {
                void call<{ sessionId: string; unary?: boolean; result?: string }>('grpc.invoke', { serverUrl: props.url, config: cfg(), method: `${service}/${method}`, payload })
                  .then((r) => {
                    props.setSessionId(r.sessionId);
                    if (r.unary && r.result !== undefined) props.push({ dir: 'in', text: r.result, ts: ts(new Date().toISOString()) });
                    else props.push({ dir: 'sys', text: `stream opened (${r.sessionId.slice(0, 8)})`, ts: ts(new Date().toISOString()) });
                  })
                  .catch((e) => props.toast('err', String(e instanceof Error ? e.message : e)));
              }}>Invoke</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OAuth
export function OAuthPage(): React.ReactElement {
  const s = useApp();
  const [grant, setGrant] = useState<OAuth2Config['grantType']>('authorization_code_pkce');
  const [authUrl, setAuthUrl] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scope, setScope] = useState('');
  const [redirect, setRedirect] = useState('http://localhost:8787/callback');
  const [tokens, setTokens] = useState<OAuthTokens | null>(null);
  const [pendingCode, setPendingCode] = useState('');
  const [discovery, setDiscovery] = useState<string>('');

  const base = (): Partial<OAuth2Config> => ({
    grantType: grant,
    authUrl: authUrl || undefined,
    accessTokenUrl: tokenUrl || undefined,
    clientId: clientId || undefined,
    clientSecret: clientSecret || undefined,
    scope: scope || undefined,
    callbackUrl: redirect || undefined,
    pkceMethod: 'S256',
    clientAuth: 'body',
    addTo: 'header',
  });

  const discover = async (): Promise<void> => {
    const issuer = authUrl.replace(/\/authorize.*$/, '').replace(/\/+$/, '');
    try {
      const r = await call<{ authorizationEndpoint?: string; tokenEndpoint?: string; issuer?: string }>('oauth.discover', { url: issuer });
      if (r.authorizationEndpoint) setAuthUrl(r.authorizationEndpoint);
      if (r.tokenEndpoint) setTokenUrl(r.tokenEndpoint);
      s.toast('ok', `Discovered issuer ${r.issuer ?? issuer}`);
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  const startAuthCode = async (): Promise<void> => {
    try {
      const r = await call<{ authUrl: string; state: string; callbackPort: number }>('oauth.start', { config: { ...base(), grantType: 'authorization_code_pkce' } as OAuth2Config });
      void call('shell.openExternal', { url: r.authUrl }).catch(() => undefined);
      setDiscovery(`Browser opened — paste the ?code= from the redirect on :${r.callbackPort} below (or auto-capture if it was the loopback).`);
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  const exchange = async (): Promise<void> => {
    let code = pendingCode.trim(); let state = '';
    if (code.startsWith('http')) {
      try { const u = new URL(code); code = u.searchParams.get('code') ?? code; state = u.searchParams.get('state') ?? ''; } catch { /* keep raw */ }
    }
    if (!code) { s.toast('warn', 'Paste the code (or full redirect URL)'); return; }
    try {
      const t = await call<OAuthTokens>('oauth.exchange', { config: base() as OAuth2Config, code, state });
      setTokens(t); s.toast('ok', 'Token acquired');
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  const direct = async (kind: 'client_credentials' | 'password'): Promise<void> => {
    try {
      const t = await call<OAuthTokens>(kind === 'client_credentials' ? 'oauth.clientCredentials' : 'oauth.passwordGrant', { config: base() as OAuth2Config });
      setTokens(t); s.toast('ok', 'Token acquired');
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  const refresh = async (): Promise<void> => {
    try {
      const t = await call<OAuthTokens>('oauth.refresh', { config: { ...base(), refreshToken: tokens?.refreshToken } as OAuth2Config });
      setTokens(t); s.toast('ok', 'Refreshed');
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  return (
    <div className="pad" style={{ maxWidth: 820 }}>
      <h3>OAuth 2 flows</h3>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {(['authorization_code_pkce', 'authorization_code', 'client_credentials', 'password', 'implicit'] as const).map((g) => (
            <button key={g} className={`btn sm ${grant === g ? 'primary' : ''}`} onClick={() => setGrant(g)}>{g}</button>
          ))}
        </div>
        <div className="grid2" style={{ marginTop: 12 }}>
          <div>
            <label className="lbl">Authorization URL</label>
            <div className="row"><input className="input mono" value={authUrl} onChange={(e) => setAuthUrl(e.target.value)} /><button className="btn sm" onClick={() => void discover()}>Discover</button></div>
          </div>
          <div><label className="lbl">Token URL</label><input className="input mono" value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} /></div>
          <div><label className="lbl">Client ID</label><input className="input" value={clientId} onChange={(e) => setClientId(e.target.value)} /></div>
          <div><label className="lbl">Client secret {(grant === 'client_credentials') && <span className="dim">(store in vault!)</span>}</label><input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} /></div>
          <div><label className="lbl">Scope</label><input className="input" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="read write" /></div>
          <div><label className="lbl">Redirect (loopback)</label><input className="input mono" value={redirect} onChange={(e) => setRedirect(e.target.value)} /></div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          {(grant === 'authorization_code_pkce' || grant === 'authorization_code' || grant === 'implicit') && (
            <button className="btn primary" onClick={() => void startAuthCode()}>Open browser — start auth</button>
          )}
          {grant === 'client_credentials' && <button className="btn primary" onClick={() => void direct('client_credentials')}>Get token</button>}
          {grant === 'password' && <button className="btn primary" onClick={() => void direct('password')}>Get token</button>}
          {tokens?.refreshToken && <button className="btn" onClick={() => void refresh()}>↻ Refresh</button>}
        </div>
        {discovery && <div className="muted" style={{ marginTop: 10 }}>{discovery}</div>}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3>Exchange code</h3>
        <div className="row">
          <input className="input mono" placeholder="paste ?code=… or the full redirect URL" value={pendingCode} onChange={(e) => setPendingCode(e.target.value)} />
          <button className="btn primary" onClick={() => void exchange()}>Exchange</button>
        </div>
      </div>

      {tokens && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row"><h3 style={{ margin: 0 }}>Token</h3><span className="spacer" />
            <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(tokens.accessToken); s.toast('ok', 'Access token copied'); }}>copy access token</button></div>
          <div className="mono" style={{ wordBreak: 'break-all', marginTop: 8 }}>{tokens.accessToken.slice(0, 80)}… ({tokens.accessToken.length} chars)</div>
          {tokens.refreshToken && <div className="dim" style={{ marginTop: 6 }}>refresh token present · expires in {tokens.expiresIn ?? '?'}s</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP
export function McpPage(): React.ReactElement {
  const s = useApp();
  const [cmd, setCmd] = useState('');
  const [args, setArgs] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tools, setTools] = useState<{ name: string; description?: string; schema?: string }[]>([]);
  const [resources, setResources] = useState<{ uri: string; name?: string }[]>([]);
  const [prompts, setPrompts] = useState<{ name: string; description?: string }[]>([]);
  const [tab, setTab] = useState('tools');
  const [callArgs, setCallArgs] = useState('{}');
  const [output, setOutput] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const now = (): string => new Date().toLocaleTimeString();

  const connect = async (): Promise<void> => {
    if (!cmd) return;
    try {
      const r = await call<{ sessionId: string }>('mcp.connect', { config: { transport: 'stdio', command: cmd, args: args.split(' ').filter(Boolean) } as McpConfig });
      setSessionId(r.sessionId);
      s.toast('ok', `MCP connected (${r.sessionId.slice(0, 8)})`);
      const [t, res, pr] = await Promise.all([
        call<{ tools: typeof tools }>('mcp.listTools', { sessionId: r.sessionId }),
        call<{ resources: typeof resources }>('mcp.listResources', { sessionId: r.sessionId }),
        call<{ prompts: typeof prompts }>('mcp.listPrompts', { sessionId: r.sessionId }),
      ]);
      setTools(t.tools); setResources(res.resources); setPrompts(pr.prompts);
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  const close = async (): Promise<void> => {
    if (sessionId) { try { await call('mcp.close', { sessionId }); } catch { /* already closed */ } }
    setSessionId(null); setTools([]); setResources([]); setPrompts([]); setOutput('');
  };

  const invoke = async (name: string, confirmed: boolean): Promise<void> => {
    if (!sessionId) return;
    try {
      const r = await call<{ content: string }>('mcp.callTool', { sessionId, name, argsJson: callArgs, confirmed });
      setOutput(`[${now()}] ${name}\n${r.content}`);
      if (!confirmed) setOutput(`[${now()}] ${name} executed (confirmed)\n${r.content}`);
      setConfirming(null);
    } catch (e) { s.toast('err', String(e instanceof Error ? e.message : e)); }
  };

  return (
    <div className="pad" style={{ maxWidth: 880 }}>
      <h3>Model Context Protocol client</h3>
      <div className="card">
        <div className="row">
          <input className="input mono" placeholder="command, e.g. node" value={cmd} onChange={(e) => setCmd(e.target.value)} style={{ width: 200 }} />
          <input className="input mono" placeholder="args, e.g. ./server.js --stdio" value={args} onChange={(e) => setArgs(e.target.value)} />
          {sessionId
            ? <button className="btn danger sm" onClick={() => void close()}>Disconnect</button>
            : <button className="btn primary sm" onClick={() => void connect()} disabled={!cmd}>Connect</button>}
        </div>
        <div className="muted" style={{ marginTop: 6 }}>
          Launch any MCP stdio server directly. Tool calls that would run side effects ask for explicit confirmation — an MCP server should never be able to act silently.
        </div>
      </div>
      {sessionId && (
        <>
          <SubTabs active={tab} onChange={setTab} tabs={[
            { id: 'tools', label: 'Tools', count: tools.length },
            { id: 'resources', label: 'Resources', count: resources.length },
            { id: 'prompts', label: 'Prompts', count: prompts.length },
          ]} />
          {tab === 'tools' && (
            <div>
              <div className="card">
                <label className="lbl">Shared args (JSON)</label>
                <CodeArea minRows={2} value={callArgs} onChange={setCallArgs} />
              </div>
              {tools.map((t) => (
                <div key={t.name} className="card" style={{ marginTop: 8 }}>
                  <div className="row">
                    <b className="mono">{t.name}</b>
                    <span className="spacer" />
                    <button className="btn sm primary" onClick={() => setConfirming(t.name)}>Run</button>
                  </div>
                  {t.description && <div className="dim">{t.description}</div>}
                  {t.schema && <details style={{ marginTop: 4 }}><summary className="dim">schema</summary><pre className="codemini">{t.schema}</pre></details>}
                </div>
              ))}
              {tools.length === 0 && <div className="muted pad">No tools reported.</div>}
            </div>
          )}
          {tab === 'resources' && (
            <div className="card">
              {resources.map((r) => <div key={r.uri} className="row" style={{ marginBottom: 4 }}><code className="mono">{r.uri}</code><span className="dim">{r.name ?? ''}</span></div>)}
              {resources.length === 0 && <div className="muted">No resources reported.</div>}
            </div>
          )}
          {tab === 'prompts' && (
            <div className="card">
              {prompts.map((p) => <div key={p.name} className="row" style={{ marginBottom: 4 }}><b>{p.name}</b><span className="dim">{p.description ?? ''}</span></div>)}
              {prompts.length === 0 && <div className="muted">No prompts reported.</div>}
            </div>
          )}
          {output && (
            <div className="card" style={{ marginTop: 12 }}>
              <div className="row"><h4>Output</h4><span className="spacer" /><button className="btn xs" onClick={() => setOutput('')}>clear</button></div>
              <pre className="codemini" style={{ maxHeight: 320 }}>{output}</pre>
            </div>
          )}
        </>
      )}
      {confirming && (
        <Modal title="Confirm MCP tool execution" onClose={() => setConfirming(null)}
          footer={<>
            <button className="btn" onClick={() => setConfirming(null)}>Cancel</button>
            <button className="btn primary" onClick={() => void invoke(confirming, true)}>Allow once</button>
          </>}>
          <p>Run <code>{confirming}</code> with args <code>{callArgs.slice(0, 200)}</code>?</p>
          <div className="muted">The tool executes on your machine through the MCP server you launched. Only confirm tools you trust.</div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Assistant
const AI_TEMPLATES = [
  { id: 'explain', label: 'Explain this API', template: 'Explain what this API endpoint does, its parameters, auth, and typical responses.' },
  { id: 'tests', label: 'Generate tests', template: 'Write postman-style pm.test() scripts for this endpoint: status checks, schema validation, boundary values.' },
  { id: 'docs', label: 'Write docs', template: 'Write concise markdown documentation for this request, with example calls.' },
  { id: 'curl', label: 'Suggest curl', template: 'Give me equivalent curl commands for this request with all headers and auth.' },
  { id: 'mock', label: 'Generate mock data', template: 'Generate a realistic JSON response mock for this endpoint.' },
  { id: 'debug', label: 'Debug failure', template: 'Given this failing request/response, diagnose what is wrong and suggest fixes.' },
  { id: 'assertions', label: 'Suggest assertions', template: 'Suggest a set of assertions (status, headers, body fields, timing) for this endpoint.' },
];
function defaultBase(provider: string): string {
  switch (provider) {
    case 'openai': return 'https://api.openai.com/v1';
    case 'anthropic': return 'https://api.anthropic.com/v1';
    case 'ollama': return 'http://localhost:11434';
    default: return '';
  }
}
export function AiAssistantPage(): React.ReactElement {
  const s = useApp();
  const [providers, setProviders] = useState<{ id: string; label: string; baseUrl: string }[]>([]);
  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKeyName, setApiKeyName] = useState('');
  const [template, setTemplate] = useState(AI_TEMPLATES[0].template);
  const [context, setContext] = useState('');
  const [output, setOutput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState('');

  useEffect(() => {
    void call<typeof providers>('ai.providers').then((p) => {
      setProviders(p);
      if (p[0]) { setProvider(p[0].id); setBaseUrl(p[0].baseUrl || defaultBase(p[0].id)); }
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    const off = onEventType<{ sessionId: string; token: string }>('ai.token', (p) => {
      if (p.sessionId === sessionId) setOutput((o) => o + p.token);
    });
    return off;
  }, [sessionId]);
  useEffect(() => { setBaseUrl(defaultBase(provider)); }, [provider]);

  const send = async (): Promise<void> => {
    setOutput(''); setStreaming(true);
    try {
      const config: AiConfig = {
        provider, baseUrl, model,
        apiKeySecretId: apiKeyName || undefined,
        systemPrompt: context || undefined,
        temperature: 0.2,
      };
      const r = await call<{ sessionId: string; content: string }>('ai.send', {
        config,
        messages: [{ role: 'user', content: `${template}\n\n${context}`.trim() }],
      });
      setSessionId(r.sessionId);
      if (r.content) setOutput(r.content);
      setStreaming(false);
    } catch (e) {
      setOutput(String(e instanceof Error ? e.message : e));
      setStreaming(false);
    }
  };

  return (
    <div className="pad" style={{ maxWidth: 880 }}>
      <h3>AI assistant</h3>
      <div className="card">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select className="input sm" style={{ width: 200 }} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            {providers.length === 0 && <option value="openai">OpenAI</option>}
          </select>
          <input className="input sm mono" style={{ flex: 1 }} placeholder="base url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input className="input sm" style={{ width: 220 }} placeholder="model, e.g. gpt-4o / llama3" value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input sm" style={{ flex: 1 }} placeholder="vault secret name for API key (optional; e.g. openai-key)" value={apiKeyName} onChange={(e) => setApiKeyName(e.target.value)} />
          <span className="dim">The key is read from your vault at call time — never stored in the workspace.</span>
        </div>
        <div style={{ marginTop: 8 }}>
          <select className="input sm" style={{ width: 220 }} value={template} onChange={(e) => setTemplate(e.target.value)}>
            {AI_TEMPLATES.map((t) => <option key={t.id} value={t.template}>{t.label}</option>)}
          </select>
          <CodeArea minRows={3} value={template} onChange={setTemplate} />
        </div>
        <div style={{ marginTop: 8 }}>
          <label className="lbl">Context (paste request/response JSON)</label>
          <CodeArea minRows={5} value={context} onChange={setContext} />
        </div>
        <button className="btn primary" style={{ marginTop: 8 }} onClick={() => void send()} disabled={streaming || !model}>{streaming ? 'Thinking…' : 'Ask'}</button>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="row"><h4 style={{ margin: 0 }}>Answer</h4><span className="spacer" />
          <button className="btn xs" onClick={() => { void navigator.clipboard.writeText(output); s.toast('ok', 'Copied'); }} disabled={!output}>copy</button></div>
        <pre className="codemini" style={{ whiteSpace: 'pre-wrap', minHeight: 120 }}>{output || <span className="muted">—</span>}</pre>
      </div>
    </div>
  );
}
