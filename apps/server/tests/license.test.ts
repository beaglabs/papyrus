import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { LicensePayload } from '@papyrus/contracts'
import { LicenseService, signLicense } from '../src/license.js'
import { testContext } from './helpers.js'

describe('signed offline licensing', () => {
  const contexts: ReturnType<typeof testContext>[] = []
  afterEach(() => { while (contexts.length) contexts.pop()?.dispose() })

  it('verifies authority, deployment binding, profile, and signature offline', () => {
    const context = testContext(); contexts.push(context)
    const pair = generateKeyPairSync('ed25519')
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const licensing = new LicenseService(context.db, context.dataDir, 'commercial', { root: publicKey }, true)
    const payload: LicensePayload = {
      licenseId: 'license-1', licensee: 'Example Agency', deploymentId: licensing.deploymentId,
      profiles: ['commercial'], features: ['gateway'], issuedAt: new Date().toISOString(), expiresAt: null,
    }
    expect(licensing.activate(signLicense(payload, 'root', privateKey)).valid).toBe(true)
    expect(licensing.status().valid).toBe(true)
    expect(licensing.activate(signLicense({ ...payload, deploymentId: 'another' }, 'root', privateKey))).toMatchObject({ valid: false })
  })
})
