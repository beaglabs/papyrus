import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { LicensePayload } from '@papyrus/contracts'
import { LicenseService, signLicense } from '../src/license.js'
import { testContext } from './helpers.js'

describe('signed offline licensing', () => {
  const contexts: ReturnType<typeof testContext>[] = []
  afterEach(() => { while (contexts.length) contexts.pop()?.dispose() })

  function setup() {
    const context = testContext(); contexts.push(context)
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const licensing = new LicenseService(context.db, context.dataDir, 'commercial', { root: publicKey }, true)
    const payload: LicensePayload = {
      licenseId: 'license-1', licensee: 'Example Agency', deploymentId: licensing.deploymentId,
      profiles: ['commercial'], features: ['gateway'], issuedAt: new Date().toISOString(), expiresAt: null,
    }
    return { context, licensing, payload, privateKey, publicKey }
  }

  it('verifies authority, deployment binding, profile, and signature offline', () => {
    const { context, licensing, payload, privateKey } = setup()
    expect(licensing.activate(signLicense(payload, 'root', privateKey)).valid).toBe(true)
    expect(licensing.status().valid).toBe(true)
    expect(licensing.activate(signLicense({ ...payload, deploymentId: 'another' }, 'root', privateKey))).toMatchObject({ valid: false })
    expect(context.service.audit.verify()).toEqual({ valid: true })
  })

  it('rejects expired, wrong-profile, unknown-authority, and tampered licenses', () => {
    const { licensing, payload, privateKey } = setup()
    expect(licensing.activate(signLicense({ ...payload, expiresAt: new Date(Date.now() - 60_000).toISOString() }, 'root', privateKey))).toMatchObject({ valid: false, reason: expect.stringMatching(/expired/i) })
    expect(licensing.activate(signLicense({ ...payload, profiles: ['government-il4'] }, 'root', privateKey))).toMatchObject({ valid: false, reason: expect.stringMatching(/does not permit/i) })
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const otherPrivate = other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(licensing.activate(signLicense(payload, 'unknown', otherPrivate))).toMatchObject({ valid: false, reason: expect.stringMatching(/authority/i) })
    const signed = signLicense(payload, 'root', privateKey)
    expect(licensing.activate({ ...signed, features: ['gateway', 'forged'] })).toMatchObject({ valid: false, reason: expect.stringMatching(/signature/i) })
  })
})
