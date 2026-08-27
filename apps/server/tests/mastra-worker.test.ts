import { describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import type { ChunkType, StepFinishPayload } from '@mastra/core/stream'
import { z } from 'zod'
import { wrapModelForCloudflare } from '../src/mastra/cloudflare-model.js'
import { MastraAgentWorker } from '../src/mastra/worker.js'

function stream(chunks: unknown[]) {
  return { fullStream: (async function * () { for (const chunk of chunks) yield chunk })() }
}

function finishChunk(type: 'finish' | 'step-finish', reason: StepFinishPayload['stepResult']['reason'], isContinued = false): ChunkType {
  return {
    type, runId: 'test-run', from: 'AGENT',
    payload: {
      stepResult: { reason, isContinued },
      output: { usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      metadata: {}, messages: { all: [], user: [], nonUser: [] },
    },
  }
}

describe('Cloudflare model compatibility', () => {
  const user = { role: 'user', content: [{ type: 'text', text: 'Inspect the workspace' }] } satisfies LanguageModelV4Prompt[number]
  const assistant = {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'read-1', toolName: 'read_file', input: { path: 'notes.md' } }],
  } satisfies LanguageModelV4Prompt[number]
  const tool = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'read-1', toolName: 'read_file', output: { type: 'text', value: 'Workspace notes' } }],
  } satisfies LanguageModelV4Prompt[number]

  // Validate the serialized HTTP payload, not just the input to the SDK.
  // Qwen rejects any system message whose index is not zero, even adjacent ones.
  function provider(options: { toolTurn?: boolean; failContinuation?: boolean } = {}) {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      if (body.messages.some((message: { role: string }, index: number) => message.role === 'system' && index !== 0)) {
        return Response.json({ error: { message: 'System message must be at the beginning.', type: 'BadRequestError', code: 400 } }, { status: 400 })
      }
      if (body.stream) {
        const hasToolResult = body.messages.some((message: { role: string }) => message.role === 'tool')
        if (hasToolResult && options.failContinuation) {
          return Response.json({ error: { message: 'Continuation request failed', type: 'BadRequestError', code: 400 } }, { status: 400 })
        }
        const chunks = options.toolTurn && !hasToolResult ? [
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'Let me inspect the workspace.' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.md"}' } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ] : [
          { choices: [{ index: 0, delta: { role: 'assistant', content: 'Done' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ]
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }] })
    })
    const model = createOpenAICompatible({
      name: 'papyrus-upstream', baseURL: 'https://api.cloudflare.com/client/v4/accounts/test/ai/v1', apiKey: 'test-key', fetch,
    }).chatModel('@cf/qwen/qwen3.8-27b')
    return { model, fetch }
  }

  for (const method of ['doGenerate', 'doStream'] as const) {
    it(`${method} combines adjacent and late system messages without changing history or tool calls`, async () => {
      const { model, fetch } = provider()
      const wrapped = wrapModelForCloudflare(model)
      const prompt: LanguageModelV4Prompt = [
        { role: 'system', content: 'Agent instructions' },
        { role: 'system', content: 'Working memory' },
        user, assistant, tool,
        { role: 'system', content: 'Workspace instructions' },
      ]
      const original = structuredClone(prompt)
      const options: LanguageModelV4CallOptions = {
        prompt, maxOutputTokens: 128, temperature: 0.2,
        tools: [{ type: 'function', name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
        toolChoice: { type: 'auto' }, abortSignal: new AbortController().signal,
        headers: { 'x-test-header': 'preserved' },
      }

      for (let call = 0; call < 2; call++) {
        const result = await wrapped[method](options)
        if ('stream' in result) {
          const chunks = []
          for await (const chunk of result.stream) chunks.push(chunk)
          expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Done' }))
          expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false)
        } else {
          expect(result.content).toContainEqual({ type: 'text', text: 'Done' })
        }
        const [url, init] = fetch.mock.calls[call]!
        const body = JSON.parse(String(init?.body))
        expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test/ai/v1/chat/completions')
        expect(body.messages).toEqual([
          { role: 'system', content: 'Agent instructions\n\nWorking memory\n\nWorkspace instructions' },
          { role: 'user', content: 'Inspect the workspace' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.md"}' } }] },
          { role: 'tool', tool_call_id: 'read-1', content: 'Workspace notes' },
        ])
        expect(body).toMatchObject({ max_tokens: 128, temperature: 0.2, tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'read_file' } }] })
        expect(init?.signal).toBe(options.abortSignal)
        expect(new Headers(init?.headers).get('x-test-header')).toBe('preserved')
      }
      expect(prompt).toEqual(original)
      expect(wrapped.provider).toBe(model.provider)
      expect(wrapped.modelId).toBe(model.modelId)
      expect(wrapped.specificationVersion).toBe(model.specificationVersion)
      expect(wrapped.supportedUrls).toEqual(model.supportedUrls)
    })
  }

  it.each([
    { name: 'empty prompt', prompt: [], messages: [] },
    { name: 'no system message', prompt: [user], messages: [{ role: 'user', content: 'Inspect the workspace' }] },
    {
      name: 'single leading system message with provider metadata',
      prompt: [{ role: 'system', content: '', providerOptions: { openaiCompatible: { name: 'instructions' } } }, user],
      messages: [{ role: 'system', content: '', name: 'instructions' }, { role: 'user', content: 'Inspect the workspace' }],
    },
    {
      name: 'single late system message',
      prompt: [user, { role: 'system', content: 'Workspace instructions' }],
      messages: [{ role: 'system', content: 'Workspace instructions' }, { role: 'user', content: 'Inspect the workspace' }],
    },
  ] satisfies Array<{ name: string; prompt: LanguageModelV4Prompt; messages: unknown[] }>)('handles $name', async ({ prompt, messages }) => {
    const { model, fetch } = provider()
    const original = structuredClone(prompt)
    await wrapModelForCloudflare(model).doGenerate({ prompt })
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).messages).toEqual(messages)
    expect(prompt).toEqual(original)
  })

  it.each([false, true])('consumes the real Mastra tool loop through its final response or error (failContinuation=%s)', async (failContinuation) => {
    const { model, fetch } = provider({ toolTurn: true, failContinuation })
    const execute = vi.fn(async () => 'Workspace notes')
    const agent = new Agent({
      id: 'test-papyrus', name: 'test-papyrus',
      instructions: [{ role: 'system', content: 'Agent instructions' }, { role: 'system', content: 'Working memory' }],
      model: wrapModelForCloudflare(model),
      tools: { read_file: createTool({ id: 'read_file', description: 'Read notes', inputSchema: z.object({ path: z.string() }), execute }) },
    })
    const worker = new MastraAgentWorker(
      { getAgent: () => agent } as never,
      { model: { endpoint: 'https://api.cloudflare.com/client/v4/accounts/test/ai/v1', model: model.modelId } } as never,
      { stagePrompt: async () => undefined } as never,
    )
    const events: Array<{ kind: string; data: unknown }> = []
    const result = worker.runPrompt({ prompt: 'Inspect the workspace', onEvent: (event) => { events.push(event) } })
    if (failContinuation) {
      await expect(result).rejects.toThrow('Continuation request failed')
      expect(events.some((event) => event.kind === 'complete')).toBe(false)
    } else {
      await expect(result).resolves.toMatchObject({ stopReason: 'stop' })
      expect(events).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } }) }))
      expect(events.filter((event) => event.kind === 'complete')).toHaveLength(1)
      expect(events.at(-1)).toMatchObject({ kind: 'complete' })
    }
    expect(execute).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(2)
    const continuation = JSON.parse(String(fetch.mock.calls[1]![1]?.body))
    expect(continuation.messages.filter((message: { role: string }) => message.role === 'system')).toHaveLength(1)
    expect(continuation.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'read-1', content: 'Workspace notes' }))
  })
})

describe('Mastra agent runtime', () => {
  function runChunks(chunks: unknown[], signal?: AbortSignal) {
    const worker = new MastraAgentWorker(
      { getAgent: () => ({ stream: async () => stream(chunks) }) } as never,
      { model: { endpoint: 'http://model.test/v1', model: 'test' } } as never,
      { stagePrompt: async () => undefined } as never,
    )
    const events: Array<{ kind: string; data: unknown }> = []
    const result = worker.runPrompt({ prompt: 'Continue', ...(signal ? { signal } : {}), onEvent: (event) => { events.push(event) } })
    return { result, events }
  }

  it('does not complete on continuing, unknown, or terminal-looking step events', async () => {
    const { result, events } = runChunks([
      finishChunk('step-finish', 'stop', true),
      { type: 'step-finish', payload: {} },
      finishChunk('step-finish', 'stop'),
      { type: 'text-delta', payload: { text: 'Final response' } },
      finishChunk('finish', 'stop'),
    ])
    await expect(result).resolves.toMatchObject({ stopReason: 'stop' })
    expect(events.at(-2)).toMatchObject({ data: { sessionUpdate: 'agent_message_chunk', content: { text: 'Final response' } } })
    expect(events.filter((event) => event.kind === 'complete')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'complete' })
  })

  it.each([
    { reason: 'length', stopReason: 'max_tokens' },
    { reason: 'tool-calls', stopReason: 'max_turn_requests' },
    { reason: 'content-filter', stopReason: 'refusal' },
  ] as const)('maps native final reason $reason to $stopReason', async ({ reason, stopReason }) => {
    const { result } = runChunks([finishChunk('finish', reason)])
    await expect(result).resolves.toMatchObject({ stopReason })
  })

  it.each([
    { name: 'empty stream', chunks: [], message: 'Mastra stream ended before the run finished' },
    { name: 'stream ending at a step', chunks: [finishChunk('step-finish', 'stop')], message: 'Mastra stream ended before the run finished' },
    { name: 'missing finish reason', chunks: [{ type: 'finish', payload: {} }], message: 'Mastra stream finished without a finish reason' },
    { name: 'native error finish', chunks: [finishChunk('finish', 'error')], message: 'Mastra run failed' },
    { name: 'serialized stream error', chunks: [{ type: 'error', payload: { error: { message: 'Provider rejected the request' } } }], message: 'Provider rejected the request' },
    { name: 'error after a step', chunks: [finishChunk('step-finish', 'stop'), { type: 'error', payload: { error: new Error('Finalization failed') } }], message: 'Finalization failed' },
  ])('does not report success for $name', async ({ chunks, message }) => {
    const { result, events } = runChunks(chunks)
    await expect(result).rejects.toThrow(message)
    expect(events.some((event) => event.kind === 'complete')).toBe(false)
  })

  it.each(['signal', 'chunk'] as const)('reports cancellation from an abort $0', async (source) => {
    const controller = new AbortController()
    if (source === 'signal') controller.abort()
    const { result, events } = runChunks([{ type: 'abort', payload: {} }], controller.signal)
    await expect(result).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(events.at(-1)).toMatchObject({ kind: 'complete', data: { stopReason: 'cancelled' } })
  })

  it('reports missing model configuration without starting a turn', async () => {
    const worker = new MastraAgentWorker({} as never, {} as never, {} as never)
    expect(worker.kind).toBe('papyrus')
    await expect(worker.health()).resolves.toMatchObject({ available: false, reason: 'Papyrus model endpoint is not configured' })
  })

  it('uses stable Papyrus thread/resource ids and stages real attachment content', async () => {
    const agentStream = vi.fn(async () => stream([
      { type: 'text-delta', payload: { text: 'Reviewed.' } },
      finishChunk('finish', 'stop'),
    ]))
    const stagePrompt = vi.fn(async () => undefined)
    const worker = new MastraAgentWorker(
      { getAgent: () => ({ stream: agentStream }) } as never,
      { model: { endpoint: 'http://model.test/v1', model: 'test' } } as never,
      { stagePrompt } as never,
    )
    const events: Array<{ kind: string; data: unknown }> = []
    const prompt: ContentBlock[] = [
      { type: 'text', text: 'Review the attachment' },
      { type: 'resource', resource: { uri: 'papyrus://sessions/s/attachments/a/policy.md', mimeType: 'text/markdown', text: '# Policy' } },
    ]
    await worker.runPrompt({
      sessionId: '11111111-1111-4111-8111-111111111111', resourceId: 'user-1', runId: 'run-1', cwd: '/', prompt,
      authorizeTool: async () => false, onEvent: (event) => { events.push(event) },
    })
    expect(stagePrompt).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', prompt)
    const [message, options] = agentStream.mock.calls[0]!
    expect(options).toMatchObject({ threadId: '11111111-1111-4111-8111-111111111111', resourceId: 'user-1' })
    expect(message).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'file', filename: 'policy.md', mediaType: 'text/markdown' })]))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'update', data: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }) }))
  })

  it('projects browser-use execution as durable inline surface state', async () => {
    const worker = new MastraAgentWorker(
      { getAgent: () => ({ stream: async () => stream([
        { type: 'tool-call', payload: { toolCallId: 'browser-1', toolName: 'mastra_workspace_execute_command', args: { command: 'browser-use open https://example.test' } } },
        { type: 'tool-result', payload: { toolCallId: 'browser-1', toolName: 'mastra_workspace_execute_command', result: 'done' } },
        finishChunk('finish', 'stop'),
      ]) }) } as never,
      { model: { endpoint: 'http://model.test/v1', model: 'test' } } as never,
      { stagePrompt: async () => undefined } as never,
    )
    const events: Array<{ kind: string; data: unknown }> = []
    await worker.runPrompt({
      sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/', prompt: 'Browse',
      authorizeTool: async () => false, onEvent: (event) => { events.push(event) },
    })
    expect(events.map((item) => item.data)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionUpdate: 'browser_state', status: 'active' }),
      expect.objectContaining({ sessionUpdate: 'browser_state', status: 'completed' }),
    ]))
  })

  it('waits for the final response before completing and promoting generated workspace files to artifacts', async () => {
    const worker = new MastraAgentWorker(
      { getAgent: () => ({ stream: async () => stream([
        { type: 'tool-call', payload: { toolCallId: 'pdf-1', toolName: 'mastra_workspace_execute_command', args: { command: 'python build.py' } } },
        { type: 'tool-result', payload: { toolCallId: 'pdf-1', toolName: 'mastra_workspace_execute_command', result: 'PDF built' } },
        finishChunk('step-finish', 'tool-calls', true),
        { type: 'text-delta', payload: { text: 'Your PDF is ready.' } },
        finishChunk('step-finish', 'stop'),
        finishChunk('finish', 'stop'),
      ]) }) } as never,
      { model: { endpoint: 'http://model.test/v1', model: 'test' } } as never,
      {
        stagePrompt: async () => undefined,
        snapshotArtifacts: async () => new Map(),
        artifactsSince: async () => [{ path: 'sample-document.pdf', mediaType: 'application/pdf', data: 'JVBERg==' }],
      } as never,
    )
    const events: Array<{ kind: string; data: unknown }> = []
    const result = await worker.runPrompt({
      sessionId: '11111111-1111-4111-8111-111111111111', cwd: '/', prompt: 'Generate a PDF',
      authorizeTool: async () => false, onEvent: (event) => { events.push(event) },
    })
    expect(result.stopReason).toBe('stop')
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'update',
      data: expect.objectContaining({
        sessionUpdate: 'tool_call_update', title: 'sample-document.pdf',
        content: [expect.objectContaining({ content: expect.objectContaining({ type: 'resource', resource: expect.objectContaining({ mimeType: 'application/pdf' }) }) })],
      }),
    }))
    expect(events.at(-1)).toMatchObject({ kind: 'complete', data: { stopReason: 'stop' } })
  })
})
