/**
 * Flow execution service: bridges the pure flow engine to the send pipeline,
 * script transforms, waits, node events (flow.node), breakpoints and stop.
 */
import type { ApiRequest, Flow, FlowRun, FlowRunLog } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';
import { executeFlow, FlowRunOutcome } from '../../core/flowsx/flowEngine';
import { executeRequest, PipelineDeps } from '../http/sendPipeline';
import { runTransformScript } from '../scripts/sandbox';

export interface FlowRunnerDeps extends PipelineDeps {
  getRequest: (id: string) => ApiRequest | undefined;
  saveFlowRun: (flowId: string, run: FlowRun, workspaceId?: string) => void;
  emitNode: (ev: { runId: string; flowId: string; node: FlowRunLog }) => void;
}

interface ActiveFlowRun { id: string; flowId: string; stop: boolean }

const activeRuns = new Map<string, ActiveFlowRun>();

export function stopFlowRun(runId: string): void {
  const r = activeRuns.get(runId);
  if (r) r.stop = true;
}

export function startFlowRun(args: { flow: Flow; variables?: Record<string, string>; environmentId?: string; breakpoints?: string[] },
  deps: FlowRunnerDeps): { runId: string } {
  const runId = uid();
  const active: ActiveFlowRun = { id: runId, flowId: args.flow.id, stop: false };
  activeRuns.set(runId, active);
  const startedAt = now();
  void (async () => {
    const outcome: FlowRunOutcome = await executeFlow(args.flow, {
      sendRequest: async (requestId, variables) => {
        const request = deps.getRequest(requestId);
        if (!request) return { error: `Request not found: ${requestId}`, tests: [] };
        const result = await executeRequest(
          { request, environmentId: args.environmentId, overrides: variables },
          deps,
        );
        return { response: result.response, tests: [...result.postTestResults, ...result.assertionResults], error: result.error };
      },
      runScript: async (code, variables) => runTransformScript(code, variables),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      log: () => undefined,
      onNode: (entry) => deps.emitNode({ runId, flowId: args.flow.id, node: entry }),
      shouldStop: () => active.stop,
    }, args.variables ?? {});
    const run: FlowRun = {
      id: runId, flowId: args.flow.id,
      status: outcome.status === 'completed' ? 'completed' : outcome.status === 'stopped' ? 'stopped' : 'failed',
      startedAt, finishedAt: now(),
      nodeLogs: outcome.nodeLogs,
      variables: outcome.variables,
    };
    deps.saveFlowRun(args.flow.id, run, args.flow.workspaceId);
    activeRuns.delete(runId);
  })();
  return { runId };
}
