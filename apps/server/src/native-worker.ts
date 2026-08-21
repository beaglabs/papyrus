import type { ContentBlock } from '@agentclientprotocol/sdk'
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeHealth,
  RuntimePromptRequest,
  RuntimePromptResult,
  RuntimeTool,
} from '@papyrus/acp-runtime'

export interface PapyrusWorkerConfig {
  endpoint?: string
  model?: string
  apiKey?: string
  promptTimeoutMs?: number
}

export const PAPYRUS_WORKER_CAPABILITIES: RuntimeCapabilities = {
  transports: ['streamable-http'],
  sessions: { cancel: true, load: true, resume: true, fork: false },
}

/**
 * Papyrus's in-process worker. The daemon owns identity, policy, durable state,
 * credentials and tools; the model endpoint receives only the governed turn.
 */
export class PapyrusWorker implements AgentRuntime {
  readonly kind = 'papyrus'
  readonly capabilities = PAPYRUS_WORKER_CAPABILITIES

  constructor(private readonly config: PapyrusWorkerConfig) {}

  async health(): Promise<RuntimeHealth> {
    if (!this.config.endpoint || !this.config.model) {
      return { available: false, reason: 'Papyrus model endpoint is not configured' }
    }
    return { available: true, version: 'native' }
  }

  async runPrompt(request: RuntimePromptRequest): Promise<RuntimePromptResult> {
    if (!this.config.endpoint || !this.config.model) {
      throw new Error('Configure PAPYRUS_MODEL_ENDPOINT and PAPYRUS_MODEL before starting a session')
    }

    const runtimeSessionId = crypto.randomUUID()
    await request.onEvent({
      kind: 'session',
      at: new Date().toISOString(),
      data: { runtimeSessionId },
    })

    const messages: ModelMessage[] = [
      {
        role: 'system',
        content: 'You are the Papyrus governed worker. Use only the supplied tools. Make reasonable assumptions and proceed without asking optional follow-up questions. Use papyrus_request_input only once, and only when a required value is missing and safe execution is impossible without it. Never use it to confirm an assumption, offer choices, or ask whether to continue. Never claim an action completed unless its tool result confirms it.',
      },
      { role: 'user', content: promptContent(request.prompt) },
    ]
    const tools: ModelTool[] = (request.tools ?? []).map(modelTool)
    if (request.elicit) {
      tools.push({
        type: 'function',
        function: {
          name: 'papyrus_request_input',
          description: 'Last-resort structured input for one required value that blocks safe execution. Do not use for optional clarification, confirmation, preferences, or offers to continue.',
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string' },
              requestedSchema: { type: 'object' },
            },
            required: ['message'],
          },
        },
      })
    }

    let elicitationUsed = false
    for (let turn = 0; turn < 32; turn += 1) {
      if (request.signal?.aborted) return { runtimeSessionId, stopReason: 'cancelled' }
      const message = await this.complete(messages, tools, request.signal)
      const text = typeof message.content === 'string' ? message.content : ''
      if (text) {
        await request.onEvent({
          kind: 'update',
          at: new Date().toISOString(),
          data: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
            messageId: `agent_${runtimeSessionId}_${turn}`,
          },
        })
      }

      const calls = message.tool_calls ?? []
      if (calls.length === 0) {
        await request.onEvent({
          kind: 'complete',
          at: new Date().toISOString(),
          data: { stopReason: 'end_turn' },
        })
        return { runtimeSessionId, stopReason: 'end_turn' }
      }

      messages.push(message)
      for (const call of calls) {
        const name = call.function.name
        const args = parseArguments(call.function.arguments)
        await request.onEvent({
          kind: 'update',
          at: new Date().toISOString(),
          data: { sessionUpdate: 'tool_call', toolCallId: call.id, title: name, kind: 'other', status: 'pending' },
        })

        let result: unknown
        try {
          if (name === 'papyrus_request_input') {
            if (!request.elicit) throw new Error('Interactive input is unavailable')
            if (elicitationUsed) throw new Error('Only one elicitation is allowed per prompt turn; continue with the available information')
            elicitationUsed = true
            result = await request.elicit({
              message: typeof args.message === 'string' ? args.message : 'The worker needs more information.',
              requestedSchema: isRecord(args.requestedSchema) ? args.requestedSchema : {
                type: 'object',
                properties: { response: { type: 'string', title: 'Response' } },
                required: ['response'],
              },
            })
          } else {
            const allowed = await request.authorizeTool(name)
            if (!allowed) throw new Error('Tool request denied by policy or user approval')
            if (!request.invokeTool) throw new Error('Governed tool execution is unavailable')
            result = await request.invokeTool(name, args)
          }
          await request.onEvent({
            kind: 'update',
            at: new Date().toISOString(),
            data: {
              sessionUpdate: 'tool_call_update',
              toolCallId: call.id,
              title: name,
              kind: 'other',
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: safeJson(result) } }],
            },
          })
        } catch (error) {
          result = { error: error instanceof Error ? error.message : 'Tool execution failed' }
          await request.onEvent({
            kind: 'update',
            at: new Date().toISOString(),
            data: {
              sessionUpdate: 'tool_call_update',
              toolCallId: call.id,
              title: name,
              kind: 'other',
              status: 'failed',
              content: [{ type: 'content', content: { type: 'text', text: safeJson(result) } }],
            },
          })
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: safeJson(result) })
      }
    }

    await request.onEvent({
      kind: 'complete',
      at: new Date().toISOString(),
      data: { stopReason: 'max_turn_requests' },
    })
    return { runtimeSessionId, stopReason: 'max_turn_requests' }
  }

  private async complete(messages: ModelMessage[], tools: ModelTool[], signal?: AbortSignal): Promise<ModelMessage> {
    const endpoint = this.config.endpoint!.replace(/\/$/, '')
    const timeout = AbortSignal.timeout(this.config.promptTimeoutMs ?? 600_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      }),
      signal: combined,
    })
    if (!response.ok) throw new Error(`Model endpoint returned ${response.status}: ${(await response.text()).slice(0, 1024)}`)
    const body = await response.json() as { choices?: Array<{ message?: ModelMessage }> }
    const message = body.choices?.[0]?.message
    if (!message) throw new Error('Model endpoint returned no assistant message')
    return message
  }
}

type ModelTool = {
  type: 'function'
  function: { name: string; description?: string; parameters: Record<string, unknown> }
}
type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | Array<Record<string, unknown>> | null
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

function modelTool(tool: RuntimeTool): ModelTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    },
  }
}

function promptContent(prompt: string | ContentBlock[]): string | Array<Record<string, unknown>> {
  if (typeof prompt === 'string') return prompt
  const content: Array<Record<string, unknown>> = []
  for (const block of prompt) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'image') content.push({ type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } })
    else if (block.type === 'resource') {
      const resource = block.resource
      if ('text' in resource) content.push({ type: 'text', text: `Attached resource ${resource.uri}:\n${resource.text}` })
      else content.push({ type: 'text', text: `Attached resource ${resource.uri} (${resource.mimeType}, base64):\n${resource.blob}` })
    }
  }
  return content.length ? content : ''
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function safeJson(value: unknown): string {
  try { return JSON.stringify(value) } catch { return JSON.stringify({ error: 'Tool result was not serializable' }) }
}
