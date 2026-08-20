import { describe, expect, it } from 'vitest'
import { resolveAgentSpec } from '../src/agents.js'

describe('agent registry', () => {
  it('resolves the built-in goose spec', () => {
    const spec = resolveAgentSpec('goose')
    expect(spec?.command).toBe('goose')
    expect(spec?.args).toEqual(['acp'])
    expect(spec?.environment()).toEqual({})
  })

  it('builds a config-driven agent only from a catalog profile', () => {
    const spec = resolveAgentSpec('reviewer', {
      reviewer: { profile: 'opencode', environment: { OPENAI_API_KEY: 'test-key' } },
    })
    expect(spec?.command).toBe('opencode')
    expect(spec?.args).toEqual(['acp'])
    expect(spec?.environment()).toEqual({ OPENAI_API_KEY: 'test-key' })
  })

  it('ships an independent OpenCode ACP profile', () => {
    expect(resolveAgentSpec('opencode')?.command).toBe('opencode')
  })

  it('rejects an unknown kind without a config entry', () => {
    expect(resolveAgentSpec('unknown')).toBeUndefined()
  })
})
