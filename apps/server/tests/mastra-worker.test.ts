import { describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import { MastraAgentWorker } from '../src/mastra/worker.js'

function stream(chunks: unknown[]) {
  return { fullStream: (async function * () { for (const chunk of chunks) yield chunk })() }
}

describe('Mastra agent runtime', () => {
  it('reports missing model configuration without starting a turn', async () => {
    const worker = new MastraAgentWorker({} as never, {} as never, {} as never)
    expect(worker.kind).toBe('papyrus')
    await expect(worker.health()).resolves.toMatchObject({ available: false, reason: 'Papyrus model endpoint is not configured' })
  })

  it('uses stable Papyrus thread/resource ids and stages real attachment content', async () => {
    const agentStream = vi.fn(async () => stream([
      { type: 'text-delta', payload: { text: 'Reviewed.' } },
      { type: 'finish', payload: { finishReason: 'stop' } },
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
        { type: 'finish', payload: { finishReason: 'stop' } },
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

  it('completes on a terminal step and promotes generated workspace files to artifacts', async () => {
    const worker = new MastraAgentWorker(
      { getAgent: () => ({ stream: async () => stream([
        { type: 'tool-call', payload: { toolCallId: 'pdf-1', toolName: 'mastra_workspace_execute_command', args: { command: 'python build.py' } } },
        { type: 'tool-result', payload: { toolCallId: 'pdf-1', toolName: 'mastra_workspace_execute_command', result: 'PDF built' } },
        { type: 'step-finish', payload: { finishReason: 'stop' } },
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
