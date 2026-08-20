// ACP Server — exposes Papyrus's governed session lifecycle over ACP.
//
// Every lifecycle operation delegates to PapyrusService. The transport layer
// does not own sessions, provider secrets, runtime state, or authorization.
import * as acp from '@agentclientprotocol/sdk'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import type { Principal, SessionEvent, Workspace } from '@papyrus/contracts'
import type { RuntimeEvent } from '@papyrus/acp-runtime'
import type { PapyrusService } from './service.js'

export interface AcpAgentContext {
  principal: Principal
  workspace: Workspace
}

// Build an AgentApp backed by the daemon's authoritative session governor.
export function buildAcpAgent(
  service: PapyrusService,
  context: AcpAgentContext,
): acp.AgentApp {
  const app = acp.agent({ name: 'papyrus' })

  app.onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: {
        list: {},
        resume: {},
        close: {},
      },
    },
    agentInfo: { name: 'papyrus', version: '0.1.0' },
  }))

  app.onRequest(acp.methods.agent.session.new, async (ctx) => {
    const session = service.createSession(
      context.principal,
      context.workspace.id,
      service.defaultGatewayAgent(),
      sessionTitle(ctx.params.cwd),
      ctx.params.cwd,
    )
    return { sessionId: session.id }
  })

  app.onRequest(acp.methods.agent.session.list, async (ctx) => {
    const matching = service.listSessions(context.principal)
      .filter((session) => !ctx.params.cwd || session.cwd === ctx.params.cwd)
    const offset = decodeCursor(ctx.params.cursor)
    const sessions = matching.slice(offset, offset + 100)
    const next = offset + sessions.length
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
      ...(next < matching.length ? { nextCursor: encodeCursor(next) } : {}),
    }
  })

  app.onRequest(acp.methods.agent.session.load, async (ctx) => {
    service.resumeSession(context.principal, ctx.params.sessionId, ctx.params.cwd)
    let after = 0
    for (;;) {
      const events = service.sessionEvents(context.principal, ctx.params.sessionId, after, 500)
      for (const event of events) await replayEvent(ctx.client, event)
      if (events.length < 500) break
      after = events[events.length - 1]!.sequence
    }
    return {}
  })

  app.onRequest(acp.methods.agent.session.resume, async (ctx) => {
    service.resumeSession(context.principal, ctx.params.sessionId, ctx.params.cwd)
    return {}
  })

  app.onRequest(acp.methods.agent.session.close, async (ctx) => {
    service.closeSession(context.principal, ctx.params.sessionId)
    return {}
  })

  app.onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    service.cancelSession(context.principal, ctx.params.sessionId)
  })

  app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
    if (!prompt) return { stopReason: 'refusal' as const }

    const result = await service.prompt(context.principal, ctx.params.sessionId, prompt, {
      signal: ctx.signal,
      onEvent: async (event) => emitRuntimeEvent(ctx.client, ctx.params.sessionId, event),
    })
    return { stopReason: normalizeStopReason(result.stopReason) }
  })

  return app
}

// Build an AcpServer wrapping the governed agent.
export function buildAcpServer(
  service: PapyrusService,
  context: AcpAgentContext,
): AcpServer {
  return new AcpServer({ agent: buildAcpAgent(service, context) })
}

async function emitRuntimeEvent(client: acp.AgentContext, sessionId: string, event: RuntimeEvent): Promise<void> {
  if (event.kind !== 'update' || !isSessionUpdate(event.data)) return
  await client.notify(acp.methods.client.session.update, { sessionId, update: event.data })
}

async function replayEvent(client: acp.AgentContext, event: SessionEvent): Promise<void> {
  if (event.kind !== 'update' || !isSessionUpdate(event.data)) return
  await client.notify(acp.methods.client.session.update, { sessionId: event.sessionId, update: event.data })
}

function isSessionUpdate(value: unknown): value is acp.SessionUpdate {
  return Boolean(value && typeof value === 'object' && typeof (value as { sessionUpdate?: unknown }).sessionUpdate === 'string')
}

function normalizeStopReason(value: string): acp.StopReason {
  return ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(value)
    ? value as acp.StopReason
    : 'end_turn'
}

function sessionTitle(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).pop() || 'Papyrus session'
}

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset)).toString('base64url')
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0
  const offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
}
