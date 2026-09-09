/**
 * MCP (Model Context Protocol) client (§61-ish): JSON-RPC 2.0 over stdio
 * (child process) or HTTP+SSE, with tool listing/calling — gated by an
 * explicit opt-in allowlist and per-call confirmation from the UI.
 */
import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { McpConfig } from '../../shared/types';
import { request } from 'undici';

export interface McpTool { name: string; description?: string; schema?: string }
export interface McpResource { uri: string; name?: string }
export interface McpPrompt { name: string; description?: string }

interface McpSession {
  id: string;
  config: McpConfig;
  process?: ChildProcess;
  endpoint?: string;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  nextId: number;
  buffer: string;
  closed: boolean;
}

const sessions = new Map<string, McpSession>();

function jsonRpc(session: McpSession, method: string, params?: unknown): Promise<unknown> {
  if (session.closed) return Promise.reject(new Error('MCP session closed'));
  const id = session.nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => {
    session.pending.set(id, { resolve, reject });
    if (session.config.transport === 'stdio' && session.process) {
      try {
        session.process.stdin?.write(payload + '\n');
      } catch (e) { session.pending.delete(id); reject(e as Error); }
    } else if (session.endpoint) {
      void request(session.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: payload,
      }).then(async (res) => {
        const text = await res.body.text();
        try { session.pending.get(id)?.resolve(parseRpcResponse(text, id)); } catch (e) { session.pending.get(id)?.reject(e as Error); }
        session.pending.delete(id);
      }).catch((e) => { session.pending.get(id)?.reject(e as Error); session.pending.delete(id); });
    }
    setTimeout(() => {
      if (session.pending.delete(id)) reject(new Error(`MCP call timed out: ${method}`));
    }, 30_000);
  });
}

function parseRpcResponse(text: string, expectId: number): unknown {
  const parsed = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
  if (parsed.error) throw new Error(parsed.error.message ?? 'MCP error');
  if (parsed.id !== undefined && parsed.id !== expectId) throw new Error('MCP id mismatch');
  return parsed.result;
}

export async function mcpConnect(config: McpConfig, sessionId?: string): Promise<{ sessionId: string }> {
  if (config.transport === 'stdio' && !config.command) throw new Error('stdio transport requires command');
  if (config.transport === 'sse' && !config.endpoint) throw new Error('sse transport requires endpoint');
  const id = sessionId ?? randomUUID();
  if (sessions.has(id)) throw new Error(`Session ${id} exists`);

  const session: McpSession = { id, config, pending: new Map(), nextId: 1, buffer: '', closed: false };
  if (config.transport === 'stdio') {
    const child = spawn(config.command!, config.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] });
    session.process = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      session.buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, idx).trim();
        session.buffer = session.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
          if (msg.id !== undefined) {
            const pending = session.pending.get(msg.id);
            if (pending) {
              session.pending.delete(msg.id);
              if (msg.error) pending.reject(new Error(msg.error.message ?? 'MCP error'));
              else pending.resolve(msg.result);
            }
          }
        } catch { /* skip malformed line */ }
      }
    });
    child.on('exit', () => { session.closed = true; });
  } else {
    session.endpoint = config.endpoint;
  }
  sessions.set(id, session);
  // initialize handshake
  await jsonRpc(session, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {}, resources: {}, prompts: {} },
    clientInfo: { name: 'api-manager', version: '1.0.0' },
  });
  return { sessionId: id };
}

export async function mcpListTools(sessionId: string): Promise<{ tools: McpTool[] }> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown MCP session ${sessionId}`);
  const result = await jsonRpc(session, 'tools/list') as { tools?: { name: string; description?: string; inputSchema?: unknown }[] } | undefined;
  return { tools: (result?.tools ?? []).map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema ? JSON.stringify(t.inputSchema) : undefined })) };
}

export async function mcpCallTool(sessionId: string, name: string, argsJson: string, confirmed: boolean): Promise<{ content: string }> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown MCP session ${sessionId}`);
  if (!confirmed && !session.config.allowlisted) throw new Error('Tool call requires explicit confirmation (set confirmed=true) or allowlisted session');
  let args: unknown = {};
  try { args = argsJson.trim() ? JSON.parse(argsJson) : {}; } catch { throw new Error('argsJson is not valid JSON'); }
  const result = await jsonRpc(session, 'tools/call', { name, arguments: args });
  return { content: JSON.stringify(result, null, 2) };
}

export async function mcpListResources(sessionId: string): Promise<{ resources: McpResource[] }> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown MCP session ${sessionId}`);
  const result = await jsonRpc(session, 'resources/list') as { resources?: { uri: string; name?: string }[] } | undefined;
  return { resources: result?.resources ?? [] };
}

export async function mcpListPrompts(sessionId: string): Promise<{ prompts: McpPrompt[] }> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown MCP session ${sessionId}`);
  const result = await jsonRpc(session, 'prompts/list') as { prompts?: { name: string; description?: string }[] } | undefined;
  return { prompts: result?.prompts ?? [] };
}

export function mcpClose(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.closed = true;
  if (session.process) { try { session.process.kill(); } catch { /* ignore */ } }
  for (const pending of session.pending.values()) pending.reject(new Error('session closed'));
  session.pending.clear();
  sessions.delete(sessionId);
}
