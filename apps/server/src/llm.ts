/**
 * Stateless LLM client. Takes provider config per-request from ACP providers/set.
 * Supports Anthropic Messages API and OpenAI Chat Completions API.
 */

export interface ProviderConfig {
  providerId: string
  apiType: string
  baseUrl: string
  headers?: Record<string, string>
}

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LlmStreamEvent {
  type: 'text' | 'tool_use' | 'done' | 'error'
  text?: string
  toolName?: string
  toolId?: string
  input?: Record<string, unknown>
  stopReason?: string
}

/** Call Anthropic Messages API with streaming. */
export async function* streamAnthropic(
  config: ProviderConfig,
  messages: LlmMessage[],
  signal?: AbortSignal | null,
): AsyncGenerator<LlmStreamEvent> {
  const response = await fetch(`${config.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...config.headers },
    body: JSON.stringify({
      model: config.headers?.['anthropic-model'] ?? 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages,
      stream: true,
    }),
    signal: signal ?? null,
  })

  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown error')
    yield { type: 'error', text: `Anthropic API error ${response.status}: ${err}` }
    return
  }

  const reader = response.body?.getReader()
  if (!reader) { yield { type: 'error', text: 'No response body' }; return }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return

        try {
          const event = JSON.parse(data)
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            yield { type: 'text', text: event.delta.text }
          } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            yield { type: 'tool_use', toolName: event.content_block.name, toolId: event.content_block.id }
          } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
            yield { type: 'done', stopReason: event.delta.stop_reason }
          }
        } catch { /* skip unparseable */ }
      }
    }
  } finally { reader.releaseLock() }
}

/** Call OpenAI Chat Completions API with streaming. */
export async function* streamOpenAI(
  config: ProviderConfig,
  messages: LlmMessage[],
  signal?: AbortSignal | null,
): AsyncGenerator<LlmStreamEvent> {
  const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...config.headers },
    body: JSON.stringify({
      model: config.headers?.['openai-model'] ?? 'gpt-4o',
      messages,
      stream: true,
    }),
    signal: signal ?? null,
  })

  if (!response.ok) {
    const err = await response.text().catch(() => 'Unknown error')
    yield { type: 'error', text: `OpenAI API error ${response.status}: ${err}` }
    return
  }

  const reader = response.body?.getReader()
  if (!reader) { yield { type: 'error', text: 'No response body' }; return }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return

        try {
          const event = JSON.parse(data)
          const delta = event.choices?.[0]?.delta
          if (delta?.content) {
            yield { type: 'text', text: delta.content }
          }
          if (event.choices?.[0]?.finish_reason) {
            yield { type: 'done', stopReason: event.choices[0].finish_reason === 'stop' ? 'end_turn' : event.choices[0].finish_reason }
          }
        } catch { /* skip unparseable */ }
      }
    }
  } finally { reader.releaseLock() }
}

/** Route to the right streaming function based on apiType. */
export async function* streamLlm(
  config: ProviderConfig,
  messages: LlmMessage[],
  signal?: AbortSignal | null,
): AsyncGenerator<LlmStreamEvent> {
  switch (config.apiType) {
    case 'anthropic': yield* streamAnthropic(config, messages, signal); break
    case 'openai': yield* streamOpenAI(config, messages, signal); break
    default: yield { type: 'error', text: `Unsupported provider type: ${config.apiType}` }
  }
}
