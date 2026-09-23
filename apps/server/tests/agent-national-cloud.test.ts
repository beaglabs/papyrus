import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IntegrationConfiguration } from '@papyrus/contracts'
import { loadAgentConfig, type AgentConfig } from '../src/agent/config.js'
import { AgentDatabase } from '../src/agent/database.js'
import { HttpMicrosoftGraphClient } from '../src/agent/graph-client.js'
import { ModelStore } from '../src/agent/model-store.js'
import { authorityHost, graphOrigin } from '../src/agent/national-cloud.js'

const exchangeIntegration: IntegrationConfiguration = {
  id: 'exchange-1', catalogId: 'exchange-email', name: 'Operations mailbox',
  integrationClass: 'human_interface', authority: 'bidirectional', risk: 'moderate',
  state: 'active', scope: 'operations', credentialRef: 'vault://customer-vault/papyrus/exchange',
  settings: { mailbox: 'soc@example.mil' }, health: 'healthy',
  createdByOid: 'owner', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', version: 1,
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    mode: 'local', profile: 'government', host: '127.0.0.1', port: 3210, publicOrigin: 'http://127.0.0.1:3210',
    dataDir: '/var/lib/papyrus', databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
    organizationName: 'Example Agency', cloud: 'USGov', licenseRequired: false, licenseAuthorities: {},
    ...overrides,
  }
}

function environment(profile: 'commercial' | 'government' | 'disconnected', cloud?: 'Public' | 'USGov' | 'USGovDoD'): NodeJS.ProcessEnv {
  return {
    PAPYRUS_MODE: 'local',
    PAPYRUS_PROFILE: profile,
    ...(cloud ? { PAPYRUS_ENTRA_CLOUD: cloud } : {}),
    PAPYRUS_DATABASE_PATH: ':memory:',
    PAPYRUS_PORTAL_SECRET: 'portal-secret-at-least-thirty-two-characters',
    PAPYRUS_DEV_ENTRA_PRINCIPAL: JSON.stringify({
      oid: 'operator-1', tenantId: 'tenant-1', displayName: 'Operator', roles: ['Papyrus.System.Owner'],
    }),
  }
}

describe('national cloud endpoints', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('addresses the DoD Graph host instead of the GCC High host', () => {
    expect(graphOrigin('Public')).toBe('https://graph.microsoft.com')
    expect(graphOrigin('USGov')).toBe('https://graph.microsoft.us')
    expect(graphOrigin('USGovDoD')).toBe('https://dod-graph.microsoft.us')
    expect(graphOrigin('USGovDoD')).not.toBe(graphOrigin('USGov'))
  })

  it('keeps the Entra authority shared by both government clouds', () => {
    expect(authorityHost('Public')).toBe('https://login.microsoftonline.com')
    expect(authorityHost('USGov')).toBe('https://login.microsoftonline.us')
    expect(authorityHost('USGovDoD')).toBe('https://login.microsoftonline.us')
  })

  it('selects the Entra cloud independently from the deployment profile', () => {
    expect(loadAgentConfig(environment('commercial')).cloud).toBe('Public')
    expect(loadAgentConfig(environment('government')).cloud).toBe('Public')
    expect(loadAgentConfig(environment('disconnected')).cloud).toBe('Public')
    expect(loadAgentConfig(environment('government', 'USGov')).cloud).toBe('USGov')
    expect(loadAgentConfig(environment('government', 'USGovDoD')).cloud).toBe('USGovDoD')
  })

  it('rejects an unsupported Entra cloud', () => {
    expect(() => loadAgentConfig({ ...environment('government'), PAPYRUS_ENTRA_CLOUD: 'USGovSecret' })).toThrow(/PAPYRUS_ENTRA_CLOUD/)
  })

  it('sends a DoD deployment at the DoD Graph host', async () => {
    const requested: string[] = []
    const client = new HttpMicrosoftGraphClient(
      config({ cloud: 'USGovDoD' }),
      { async resolve() { return { accessToken: 'token' } } },
      (async (input: RequestInfo | URL) => {
        requested.push(String(input))
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    )

    await client.listMessages(exchangeIntegration, undefined, new AbortController().signal)
    expect(requested).toHaveLength(1)
    expect(new URL(requested[0] as string).host).toBe('dod-graph.microsoft.us')
  })

  it('sends a GCC High deployment at the GCC High Graph host', async () => {
    const requested: string[] = []
    const client = new HttpMicrosoftGraphClient(
      config({ cloud: 'USGov' }),
      { async resolve() { return { accessToken: 'token' } } },
      (async (input: RequestInfo | URL) => {
        requested.push(String(input))
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as typeof fetch,
    )

    await client.listMessages(exchangeIntegration, undefined, new AbortController().signal)
    expect(new URL(requested[0] as string).host).toBe('graph.microsoft.us')
  })
})

describe('legacy model bootstrap endpoint selection', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function store(): ModelStore {
    return new ModelStore(new AgentDatabase(':memory:'))
  }

  it('refuses to invent a commercial endpoint on the government profile', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const models = store()
    expect(models.bootstrapLegacy({ PAPYRUS_AGENT_MODEL: 'openai/gpt-5' }, { profile: 'government' })).toBeUndefined()
    expect(models.list()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('will not fall back to a commercial provider endpoint'))
  })

  it('refuses to invent a commercial endpoint on every restricted runtime posture', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const profile of ['government', 'disconnected'] as const) {
      const models = store()
      expect(models.bootstrapLegacy({ PAPYRUS_AGENT_MODEL: 'openai/gpt-5' }, { profile })).toBeUndefined()
      expect(models.list()).toHaveLength(0)
    }
  })

  it('imports the endpoint the operator configured for a government deployment', () => {
    const models = store()
    const created = models.bootstrapLegacy(
      { PAPYRUS_AGENT_MODEL: 'openai/gpt-5', PAPYRUS_MODEL_BASE_URL: 'https://agency-openai.openai.azure.us/v1' },
      { profile: 'government' },
    )
    expect(created?.baseUrl).toBe('https://agency-openai.openai.azure.us/v1')
    expect(models.list()).toHaveLength(1)
  })

  it('keeps the commercial default only for the commercial profile', () => {
    const models = store()
    const created = models.bootstrapLegacy({ PAPYRUS_AGENT_MODEL: 'openai/gpt-5' }, { profile: 'commercial' })
    expect(created?.baseUrl).toBe('https://api.openai.com/v1')
  })

  it('still allows a loopback provider on a government profile', () => {
    const models = store()
    const created = models.bootstrapLegacy({ PAPYRUS_AGENT_MODEL: 'ollama/qwen3-32b' }, { profile: 'government' })
    expect(created?.baseUrl).toBe('http://127.0.0.1:11434/v1')
  })

  it('warns when an operator points a government profile at a commercial host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const models = store()
    const created = models.bootstrapLegacy(
      { PAPYRUS_AGENT_MODEL: 'openai/gpt-5', PAPYRUS_MODEL_BASE_URL: 'https://api.openai.com/v1' },
      { profile: 'government' },
    )
    expect(created?.baseUrl).toBe('https://api.openai.com/v1')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('commercial endpoint'))
  })
})
