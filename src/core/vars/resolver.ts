/**
 * Variable resolution engine.
 * Scope precedence (highest wins): script > local > data > request > folder > collection > environment > workspace > global > dynamic(fallback).
 * Supports nested references with cycle detection and resolution tracing.
 */
import type { ResolutionTraceEntry, ResolveResult, VariableScope } from '../../shared/types';
import { evalDynamic, isDynamic } from './dynamic';

export interface ScopeVar { value: string; isSecret?: boolean; enabled?: boolean; }
export interface ScopeSource {
  scope: VariableScope;
  sourceId?: string;
  sourceName?: string;
  vars: Record<string, ScopeVar>;
}

export const SCOPE_ORDER: VariableScope[] = [
  'dynamic', 'global', 'workspace', 'environment', 'collection', 'folder', 'request', 'data', 'local', 'script',
];

export const VAR_RE = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

export function findVariables(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  const re = new RegExp(VAR_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return `${'•'.repeat(Math.min(12, value.length - 2))}${value.slice(-2)}`;
}

function scopePriority(scope: VariableScope): number { return SCOPE_ORDER.indexOf(scope); }

/** Build a lookup chain sorted highest-precedence-first. */
export function buildChain(sources: ScopeSource[]): ScopeSource[] {
  return [...sources].sort((a, b) => scopePriority(b.scope) - scopePriority(a.scope));
}

export interface ResolverOptions {
  /** unresolved variable policy (default 'keep') */
  unresolved?: 'keep' | 'empty';
  maxDepth?: number;
}

export class VariableResolver {
  private chain: ScopeSource[];
  private opts: Required<ResolverOptions>;
  dynamicValues: Record<string, string> = {};

  constructor(sources: ScopeSource[], opts: ResolverOptions = {}) {
    this.chain = buildChain(sources);
    this.opts = { unresolved: opts.unresolved ?? 'keep', maxDepth: opts.maxDepth ?? 12 };
  }

  lookupRaw(name: string, trace?: ResolutionTraceEntry[]): { value: string; source?: ScopeSource; secret: boolean } | undefined {
    for (const source of this.chain) {
      const v = source.vars[name];
      if (v && v.enabled !== false) {
        trace?.push({
          variable: name, scope: source.scope, sourceId: source.sourceId, sourceName: source.sourceName,
          valueMasked: v.isSecret ? maskSecret(v.value) : v.value, found: true,
        });
        return { value: v.value, source, secret: !!v.isSecret };
      }
    }
    return undefined;
  }

  /** Resolve a single variable with nested resolution + cycle detection. */
  resolveValue(name: string, trace: ResolutionTraceEntry[], stack: string[], depth: number): { value: string | undefined; cycles: string[] } {
    const cycles: string[] = [];
    if (stack.includes(name)) {
      cycles.push([...stack, name].join(' -> '));
      return { value: undefined, cycles };
    }
    if (depth > this.opts.maxDepth) return { value: undefined, cycles };

    if (isDynamic(name)) {
      const dyn = evalDynamic(name);
      if (dyn !== undefined) {
        this.dynamicValues[name] = dyn;
        trace.push({ variable: name, scope: 'dynamic', valueMasked: dyn, found: true });
        return { value: dyn, cycles };
      }
    }

    const hit = this.lookupRaw(name, trace);
    if (!hit) {
      trace.push({ variable: name, scope: 'dynamic', valueMasked: '', found: false });
      return { value: undefined, cycles };
    }
    // Nested references inside the value
    const nested = findVariables(hit.value);
    if (nested.length === 0) return { value: hit.value, cycles };
    let out = hit.value;
    for (const n of nested) {
      const sub = this.resolveValue(n, trace, [...stack, name], depth + 1);
      cycles.push(...sub.cycles);
      if (sub.value !== undefined) {
        out = out.replace(new RegExp(`\\{\\{\\s*${escapeRe(n)}\\s*\\}\\}`, 'g'), sub.value);
      }
    }
    return { value: out, cycles };
  }

  resolve(text: string): ResolveResult {
    const trace: ResolutionTraceEntry[] = [];
    const unresolved: string[] = [];
    const cycles: string[] = [];
    const names = findVariables(text ?? '');
    const values = new Map<string, string | undefined>();
    for (const n of names) {
      if (!values.has(n)) {
        const r = this.resolveValue(n, trace, [], 0);
        values.set(n, r.value);
        cycles.push(...r.cycles);
        if (r.value === undefined && !isDynamic(n)) unresolved.push(n);
      }
    }
    let resolved = text ?? '';
    for (const [n, v] of values) {
      if (v !== undefined) {
        resolved = resolved.replace(new RegExp(`\\{\\{\\s*${escapeRe(n)}\\s*\\}\\}`, 'g'), v);
      } else if (this.opts.unresolved === 'empty') {
        resolved = resolved.replace(new RegExp(`\\{\\{\\s*${escapeRe(n)}\\s*\\}\\}`, 'g'), '');
      }
    }
    return { resolved, trace, unresolved, cycles: [...new Set(cycles)], dynamicUsed: this.dynamicValues };
  }

  /** Get the effective value of a single variable, fully resolved. */
  get(name: string): { value: string | undefined; trace: ResolutionTraceEntry[] } {
    const trace: ResolutionTraceEntry[] = [];
    const r = this.resolveValue(name, trace, [], 0);
    return { value: r.value, trace };
  }
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Flatten sources to a simple key→value map (highest precedence wins). */
export function flatten(sources: ScopeSource[]): Record<string, string> {
  const chain = buildChain(sources);
  const out: Record<string, string> = {};
  for (const s of [...chain].reverse()) {
    for (const [k, v] of Object.entries(s.vars)) if (v.enabled !== false) out[k] = v.value;
  }
  return out;
}

/** Compute dependency edges: variable -> variables referenced in its value. */
export function dependencies(vars: Record<string, string>): { nodes: string[]; edges: { from: string; to: string }[]; cycles: string[][] } {
  const nodes = Object.keys(vars);
  const edges: { from: string; to: string }[] = [];
  for (const [k, v] of Object.entries(vars)) {
    for (const ref of findVariables(v)) edges.push({ from: k, to: ref });
  }
  const cycles = findCycles(nodes, edges);
  return { nodes, edges, cycles };
}

function findCycles(nodes: string[], edges: { from: string; to: string }[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const path: string[] = [];
  const dfs = (n: string) => {
    state.set(n, 'visiting');
    path.push(n);
    for (const next of adj.get(n) ?? []) {
      if (!nodes.includes(next)) continue;
      if (state.get(next) === 'visiting') {
        const i = path.indexOf(next);
        cycles.push([...path.slice(i), next]);
      } else if (!state.get(next)) dfs(next);
    }
    path.pop();
    state.set(n, 'done');
  };
  for (const n of nodes) if (!state.get(n)) dfs(n);
  return cycles;
}
