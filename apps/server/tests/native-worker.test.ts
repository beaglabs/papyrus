import { describe, expect, it } from 'vitest'
import { PapyrusWorker } from '../src/native-worker.js'

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
})
