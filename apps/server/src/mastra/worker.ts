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
import type { ChunkType } from '@mastra/core/stream'
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
    const artifactBaseline = await this.workspaces.snapshotArtifacts?.(threadId) ?? new Map<string, number>()
    const message = promptToMessage(request.prompt)
    const requestContext = new RequestContext()
    requestContext.set('cwd', cwd)
    requestContext.set('sessionId', threadId)
    requestContext.set('runId', request.runId ?? runtimeSessionId)
    requestContext.set('upstreamModel', { endpoint: model.endpoint, ...(model.apiKey ? { apiKey: model.apiKey } : {}) })
    requestContext.set('writeArtifact', async (filename: string, data: Buffer) => await this.workspaces.writeArtifact(threadId, filename, data))
    if (request.invokeTool) requestContext.set('invokeTool', request.invokeTool)
    if (request.authorizeTool) requestContext.set('authorizeTool', request.authorizeTool)
    if (request.elicit) requestContext.set('elicit', request.elicit)
    if (request.setGoal) requestContext.set('setGoal', request.setGoal)
    if (request.browse) requestContext.set('browse', request.browse)

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
      hooks: {
        beforeToolCall: async ({ toolName }: { toolName: string }) => {
          if (!request.checkToolExecution) throw new Error('Tool execution authorization is unavailable')
          request.signal?.throwIfAborted()
          await request.checkToolExecution(toolName)
          request.signal?.throwIfAborted()
        },
      },
    })

    const browserCalls = new Set<string>()
    const toolStates = new Map<string, { title: string; kind: string; status: string }>()
    const updateTool = async (id: string, update: Record<string, unknown>) => {
      const current = toolStates.get(id)
      const status = String(update.status ?? current?.status ?? 'pending')
      // Late output must not restart a finished tool; a successful result
      // wrapper must not overwrite a failed sandbox process exit.
      const nextStatus = current?.status === 'failed' ? 'failed'
        : current?.status === 'completed' && ['pending', 'in_progress'].includes(status) ? 'completed' : status
      const next = { title: String(update.title ?? current?.title ?? 'Tool activity'), kind: String(update.kind ?? current?.kind ?? 'other'), status: nextStatus }
      toolStates.set(id, next)
      await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: {
        sessionUpdate: current ? 'tool_call_update' : 'tool_call', toolCallId: id, ...update, ...next,
      } })
    }
    const closeActiveTools = async (message: string) => {
      for (const [id, tool] of toolStates) {
        if (tool.status === 'pending' || tool.status === 'in_progress') await updateTool(id, { status: 'failed', content: toolUpdateContent(message) })
      }
      for (const id of browserCalls) await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { sessionUpdate: 'browser_state', status: 'failed', toolCallId: id } })
      browserCalls.clear()
    }
    let artifactsEmitted = false
    let reasoningStatusEmitted = false
    const complete = async (stopReason: string): Promise<RuntimePromptResult> => {
      await closeActiveTools(stopReason === 'cancelled' ? 'Cancelled' : 'Run ended before this tool completed')
      if (!artifactsEmitted) {
        artifactsEmitted = true
        const artifacts = await this.workspaces.artifactsSince?.(threadId, artifactBaseline) ?? []
        for (const artifact of artifacts) {
          await request.onEvent({
            kind: 'update', at: new Date().toISOString(),
            data: {
              sessionUpdate: 'tool_call_update', toolCallId: `artifact_${runtimeSessionId}_${artifact.path}`,
              title: artifact.path, kind: 'edit', status: 'completed',
              content: [{ type: 'content', content: { type: 'resource', resource: {
                uri: `papyrus://sessions/${threadId}/artifacts/${encodeURIComponent(artifact.path)}`,
                mimeType: artifact.mediaType, blob: artifact.data,
              } } }],
            },
          })
        }
      }
      await request.onEvent({ kind: 'complete', at: new Date().toISOString(), data: { stopReason } })
      return { runtimeSessionId, stopReason }
    }
    try {
      for await (const chunk of stream.fullStream as AsyncIterable<{ type: string; payload?: unknown; data?: unknown }>) {
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
            // Never persist or render the provider's raw chain-of-thought.
            // One compact status event keeps the UI responsive without leaking
            // internal reasoning or flooding durable session history.
            if (!reasoningStatusEmitted) {
              reasoningStatusEmitted = true
              await request.onEvent({
                kind: 'update', at: new Date().toISOString(),
                data: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Working…' }, messageId: `thought_${runtimeSessionId}` },
              })
            }
            break
          }
          case 'tool-call-input-streaming-start': {
            const call = chunk.payload as { toolCallId?: string; toolName?: string }
            if (call.toolCallId && call.toolName) await updateTool(call.toolCallId, {
              title: call.toolName, kind: toolKindFor(call.toolName), status: 'pending',
            })
            break
          }
          case 'tool-call': {
            const call = chunk.payload as { toolCallId?: string; toolName?: string; args?: unknown; input?: unknown }
            if (!call.toolCallId || !call.toolName) break
            if (isBrowserCall(call.toolName)) {
              browserCalls.add(call.toolCallId)
              await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { sessionUpdate: 'browser_state', status: 'active', toolCallId: call.toolCallId } })
            }
            await updateTool(call.toolCallId, { title: call.toolName, kind: toolKindFor(call.toolName), status: 'in_progress' })
            break
          }
          case 'data-sandbox-stdout':
          case 'data-sandbox-stderr': {
            const data = chunk.data as { toolCallId?: string; output?: string } | undefined
            if (data?.toolCallId && typeof data.output === 'string') await updateTool(data.toolCallId, {
              status: 'in_progress',
              _meta: { papyrus: { outputDelta: { stream: chunk.type === 'data-sandbox-stderr' ? 'stderr' : 'stdout', text: data.output } } },
            })
            break
          }
          case 'data-sandbox-exit': {
            const data = chunk.data as { toolCallId?: string; exitCode?: number; success?: boolean } | undefined
            if (data?.toolCallId) await updateTool(data.toolCallId, {
              status: data.success === false || (typeof data.exitCode === 'number' && data.exitCode !== 0) ? 'failed' : 'in_progress',
              _meta: { papyrus: { exitCode: data.exitCode } },
            })
            break
          }
          case 'tool-output': {
            const output = chunk.payload as { toolCallId?: string; output?: unknown }
            if (output.toolCallId && output.output !== undefined) await updateTool(output.toolCallId, { status: 'in_progress', content: toolUpdateContent(output.output) })
            break
          }
          case 'tool-error': {
            const error = chunk.payload as { toolCallId?: string; toolName?: string; error?: unknown }
            if (error.toolCallId) await updateTool(error.toolCallId, {
              ...(error.toolName ? { title: error.toolName, kind: toolKindFor(error.toolName) } : {}),
              status: 'failed', content: toolUpdateContent(streamError(error.error).message),
            })
            if (error.toolCallId && browserCalls.delete(error.toolCallId)) await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { sessionUpdate: 'browser_state', status: 'failed', toolCallId: error.toolCallId } })
            break
          }
          case 'tool-result': {
            const result = chunk.payload as { toolCallId?: string; toolName?: string; result?: unknown; isError?: boolean }
            if (!result.toolCallId) break
            await updateTool(result.toolCallId, {
              ...(result.toolName ? { title: result.toolName, kind: toolKindFor(result.toolName) } : {}),
              status: result.isError ? 'failed' : 'completed', content: toolUpdateContent(result.result),
            })
            if (browserCalls.delete(result.toolCallId)) {
              await request.onEvent({ kind: 'update', at: new Date().toISOString(), data: { sessionUpdate: 'browser_state', status: toolStates.get(result.toolCallId)?.status === 'failed' ? 'failed' : 'completed', toolCallId: result.toolCallId } })
            }
            break
          }
          case 'finish': {
            const payload = chunk.payload as Extract<ChunkType, { type: 'finish' }>['payload'] | undefined
            const reason = payload?.stepResult?.reason
            if (!reason) throw new Error('Mastra stream finished without a finish reason')
            if (reason === 'error') throw streamError(payload?.error ?? 'Mastra run failed')
            return await complete(normalizeStopReason(reason))
          }
          // A step is not a turn: tool results, goal evaluation, and further model
          // calls may follow. Only Mastra's final `finish` completes the run.
          case 'step-finish': break
          case 'abort': return await complete('cancelled')
          case 'error': {
            const payload = chunk.payload as { error?: unknown } | undefined
            throw streamError(payload instanceof Error ? payload : payload?.error)
          }
        }
      }

      if (request.signal?.aborted) return await complete('cancelled')
      throw new Error('Mastra stream ended before the run finished')
    } catch (error) {
      await closeActiveTools(request.signal?.aborted ? 'Cancelled' : streamError(error).message)
      throw error
    }
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
  return name === 'papyrus_exec_code' || name === 'mastra_workspace_execute_command' ? 'execute'
    : name.includes('read') || name.includes('list') || name.includes('glob') ? 'read'
    : name.includes('write') ? 'edit'
    : 'other'
}

function isBrowserCall(toolName: string): boolean {
  // Only the broker controls the inline viewer. MCP browsers may live on a
  // different host, and shell text must not claim a browser was controlled.
  return toolName === 'papyrus_browser_navigate' || toolName === 'papyrus_browser_read'
}

function normalizeStopReason(reason: string): string {
  // A final finish with tool calls means Mastra stopped its loop (e.g. maxSteps),
  // not that the requested work completed or another step is still running.
  if (reason === 'tool-calls' || reason === 'tool_use') return 'max_turn_requests'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content-filter' || reason === 'tripwire') return 'refusal'
  return reason
}

function streamError(error: unknown): Error {
  if (error instanceof Error) return error
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return new Error(error.message)
  return new Error(typeof error === 'string' ? error : 'Mastra stream error')
}

function toolUpdateContent(result: unknown): Array<{ type: 'content'; content: unknown }> {
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown[] }).content)) {
    return ((result as { content: unknown[] }).content).map((content) => ({ type: 'content' as const, content }))
  }
  if (result && typeof result === 'object' && typeof (result as { type?: string }).type === 'string') {
    return [{ type: 'content', content: result }]
  }
  return [{ type: 'content', content: { type: 'text', text: typeof result === 'string' ? result : safeJson(result) } }]
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) } catch { return JSON.stringify({ error: 'Tool result was not serializable' }) }
}
