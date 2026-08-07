import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signLicense } from '@papyrus/core/auth/license'
import { describe, expect, it } from 'vitest'
import { LicenseService } from './license-service.js'

function authority() {
  return generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

describe('LicenseService', () => {
  it('fails closed when no license is installed', () => {
    const keys = authority()
    const service = new LicenseService('commercial', mkdtempSync(join(tmpdir(), 'papyrus-license-')), keys.publicKey)
    expect(service.getStatus()).toMatchObject({ valid: false, reason: 'No license installed' })
  })

  it('activates a signed perpetual license bound to this deployment', () => {
    const keys = authority()
    const service = new LicenseService('commercial', mkdtempSync(join(tmpdir(), 'papyrus-license-')), keys.publicKey)
    const license = signLicense({ licenseId: 'perpetual-1', licensee: 'Test Agency', profile: 'commercial', deploymentId: service.identity.deploymentId, issuedAt: new Date().toISOString(), expiresAt: null }, keys.privateKey)
    expect(service.activate(license).valid).toBe(true)
    expect(service.getStatus()).toMatchObject({ valid: true, licenseId: 'perpetual-1' })
  })

  it('rejects forged, expired, wrong-profile, and wrong-deployment licenses', () => {
    const trusted = authority()
    const attacker = authority()
    const service = new LicenseService('commercial', mkdtempSync(join(tmpdir(), 'papyrus-license-')), trusted.publicKey)
    const base = { licenseId: 'pilot-1', licensee: 'Test Agency', profile: 'commercial' as const, deploymentId: service.identity.deploymentId, issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }
    expect(service.activate(signLicense(base, attacker.privateKey)).reason).toBe('Invalid signature')
    expect(service.activate(signLicense({ ...base, expiresAt: '2020-01-01T00:00:00Z' }, trusted.privateKey)).reason).toContain('expired')
    expect(service.activate(signLicense({ ...base, profile: 'niprnet-il4' }, trusted.privateKey)).reason).toContain('not "commercial"')
    expect(service.activate(signLicense({ ...base, deploymentId: 'another-deployment' }, trusted.privateKey)).reason).toContain('another deployment')
  })
})
