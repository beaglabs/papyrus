import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  generateAuthorityKeyPair,
  loadStoredLicense,
  signLicense,
  storeLicense,
  validateLicense,
  verifyLicenseSignature,
} from '../src/auth/license.js'
import type { LicensePayload, NetworkProfile } from '../src/auth/types.js'

function makePayload(profile: NetworkProfile = 'commercial'): LicensePayload {
  return {
    licenseId: 'papyrus-test-001',
    licensee: 'AFCyberWorx',
    profile,
    features: { agents: true, crossDomainExport: false },
    nodeLimit: 50,
    expiresAt: null,
    issuedAt: '2026-08-07T00:00:00Z',
  }
}

describe('offline license (Ed25519, profile-bound)', () => {
  const authority = generateAuthorityKeyPair()

  it('signs and verifies a license', () => {
    const license = signLicense(makePayload(), authority.privateKeyPem)
    expect(license.signature).toBeTruthy()
    expect(license.publicKey).toBeTruthy()
    expect(verifyLicenseSignature(license)).toBe(true)
  })

  it('rejects a tampered license', () => {
    const license = signLicense(makePayload(), authority.privateKeyPem)
    license.licensee = 'TAMPERED'
    expect(verifyLicenseSignature(license)).toBe(false)
  })

  it('validates a correct license (same profile)', () => {
    const license = signLicense(makePayload('siprnet-il6'), authority.privateKeyPem)
    const status = validateLicense(license, 'siprnet-il6')
    expect(status.valid).toBe(true)
    expect(status.profile).toBe('siprnet-il6')
    expect(status.licensee).toBe('AFCyberWorx')
    expect(status.reason).toBeUndefined()
  })

  it('rejects license for wrong profile', () => {
    const license = signLicense(makePayload('siprnet-il6'), authority.privateKeyPem)
    const status = validateLicense(license, 'commercial')
    expect(status.valid).toBe(false)
    expect(status.reason).toContain('bound to profile')
  })

  it('rejects expired license', () => {
    const payload = makePayload()
    payload.expiresAt = '2020-01-01T00:00:00Z'
    const license = signLicense(payload, authority.privateKeyPem)
    const status = validateLicense(license, 'commercial')
    expect(status.valid).toBe(false)
    expect(status.reason).toContain('expired')
  })

  it('accepts license with future expiry', () => {
    const payload = makePayload()
    payload.expiresAt = '2099-12-31T23:59:59Z'
    const license = signLicense(payload, authority.privateKeyPem)
    const status = validateLicense(license, 'commercial')
    expect(status.valid).toBe(true)
  })

  it('stores and loads license from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-license-'))
    try {
      const license = signLicense(makePayload(), authority.privateKeyPem)
      storeLicense(license, dir)
      const loaded = loadStoredLicense(dir)
      expect(loaded).not.toBeNull()
      expect(loaded?.license.licenseId).toBe('papyrus-test-001')
      expect(loaded?.activatedAt).toBeTruthy()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('returns null when no license stored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-license-empty-'))
    try {
      expect(loadStoredLicense(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})
