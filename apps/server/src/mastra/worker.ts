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
import type { ServerConfig } from '../config.js'
import { buildSessionToolset } from './tools.js'
import type { PapyrusWorkspaceManager } from './workspace.js'

export const PAPYRUS_WORKER_CAPABILITIES: RuntimeCapabilities = {
  transports: ['streamable-http'],
  sessions: { cancel: true, load: true, resume: true, fork: false },
}

// Mastra-backed implementation of the AgentRuntime contract. Translates the
// prompt → tool-call → tool-result loop into Mastra's stream API, emitting the
// same RuntimeEvent shapes that PapyrusService already persists into the
// session event log. Governed tools call back through PapyrusService so Cedar,
// durable approvals, source assignments, and audit remain authoritative.
export class MastraAgentWorker implements AgentRuntime {
  readonly kind = 'papyrus'
  readonly capabilities = PAPYRUS_WORKER_CAPABILITIES

  constructor(
    private readonly mastra: Mastra,
    private readonly config: ServerConfig,
    private readonly workspaces: PapyrusWorkspaceManager,
  ) {}

  async health(): Promise<RuntimeHealth> {
    const model = this.config.model
    if (!model?.endpoint || !model.model) return { available: false, reason: 'Papyrus model endpoint is not configured' }
    return { available: true, version: 'mastra' }
  }

  async runPrompt(request: RuntimePromptRequest): Promise<RuntimePromptResult> {
    const model = this.config.model
    if (!model?.endpoint || !model.model) throw new Error('Configure PAPYRUS_MODEL_ENDPOINT and PAPYRUS_MODEL before starting a session')

    const runtimeSessionId = request.sessionId ?? randomUUID()
    await request.onEvent({ kind: 'session', at: new Date().toISOString(), data: { runtimeSessionId } })

    const agent = this.mastra.getAgent('papyrus') ?? this.mastra.getAgent('default')
    if (!agent) throw new Error('No Mastra agent is configured')

    const cwd = request.cwd ?? process.cwd()
    const threadId = request.sessionId ?? runtimeSessionId
    const resourceId = request.resourceId ?? threadId
    await this.workspaces.stagePrompt(threadId, request.prompt)
    const message = promptToMessage(request.prompt)
    const requestContext = new RequestContext()
    requestContext.set('cwd', cwd)
    requestContext.set('sessionId', threadId)
    requestContext.set('runId', request.runId ?? runtimeSessionId)
    requestContext.set('upstreamModel', { endpoint: model.endpoint, ...(model.apiKey ? { apiKey: model.apiKey } : {}) })
    if (request.invokeTool) requestContext.set('invokeTool', request.invokeTool)
    if (request.authorizeTool) requestContext.set('authorizeTool', request.authorizeTool)
    if (request.elicit) requestContext.set('elicit', request.elicit)

    const sessionTools = buildSessionToolset((request.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema,
    })))

    const stream = await (agent as unknown as {
      stream: (m: unknown, opts: Record<string, unknown>) => Promise<{ fullStream: AsyncIterable<unknown> }>
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

function promptToMessage(prompt: string | ContentBlock[]): string | Array<{ type: 'text'; text: string } | { type: 'file'; data: Uint8Array; mediaType: string; filename?: string }> {
  if (typeof prompt === 'string') return prompt
  const parts: Array<{ type: 'text'; text: string } | { type: 'file'; data: Uint8Array; mediaType: string; filename?: string }> = []
  for (const block of prompt) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image' || block.type === 'audio') parts.push({ type: 'file', data: Buffer.from(block.data, 'base64'), mediaType: block.mimeType })
    else if (block.type === 'resource') {
      const filename = decodeURIComponent(block.resource.uri.split('/').at(-1) ?? 'attachment')
      const data = 'text' in block.resource ? Buffer.from(block.resource.text) : Buffer.from(block.resource.blob, 'base64')
      parts.push({ type: 'file', data, mediaType: block.resource.mimeType ?? 'application/octet-stream', filename })
    } else if (block.type === 'resource_link') parts.push({ type: 'text', text: `[Attached link: ${block.title ?? block.name ?? block.uri}](${block.uri})` })
  }
  return parts
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
