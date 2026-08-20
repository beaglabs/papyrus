import { describe, expect, it } from 'vitest'
import { resolveAgentSpec } from '../src/agents.js'

describe('agent registry', () => {
  it('resolves the built-in goose spec', () => {
    const spec = resolveAgentSpec('goose')
    expect(spec?.command).toBe('goose')
    expect(spec?.args).toEqual(['acp'])
    expect(spec?.environment()).toEqual({})
  })

  it('builds a config-driven agent from an env template', () => {
    const spec = resolveAgentSpec('opencode', {
      opencode: { command: 'opencode', args: ['acp'], env: { MODEL: 'test-model', OPENAI_BASE_URL: 'http://m/v1', OPENAI_API_KEY: 'test-key' } },
    })
    expect(spec?.command).toBe('opencode')
    expect(spec?.environment()).toEqual({ MODEL: 'test-model', OPENAI_BASE_URL: 'http://m/v1', OPENAI_API_KEY: 'test-key' })
  })

  it('rejects an unknown kind without a config entry', () => {
    expect(resolveAgentSpec('unknown')).toBeUndefined()
  })
})
