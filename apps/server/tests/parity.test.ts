import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ServerConfig } from '../src/config.js'
import { assertRuntime } from '../src/config.js'
import { PapyrusDatabase } from '../src/db.js'
import { PapyrusService } from '../src/service.js'

function context(mode: 'local' | 'persistent') {
  const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-parity-'))
  const config: ServerConfig = {
    mode, profile: 'commercial', host: mode === 'local' ? '127.0.0.1' : '0.0.0.0', port: 3210, dataDir,
    databasePath: ':memory:', publicOrigin: mode === 'local' ? 'http://127.0.0.1:3210' : 'https://example.gov',
    branding: { organizationName: 'Parity Organization' }, promptTimeoutMs: 30_000, sessionSecret: 'parity-session-secret-that-is-at-least-32-characters',
    licenseRequired: false, licenseAuthorities: {},
  }
  const db = new PapyrusDatabase(':memory:')
  const service = new PapyrusService(db, config)
  return { config, db, service, dispose: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }) } }
}

describe('runtime and mode parity', () => {
  it('enforces Node 24+ and FIPS requirements', () => {
    expect(() => assertRuntime({ profile: 'commercial', mode: 'persistent', nodeVersion: '22.23.1' })).toThrow(/Node\.js 24/)
    // Government profiles only enforce FIPS in persistent mode (production)
    expect(() => assertRuntime({ profile: 'government-il4', mode: 'local', nodeVersion: '24.0.0', fipsEnabled: false })).not.toThrow()
    expect(() => assertRuntime({ profile: 'government-il4', mode: 'persistent', nodeVersion: '24.0.0', fipsEnabled: false })).toThrow(/FIPS/)
    expect(() => assertRuntime({ profile: 'government-il6', mode: 'persistent', nodeVersion: '24.0.0', fipsEnabled: true })).not.toThrow()
    expect(() => assertRuntime({ profile: 'commercial', mode: 'local', nodeVersion: '24.0.0', fipsEnabled: false })).not.toThrow()
  })

  it('shares the same policy and audit behavior in local and persistent modes', () => {
    const local = context('local')
    const persistent = context('persistent')
    try {
      expect(persistent.service.policy.policyVersion).toBe(local.service.policy.policyVersion)
      const alice = local.db.upsertUser({ externalId: 'oidc:issuer:alice', displayName: 'Alice', authMethod: 'oidc' })
      local.db.setRole(alice.id, 'User')
      const bob = persistent.db.upsertUser({ externalId: 'oidc:issuer:bob', displayName: 'Bob', authMethod: 'oidc' })
      persistent.db.setRole(bob.id, 'User')
      const resource = { type: 'Deployment' as const, id: local.service.license.deploymentId }
      const localDecision = local.service.policy.authorize(local.db.getPrincipal(alice.id)!, 'ManageUsers', resource)
      const persistentDecision = persistent.service.policy.authorize(persistent.db.getPrincipal(bob.id)!, 'ManageUsers', resource)
      expect(persistentDecision.allowed).toBe(localDecision.allowed)

      local.service.audit.append({ actorId: null, action: 'Parity', resourceType: 'Test', resourceId: '1', decision: 'deny', metadata: {} })
      persistent.service.audit.append({ actorId: null, action: 'Parity', resourceType: 'Test', resourceId: '1', decision: 'deny', metadata: {} })
      expect(local.service.audit.verify()).toEqual({ valid: true })
      expect(persistent.service.audit.verify()).toEqual({ valid: true })
    } finally {
      local.dispose()
      persistent.dispose()
    }
  })
})
