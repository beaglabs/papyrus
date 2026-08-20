import { describe, expect, it } from 'vitest'
import {
  RuntimeRegistry,
  type AgentRuntime,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeLaunchOptions,
  type RuntimePromptRequest,
  type RuntimePromptResult,
} from '../src/index.js'

const capabilities: RuntimeCapabilities = {
  transports: ['stdio'],
  sessions: { cancel: true, load: false, resume: false, fork: false },
}

class FixtureRuntime implements AgentRuntime {
  readonly kind = 'fixture'
  readonly capabilities = capabilities

  async health() {
    return { available: true, version: 'fixture-1' }
  }

  async runPrompt(_request: RuntimePromptRequest): Promise<RuntimePromptResult> {
    return { runtimeSessionId: 'fixture-session', stopReason: 'end_turn' }
  }
}

const fixtureAdapter: RuntimeAdapter = {
  kind: 'fixture',
  create(_options?: RuntimeLaunchOptions) {
    return new FixtureRuntime()
  },
}

describe('RuntimeRegistry', () => {
  it('creates a registered runtime without adapter-specific types', async () => {
    const registry = new RuntimeRegistry([fixtureAdapter])
    const runtime = registry.create('fixture')

    expect(registry.kinds()).toEqual(['fixture'])
    expect(runtime.kind).toBe('fixture')
    expect(await runtime.health()).toEqual({ available: true, version: 'fixture-1' })
  })

  it('rejects unknown and duplicate adapters', () => {
    const registry = new RuntimeRegistry([fixtureAdapter])

    expect(() => registry.register(fixtureAdapter)).toThrow('already registered')
    expect(() => registry.create('missing')).toThrow('Unknown runtime adapter')
  })

  it('rejects adapters that return the wrong runtime kind', () => {
    const registry = new RuntimeRegistry([{
      kind: 'alias',
      create: () => new FixtureRuntime(),
    }])

    expect(() => registry.create('alias')).toThrow('mismatched runtime')
  })
})
