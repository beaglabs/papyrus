import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LicensePayload } from '@papyrus/contracts'
import { CyberDatabase } from '../src/cyber/database.js'
import { LicenseService, signLicense } from '../src/license.js'

describe('cyber daemon licensing', () => {
  it('keeps deployment-bound offline licensing for the new profiles', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-cyber-license-'))
    const db = new CyberDatabase(':memory:')
    try {
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const license = new LicenseService(db, dataDir, 'gcch', { beag: publicKey }, true)
      const payload: LicensePayload = {
        licenseId: 'cyber-1', licensee: 'Example Agency', deploymentId: license.deploymentId,
        profiles: ['gcch'], features: ['core', 'teams', 'security-connectors'], issuedAt: new Date().toISOString(), expiresAt: null,
      }
      expect(license.activate(signLicense(payload, 'beag', privateKey))).toMatchObject({ valid: true })
      expect(license.status().license?.features).toContain('security-connectors')
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }) }
  })
})
