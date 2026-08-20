import { describe, expect, it } from 'vitest'
import { ACP_PROTOCOL_VERSION, GooseRuntime, gooseRuntimeAdapter } from '../src/index.js'

describe('GooseRuntime', () => {
  it('pins stable ACP v1', () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1)
  })

  it('registers Goose as a runtime adapter', () => {
    const runtime = gooseRuntimeAdapter.create({ command: 'goose' })

    expect(runtime.kind).toBe('goose')
    expect(runtime.capabilities.transports).toContain('stdio')
  })

  it('reports an unavailable binary without throwing', async () => {
    const runtime = new GooseRuntime({ command: 'definitely-not-a-real-goose-binary', startupTimeoutMs: 100 })
    await expect(runtime.health()).resolves.toMatchObject({ available: false })
  })
})
