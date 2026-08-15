import {
  Annotation,
  Command,
  END,
  MemorySaver,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph'
import type { ApprovalRequest, RunEvent } from '@papyrus/core'

const RunState = Annotation.Root({
  runId: Annotation<string>,
  request: Annotation<string>,
  plan: Annotation<string[]>({ reducer: (_left, right) => right, default: () => [] }),
  cursor: Annotation<number>({ reducer: (_left, right) => right, default: () => 0 }),
  requiresApproval: Annotation<boolean>({ reducer: (_left, right) => right, default: () => false }),
  output: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
})

function plan(state: typeof RunState.State) {
  return {
    plan: [
      'Understand the requested outcome',
      'Apply policy and select tools',
      'Produce a reviewable artifact',
    ],
    requiresApproval: /\b(send|submit|delete|publish|external|credential)\b/i.test(state.request),
  }
}

function policy(state: typeof RunState.State) {
  if (!state.requiresApproval) return {}
  const request: ApprovalRequest = {
    id: `approval-${state.runId}`,
    runId: state.runId,
    eventId: '',
    requestedBy: 'agent:orchestrator',
    action: state.request,
    reason: 'This action can affect an external system or protected information.',
    risk: 'moderate',
    requestedAt: new Date().toISOString(),
  }
  const decision = interrupt(request) as { decision?: string }
  if (decision?.decision !== 'approved') throw new Error('Run was not approved')
  return { requiresApproval: false }
}

function complete(state: typeof RunState.State) {
  return { cursor: state.plan.length }
}

export function createPapyrusRunGraph() {
  return new StateGraph(RunState)
    .addNode('plan', plan)
    .addNode('policy', policy)
    .addNode('complete', complete)
    .addEdge(START, 'plan')
    .addEdge('plan', 'policy')
    .addEdge('policy', 'complete')
    .addEdge('complete', END)
    .compile({ checkpointer: new MemorySaver() })
}

let runtimeGraph: ReturnType<typeof createPapyrusRunGraph> | undefined
function getRuntimeGraph() {
  if (!runtimeGraph) runtimeGraph = createPapyrusRunGraph()
  return runtimeGraph
}

export async function startPapyrusRun(runId: string, request: string) {
  return getRuntimeGraph().invoke({ runId, request }, { configurable: { thread_id: runId } })
}

export async function resumePapyrusRun(
  runId: string,
  request: string,
  decision: 'approved' | 'rejected',
) {
  const config = { configurable: { thread_id: runId } }
  try {
    return await getRuntimeGraph().invoke(new Command({ resume: { decision } }), config)
  } catch {
    // Reconstruct the interrupt from the durable request after a daemon restart.
    await getRuntimeGraph().invoke({ runId, request }, config)
    return getRuntimeGraph().invoke(new Command({ resume: { decision } }), config)
  }
}

export function eventFor<T extends Record<string, unknown>>(
  runId: string,
  sequence: number,
  kind: RunEvent<T>['kind'],
  payload: T,
): RunEvent<T> {
  return {
    schema: 'papyrus.run-event/v1',
    id: `event-${runId}-${sequence}`,
    runId,
    sequence,
    kind,
    actor: 'agent:orchestrator',
    occurredAt: new Date().toISOString(),
    payload,
  }
}
