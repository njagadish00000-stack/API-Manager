#!/usr/bin/env node
/* Local test peers for API Manager verification: WS echo, SSE source, fake OIDC IdP,
 * minimal MQTT broker (v3.1.1 just-enough), minimal Socket.IO Engine.IO handshake, gRPC Greeter.
 * All on 127.0.0.1 — offline by design. */
'use strict';
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const NM = '/home/user/API-Manager/node_modules';

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
    const def = protoLoader.loadSync('/tmp/peers/greeter.proto', { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
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
