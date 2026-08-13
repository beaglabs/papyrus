/**
 * Browser-safe contracts for durable Papyrus agent runs.
 *
 * Phase 1 defines the protocol only. Later phases provide the LangGraph
 * executor, Stagehand sessions, intake controls, and CAPE workflow packs.
 */

export const RUN_EVENT_VERSION = 'papyrus.run-event/v1' as const

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type RunEventKind =
  | 'run.created'
  | 'run.started'
  | 'run.status'
  | 'run.message.delta'
  | 'run.plan.updated'
  | 'tool.requested'
  | 'tool.started'
  | 'tool.output'
  | 'tool.completed'
  | 'tool.failed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'artifact.created'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'

export type SessionKind = 'browser' | 'document' | 'data' | 'files' | 'terminal' | 'evidence'

export interface PapyrusRun {
  id: string
  organizationId: string
  projectId: string
  threadId: string
  requestedBy: string
  title: string
  status: RunStatus
  classification: string
  model?: string
  skillIds: string[]
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface RunEvent<TPayload = Record<string, unknown>> {
  schema: typeof RUN_EVENT_VERSION
  id: string
  runId: string
  sequence: number
  kind: RunEventKind
  actor: string
  occurredAt: string
  payload: TPayload
}

export interface ToolSession {
  id: string
  runId: string
  kind: SessionKind
  title: string
  status: 'starting' | 'active' | 'paused' | 'closed' | 'failed'
  classification: string
  startedAt: string
  updatedAt: string
  endedAt?: string
}

export interface ApprovalRequest {
  id: string
  runId: string
  eventId: string
  requestedBy: string
  action: string
  reason: string
  risk: 'low' | 'moderate' | 'high'
  requestedAt: string
  expiresAt?: string
}

export interface ApprovalDecision {
  requestId: string
  decision: 'approved' | 'rejected' | 'modified'
  decidedBy: string
  decidedAt: string
  modification?: Record<string, unknown>
  rationale?: string
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
