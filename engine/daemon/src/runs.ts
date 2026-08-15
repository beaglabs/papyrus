import { randomUUID } from 'node:crypto'
import { generateModelText } from '@papyrus/agents/model-provider'
import { resumePapyrusRun, startPapyrusRun } from '@papyrus/agents/run-graph'
import type {
  ApprovalDecision,
  ApprovalRequest,
  PapyrusRun,
  RunEvent,
  ToolSession,
} from '@papyrus/core'
import { getDb } from './database.js'
import { listReleasedContext } from './intake.js'
import { getModelRuntimeProvider } from './model-runtime.js'

export interface RunMessage {
  id: string
  runId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  sources: Array<{ id: string; title: string; kind: string }>
  createdAt: string
}

export interface RunPlanStep {
  id: string
  title: string
  status: 'queued' | 'active' | 'complete' | 'failed'
  detail?: string
}

export interface RunBundle {
  run: PapyrusRun
  request: string
  messages: RunMessage[]
  plan: RunPlanStep[]
  events: RunEvent[]
  approvals: Array<ApprovalRequest & { status: string; decision?: ApprovalDecision }>
  sessions: Array<ToolSession & { metadata: Record<string, unknown>; takeoverBy?: string }>
}

type Subscriber = (event: RunEvent) => void
const subscribers = new Map<string, Set<Subscriber>>()

function mapRun(row: Record<string, unknown>): PapyrusRun {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: String(row.project_id),
    threadId: String(row.thread_id),
    requestedBy: String(row.requested_by),
    title: String(row.title),
    status: row.status as PapyrusRun['status'],
    classification: String(row.classification),
    model: row.model ? String(row.model) : undefined,
    skillIds: JSON.parse(String(row.skill_ids)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
  }
}

function eventFrom(row: Record<string, unknown>): RunEvent {
  return {
    schema: 'papyrus.run-event/v1',
    id: String(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    kind: row.kind as RunEvent['kind'],
    actor: String(row.actor),
    occurredAt: String(row.occurred_at),
    payload: JSON.parse(String(row.payload)),
  }
}

export function appendRunEvent(
  runId: string,
  kind: RunEvent['kind'],
  actor: string,
  payload: Record<string, unknown>,
): RunEvent {
  const db = getDb()
  const event = db
    .transaction((): RunEvent => {
      const sequence = Number(
        (
          db
            .prepare(
              'SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM run_events WHERE run_id=?',
            )
            .get(runId) as { sequence: number }
        ).sequence,
      )
      const created: RunEvent = {
        schema: 'papyrus.run-event/v1',
        id: `event-${randomUUID()}`,
        runId,
        sequence,
        kind,
        actor,
        occurredAt: new Date().toISOString(),
        payload,
      }
      db.prepare(
        'INSERT INTO run_events (id,run_id,sequence,kind,actor,payload,occurred_at) VALUES (?,?,?,?,?,?,?)',
      ).run(created.id, runId, sequence, kind, actor, JSON.stringify(payload), created.occurredAt)
      return created
    })
    .immediate()
  for (const subscriber of subscribers.get(runId) ?? []) subscriber(event)
  return event
}

export function subscribeRun(runId: string, subscriber: Subscriber): () => void {
  const runSubscribers = subscribers.get(runId) ?? new Set<Subscriber>()
  runSubscribers.add(subscriber)
  subscribers.set(runId, runSubscribers)
  return () => {
    runSubscribers.delete(subscriber)
    if (!runSubscribers.size) subscribers.delete(runId)
  }
}

function setRunStatus(runId: string, status: PapyrusRun['status']): void {
  const now = new Date().toISOString()
  getDb()
    .prepare('UPDATE agent_runs SET status=?,updated_at=?,completed_at=? WHERE id=?')
    .run(status, now, ['completed', 'failed', 'cancelled'].includes(status) ? now : null, runId)
  appendRunEvent(runId, 'run.status', 'system:runtime', { status })
}

export function appendRunMessage(
  runId: string,
  role: RunMessage['role'],
  content: string,
  sources: RunMessage['sources'] = [],
): RunMessage {
  const message: RunMessage = {
    id: `message-${randomUUID()}`,
    runId,
    role,
    content,
    sources,
    createdAt: new Date().toISOString(),
  }
  getDb()
    .prepare(
      'INSERT INTO run_messages (id,run_id,role,content,sources_json,created_at) VALUES (?,?,?,?,?,?)',
    )
    .run(message.id, runId, role, content, JSON.stringify(sources), message.createdAt)
  appendRunEvent(runId, 'run.message.delta', role === 'user' ? 'user' : 'agent:orchestrator', {
    messageId: message.id,
    role,
    content,
    sources,
    complete: true,
  })
  return message
}

function setPlan(runId: string, titles: string[], cursor = 0): RunPlanStep[] {
  const plan = titles.map(
    (title, index): RunPlanStep => ({
      id: `step-${index + 1}`,
      title,
      status: index < cursor ? 'complete' : index === cursor ? 'active' : 'queued',
    }),
  )
  const now = new Date().toISOString()
  getDb()
    .prepare(
      'INSERT INTO run_plans (run_id,plan_json,updated_at) VALUES (?,?,?) ON CONFLICT(run_id) DO UPDATE SET plan_json=excluded.plan_json,updated_at=excluded.updated_at',
    )
    .run(runId, JSON.stringify(plan), now)
  appendRunEvent(runId, 'run.plan.updated', 'agent:orchestrator', { plan })
  return plan
}

function saveApproval(runId: string, approval: ApprovalRequest): void {
  const event = appendRunEvent(runId, 'approval.requested', approval.requestedBy, {
    approval: { ...approval, eventId: undefined },
  })
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO approval_requests (id,run_id,event_id,action,reason,risk,status,requested_by,requested_at) VALUES (?,?,?,?,?,?,'pending',?,?)`,
    )
    .run(
      approval.id,
      runId,
      event.id,
      approval.action,
      approval.reason,
      approval.risk,
      approval.requestedBy,
      approval.requestedAt,
    )
}

async function generateRunOutput(runId: string, request: string) {
  const row = getDb()
    .prepare('SELECT organization_id,project_id FROM agent_runs WHERE id=?')
    .get(runId) as { organization_id: string; project_id: string } | undefined
  if (!row) throw new Error('Run not found')
  const provider = getModelRuntimeProvider(row.organization_id)
  if (!provider)
    throw new Error(
      'No model provider is configured. Configure the local Phi endpoint in Administration before starting a run.',
    )
  getDb()
    .prepare('UPDATE agent_runs SET model=?,updated_at=? WHERE id=?')
    .run(provider.model, new Date().toISOString(), runId)
  const released = listReleasedContext(row.organization_id, row.project_id)
  const context = released
    .filter((source) => source.text)
    .map(
      (source) =>
        `SOURCE: ${source.title}\nCLASSIFICATION: ${source.classification}\n${source.text}`,
    )
    .join('\n\n---\n\n')
  appendRunEvent(runId, 'model.requested', 'agent:orchestrator', {
    model: provider.model,
    releasedSourceIds: released.map((source) => source.id),
  })
  const output = await generateModelText(provider, {
    system: `You are Papyrus, a locally operated government business-process agent. Work only from the user's request and the released staging context below. Do not invent records, system actions, identifiers, timestamps, citations, or completion claims. Clearly distinguish proposed work from completed tool actions. Respect classification and require human approval before external writes.\n\nRELEASED STAGING CONTEXT\n${context || '(No released documents are available for this project.)'}`,
    messages: [{ role: 'user', content: request }],
    temperature: 0.2,
    maxOutputTokens: 4096,
  })
  appendRunEvent(runId, 'model.completed', 'agent:orchestrator', { model: provider.model })
  return { output, sources: released.map(({ id, title, kind }) => ({ id, title, kind })) }
}

async function advanceRun(
  runId: string,
  request: string,
  decision?: 'approved' | 'rejected',
): Promise<void> {
  try {
    setRunStatus(runId, 'running')
    const result = decision
      ? await resumePapyrusRun(runId, request, decision)
      : await startPapyrusRun(runId, request)
    const state = result as Record<string, unknown>
    const plan = Array.isArray(state.plan) ? state.plan.map(String) : []
    if (plan.length) setPlan(runId, plan, Number(state.cursor ?? 0))
    const interruption = (
      state.__interrupt__ as Array<{ value?: ApprovalRequest }> | undefined
    )?.[0]?.value
    if (interruption) {
      saveApproval(runId, interruption)
      setRunStatus(runId, 'waiting_for_approval')
      return
    }
    const generated = await generateRunOutput(runId, request)
    appendRunMessage(runId, 'assistant', generated.output, generated.sources)
    setPlan(runId, plan, plan.length)
    setRunStatus(runId, 'completed')
    appendRunEvent(runId, 'run.completed', 'agent:orchestrator', {})
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Run execution failed'
    setRunStatus(runId, decision === 'rejected' ? 'cancelled' : 'failed')
    appendRunMessage(runId, 'system', message)
    appendRunEvent(
      runId,
      decision === 'rejected' ? 'run.cancelled' : 'run.failed',
      'system:runtime',
      { message },
    )
  }
}

export function createRun(input: {
  organizationId: string
  projectId: string
  requestedBy: string
  request: string
  classification?: string
  skillIds?: string[]
}): RunBundle {
  if (!input.request.trim()) throw new Error('A run request is required')
  const classification = (input.classification ?? 'CUI').trim().toUpperCase()
  if (!['UNCLASSIFIED', 'CUI', 'CUI//SP-PRVCY', 'CUI//SP-PROPIN'].includes(classification))
    throw new Error('Unsupported run classification')
  const id = `run-${randomUUID()}`
  const now = new Date().toISOString()
  getDb()
    .prepare(
      `INSERT INTO agent_runs (id,organization_id,project_id,thread_id,requested_by,title,request,status,classification,skill_ids,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'queued',?,?,?,?)`,
    )
    .run(
      id,
      input.organizationId,
      input.projectId,
      `thread-${id}`,
      input.requestedBy,
      input.request.trim().slice(0, 100),
      input.request.trim(),
      classification,
      JSON.stringify(input.skillIds ?? []),
      now,
      now,
    )
  appendRunEvent(id, 'run.created', input.requestedBy, { request: input.request.trim() })
  appendRunMessage(id, 'user', input.request.trim())
  void advanceRun(id, input.request.trim())
  return getRunBundle(id)
}

export function listRuns(projectId: string): PapyrusRun[] {
  return (
    getDb()
      .prepare('SELECT * FROM agent_runs WHERE project_id=? ORDER BY created_at DESC')
      .all(projectId) as Record<string, unknown>[]
  ).map(mapRun)
}

export function getRunBundle(runId: string): RunBundle {
  const db = getDb()
  const row = db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error('Run not found')
  const messages = (
    db
      .prepare('SELECT * FROM run_messages WHERE run_id=? ORDER BY created_at')
      .all(runId) as Record<string, unknown>[]
  ).map(
    (item): RunMessage => ({
      id: String(item.id),
      runId,
      role: item.role as RunMessage['role'],
      content: String(item.content),
      sources: JSON.parse(String(item.sources_json)),
      createdAt: String(item.created_at),
    }),
  )
  const planRow = db.prepare('SELECT plan_json FROM run_plans WHERE run_id=?').get(runId) as
    | { plan_json: string }
    | undefined
  const events = (
    db.prepare('SELECT * FROM run_events WHERE run_id=? ORDER BY sequence').all(runId) as Record<
      string,
      unknown
    >[]
  ).map(eventFrom)
  const approvals = (
    db
      .prepare('SELECT * FROM approval_requests WHERE run_id=? ORDER BY requested_at')
      .all(runId) as Record<string, unknown>[]
  ).map((item) => ({
    id: String(item.id),
    runId,
    eventId: String(item.event_id ?? ''),
    requestedBy: String(item.requested_by),
    action: String(item.action),
    reason: String(item.reason),
    risk: item.risk as ApprovalRequest['risk'],
    requestedAt: String(item.requested_at),
    status: String(item.status),
    decision: item.decided_at
      ? {
          requestId: String(item.id),
          decision: item.status as ApprovalDecision['decision'],
          decidedBy: String(item.decided_by),
          decidedAt: String(item.decided_at),
          rationale: item.rationale ? String(item.rationale) : undefined,
          modification: item.modification_json
            ? JSON.parse(String(item.modification_json))
            : undefined,
        }
      : undefined,
  }))
  const sessions = (
    db
      .prepare('SELECT * FROM tool_sessions WHERE run_id=? ORDER BY updated_at DESC')
      .all(runId) as Record<string, unknown>[]
  ).map((item) => ({
    id: String(item.id),
    runId,
    kind: item.kind as ToolSession['kind'],
    title: String(item.title),
    status: item.status as ToolSession['status'],
    classification: String(item.classification),
    startedAt: String(item.started_at),
    updatedAt: String(item.updated_at),
    endedAt: item.ended_at ? String(item.ended_at) : undefined,
    metadata: JSON.parse(String(item.metadata_json)),
    takeoverBy: item.takeover_by ? String(item.takeover_by) : undefined,
  }))
  return {
    run: mapRun(row),
    request: String(row.request),
    messages,
    plan: planRow ? JSON.parse(planRow.plan_json) : [],
    events,
    approvals,
    sessions,
  }
}

export function decideApproval(
  runId: string,
  requestId: string,
  actor: string,
  input: { decision: 'approved' | 'rejected'; rationale?: string },
): RunBundle {
  const db = getDb()
  const runRow = db.prepare('SELECT request FROM agent_runs WHERE id=?').get(runId) as
    | { request: string }
    | undefined
  if (!runRow) throw new Error('Run not found')
  const changed = db
    .prepare(
      `UPDATE approval_requests SET status=?,decided_by=?,decided_at=?,rationale=? WHERE id=? AND run_id=? AND status='pending'`,
    )
    .run(input.decision, actor, new Date().toISOString(), input.rationale ?? null, requestId, runId)
  if (!changed.changes) throw new Error('Pending approval not found')
  appendRunEvent(runId, 'approval.resolved', actor, {
    requestId,
    decision: input.decision,
    rationale: input.rationale,
  })
  void advanceRun(runId, runRow.request, input.decision)
  return getRunBundle(runId)
}
