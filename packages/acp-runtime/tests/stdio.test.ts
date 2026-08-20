import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RuntimeProcessExitError,
  StdioAcpRuntime,
  type RuntimeEvent,
  type RuntimePromptRequest,
} from '../src/index.js'

const fixturePath = fileURLToPath(new URL('./fixtures/stdio-agent.mjs', import.meta.url))

function runtime(mode = 'complete', promptTimeoutMs?: number): StdioAcpRuntime {
  return new StdioAcpRuntime({
    kind: 'fixture',
    command: process.execPath,
    args: [fixturePath],
    versionArgs: [fixturePath, '--version'],
    baseEnvironment: { PAPYRUS_STDIO_FIXTURE_MODE: mode },
    startupTimeoutMs: 1_000,
    shutdownGraceMs: 100,
    ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
  })
}

function request(events: RuntimeEvent[]): RuntimePromptRequest {
  return {
    cwd: process.cwd(),
    prompt: 'hello',
    authorizeTool: async () => true,
    onEvent: (event) => { events.push(event) },
  }
}

describe('StdioAcpRuntime', () => {
  it('checks the configured binary version', async () => {
    await expect(runtime().health()).resolves.toEqual({
      available: true,
      version: 'papyrus-acp-fixture 1.0.0',
    })
  })

  it('runs a complete ACP prompt and captures bounded stderr', async () => {
    const events: RuntimeEvent[] = []
    const result = await runtime().runPrompt(request(events))

    expect(result).toEqual({
      runtimeSessionId: 'fixture-session',
      stopReason: 'end_turn',
    })
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['stderr', 'session', 'update', 'complete']),
    )
  })

  it('terminates a runtime when the prompt deadline expires', async () => {
    const events: RuntimeEvent[] = []

    await expect(runtime('hang', 50).runPrompt(request(events)))
      .rejects.toThrow('fixture prompt timed out')
  })

  it('classifies a runtime crash before turn completion', async () => {
    const events: RuntimeEvent[] = []

    try {
      await runtime('crash').runPrompt(request(events))
      throw new Error('Expected fixture runtime to crash')
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeProcessExitError)
      expect((error as RuntimeProcessExitError).exit.code).toBe(17)
    }
  })

  it('propagates caller cancellation', async () => {
    const events: RuntimeEvent[] = []
    const controller = new AbortController()
    const prompt = runtime('hang').runPrompt({
      ...request(events),
      signal: controller.signal,
    })

    setTimeout(() => controller.abort(new Error('cancelled by test')), 50)
    await expect(prompt).rejects.toThrow('cancelled by test')
  })
})
