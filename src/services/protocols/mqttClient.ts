/**
 * MQTT sessions (§13) via the `mqtt` package; emits mqtt.message events.
 */
import mqtt, { MqttClient } from 'mqtt';
import { randomUUID } from 'node:crypto';
import type { MqttConfig } from '../../shared/types';
import { now } from '../../shared/types';
import type { SessionEmitter } from './websocket';

const clients = new Map<string, MqttClient>();

export interface MqttMessageRecord { sessionId: string; topic: string; payload: string; qos: number; retain: boolean; }

export function mqttConnect(config: MqttConfig, emit: SessionEmitter, sessionId?: string): Promise<{ sessionId: string }> {
  const id = sessionId ?? randomUUID();
  if (clients.has(id)) throw new Error(`Session ${id} already exists`);
  const scheme = config.useTls ? 'mqtts' : 'mqtt';
  const url = `${scheme}://${config.host}:${config.port}`;
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, {
      clientId: config.clientId || `api-manager-${randomUUID().slice(0, 8)}`,
      username: config.username || undefined,
      password: config.password || undefined,
      keepalive: config.keepAlive ?? 60,
      clean: config.clean ?? true,
      connectTimeout: 15000,
      rejectUnauthorized: true,
    });
    clients.set(id, client);
    client.on('connect', () => {
      emit('mqtt.message', { sessionId: id, topic: '$sys', payload: `connected to ${url}`, qos: 0, retain: false });
      for (const topic of config.subscribeTopics ?? []) {
        client.subscribe(topic, { qos: config.qos ?? 0 });
      }
      resolve({ sessionId: id });
    });
    client.on('message', (topic: string, payload: Buffer, packet: { qos?: number; retain?: boolean }) => {
      emit('mqtt.message', { sessionId: id, topic, payload: payload.toString('utf8'), qos: packet.qos ?? 0, retain: packet.retain ?? false });
    });
    client.on('error', (err: Error) => {
      emit('mqtt.message', { sessionId: id, topic: '$sys', payload: `error: ${err.message}`, qos: 0, retain: false });
      reject(err);
    });
    client.on('close', () => {
      emit('mqtt.message', { sessionId: id, topic: '$sys', payload: 'connection closed', qos: 0, retain: false });
      clients.delete(id);
    });
  });
}

export function mqttPublish(sessionId: string, topic: string, payload: string, qos: 0 | 1 | 2 = 0, retain = false): Promise<void> {
  const client = clients.get(sessionId);
  if (!client) throw new Error(`Unknown MQTT session ${sessionId}`);
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos, retain }, (err) => (err ? reject(err) : resolve()));
  });
}

export function mqttSubscribe(sessionId: string, topic: string, qos: 0 | 1 | 2 = 0): Promise<void> {
  const client = clients.get(sessionId);
  if (!client) throw new Error(`Unknown MQTT session ${sessionId}`);
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos }, (err) => (err ? reject(err) : resolve()));
  });
}

export function mqttUnsubscribe(sessionId: string, topic: string): Promise<void> {
  const client = clients.get(sessionId);
  if (!client) throw new Error(`Unknown MQTT session ${sessionId}`);
  return new Promise((resolve, reject) => {
    client.unsubscribe(topic, (err) => (err ? reject(err as Error | undefined) : resolve()));
  });
}

export function mqttClose(sessionId: string): void {
  clients.get(sessionId)?.end(true);
  clients.delete(sessionId);
}

export function mqttStatus(sessionId: string): boolean {
  return clients.get(sessionId)?.connected ?? false;
}

/** One-shot publish helper (connect → publish → optionally wait → disconnect). */
export async function mqttOneShot(config: MqttConfig, emit: SessionEmitter): Promise<{ sessionId: string; ts: string }> {
  const { sessionId } = await mqttConnect(config, emit);
  try {
    if (config.topic) await mqttPublish(sessionId, config.topic, '', config.qos ?? 0, config.retain ?? false);
    return { sessionId, ts: now() };
  } finally {
    // leave session open if subscribe topics configured
    if (!config.subscribeTopics?.length) mqttClose(sessionId);
  }
}
