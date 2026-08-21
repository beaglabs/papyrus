import { afterEach, describe, expect, it, vi } from 'vitest'
import { PapyrusWorker } from '../src/native-worker.js'

afterEach(() => vi.unstubAllGlobals())

describe('Papyrus native worker', () => {
  it('is the sole in-process engine and reports missing model configuration', async () => {
    const worker = new PapyrusWorker({})
    expect(worker.kind).toBe('papyrus')
    expect(worker.capabilities.transports).toEqual(['streamable-http'])
    await expect(worker.health()).resolves.toMatchObject({
      available: false,
      reason: 'Papyrus model endpoint is not configured',
    })
  })

  it('advertises governed durable-session capabilities', () => {
    const worker = new PapyrusWorker({ endpoint: 'http://127.0.0.1:8000', model: 'test-model' })
    expect(worker.capabilities.sessions).toEqual({
      cancel: true,
      load: true,
      resume: true,
      fork: false,
    })
  })

  it('emits ACP content directly from the configured model endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'Governed response.' } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const events: Array<{ kind: string; data: unknown }> = []
    const worker = new PapyrusWorker({ endpoint: 'http://127.0.0.1:8000', model: 'test-model' })
    const result = await worker.runPrompt({
      cwd: '/',
      prompt: 'Perform the work',
      authorizeTool: async () => false,
      onEvent: (event) => { events.push(event) },
    })
    expect(result.stopReason).toBe('end_turn')
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'update',
      data: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
    }))
  })

  it('routes model tool calls through Papyrus authorization and execution', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"query":"policy"}' } }],
        } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'The governed lookup completed.' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const invokeTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'result' }] }))
    const events: Array<{ kind: string; data: unknown }> = []
    const worker = new PapyrusWorker({ endpoint: 'http://127.0.0.1:8000', model: 'test-model' })
    await worker.runPrompt({
      cwd: '/',
      prompt: 'Look up the policy',
      tools: [{ name: 'lookup', description: 'Governed lookup', inputSchema: { type: 'object' } }],
      authorizeTool: async (name) => name === 'lookup',
      invokeTool,
      onEvent: (event) => { events.push(event) },
    })
    expect(invokeTool).toHaveBeenCalledWith('lookup', { query: 'policy' })
    expect(events).toContainEqual(expect.objectContaining({
      kind: 'update',
      data: expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed' }),
    }))
  })
})
