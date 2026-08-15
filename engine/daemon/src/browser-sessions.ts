import { randomUUID } from 'node:crypto'
import { type ManagedBrowserSession, launchManagedBrowser } from '@papyrus/browser'
import type { ToolSession } from '@papyrus/core'
import { getDb } from './database.js'
import { appendRunEvent, appendRunMessage } from './runs.js'

const activeSessions = new Map<string, ManagedBrowserSession>()

function persist(
  session: ToolSession,
  metadata: Record<string, unknown>,
  takeoverBy?: string,
): void {
  getDb()
    .prepare(
      'INSERT INTO tool_sessions (id,run_id,kind,title,status,classification,metadata_json,takeover_by,started_at,updated_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,metadata_json=excluded.metadata_json,takeover_by=excluded.takeover_by,updated_at=excluded.updated_at,ended_at=excluded.ended_at',
    )
    .run(
      session.id,
      session.runId,
      session.kind,
      session.title,
      session.status,
      session.classification,
      JSON.stringify(metadata),
      takeoverBy ?? null,
      session.startedAt,
      session.updatedAt,
      session.endedAt ?? null,
    )
}

export async function startBrowserSession(input: {
  runId: string
  actor: string
  classification: string
  url: string
  allowedOrigins: string[]
}) {
  const requestedId = `browser-${randomUUID()}`
  appendRunEvent(input.runId, 'tool.requested', input.actor, {
    sessionId: requestedId,
    kind: 'browser',
    url: input.url,
  })
  try {
    const managed = await launchManagedBrowser(input.runId, input.classification, {
      allowedOrigins: input.allowedOrigins,
      downloads: 'quarantine',
      credentialRefs: [],
    })
    await managed.navigate(input.url)
    activeSessions.set(managed.session.id, managed)
    persist(managed.session, {
      url: input.url,
      allowedOrigins: input.allowedOrigins,
      control: 'agent',
    })
    appendRunEvent(input.runId, 'tool.started', 'tool:stagehand', {
      session: managed.session,
      url: input.url,
    })
    appendRunMessage(
      input.runId,
      'assistant',
      `Started a governed browser session for ${new URL(input.url).origin}.`,
      [{ id: managed.session.id, title: new URL(input.url).hostname, kind: 'browser' }],
    )
    return { session: managed.session, metadata: { url: input.url, control: 'agent' } }
  } catch (error) {
    appendRunEvent(input.runId, 'tool.failed', 'tool:stagehand', {
      sessionId: requestedId,
      message: error instanceof Error ? error.message : 'Browser launch failed',
    })
    throw error
  }
}

export function setBrowserTakeover(input: {
  runId: string
  sessionId: string
  actor: string
  takeover: boolean
}) {
  const row = getDb()
    .prepare("SELECT * FROM tool_sessions WHERE id=? AND run_id=? AND kind='browser'")
    .get(input.sessionId, input.runId) as Record<string, unknown> | undefined
  if (!row) throw new Error('Browser session not found')
  const metadata = {
    ...JSON.parse(String(row.metadata_json)),
    control: input.takeover ? 'human' : 'agent',
  }
  const status = input.takeover ? 'paused' : 'active'
  const now = new Date().toISOString()
  getDb()
    .prepare(
      'UPDATE tool_sessions SET status=?,metadata_json=?,takeover_by=?,updated_at=? WHERE id=?',
    )
    .run(
      status,
      JSON.stringify(metadata),
      input.takeover ? input.actor : null,
      now,
      input.sessionId,
    )
  appendRunEvent(input.runId, 'run.status', input.actor, {
    browserSessionId: input.sessionId,
    browserControl: metadata.control,
  })
  return {
    id: input.sessionId,
    status,
    metadata,
    takeoverBy: input.takeover ? input.actor : undefined,
  }
}

export async function browserAction(input: {
  runId: string
  sessionId: string
  actor: string
  instruction: string
}) {
  const managed = activeSessions.get(input.sessionId)
  if (!managed)
    throw new Error('Browser runtime is not active; start a new session after daemon restart')
  const row = getDb()
    .prepare('SELECT takeover_by FROM tool_sessions WHERE id=? AND run_id=?')
    .get(input.sessionId, input.runId) as { takeover_by?: string } | undefined
  if (!row) throw new Error('Browser session not found')
  if (row.takeover_by) throw new Error('Browser is under human control')
  appendRunEvent(input.runId, 'tool.started', input.actor, {
    sessionId: input.sessionId,
    instruction: input.instruction,
  })
  const output = await managed.act(input.instruction)
  appendRunEvent(input.runId, 'tool.completed', 'tool:stagehand', {
    sessionId: input.sessionId,
    instruction: input.instruction,
    output,
  })
  return { output }
}

export async function getBrowserFrame(runId: string, sessionId: string) {
  const row = getDb()
    .prepare("SELECT id FROM tool_sessions WHERE id=? AND run_id=? AND kind='browser'")
    .get(sessionId, runId)
  if (!row) throw new Error('Browser session not found')
  const managed = activeSessions.get(sessionId)
  if (!managed)
    throw new Error('Browser runtime is not active; start a new session after daemon restart')
  return {
    mediaType: 'image/png',
    contentBase64: await managed.screenshot(),
    capturedAt: new Date().toISOString(),
  }
}
