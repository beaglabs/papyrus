/**
 * ACP Server — handles the full ACP protocol directly.
 * Provider config comes from clients via providers/set, not from server config.
 * Sessions are managed in Papyrus's database for policy enforcement.
 */
import * as acp from '@agentclientprotocol/sdk'
import { AcpServer } from '@agentclientprotocol/sdk/experimental/server'
import type { Principal, Session, Workspace } from '@papyrus/contracts'
import type { PapyrusService } from './service.js'
import { streamLlm, type ProviderConfig, type LlmMessage } from './llm.js'

export interface AcpAgentContext {
  principal: Principal
  workspace: Workspace
}

/** Per-connection state: provider config + session tracking. */
interface ConnectionState {
  providers: Map<string, ProviderConfig>
  sessions: Map<string, Session>
}

/**
 * Build an AgentApp that handles the ACP protocol.
 * The AcpServer wraps this for HTTP/WebSocket transport.
 */
export function buildAcpAgent(
  service: PapyrusService,
  context: AcpAgentContext,
): acp.AgentApp {
  const app = acp.agent({ name: 'papyrus' })
  const state: ConnectionState = { providers: new Map(), sessions: new Map() }

  // --- initialize ---
  app.onRequest(acp.methods.agent.initialize, (ctx) => {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        providers: {},
        session: {
          new: true,
          list: true,
          close: true,
          prompt: true,
          cancel: true,
          setMode: false,
          setConfigOption: false,
          load: false,
          fork: false,
          resume: false,
          delete: false,
        },
      },
      agentInfo: { name: 'papyrus', version: '0.1.0' },
    }
  })

  // --- providers/list ---
  app.onRequest(acp.methods.agent.providers.list, () => {
    const providers: Array<{ providerId: string; supported: string[]; required: boolean; current?: { apiType: string; baseUrl: string } | null }> = []
    for (const [id, cfg] of state.providers) {
      providers.push({
        providerId: id,
        supported: [cfg.apiType],
        required: false,
        current: { apiType: cfg.apiType, baseUrl: cfg.baseUrl },
      })
    }
    return { providers }
  })

  // --- providers/set ---
  app.onRequest(acp.methods.agent.providers.set, (ctx) => {
    const { providerId, apiType, baseUrl, headers } = ctx.params
    const config: ProviderConfig = { providerId, apiType, baseUrl }
    if (headers) config.headers = headers as Record<string, string>
    state.providers.set(providerId, config)
    return {}
  })

  // --- providers/disable ---
  app.onRequest(acp.methods.agent.providers.disable, (ctx) => {
    state.providers.delete(ctx.params.providerId)
    return {}
  })

  // --- session/new ---
  app.onRequest(acp.methods.agent.session.new, async (ctx) => {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const session = service.db.createSession(context.principal.id, context.workspace.id, 'papyrus', ctx.params.cwd || '/')
    state.sessions.set(session.id, session)
    return { sessionId: session.id }
  })

  // --- session/list ---
  app.onRequest(acp.methods.agent.session.list, async () => {
    const sessions = service.listSessions(context.principal)
    return {
      sessions: sessions.map((s) => ({
        sessionId: s.id,
        cwd: '/',
        title: s.title,
      })),
    }
  })

  // --- session/close ---
  app.onRequest(acp.methods.agent.session.close, async (ctx) => {
    service.db.setSessionStatus(ctx.params.sessionId, 'stopped')
    state.sessions.delete(ctx.params.sessionId)
    return {}
  })

  // --- session/prompt ---
  app.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const { sessionId, prompt } = ctx.params

    // Get provider config
    const provider = [...state.providers.values()][0]
    if (!provider) {
      return { stopReason: 'refusal' as const }
    }

    // Build messages from prompt content blocks
    const messages: LlmMessage[] = []
    for (const block of prompt) {
      if (block.type === 'text') {
        messages.push({ role: 'user', content: block.text })
      }
    }

    // Stream LLM response via session/update notifications
    const messageId = `msg_${Date.now()}`
    try {
      for await (const event of streamLlm(provider, messages, ctx.signal)) {
        if (event.type === 'text' && event.text) {
          await ctx.client.notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: event.text },
              messageId,
            },
          })
        } else if (event.type === 'done') {
          return { stopReason: (event.stopReason === 'end_turn' ? 'end_turn' : event.stopReason) as 'end_turn' }
        } else if (event.type === 'error') {
          await ctx.client.notify('session/update', {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `\n\n[Error: ${event.text}]` },
              messageId,
            },
          })
          return { stopReason: 'refusal' as const }
        }
      }
    } catch (err) {
      if (ctx.signal.aborted) return { stopReason: 'cancelled' as const }
      return { stopReason: 'refusal' as const }
    }

    return { stopReason: 'end_turn' as const }
  })

  return app
}

/**
 * Build an AcpServer wrapping the agent.
 * Caller uses prepareWebSocketUpgrade() or handleRequest() for transport.
 */
export function buildAcpServer(
  service: PapyrusService,
  context: AcpAgentContext,
): AcpServer {
  const agent = buildAcpAgent(service, context)
  return new AcpServer({ agent })
}
