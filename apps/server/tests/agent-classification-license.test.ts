import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LicensePayload } from '@papyrus/contracts'
import { AgentDatabase } from '../src/agent/database.js'
import { LicenseService, signLicense } from '../src/license.js'

const originalClassification = process.env.PAPYRUS_CLASSIFICATION

afterEach(() => {
  if (originalClassification === undefined) delete process.env.PAPYRUS_CLASSIFICATION
  else process.env.PAPYRUS_CLASSIFICATION = originalClassification
})

function fixture(features: string[]) {
  const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-classification-license-'))
  const db = new AgentDatabase(':memory:')
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const license = new LicenseService(db, dataDir, 'government', { beag: publicKey }, true)
  const payload: LicensePayload = {
    licenseId: 'classification-test',
    licensee: 'Example Agency',
    deploymentId: license.deploymentId,
    profiles: ['government'],
    features,
    issuedAt: new Date().toISOString(),
    expiresAt: null,
  }
  expect(license.activate(signLicense(payload, 'beag', privateKey))).toMatchObject({ valid: true })
  return {
    license,
    close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }) },
  }
}

describe.sequential('classification banner entitlement', () => {
  it('uses PAPYRUS_CLASSIFICATION as the effective marking when the capability is licensed', () => {
    process.env.PAPYRUS_CLASSIFICATION = 'secret'
    const { license, close } = fixture(['core', 'classification-banners', 'classification:top-secret'])
    try {
      expect(license.status().license?.features).toContain('classification-banners')
      expect(license.status().license?.features).toContain('classification:secret')
      expect(license.status().license?.features).not.toContain('classification:top-secret')
    } finally { close() }
  })

  it('shows no effective marking when PAPYRUS_CLASSIFICATION is unset', () => {
    delete process.env.PAPYRUS_CLASSIFICATION
    const { license, close } = fixture(['core', 'classification-banners', 'classification:secret'])
    try {
      expect(license.status().license?.features).toContain('classification-banners')
      expect(license.status().license?.features.some((feature) => feature.startsWith('classification:'))).toBe(false)
    } finally { close() }
  })

  it('cannot create a classification marking without the signed capability', () => {
    process.env.PAPYRUS_CLASSIFICATION = 'top-secret-sci'
    const { license, close } = fixture(['core'])
    try {
      expect(license.status().license?.features).not.toContain('classification-banners')
      expect(license.status().license?.features.some((feature) => feature.startsWith('classification:'))).toBe(false)
    } finally { close() }
  })

  it('rejects unsupported PAPYRUS_CLASSIFICATION values', () => {
    process.env.PAPYRUS_CLASSIFICATION = 'super-secret'
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-classification-invalid-'))
    const db = new AgentDatabase(':memory:')
    try {
      expect(() => new LicenseService(db, dataDir, 'government', {}, false)).toThrow(/Unsupported PAPYRUS_CLASSIFICATION/)
    } finally { db.close(); rmSync(dataDir, { recursive: true, force: true }) }
  })
})
