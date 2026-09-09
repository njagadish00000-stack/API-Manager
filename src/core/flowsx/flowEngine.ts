/**
 * Flow execution engine (§54). Traverses a flow graph, executing nodes in
 * topological order with control flow (conditions, loops, branches, delays,
 * retries, assertions, scripts, subflows). Pure — the caller injects
 * sendRequest + script execution.
 */
import type { Flow, FlowNode, FlowRunLog, ApiResponse, TestResult } from '../../shared/types';
import { uid } from '../../shared/ids';
import { VariableResolver } from '../vars/resolver';
import { evaluateAssertions } from '../assert/assertions';
import { now } from '../../shared/types';

export interface FlowRuntime {
  sendRequest: (requestId: string, variables: Record<string, string>) => Promise<{ response?: ApiResponse; tests: TestResult[]; error?: string }>;
  runScript: (code: string, variables: Record<string, string>) => Promise<{ variables: Record<string, string>; logs: string[] }>;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  onNode?: (entry: FlowRunLog) => void;
  shouldStop?: () => boolean;
  breakpoints?: Set<string>;
  onBreakpoint?: (nodeId: string, variables: Record<string, string>) => Promise<void>;
}

export interface FlowRunOutcome { status: 'completed' | 'failed' | 'stopped'; nodeLogs: FlowRunLog[]; variables: Record<string, string>; error?: string }

export async function executeFlow(flow: Flow, runtime: FlowRuntime, initialVars: Record<string, string> = {}): Promise<FlowRunOutcome> {
  const vars: Record<string, string> = { ...initialVars };
  for (const v of flow.variables ?? []) if (v.enabled) vars[v.key] = vars[v.key] ?? v.value;
  const nodeLogs: FlowRunLog[] = [];
  const nodesById = new Map(flow.nodes.map((n) => [n.id, n]));
  const edgesFrom = new Map<string, { target: string; label?: string; sourceHandle?: string }[]>();
  for (const e of flow.edges) {
    if (!edgesFrom.has(e.source)) edgesFrom.set(e.source, []);
    edgesFrom.get(e.source)!.push({ target: e.target, label: e.label, sourceHandle: e.sourceHandle });
  }

  const emits = (entry: FlowRunLog) => { nodeLogs.push(entry); runtime.onNode?.(entry); };

  let current: FlowNode | undefined = flow.nodes.find((n) => !flow.edges.some((e) => e.target === n.id)) ?? flow.nodes[0];
  const maxSteps = 10_000;
  let steps = 0;
  const visitCounts = new Map<string, number>();

  while (current && steps++ < maxSteps) {
    if (runtime.shouldStop?.()) return { status: 'stopped', nodeLogs, variables: vars };
    const node = current;
    const startedAt = now();
    const t0 = Date.now();
    const logLines: string[] = [];
    let output: unknown;
    let failed: string | undefined;
    let skipped = false;

    visits(node, visitCounts);
    if ((visitCounts.get(node.id) ?? 0) > 500) {
      return { status: 'failed', nodeLogs, variables: vars, error: `Node "${node.label}" executed more than 500 times (possible infinite loop)` };
    }

    if (runtime.breakpoints?.has(node.id) && runtime.onBreakpoint) {
      await runtime.onBreakpoint(node.id, vars);
    }

    try {
      output = await executeNode(node, vars, runtime, flow, logLines, (o) => { output = o; });
      if (output === '__skip__') { skipped = true; output = undefined; }
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }

    const entry: FlowRunLog = {
      nodeId: node.id,
      status: failed ? 'failed' : skipped ? 'skipped' : 'success',
      startedAt, durationMs: Date.now() - t0,
      input: node.config, output, error: failed, log: logLines.length ? logLines : undefined,
    };
    emits(entry);
    if (failed && node.type !== 'condition') {
      const onErr = nextAfter(node, edgesFrom, 'error');
      if (!onErr) return { status: 'failed', nodeLogs, variables: vars, error: failed };
      current = nodesById.get(onErr);
      continue;
    }
    // choose next
    let nextId = nextAfter(node, edgesFrom, branchHandle(node, output, failed));
    if (!nextId) nextId = nextAfter(node, edgesFrom);
    current = nextId ? nodesById.get(nextId) : undefined;
  }
  return { status: 'completed', nodeLogs, variables: vars };
}

function visits(node: FlowNode, counts: Map<string, number>): void {
  counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
}

function nextAfter(node: FlowNode, edgesFrom: Map<string, { target: string; label?: string; sourceHandle?: string }[]>, handle?: string): string | undefined {
  const edges = edgesFrom.get(node.id) ?? [];
  if (handle) {
    const byHandle = edges.find((e) => e.sourceHandle === handle) ?? edges.find((e) => e.label === handle);
    if (byHandle) return byHandle.target;
  }
  return edges.find((e) => !e.sourceHandle && !e.label)?.target ?? edges[0]?.target;
}

function branchHandle(node: FlowNode, output: unknown, failed?: string): string | undefined {
  if (node.type === 'condition' || node.type === 'branch') {
    if (failed) return 'error';
    return output === true || output === 'true' ? 'true' : 'false';
  }
  return failed ? 'error' : undefined;
}

async function executeNode(
  node: FlowNode,
  vars: Record<string, string>,
  rt: FlowRuntime,
  _flow: Flow,
  logs: string[],
  _setOut: (o: unknown) => void,
): Promise<unknown> {
  const cfg = node.config ?? {};
  const str = (k: string, dflt = '') => String(cfg[k] ?? dflt);
  const num = (k: string, dflt = 0) => Number(cfg[k] ?? dflt);

  switch (node.type) {
    case 'request': {
      const requestId = str('requestId');
      if (!requestId) throw new Error('No request selected for the node');
      const res = await rt.sendRequest(requestId, { ...vars });
      if (res.error) throw new Error(res.error);
      const response = res.response;
      // map response fields into variables
      if (response) {
        vars[`${node.id}.status`] = String(response.status);
        vars[`${node.id}.body`] = response.bodyText ?? '';
        vars[`${node.id}.time`] = String(response.timing.totalMs);
        if (str('saveBodyToVariable')) vars[str('saveBodyToVariable')] = response.bodyText ?? '';
        if (str('saveJsonPathToVariable')) {
          try {
            const parsed = JSON.parse(response.bodyText ?? '') as unknown;
            const { getByPath } = await import('../jsonx/jsonUtils');
            const val = getByPath(parsed, str('jsonPath'));
            if (val !== undefined) vars[str('saveJsonPathToVariable')] = typeof val === 'string' ? val : JSON.stringify(val);
          } catch { /* not json */ }
        }
      }
      const failedTests = res.tests.filter((t) => !t.passed);
      logs.push(`${response?.status ?? '?'} in ${response?.timing.totalMs ?? '?'}ms, ${res.tests.length} tests (${failedTests.length} failed)`);
      if (failedTests.length > 0 && str('failOnTestFailure', 'false') === 'true') throw new Error(`${failedTests.length} test(s) failed`);
      return { status: response?.status, durationMs: response?.timing.totalMs, tests: res.tests.length, failed: failedTests.length };
    }
    case 'condition': {
      const expr = str('expression');
      const resolver = new VariableResolver([{ scope: 'local', vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v }])) }]);
      const resolved = resolver.resolve(expr).resolved;
      const result = truthy(resolved);
      logs.push(`condition "${expr}" → ${resolved} → ${result}`);
      return result;
    }
    case 'branch': {
      const expr = str('expression');
      const resolver = new VariableResolver([{ scope: 'local', vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v }])) }]);
      const resolved = resolver.resolve(expr).resolved;
      logs.push(`branch "${expr}" → ${resolved}`);
      return resolved;
    }
    case 'loop': {
      // loop semantics handled by graph structure via connector handles; here act as pass-through counter
      const max = num('maxIterations', 10);
      const key = `__loop_${node.id}`;
      const cur = Number(vars[key] ?? 0) + 1;
      vars[key] = String(cur);
      const again = cur <= max;
      logs.push(`loop iteration ${cur}/${max}${again ? ' (continue)' : ' (exit)'}`);
      return again ? 'true' : 'false';
    }
    case 'variable': {
      const name = str('name');
      const value = str('value');
      const resolver = new VariableResolver([{ scope: 'local', vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v }])) }]);
      if (!name) throw new Error('Variable node missing name');
      vars[name] = resolver.resolve(value).resolved;
      logs.push(`set ${name}=${vars[name]}`);
      return { [name]: vars[name] };
    }
    case 'transform': {
      const code = str('code');
      const res = await rt.runScript(code, { ...vars });
      Object.assign(vars, res.variables);
      logs.push(...res.logs);
      return res.variables;
    }
    case 'script': {
      const code = str('code');
      const res = await rt.runScript(code, { ...vars });
      Object.assign(vars, res.variables);
      logs.push(...res.logs);
      return res.variables;
    }
    case 'delay': {
      const ms = num('ms', 1000);
      logs.push(`delaying ${ms}ms`);
      await rt.sleep(Math.min(ms, 60_000));
      return { delayed: ms };
    }
    case 'assertion': {
      const varName = str('responseVariable') || Object.keys(vars).find((k) => k.endsWith('.status'))?.replace('.status', '') || '';
      const bodyVar = vars[`${varName}.body`];
      const assertions = (cfg.assertions as import('../../shared/types').Assertion[] | undefined) ?? [];
      const fakeResponse = {
        id: uid(), status: Number(vars[`${varName}.status`] ?? 0), statusText: '', httpVersion: '',
        headers: [], cookies: [], bodyText: bodyVar ?? '', bodyIsBinary: false, bodySize: bodyVar?.length ?? 0,
        timing: { totalMs: Number(vars[`${varName}.time`] ?? 0) }, redirects: [], retryAttempts: [], timestamp: now(),
      };
      const results = evaluateAssertions(assertions, fakeResponse);
      const failed = results.filter((r) => !r.passed);
      logs.push(...results.map((r) => `${r.passed ? '✓' : '✗'} ${r.name}${r.error ? ` — ${r.error}` : ''}`));
      if (failed.length > 0) throw new Error(`${failed.length} assertion(s) failed: ${failed[0].error}`);
      return results;
    }
    case 'retry': {
      const attempts = num('maxRetries', 3);
      const delayMs = num('delayMs', 500);
      const requestId = str('requestId');
      let lastErr: string | undefined;
      for (let i = 1; i <= attempts; i++) {
        try {
          const res = await rt.sendRequest(requestId, { ...vars });
          if (!res.error) { logs.push(`attempt ${i} succeeded`); return { attempt: i, status: res.response?.status }; }
          lastErr = res.error;
        } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
        logs.push(`attempt ${i} failed: ${lastErr}`);
        if (i < attempts) await rt.sleep(delayMs * i);
      }
      throw new Error(`All ${attempts} attempts failed. Last error: ${lastErr}`);
    }
    case 'merge': {
      logs.push('merge');
      return { merged: true };
    }
    case 'output': {
      const template = str('template');
      const resolver = new VariableResolver([{ scope: 'local', vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v }])) }]);
      const out = template ? resolver.resolve(template).resolved : JSON.stringify(vars, null, 2);
      rt.log(out);
      logs.push(out);
      return out;
    }
    case 'subflow': {
      // the runtime expands subflows by inlining; if not expanded, run fallback
      logs.push(`subflow ${str('flowId')} (handled by runtime)`);
      return {};
    }
    case 'webhook': case 'database': case 'file': {
      logs.push(`${node.type} node executes via runtime services; mark as pass-through here`);
      return {};
    }
    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}

function truthy(v: string): boolean {
  const t = v.trim().toLowerCase();
  return !(t === '' || t === 'false' || t === '0' || t === 'null' || t === 'undefined' || t === 'no');
}

export const FLOW_NODE_CATALOG: { type: FlowNode['type']; label: string; description: string; defaults: Record<string, unknown> }[] = [
  { type: 'request', label: 'Request', description: 'Send a saved request', defaults: { requestId: '' } },
  { type: 'condition', label: 'Condition', description: 'True/false branch on an expression', defaults: { expression: '{{status}} == 200' } },
  { type: 'loop', label: 'Loop', description: 'Repeat a branch N times', defaults: { maxIterations: 10 } },
  { type: 'variable', label: 'Set Variable', description: 'Assign a flow variable', defaults: { name: 'myVar', value: '{{$uuid}}' } },
  { type: 'transform', label: 'Transform', description: 'JS snippet to transform variables', defaults: { code: 'vars.result = vars.input;' } },
  { type: 'script', label: 'Script', description: 'Run a JavaScript snippet', defaults: { code: 'console.log(vars);' } },
  { type: 'delay', label: 'Delay', description: 'Wait N milliseconds', defaults: { ms: 1000 } },
  { type: 'retry', label: 'Retry', description: 'Retry a request with backoff', defaults: { requestId: '', maxRetries: 3, delayMs: 500 } },
  { type: 'assertion', label: 'Assertion', description: 'Assert on flow variables', defaults: { assertions: [] } },
  { type: 'branch', label: 'Branch', description: 'Route by value', defaults: { expression: '{{status}}' } },
  { type: 'merge', label: 'Merge', description: 'Join branches', defaults: {} },
  { type: 'output', label: 'Output', description: 'Emit a value to the flow log', defaults: { template: '{{vars}}' } },
];
