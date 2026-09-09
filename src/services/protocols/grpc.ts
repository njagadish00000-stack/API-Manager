/**
 * gRPC client (§13) implemented natively on @grpc/grpc-js + protobufjs:
 *  - Server reflection (grpc.reflection.v1, fallback v1alpha) using a
 *    manually-defined reflection proto — no proto-loader dependency
 *  - Dynamic unary / client-streaming / server-streaming / bidi calls
 *  - TLS / plaintext, custom metadata, per-session streaming state
 *  - Loading user-supplied .proto files from disk as an alternative source
 */
import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
// side effect: adds protobuf.Root.fromDescriptor(FileDescriptorSet bytes)
import 'protobufjs/ext/descriptor';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { GrpcConfig, KeyValue } from '../../shared/types';
import type { SessionEmitter } from './websocket';

// ---------------------------------------------------------------------------
// Reflection protocol message definitions (grpc.reflection.v1)
// ---------------------------------------------------------------------------

const reflectionProto = `
syntax = "proto3";
package grpc.reflection.v1;
service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    ExtensionRequest file_containing_extension = 5;
    string all_extension_numbers_of_type = 6;
    string list_services = 7;
  }
}
message ExtensionRequest { string containing_type = 1; int32 extension_number = 2; }
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ExtensionNumberResponse all_extension_numbers_response = 5;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ExtensionNumberResponse { string base_type_name = 1; repeated int32 extension_number = 2; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

interface ReflectionTypes { request: protobuf.Type; response: protobuf.Type }

let reflectionTypes: ReflectionTypes | undefined;
function loadReflectionTypes(): ReflectionTypes {
  if (reflectionTypes) return reflectionTypes;
  const root = protobuf.parse(reflectionProto, { keepCase: false }).root;
  reflectionTypes = {
    request: root.lookupType('grpc.reflection.v1.ServerReflectionRequest'),
    response: root.lookupType('grpc.reflection.v1.ServerReflectionResponse'),
  };
  return reflectionTypes;
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function encodeVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v & 0x7f);
  return Buffer.from(out);
}

/** Manually wire-encode a FileDescriptorSet { repeated FileDescriptorProto file = 1 } */
function fileDescriptorSetBuffer(files: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(Buffer.from([0x0a])); // field 1, length-delimited
    parts.push(encodeVarint(f.length));
    parts.push(f);
  }
  return Buffer.concat(parts);
}

type RootWithDescriptor = typeof protobuf.Root & { fromDescriptor: (d: Uint8Array) => protobuf.Root };

function rootFromFileDescriptorProtos(files: Buffer[]): protobuf.Root {
  const buf = fileDescriptorSetBuffer(files);
  return (protobuf.Root as RootWithDescriptor).fromDescriptor(new Uint8Array(buf));
}

function encodeRequest(reqType: protobuf.Type, msg: unknown): Buffer {
  return Buffer.from(reqType.encode(reqType.fromObject(msg as Record<string, unknown>)).finish());
}

function makeCredentials(useTls: boolean): grpc.ChannelCredentials {
  return useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
}

function metadataFrom(kvs: KeyValue[] | undefined): grpc.Metadata {
  const meta = new grpc.Metadata();
  for (const kv of kvs ?? []) if (kv.enabled && kv.key) meta.add(kv.key, kv.value);
  return meta;
}

// ---------------------------------------------------------------------------
// Reflection queries
// ---------------------------------------------------------------------------

interface ReflectionServerResponse {
  fileDescriptorResponse?: { fileDescriptorProto?: number[][] };
  listServicesResponse?: { service?: { name?: string }[] };
  errorResponse?: { errorMessage?: string; errorCode?: number };
}

const REFLECTION_PATHS = [
  '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
  '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
];

function reflectQuery(
  serverUrl: string,
  path: string,
  credential: grpc.ChannelCredentials,
  requests: unknown[],
  metadataKvs: KeyValue[],
  timeoutMs = 20000,
): Promise<ReflectionServerResponse[]> {
  const { request: reqType, response: resType } = loadReflectionTypes();
  return new Promise((resolve, reject) => {
    const client = new grpc.Client(serverUrl, credential, { 'grpc.max_receive_message_length': 64 * 1024 * 1024 });
    const meta = metadataFrom(metadataKvs);
    const call = client.makeBidiStreamRequest<Buffer, Buffer>(
      path, (b: Buffer) => b, (b: Buffer) => b, meta, { deadline: new Date(Date.now() + timeoutMs) },
    );
    const results: ReflectionServerResponse[] = [];
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      client.close();
      if (err) reject(err); else resolve(results);
    };
    call.on('data', (raw: Buffer) => {
      try {
        const decoded = resType.toObject(resType.decode(new Uint8Array(raw)), { bytes: Array }) as ReflectionServerResponse;
        results.push(decoded);
      } catch { /* skip undecodable frame */ }
    });
    call.on('error', done);
    call.on('end', () => done());
    call.on('status', () => { /* stream closed */ });
    for (const req of requests) {
      call.write(encodeRequest(reqType, req));
    }
    call.end();
    setTimeout(() => { if (!settled) { try { call.cancel(); } catch { /* noop */ } done(new Error('reflection timeout')); } }, timeoutMs);
  });
}

/** list service names, trying v1 then v1alpha */
export async function listServiceNames(serverUrl: string, config: Pick<GrpcConfig, 'useTls' | 'metadata'>): Promise<string[]> {
  const credentials = makeCredentials(config.useTls ?? false);
  for (const path of REFLECTION_PATHS) {
    try {
      const responses = await reflectQuery(serverUrl, path, credentials, [{ host: '', listServices: '*' }], config.metadata ?? []);
      const names: string[] = [];
      for (const r of responses) for (const s of r.listServicesResponse?.service ?? []) if (s.name) names.push(s.name);
      if (names.length > 0 || responses.length > 0) return names;
    } catch { /* try next */ }
  }
  throw new Error(`gRPC reflection failed for ${serverUrl} (v1 and v1alpha)`);
}

/** fetch FileDescriptorProtos for a set of symbols */
async function fetchSymbolProtos(serverUrl: string, symbols: string[], config: Pick<GrpcConfig, 'useTls' | 'metadata'>): Promise<Buffer[]> {
  const credentials = makeCredentials(config.useTls ?? false);
  const requests = symbols.map((s) => ({ host: '', fileContainingSymbol: s }));
  let lastErr: Error | undefined;
  for (const path of REFLECTION_PATHS) {
    try {
      const responses = await reflectQuery(serverUrl, path, credentials, requests, config.metadata ?? []);
      const out: Buffer[] = [];
      const seen = new Set<string>();
      for (const r of responses) {
        if (r.errorResponse) continue;
        for (const proto of r.fileDescriptorResponse?.fileDescriptorProto ?? []) {
          const buf = Buffer.from(proto);
          const key = buf.slice(0, 40).toString('hex');
          if (!seen.has(key)) { seen.add(key); out.push(buf); }
        }
      }
      if (out.length > 0) return out;
      return out;
    } catch (e) { lastErr = e instanceof Error ? e : new Error(String(e)); }
  }
  throw lastErr ?? new Error('reflection symbol fetch failed');
}

// ---------------------------------------------------------------------------
// Schema model
// ---------------------------------------------------------------------------

interface ServiceInfo {
  name: string;
  methods: { name: string; inputType: string; outputType: string; clientStreaming: boolean; serverStreaming: boolean }[];
}

interface LoadedSchema { root: protobuf.Root; services: ServiceInfo[] }

export async function loadSchema(serverUrl: string, config: GrpcConfig): Promise<LoadedSchema> {
  let root: protobuf.Root;
  if (config.protoFiles?.length) {
    root = new protobuf.Root();
    for (const file of config.protoFiles) {
      if (!existsSync(file)) throw new Error(`proto file not found: ${file}`);
      const parsed = protobuf.parse(readFileSync(file, 'utf8'), { keepCase: true });
      for (const n of parsed.root.nestedArray) root.add(n);
    }
  } else {
    const names = await listServiceNames(serverUrl, config);
    const buffers = await fetchSymbolProtos(serverUrl, names, config);
    if (buffers.length === 0) throw new Error(`No descriptors returned for ${serverUrl}`);
    root = rootFromFileDescriptorProtos(buffers);
  }
  root.resolveAll();

  const services: ServiceInfo[] = [];
  const saw = new Set<string>();
  const walk = (ns: protobuf.NamespaceBase) => {
    for (const nested of ns.nestedArray) {
      const maybeService = nested as protobuf.Service;
      if (Array.isArray(maybeService.methodsArray) && maybeService.methodsArray.length >= 0 && (maybeService as unknown as { isService?: boolean }).isService !== false && (nested as unknown as { methods: unknown }).methods) {
        if (!saw.has(maybeService.fullName.slice(1))) {
          saw.add(maybeService.fullName.slice(1));
          services.push({
            name: maybeService.fullName.slice(1),
            methods: maybeService.methodsArray.map((m) => ({
              name: m.name,
              inputType: m.requestType,
              outputType: m.responseType,
              clientStreaming: !!m.requestStream,
              serverStreaming: !!m.responseStream,
            })),
          });
        }
      }
      if ((nested as protobuf.Namespace).nestedArray) walk(nested as protobuf.Namespace);
    }
  };
  walk(root);
  return { root, services };
}

// ---------------------------------------------------------------------------
// Dynamic invocation
// ---------------------------------------------------------------------------

interface GrpcStreamSession {
  id: string;
  serverUrl: string;
  path: string;
  call: ReturnType<grpc.Client['makeBidiStreamRequest']> | grpc.ClientWritableStream<Buffer>;
  kind: 'client-stream' | 'bidi';
}

const streamSessions = new Map<string, GrpcStreamSession>();

export interface GrpcInvokeResult { sessionId: string; initial?: string; unary?: boolean; result?: string }

function buildMessageType(root: protobuf.Root, typeName: string): protobuf.Type {
  const name = typeName.startsWith('.') ? typeName.slice(1) : typeName;
  const t = root.lookupType(name);
  if (!(t instanceof protobuf.Type)) throw new Error(`message type not found: ${name}`);
  return t;
}

export async function grpcInvoke(args: {
  serverUrl: string;
  config: GrpcConfig;
  method: string; // "pkg.Service/Method" | "pkg.Service.Method" | method name
  payload: string;
  sessionId?: string;
}, emit: SessionEmitter): Promise<GrpcInvokeResult> {
  const schema = await loadSchema(args.serverUrl, args.config);
  let service = args.config.service as string | undefined;
  let method = args.config.method as string | undefined;
  if (args.method.includes('/')) {
    const idx = args.method.lastIndexOf('/');
    service = args.method.slice(0, idx);
    method = args.method.slice(idx + 1);
  } else if (args.method.includes('.')) {
    const idx = args.method.lastIndexOf('.');
    service = args.method.slice(0, idx);
    method = args.method.slice(idx + 1);
  } else if (args.method) {
    for (const s of schema.services) {
      if (s.methods.some((m) => m.name === args.method)) { service = s.name; method = args.method; break; }
    }
  }
  if (!service || !method) throw new Error('grpc.invoke requires a service and method');
  const svc = schema.services.find((s) => s.name === service);
  if (!svc) throw new Error(`service not found: ${service}`);
  const m = svc.methods.find((x) => x.name === method);
  if (!m) throw new Error(`method not found: ${service}/${method}`);

  const reqType = buildMessageType(schema.root, m.inputType);
  const resType = buildMessageType(schema.root, m.outputType);
  const meta = metadataFrom(args.config.metadata);
  const creds = makeCredentials(args.config.useTls ?? false);
  const client = new grpc.Client(args.serverUrl, creds, { 'grpc.max_receive_message_length': 64 * 1024 * 1024 });
  const parsed = safeJsonParse(args.payload);
  const path = `/${service}/${method}`;
  const serializer = (obj: unknown) => Buffer.from(reqType.encode(reqType.fromObject((obj ?? {}) as Record<string, unknown>)).finish());
  const deserializer = (buf: Buffer) => convertProtobufValue(resType.toObject(resType.decode(new Uint8Array(buf)), { longs: String, enums: String, defaults: true }));

  if (!m.clientStreaming && !m.serverStreaming) {
    const result = await new Promise<unknown>((resolve, reject) => {
      client.makeUnaryRequest(path, serializer, deserializer, parsed, meta, (err: grpc.ServiceError | null, value?: unknown) => {
        if (err) reject(err); else resolve(value);
      });
    });
    client.close();
    return { sessionId: args.sessionId ?? randomUUID(), unary: true, result: JSON.stringify(result, null, 2) };
  }

  const sessionId = args.sessionId ?? randomUUID();
  const emitIn = (data: string) => emit('grpc.stream', { sessionId, direction: 'in', data });
  const emitOut = (data: string) => emit('grpc.stream', { sessionId, direction: 'out', data });

  if (!m.clientStreaming && m.serverStreaming) {
    const call = client.makeServerStreamRequest(path, serializer, deserializer, parsed, meta);
    call.on('data', (value: unknown) => emitIn(JSON.stringify(value, null, 2)));
    call.on('end', () => { emitIn('[stream ended]'); client.close(); });
    call.on('error', (err: Error) => { emitIn(`[error] ${err.message}`); client.close(); });
    return { sessionId, unary: false };
  }

  if (m.clientStreaming && m.serverStreaming) {
    const call = client.makeBidiStreamRequest(path, serializer, deserializer, meta);
    call.on('data', (value: unknown) => emitIn(JSON.stringify(value, null, 2)));
    call.on('end', () => { emitIn('[stream ended]'); client.close(); });
    call.on('error', (err: Error) => { emitIn(`[error] ${err.message}`); });
    streamSessions.set(sessionId, { id: sessionId, serverUrl: args.serverUrl, path, call, kind: 'bidi' });
    if (args.payload.trim()) { call.write(serializer(parsed)); emitOut(args.payload); }
    return { sessionId, unary: false, initial: undefined };
  }

  // client streaming only
  const call = client.makeClientStreamRequest(path, serializer, deserializer, meta, (err: grpc.ServiceError | null, response?: unknown) => {
    if (err) emitIn(`[error] ${err.message}`);
    else emitIn(JSON.stringify(response, null, 2));
    emitIn('[client stream closed]');
    streamSessions.delete(sessionId);
    client.close();
  });
  streamSessions.set(sessionId, { id: sessionId, serverUrl: args.serverUrl, path, call, kind: 'client-stream' });
  if (args.payload.trim()) { call.write(serializer(parsed)); emitOut(args.payload); }
  return { sessionId, unary: false };
}

export function grpcSend(sessionId: string, payload: string): void {
  const session = streamSessions.get(sessionId);
  if (!session) throw new Error(`Unknown gRPC stream session ${sessionId}`);
  const call = session.call as grpc.ClientWritableStream<unknown>;
  call.write(safeJsonParse(payload));
}

export function grpcEndStream(sessionId: string): void {
  const session = streamSessions.get(sessionId);
  if (session) (session.call as grpc.ClientWritableStream<unknown>).end();
}

export function grpcClose(sessionId: string): void {
  const session = streamSessions.get(sessionId);
  if (session) {
    const cancellable = session.call as unknown as { cancel?: () => void; destroy?: () => void };
    try { cancellable.cancel?.(); } catch { /* noop */ }
    try { cancellable.destroy?.(); } catch { /* noop */ }
  }
  streamSessions.delete(sessionId);
}

function safeJsonParse(text: string): unknown {
  const t = text.trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch (e) { throw new Error(`Invalid JSON payload: ${e instanceof Error ? e.message : e}`); }
}

/** protobufjs may return Long objects; ensure JSON-safe structure */
function convertProtobufValue<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k: string, val: unknown) => {
    if (val && typeof val === 'object' && 'low' in (val as object) && 'high' in (val as object) && 'unsigned' in (val as object)) {
      const l = val as { low: number; high: number; unsigned: boolean };
      return (BigInt(l.high >>> 0) * BigInt(4294967296) + BigInt(l.low >>> 0)).toString();
    }
    return val;
  })) as T;
}

export { loadSchema as loadGrpcSchema };
