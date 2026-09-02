import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INTEGRATION_CATALOG } from '../src/cyber/catalog.js'
import type { CyberConfig } from '../src/cyber/config.js'
import { CyberDatabase } from '../src/cyber/database.js'
import { CyberService } from '../src/cyber/service.js'

describe('cyber integration lifecycle', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  function setup() {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-cyber-test-'))
    const db = new CyberDatabase(':memory:')
    const config: CyberConfig = {
      mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 3210, publicOrigin: 'http://127.0.0.1:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
    const service = new CyberService(db, config)
    const owner = { oid: 'owner-oid', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner' as const], groups: [], source: 'development' as const }
    const viewer = { oid: 'viewer-oid', tenantId: 'tenant', displayName: 'Viewer', roles: ['Papyrus.Integration.View' as const], groups: [], source: 'development' as const }
    disposers.push(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }) })
    return { db, service, owner, viewer }
  }

  it('requires Entra application roles and enforces draft, test, approval, activation', async () => {
    const { db, service, owner, viewer } = setup()
    expect(() => service.createIntegration(viewer, 'zeek', { name: 'Zeek East', scope: 'east enclave', settings: {} }))
      .toThrow(/Papyrus\.Integration\.Manage/)
    const integration = service.createIntegration(owner, 'zeek', { name: 'Zeek East', scope: 'east enclave', settings: {} })
    expect(integration.state).toBe('draft')
    expect((await service.testIntegration(owner, integration.id)).state).toBe('tested')
    expect(service.submitIntegration(owner, integration.id).state).toBe('awaiting_approval')
    expect(service.activateIntegration(owner, integration.id).state).toBe('active')
    expect(db.verifyEventChain()).toEqual({ valid: true, count: 4 })
  })

  it('rejects inline connector secrets and stores only credential references', () => {
    const { service, owner } = setup()
    expect(() => service.createIntegration(owner, 'defender-xdr', {
      name: 'Defender', scope: 'enterprise', settings: { clientSecret: 'do-not-store' },
    })).toThrow(/vault reference/i)
    const integration = service.createIntegration(owner, 'defender-xdr', {
      name: 'Defender', scope: 'enterprise', credentialRef: 'keyvault://papyrus/connectors/defender', settings: { dataHandling: 'metadata_only' },
    })
    expect(integration.credentialRef).toBe('keyvault://papyrus/connectors/defender')
    expect(JSON.stringify(integration)).not.toContain('do-not-store')
  })

  it('requires Security.Manage before activating high-risk connectors', async () => {
    const { service, owner } = setup()
    const integration = service.createIntegration(owner, 'microsoft-entra', { name: 'Entra terrain', scope: 'tenant', settings: {} })
    await service.testIntegration(owner, integration.id)
    service.submitIntegration(owner, integration.id)
    const integrationManager = {
      oid: 'manager', tenantId: 'tenant', displayName: 'Manager', roles: ['Papyrus.Integration.Manage' as const], groups: [], source: 'development' as const,
    }
    expect(() => service.activateIntegration(integrationManager, integration.id)).toThrow(/Papyrus\.Security\.Manage/)
  })

  it('keeps configuration-only tests unknown and refuses to activate a pull connector without a driver', async () => {
    const { service, owner } = setup()
    const integration = service.createIntegration(owner, 'exchange-email', { name: 'Mailbox', scope: 'operations', settings: {} })
    expect(await service.testIntegration(owner, integration.id)).toMatchObject({ state: 'tested', health: 'unknown' })
    service.submitIntegration(owner, integration.id)
    expect(() => service.activateIntegration(owner, integration.id)).toThrow(/driver must be installed/i)
  })

  it('exposes evidence and terrain connectors as Observation API source profiles', () => {
    const sources = INTEGRATION_CATALOG.filter((entry) => ['evidence_source', 'terrain_source'].includes(entry.integrationClass))
    expect(sources.every((entry) => entry.syncMode === 'push' && entry.observationProtocol)).toBe(true)
    for (const entry of sources) for (const schema of entry.observationProtocol?.schemas ?? []) {
      expect(entry.evidenceTypes.length === 0 || entry.evidenceTypes.includes(schema.evidenceType)).toBe(true)
      expect(schema.canonicalExample?.evidenceType).toBe(schema.evidenceType)
    }
    expect(INTEGRATION_CATALOG.find((entry) => entry.id === 'observation-api')).toMatchObject({ name: 'Custom Source' })
    expect(INTEGRATION_CATALOG.find((entry) => entry.id === 'zeek')?.observationProtocol?.schemas.map((schema) => schema.id)).toContain('zeek.conn@1')
    expect(INTEGRATION_CATALOG.find((entry) => entry.id === 'asset-inventory')?.observationProtocol?.schemas.map((schema) => schema.id)).toContain('asset.device@1')
  })
})
