import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { LicensePayload, SignedLicense } from '@papyrus/contracts'
import { AgentDatabase } from '../src/agent/database.js'
import { LicenseService, signLicense } from '../src/license.js'

type Branding = { branding: { entraAppLogoUrl: string } }

const originalLogo = process.env.PAPYRUS_ENTRA_APP_LOGO_URL

afterEach(() => {
  if (originalLogo === undefined) delete process.env.PAPYRUS_ENTRA_APP_LOGO_URL
  else process.env.PAPYRUS_ENTRA_APP_LOGO_URL = originalLogo
})

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-license-branding-'))
  const db = new AgentDatabase(':memory:')
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const license = new LicenseService(db, dataDir, 'government', { beag: publicKey }, true)
  const base: LicensePayload = {
    licenseId: 'branding-test',
    licensee: 'Example Agency',
    deploymentId: license.deploymentId,
    profiles: ['government'],
    features: ['core'],
    issuedAt: new Date().toISOString(),
    expiresAt: null,
  }
  return {
    db,
    dataDir,
    license,
    privateKey,
    base,
    close: () => { db.close(); rmSync(dataDir, { recursive: true, force: true }) },
  }
}

describe.sequential('license-provisioned Entra branding', () => {
  it('uses the Entra App Registration logo from the verified signed license', () => {
    process.env.PAPYRUS_ENTRA_APP_LOGO_URL = 'https://legacy.example/should-not-win.png'
    const { license, privateKey, base, close } = fixture()
    try {
      expect(process.env.PAPYRUS_ENTRA_APP_LOGO_URL).toBeUndefined()
      const payload = {
        ...base,
        branding: { entraAppLogoUrl: 'https://cdn.example.gov/papyrus-app.png' },
      } satisfies LicensePayload & Branding
      const document = signLicense(payload, 'beag', privateKey) as SignedLicense & Branding
      expect(license.activate(document)).toMatchObject({ valid: true })
      expect(process.env.PAPYRUS_ENTRA_APP_LOGO_URL).toBe('https://cdn.example.gov/papyrus-app.png')
      expect((license.status().license as (NonNullable<ReturnType<typeof license.status>['license']> & Branding) | undefined)?.branding.entraAppLogoUrl)
        .toBe('https://cdn.example.gov/papyrus-app.png')
    } finally { close() }
  })

  it('does not apply branding when the signed payload is tampered with', () => {
    const { license, privateKey, base, close } = fixture()
    try {
      const payload = {
        ...base,
        branding: { entraAppLogoUrl: 'https://cdn.example.gov/approved.png' },
      } satisfies LicensePayload & Branding
      const signed = signLicense(payload, 'beag', privateKey) as SignedLicense & Branding
      const tampered = {
        ...signed,
        branding: { entraAppLogoUrl: 'https://attacker.example/changed.png' },
      }
      const result = license.activate(tampered)
      expect(result.valid).toBe(false)
      expect(result.reason).toBe('Invalid license signature')
      expect(process.env.PAPYRUS_ENTRA_APP_LOGO_URL).toBeUndefined()
    } finally { close() }
  })
})
