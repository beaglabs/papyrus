import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentConfig } from '../src/agent/config.js'
import { AgentDatabase } from '../src/agent/database.js'
import { AgentService } from '../src/agent/service.js'
import { SessionConnectorStore } from '../src/agent/session-connectors.js'

describe('session connector bindings', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-session-connectors-'))
    const db = new AgentDatabase(':memory:')
    const config: AgentConfig = {
      mode: 'local', profile: 'commercial', host: 'localhost', port: 3210, publicOrigin: 'http://localhost:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
    const service = new AgentService(db, config)
    const store = new SessionConnectorStore(db)
    const owner = {
      oid: 'owner-oid', tenantId: 'tenant', displayName: 'Owner',
      roles: ['Papyrus.System.Owner' as const], groups: [], source: 'development' as const,
    }
    disposers.push(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }) })
    return { db, service, store, owner }
  }

  it('binds an existing connector to one session without making it connected in another', () => {
    const { service, store, owner } = setup()
    const integration = service.createIntegration(owner, 'observation-api', {
      name: 'Operations observations', scope: 'enterprise', settings: {},
    })
    expect(integration.state).toBe('active')

    expect(store.list(service, owner, 'thread-a').find((item) => item.catalogId === 'observation-api')).toMatchObject({
      status: 'available', integrationId: integration.id,
    })
    expect(store.list(service, owner, 'thread-b').find((item) => item.catalogId === 'observation-api')).toMatchObject({
      status: 'available', integrationId: integration.id,
    })

    const connected = store.connect(service, owner, 'thread-a', 'observation-api', integration.id)
    expect(connected).toMatchObject({ status: 'connected', integrationId: integration.id })
    expect(store.isIntegrationConnected(owner, 'thread-a', integration.id)).toBe(true)
    expect(store.isIntegrationConnected(owner, 'thread-b', integration.id)).toBe(false)

    expect(store.list(service, owner, 'thread-a').find((item) => item.catalogId === 'observation-api')?.status).toBe('connected')
    expect(store.list(service, owner, 'thread-b').find((item) => item.catalogId === 'observation-api')?.status).toBe('available')
  })

  it('reports setup state and searches the deployment connector catalog', () => {
    const { service, store, owner } = setup()
    const teams = store.list(service, owner, 'thread-a', 'teams')
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ catalogId: 'microsoft-teams', status: 'needs_setup', authority: 'bidirectional' })
    expect(teams[0]?.capabilities.length).toBeGreaterThan(0)
  })

  it('disconnects only the session binding and retains the reusable integration configuration', () => {
    const { service, store, owner } = setup()
    const integration = service.createIntegration(owner, 'observation-api', {
      name: 'Operations observations', settings: {},
    })
    store.connect(service, owner, 'thread-a', 'observation-api', integration.id)
    store.disconnect(owner, 'thread-a', 'observation-api')

    expect(store.isIntegrationConnected(owner, 'thread-a', integration.id)).toBe(false)
    expect(service.integrations(owner).find((candidate) => candidate.id === integration.id)?.state).toBe('active')
    expect(store.list(service, owner, 'thread-a').find((item) => item.catalogId === 'observation-api')?.status).toBe('available')
  })
})
