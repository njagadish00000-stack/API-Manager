#!/usr/bin/env node
/* Local test peers for API Manager verification: WS echo, SSE source, fake OIDC IdP,
 * minimal MQTT broker (v3.1.1 just-enough), minimal Socket.IO Engine.IO handshake, gRPC Greeter.
 * All on 127.0.0.1 — offline by design. */
'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const NM = path.join(__dirname, '..', 'node_modules');
const PEERS_DIR = process.env.AM_PEERS_DIR || '/tmp/peers';

/* ---------- 0. Self-provision fixture files (certs, proto, plugin, MCP server) -- */
function provisionFixtures() {
  fs.mkdirSync(PEERS_DIR, { recursive: true });
  const write = (name, content) => fs.writeFileSync(path.join(PEERS_DIR, name), content);

  /* gRPC Greeter proto */
  write('greeter.proto', `syntax = "proto3";
package greeter;
service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }
message HelloRequest { string name = 1; }
message HelloReply { string message = 1; int64 time_ms = 2; }
`);

  /* Self-signed TLS certificate for peer.local / 127.0.0.1 */
  if (!fs.existsSync(path.join(PEERS_DIR, 'peer-cert.pem')) || !fs.existsSync(path.join(PEERS_DIR, 'peer-key.pem'))) {
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(PEERS_DIR, 'peer-key.pem'),
      '-out', path.join(PEERS_DIR, 'peer-cert.pem'),
      '-days', '30', '-subj', '/CN=peer.local',
      '-addext', 'subjectAltName=DNS:peer.local,DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8' });
    if (r.status !== 0) console.error('[peer:fixtures] openssl cert generation failed:', r.stderr);
  }

  /* Demo plugin (manifest + CommonJS entry exporting a pre-request hook) */
  const pluginDir = path.join(PEERS_DIR, 'plugin-demo');
  fs.mkdirSync(pluginDir, { recursive: true });
  write('plugin-demo/manifest.json', JSON.stringify({
    id: 'demo-banner', name: 'Demo Banner Plugin', version: '1.0.0',
    description: 'Verification fixture plugin', entry: 'index.js',
    permissions: ['pre-request', 'console'],
  }, null, 2));
  write('plugin-demo/index.js', `'use strict';
module.exports['pre-request'] = function (payload) {
  payload.headers = payload.headers || [];
  payload.headers.push({ key: 'x-plugin', value: 'plugin-was-here' });
  return payload;
};
`);

  /* Minimal MCP stdio server (JSON-RPC line-delimited): echo tool, 1 resource, 1 prompt */
  write('mcp-echo.cjs', `#!/usr/bin/env node
'use strict';
let buf = '';
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
process.stdin.on('data', (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'mcp-echo-peer', version: '1.0.0' } } });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'echo', description: 'echoes text',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
      return;
    }
    if (method === 'tools/call') {
      const text = params?.arguments?.text ?? '';
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echo:' + text }] } });
      return;
    }
    if (method === 'resources/list') {
      send({ jsonrpc: '2.0', id, result: { resources: [{ uri: 'hello://world', name: 'Hello Resource' }] } });
      return;
    }
    if (method === 'prompts/list') {
      send({ jsonrpc: '2.0', id, result: { prompts: [{ name: 'greet', description: 'greeting prompt' }] } });
      return;
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
  }
});
`);
  console.log('[peer:fixtures] provisioned under', PEERS_DIR);
}
provisionFixtures();

/* ---------- 0b. Plain HTTP echo server :8081 ---------------------------- */
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('x-echo-peers', 'api-manager-verify');
  if (req.url === '/status/503') { res.writeHead(503); res.end(JSON.stringify({ error: 'service unavailable' })); return; }
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/echo?redirected=1' }); res.end(); return; }
  res.writeHead(200);
  res.end(JSON.stringify({
    ok: true, method: req.method, url: req.url,
    headers: req.headers, body: raw.toString('utf8'), bodyBytes: raw.length,
  }));
}).listen(8081, '127.0.0.1', () => console.log('[peer:http] echo on http://127.0.0.1:8081'));

/* ---------- 1. WebSocket echo :8090 ----------------------------------- */
const { WebSocketServer } = require(NM + '/ws');
const wss = new WebSocketServer({ host: '127.0.0.1', port: 8090 });
wss.on('connection', (sock) => {
  console.log('[peer:ws] connection');
  sock.send('welcome-from-peer');
  sock.on('message', (data, isBinary) => {
    console.log('[peer:ws] recv:', data.toString().slice(0, 80));
    const m = data.toString();
    if (m === 'ping') sock.send('pong: ' + Date.now());
    else sock.send('echo:' + m, { binary: isBinary });
  });
});

/* ---------- 2. SSE source :8091 --------------------------------------- */
http.createServer((req, res) => {
  if (req.url === '/events') {
    console.log('[peer:sse] client connected');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      res.write(`id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`);
      if (n >= 60) { clearInterval(t); }
    }, 100);
    req.on('close', () => clearInterval(t));
  } else { res.writeHead(404); res.end(); }
}).listen(8091, '127.0.0.1');

/* ---------- 3. Fake OIDC IdP :8092 ------------------------------------- */
const oidcCfg = JSON.stringify({
  issuer: 'http://127.0.0.1:8092',
  authorization_endpoint: 'http://127.0.0.1:8092/authorize',
  token_endpoint: 'http://127.0.0.1:8092/token',
  userinfo_endpoint: 'http://127.0.0.1:8092/userinfo',
  jwks_uri: 'http://127.0.0.1:8092/jwks',
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'client_credentials', 'password', 'refresh_token'],
});
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function fakeJWT(sub) {
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, iss: 'http://127.0.0.1:8092', exp: 1999999999 })}.${crypto.randomBytes(16).toString('base64url')}`;
}
function readBody(req) { return new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); }); }
http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/.well-known/openid-configuration') { res.end(oidcCfg); }
  else if (req.url === '/token' && req.method === 'POST') {
    const q = new URLSearchParams(await readBody(req));
    const grant = q.get('grant_type');
    if (grant === 'client_credentials' || grant === 'password' || grant === 'refresh_token' || grant === 'authorization_code') {
      res.end(JSON.stringify({ access_token: 'AT-' + grant + '-' + crypto.randomBytes(8).toString('hex'), token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT-' + crypto.randomBytes(8).toString('hex'), id_token: fakeJWT('peer-user'), scope: q.get('scope') ?? '' }));
    } else { res.statusCode = 400; res.end(JSON.stringify({ error: 'unsupported_grant_type' })); }
  } else if (req.url === '/userinfo') { res.end(JSON.stringify({ sub: 'peer-user', name: 'OIDC Test Peer' })); }
  else { res.statusCode = 404; res.end('{}'); }
}).listen(8092, '127.0.0.1');

/* ---------- 4. Minimal Socket.IO (Engine.IO v4, WS + polling fallback) :8093 -------- */
const sioServer = http.createServer((req, res) => {
  if (!req.url.startsWith('/socket.io/')) { res.writeHead(404); return res.end(); }
  if (req.method === 'POST') { let b=''; req.on('data',(c)=>b+=c); req.on('end',()=>{ console.log('[peer:sio] POST:', b.slice(0,100)); res.writeHead(400); res.end(); }); return; }
  console.log('[peer:sio] handshake GET');
  const sid = 'sio-' + crypto.randomBytes(4).toString('hex');
  const body = '0' + JSON.stringify({ sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000 }) + '\x1e' + '40' + JSON.stringify({ sid: 'nsp-' + sid });
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
});
const sioWss = new WebSocketServer({ server: sioServer, path: '/socket.io/' });
sioWss.on('connection', (sock) => {
  const sid = 'sio-ws-' + crypto.randomBytes(4).toString('hex');
  console.log('[peer:sio] ws upgrade');
  sock.send('0' + JSON.stringify({ sid, upgrades: [], pingInterval: 25000, pingTimeout: 20000 }));
  sock.on('message', (d) => {
    const m = d.toString();
    console.log('[peer:sio] ws frame:', m.slice(0, 120));
    if (m === '2probe') sock.send('3probe');
    else if (m === '5' || m === '40' || m.startsWith('40{')) sock.send('40' + JSON.stringify({ sid: 'nsp-' + sid }));
    else if (m.startsWith('42')) { const idx = m.indexOf('['); console.log('[peer:sio] event payload:', m.slice(idx)); }
    else if (m === '2') sock.send('3');
  });
});
sioServer.listen(8093, '127.0.0.1');

/* ---------- 5. Minimal MQTT 3.1.1 broker :1884 -------------------------- */
function encLen(n) { const b = []; let x = n; do { let d = x % 128; x = Math.floor(x / 128); if (x > 0) d |= 0x80; b.push(d); } while (x > 0); return b; }
function u16(a, i) { return (a[i] << 8) | a[i + 1]; }
net.createServer((sock) => {
  let buf = Buffer.alloc(0); const topics = new Set();
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const hdr = buf[0];
      const type = hdr >> 4;
      // decode remaining length
      let mul = 1, len = 0, i = 1;
      do { if (i >= buf.length) return; len += (buf[i] & 0x7f) * mul; mul *= 128; i += 1; } while (buf[i - 1] & 0x80);
      if (buf.length < i + len) return;
      const pkt = buf.subarray(i, i + len); buf = buf.subarray(i + len);
      if (type === 1) { // CONNECT → CONNACK
        console.log('[peer:mqtt] CONNECT');
        sock.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
      } else if (type === 8) { // SUBSCRIBE
        const pktId = [pkt[0], pkt[1]];
        let j = 2; const granted = [];
        while (j < pkt.length) {
          const tl = u16(pkt, j); const topic = pkt.subarray(j + 2, j + 2 + tl).toString();
          topics.add(topic); granted.push(pkt[j + 2 + tl] & 0x03);
          console.log('[peer:mqtt] SUBSCRIBE', topic);
          j = j + 2 + tl + 1;
        }
        sock.write(Buffer.from([0x90, 2 + granted.length, ...pktId, ...granted]));
      } else if (type === 3) { // PUBLISH
        const qos = (hdr >> 1) & 0x03;
        const tl = u16(pkt, 0); const topic = pkt.subarray(2, 2 + tl).toString();
        let off = 2 + tl; const pktId = qos ? [pkt[off], pkt[off + 1]] : null; if (pktId) off += 2;
        const payload = pkt.subarray(off);
        console.log('[peer:mqtt] PUBLISH', topic, '=', payload.toString().slice(0, 60));
        if (topics.has(topic)) { // forward to this same client (self-subscribed)
          const head = Buffer.from([0x30, ...encLen(2 + topic.length + payload.length)]);
          sock.write(Buffer.concat([head, Buffer.from([topic.length >> 8, topic.length & 0xff]), Buffer.from(topic), payload]));
        }
        if (qos === 1) sock.write(Buffer.from([0x40, 0x02, ...pktId]));
      } else if (type === 10) { // UNSUBSCRIBE → UNSUBACK
        sock.write(Buffer.from([0xb0, 0x02, pkt[0], pkt[1]]));
        let t = 4;
        while (t < pkt.length) { const tl = u16(pkt, t); topics.delete(pkt.subarray(t + 2, t + 2 + tl).toString()); t += 2 + tl; }
      } else if (type === 12) { sock.write(Buffer.from([0xd0, 0x00])); } // PINGREQ→RESP
      else if (type === 14) { sock.end(); } // DISCONNECT
    }
  });
}).listen(1884, '127.0.0.1');

/* ---------- 6. gRPC Greeter with server reflection? no -> plain :50051 - */
(async () => {
  try {
    const grpc = require(NM + '/@grpc/grpc-js');
    const protoLoader = require(NM + '/@grpc/proto-loader');
    const def = protoLoader.loadSync(path.join(PEERS_DIR, 'greeter.proto'), { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    const greeter = grpc.loadPackageDefinition(def).greeter;
    const server = new grpc.Server();
    server.addService(greeter.Greeter.service, {
      SayHello: (call, cb) => { console.log('[peer:grpc] SayHello from client:', call.request.name); cb(null, { message: 'Hello, ' + call.request.name + '!' , timeMs: Date.now() }); },
    });
    server.bindAsync('127.0.0.1:50051', grpc.ServerCredentials.createInsecure(), (err) => {
      if (err) console.error('grpc bind failed', err.message);
      else server.start();
    });
  } catch (e) { console.error('grpc peer setup failed:', e.message); }
})();

console.log('peers up: ws 8090 / sse 8091 / oidc 8092 / socketio 8093 / mqtt 1884 / grpc 50051');
