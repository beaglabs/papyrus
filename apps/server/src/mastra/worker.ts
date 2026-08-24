import type { ContentBlock } from '@agentclientprotocol/sdk'
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimePromptRequest,
  RuntimePromptResult,
} from '@papyrus/acp-runtime'
import { RequestContext } from '@mastra/core/request-context'
import { randomUUID } from 'node:crypto'
import type { Mastra } from '@mastra/core/mastra'
import { MastraAuthProvider, type MastraAuthRequest } from '@mastra/core/server'
import { AuthService } from '../auth.js'
import type { ServerConfig } from '../config.js'
import { PapyrusAuthUser } from './auth-provider.js'
import { buildSessionToolset } from './tools.js'

export const PAPYRUS_WORKER_CAPABILITIES: RuntimeCapabilities = {
  transports: ['streamable-http'],
  sessions: { cancel: true, load: true, resume: true, fork: false },
}

// Mastra-backed implementation of the AgentRuntime contract. Translates the
// prompt → tool-call → tool-result loop into Mastra's stream API, emitting the
// same RuntimeEvent shapes that PapyrusService already persists into the
// session event log. Tool approvals and elicitations are handled by Mastra's
// built-in approval + suspend mechanisms — the worker only translates
// text/tool-call/tool-result/finish chunks to RuntimeEvent.
export class MastraAgentWorker implements AgentRuntime {
  readonly kind = 'papyrus'
  readonly capabilities = PAPYRUS_WORKER_CAPABILITIES

  constructor(
    private readonly mastra: Mastra,
    private readonly config: ServerConfig,
  ) {}

  async health(): Promise<RuntimeHealth> {
    const model = this.config.model
    if (!model?.endpoint || !model.model) return { available: false, reason: 'Papyrus model endpoint is not configured' }
    return { available: true, version: 'mastra' }
  }

  async runPrompt(request: RuntimePromptRequest): Promise<RuntimePromptResult> {
    const model = this.config.model
    if (!model?.endpoint || !model.model) throw new Error('Configure PAPYRUS_MODEL_ENDPOINT and PAPYRUS_MODEL before starting a session')

    const runtimeSessionId = randomUUID()
    await request.onEvent({ kind: 'session', at: new Date().toISOString(), data: { runtimeSessionId } })

    const agent = this.mastra.getAgent('papyrus') ?? this.mastra.getAgent('default')
    if (!agent) throw new Error('No Mastra agent is configured')

    const cwd = request.cwd ?? process.cwd()
    const threadId = `acp_${runtimeSessionId}`
    const resourceId = threadId
    const message = promptToMessage(request.prompt)
    const requestContext = new RequestContext()
    requestContext.set('cwd', cwd)
    requestContext.set('upstreamModel', { endpoint: model.endpoint, ...(model.apiKey ? { apiKey: model.apiKey } : {}) })
    if (request.invokeTool) requestContext.set('invokeTool', request.invokeTool)
    if (request.authorizeTool) requestContext.set('authorizeTool', request.authorizeTool)

    const sessionTools = buildSessionToolset((request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    })))

    const stream = await (agent as unknown as {
      stream: (m: string, opts: Record<string, unknown>) => Promise<{ fullStream: AsyncIterable<unknown> }>
    }).stream(message, {
      threadId, resourceId, maxSteps: 32,
      requestContext, abortSignal: request.signal,
      toolsets: Object.keys(sessionTools).length ? { session: sessionTools } : undefined,
    })

    for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: unknown }>) {
      if (request.signal?.aborted) break
      switch (chunk.type) {
        case 'text-delta': {
          const delta = chunk.payload as { text?: string }
          if (typeof delta.text === 'string' && delta.text) {
            await request.onEvent({
              kind: 'update', at: new Date().toISOString(),
              data: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta.text }, messageId: `agent_${runtimeSessionId}` },
            })
          }
          break
        }
        case 'reasoning-delta': {
          const delta = chunk.payload as { text?: string }
          if (typeof delta.text === 'string' && delta.text) {
            await request.onEvent({
              kind: 'update', at: new Date().toISOString(),
              data: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta.text }, messageId: `thought_${runtimeSessionId}` },
            })
          }
          break
        }
        case 'tool-call': {
          const call = chunk.payload as { toolCallId?: string; toolName?: string }
          if (!call.toolCallId || !call.toolName) break
          await request.onEvent({
            kind: 'update', at: new Date().toISOString(),
            data: { sessionUpdate: 'tool_call', toolCallId: call.toolCallId, title: call.toolName, kind: toolKindFor(call.toolName), status: 'pending' },
          })
          break
        }
        case 'tool-result': {
          const result = chunk.payload as { toolCallId?: string; toolName?: string; result?: unknown }
          if (!result.toolCallId) break
          await request.onEvent({
            kind: 'update', at: new Date().toISOString(),
            data: {
              sessionUpdate: 'tool_call_update', toolCallId: result.toolCallId,
              title: result.toolName ?? 'tool', kind: toolKindFor(result.toolName ?? ''), status: 'completed',
              content: toolUpdateContent(result.result),
            },
          })
          break
        }
        // Mastra handles approval + suspend natively; the runtime doesn't need
        // to do anything for those chunks. They're surfaced through the
        // MastraHonoServer's response and consumed by `useChat` on the web.
        case 'finish': {
          const payload = chunk.payload as { finishReason?: string }
          const stopReason = normalizeStopReason(payload.finishReason)
          await request.onEvent({ kind: 'complete', at: new Date().toISOString(), data: { stopReason } })
          return { runtimeSessionId, stopReason }
        }
        case 'error': {
          const payload = chunk.payload as { error?: unknown }
          throw payload instanceof Error ? payload : new Error(String((payload as { error?: unknown })?.error ?? 'Mastra stream error'))
        }
      }
    }

    await request.onEvent({ kind: 'complete', at: new Date().toISOString(), data: { stopReason: 'end_turn' } })
    return { runtimeSessionId, stopReason: 'end_turn' }
  }
}

function promptToMessage(prompt: string | ContentBlock[]): string {
  if (typeof prompt === 'string') return prompt
  const parts: string[] = []
  for (const block of prompt) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'image') parts.push(`[image ${block.mimeType}, ${block.data.length} chars base64]`)
    else if (block.type === 'resource') parts.push(`[resource ${block.resource.uri}]`)
    else if (block.type === 'audio') parts.push(`[audio ${block.mimeType}]`)
    else if (block.type === 'resource_link') parts.push(`[link ${block.uri}]`)
  }
  return parts.join('\n')
}

function toolKindFor(name: string): string {
  return name === 'papyrus_exec_code' ? 'execute'
    : name.includes('read') || name.includes('list') || name.includes('glob') ? 'read'
    : name.includes('write') ? 'edit'
    : 'other'
}

function normalizeStopReason(reason: string | undefined): string {
  if (!reason) return 'end_turn'
  if (reason === 'tool-calls' || reason === 'tool_use') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return reason
}

function toolUpdateContent(result: unknown): Array<{ type: 'content'; content: unknown }> {
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown[] }).content)) {
    return ((result as { content: unknown[] }).content).map((content) => ({ type: 'content' as const, content }))
  }
  if (result && typeof result === 'object' && typeof (result as { type?: string }).type === 'string') {
    return [{ type: 'content', content: result }]
  }
  return [{ type: 'content', content: { type: 'text', text: safeJson(result) } }]
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) } catch { return JSON.stringify({ error: 'Tool result was not serializable' }) }
}

export function buildPapyrusAuthProvider(auth: AuthService): MastraAuthProvider<PapyrusAuthUser> {
  return new (class extends MastraAuthProvider<PapyrusAuthUser> {
    constructor() {
      super({ name: 'papyrus', public: ['/api/agents/health', '/api/agents/openapi.json'] })
    }
    authorizeUser(_user: PapyrusAuthUser, _request: MastraAuthRequest): boolean { return true }
    async authenticateToken(token: string, request: MastraAuthRequest): Promise<PapyrusAuthUser | null> {
      const { IncomingMessage } = await import('node:http')
      const incoming = request instanceof IncomingMessage
        ? request
        : Object.assign(Object.create(IncomingMessage.prototype), {
            headers: request instanceof Request ? request.headers : (request as { raw?: { headers?: Headers } }).raw?.headers,
            method: request instanceof Request ? request.method : 'GET',
            url: request instanceof Request ? request.url : '/api/agents/me',
            socket: { authorized: true, encrypted: false, getPeerX509Certificate: () => undefined },
          }) as InstanceType<typeof IncomingMessage>
      if (incoming.headers && !(incoming.headers as Record<string, unknown>).authorization) {
        ;(incoming.headers as Record<string, string>).authorization = `Bearer ${token}`
      }
      const principal = auth.authenticate(incoming)
      return principal ? new PapyrusAuthUser(principal) : null
    }
  })()
}