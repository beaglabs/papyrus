import { describe, expect, it } from 'vitest'
import { resolveAgentSpec } from '../src/agents.js'

describe('agent registry', () => {
  it('resolves the built-in goose spec', () => {
    const spec = resolveAgentSpec('goose')
    expect(spec?.command).toBe('goose')
    expect(spec?.args).toEqual(['acp'])
    expect(spec?.environment({ provider: 'openai-compatible', baseUrl: 'http://m/v1', model: 'm', secretRef: 'primary' }, 'sekret'))
      .toMatchObject({ GOOSE_PROVIDER: 'openai', OPENAI_HOST: 'http://m/v1', OPENAI_API_KEY: 'sekret' })
  })

  it('builds a config-driven agent from an env template', () => {
    const spec = resolveAgentSpec('opencode', {
      opencode: { command: 'opencode', args: ['acp'], env: { MODEL: '{model}', OPENAI_BASE_URL: '{baseUrl}', OPENAI_API_KEY: '{secret}' } },
    })
    expect(spec?.command).toBe('opencode')
    expect(spec?.environment({ provider: 'openai-compatible', baseUrl: 'http://m/v1', model: 'gpt', secretRef: 'p' }, 'k'))
      .toEqual({ MODEL: 'gpt', OPENAI_BASE_URL: 'http://m/v1', OPENAI_API_KEY: 'k' })
  })

  it('rejects an unknown kind without a config entry', () => {
    expect(resolveAgentSpec('unknown')).toBeUndefined()
  })
})
