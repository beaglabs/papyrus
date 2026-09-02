import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('requires Entra application roles and enforces draft, test, approval, activation', () => {
    const { db, service, owner, viewer } = setup()
    expect(() => service.createIntegration(viewer, 'zeek', { name: 'Zeek East', scope: 'east enclave', settings: {} }))
      .toThrow(/Papyrus\.Integration\.Manage/)
    const integration = service.createIntegration(owner, 'zeek', { name: 'Zeek East', scope: 'east enclave', settings: {} })
    expect(integration.state).toBe('draft')
    expect(service.testIntegration(owner, integration.id).state).toBe('tested')
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

  it('requires Security.Manage before activating high-risk connectors', () => {
    const { service, owner } = setup()
    const integration = service.createIntegration(owner, 'microsoft-entra', { name: 'Entra terrain', scope: 'tenant', settings: {} })
    service.testIntegration(owner, integration.id)
    service.submitIntegration(owner, integration.id)
    const integrationManager = {
      oid: 'manager', tenantId: 'tenant', displayName: 'Manager', roles: ['Papyrus.Integration.Manage' as const], groups: [], source: 'development' as const,
    }
    expect(() => service.activateIntegration(integrationManager, integration.id)).toThrow(/Papyrus\.Security\.Manage/)
  })
})
