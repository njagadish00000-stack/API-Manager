/**
 * AI assistant (§?): OpenAI-compatible chat completions with streaming
 * token events (ai.token), Anthropic Messages API adapter, usage capture,
 * and a pluggable provider list. Designed for local/self-hosted endpoints
 * (LM Studio, Ollama /v1) and hosted providers — no hard-coded vendor.
 */
import { request } from 'undici';
import { randomUUID } from 'node:crypto';
import type { AiConfig } from '../../shared/types';


export interface AiProviderInfo { id: string; label: string; baseUrl: string }

export function listProviders(): AiProviderInfo[] {
  return [
    { id: 'openai-compatible', label: 'OpenAI-compatible', baseUrl: 'https://api.openai.com/v1' },
    { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1' },
    { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
    { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com' },
    { id: 'custom', label: 'Custom', baseUrl: '' },
  ];
}

export interface AiMessage { role: string; content: string }
export interface AiSendResult { sessionId: string; content: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }

export interface AiDeps {
  resolveSecret: (secretId?: string) => string | undefined;
  emit: (type: 'ai.token', payload: { sessionId: string; token: string }) => void;
}

export async function aiSend(args: { config: AiConfig; messages: AiMessage[]; sessionId?: string }, deps: AiDeps): Promise<AiSendResult> {
  const sessionId = args.sessionId ?? randomUUID();
  const apiKey = deps.resolveSecret(args.config.apiKeySecretId);
  if (args.config.provider === 'anthropic') {
    return anthropicSend(sessionId, args.config, args.messages, apiKey, deps);
  }
  return openAiCompatibleSend(sessionId, args.config, args.messages, apiKey, deps);
}

async function openAiCompatibleSend(sessionId: string, config: AiConfig, messages: AiMessage[], apiKey: string | undefined, deps: AiDeps): Promise<AiSendResult> {
  const base = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: config.systemPrompt ? [{ role: 'system', content: config.systemPrompt }, ...messages] : messages,
    temperature: config.temperature ?? 0.2,
    stream: true,
  };
  if (config.maxTokens) body.max_tokens = config.maxTokens;

  const res = await request(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`AI provider error (HTTP ${res.statusCode}): ${text.slice(0, 400)}`);
  }
  const contentType = String(res.headers['content-type'] ?? '');
  if (contentType.includes('text/event-stream')) {
    let content = '';
    let usage: AiSendResult['usage'];
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            deps.emit('ai.token', { sessionId, token: delta });
          }
          if (parsed.usage) {
            usage = { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens, totalTokens: parsed.usage.total_tokens };
          }
        } catch { /* partial JSON → keep buffering next chunk */ }
      }
    }
    return { sessionId, content, usage };
  }
  const text = await res.body.text();
  const parsed = JSON.parse(text) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  return {
    sessionId,
    content: parsed.choices?.[0]?.message?.content ?? '',
    usage: parsed.usage ? { promptTokens: parsed.usage.prompt_tokens, completionTokens: parsed.usage.completion_tokens, totalTokens: parsed.usage.total_tokens } : undefined,
  };
}

async function anthropicSend(sessionId: string, config: AiConfig, messages: AiMessage[], apiKey: string | undefined, deps: AiDeps): Promise<AiSendResult> {
  if (!apiKey) throw new Error('anthropic provider requires an API key (set apiKeySecretId)');
  const base = (config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const body = {
    model: config.model || 'claude-3-5-sonnet-20241022',
    messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    system: config.systemPrompt,
    max_tokens: config.maxTokens ?? 4096,
    temperature: config.temperature ?? 0.2,
    stream: true,
  };
  const res = await request(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (res.statusCode >= 300) {
    const text = await res.body.text();
    throw new Error(`anthropic error (HTTP ${res.statusCode}): ${text.slice(0, 400)}`);
  }
  let content = '';
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const parsed = JSON.parse(data) as { type?: string; delta?: { type?: string; text?: string } };
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          content += parsed.delta.text;
          deps.emit('ai.token', { sessionId, token: parsed.delta.text });
        }
      } catch { /* partial */ }
    }
  }
  return { sessionId, content };
}

export function aiPromptTemplates(): { id: string; label: string; template: string }[] {
  return [
    { id: 'gen-tests', label: 'Generate tests for this request', template: 'Generate JavaScript post-response tests (pm.test style) for the following API request and expected behavior:\n\n{{context}}' },
    { id: 'explain', label: 'Explain this payload', template: 'Explain the following JSON payload structure and its purpose:\n\n{{context}}' },
    { id: 'gen-schema', label: 'Generate JSON schema', template: 'Generate a JSON Schema (draft 2020-12) for:\n\n{{context}}' },
    { id: 'mock-data', label: 'Generate mock data', template: 'Generate realistic mock JSON data for this schema/example:\n\n{{context}}' },
    { id: 'docstring', label: 'Write documentation', template: 'Write concise markdown documentation for the following request:\n\n{{context}}' },
    { id: 'code-fix', label: 'Fix my script', template: 'The following script fails. Explain the error and provide a fixed version:\n\n{{context}}\n\nError:\n{{error}}' },
    { id: 'assertions', label: 'Propose assertions', template: 'Suggest important assertions for this HTTP request/response:\n\n{{context}}' },
  ];
}
