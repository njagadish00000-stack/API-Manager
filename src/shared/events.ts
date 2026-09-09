/**
 * Push events emitted by the backend over the bridge (both transports).
 */
import type {
  CapturedExchange, ConsoleLogEntry, FlowRunLog, MockRequestLog,
  MonitorResult, WebhookEvent,
} from './types';

export interface RequestProgressEvent {
  opId: string;
  phase: 'dns' | 'connect' | 'tls' | 'upload' | 'server' | 'download' | 'retry' | 'redirect' | 'done';
  detail?: string;
  bytesReceived?: number;
  attempt?: number;
}

export interface RunProgressEvent {
  runId: string;
  executed: number;
  total: number;
  passed: number;
  failed: number;
  currentRequest?: string;
  iteration: number;
  status: string;
}

export interface PerfTickEvent {
  runId: string;
  t: number;
  concurrency: number;
  rps: number;
  avgMs: number;
  errors: number;
  total: number;
  p50: number; p90: number; p99: number;
}

export interface FlowNodeEvent {
  runId: string;
  flowId: string;
  node: FlowRunLog;
}

export interface SseFrameEvent { sessionId: string; event?: string; data: string; id?: string; }
export interface WsMessageEvent { sessionId: string; direction: 'in' | 'out' | 'sys'; data: string; binary: boolean; ts: string; }
export interface MqttMessageEvent { sessionId: string; topic: string; payload: string; qos: number; retain: boolean; }
export interface GrpcStreamEvent { sessionId: string; direction: 'in' | 'out'; data: string; }

export interface BridgeEvents {
  'console.log': ConsoleLogEntry;
  'request.progress': RequestProgressEvent;
  'run.progress': RunProgressEvent;
  'perf.tick': PerfTickEvent;
  'mock.log': MockRequestLog;
  'webhook.event': WebhookEvent;
  'capture.exchange': CapturedExchange;
  'flow.node': FlowNodeEvent;
  'monitor.result': MonitorResult;
  'sse.frame': SseFrameEvent;
  'ws.message': WsMessageEvent;
  'mqtt.message': MqttMessageEvent;
  'grpc.stream': GrpcStreamEvent;
  'ai.token': { sessionId: string; token: string };
  'workspace.changed': { workspaceId: string };
  'vault.locked': Record<string, never>;
}

export type BridgeEventType = keyof BridgeEvents;

export interface BridgeEventEnvelope<K extends BridgeEventType = BridgeEventType> {
  type: K;
  payload: BridgeEvents[K];
  ts: string;
}
