import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  generateMemberIdentity,
  hasMemberIdentity,
  loadMemberIdentity,
  loadOrGenerateMemberIdentity,
  publicKeyFromPrivate,
} from '../src/auth/keygen.js'

describe('Ed25519 member key generation', () => {
  it('generates a valid keypair', () => {
    const id = generateMemberIdentity()
    expect(id.publicKey).toMatch(/^[0-9a-f]{64}$/)
    expect(id.privateKey).toMatch(/^[0-9a-f]{64}$/)
    expect(id.createdAt).toBeTruthy()
  })

  it('derives public key from a real PEM private key', () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const derived = publicKeyFromPrivate(privateKey)
    expect(derived).toMatch(/^[0-9a-f]{64}$/)
  })

  it('loads or generates identity (creates file if absent)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-test-'))
    try {
      expect(hasMemberIdentity(dir)).toBe(false)
      const id1 = loadOrGenerateMemberIdentity(dir)
      expect(hasMemberIdentity(dir)).toBe(true)
      const id2 = loadOrGenerateMemberIdentity(dir) // loads existing
      expect(id2.publicKey).toBe(id1.publicKey)
      expect(id2.privateKey).toBe(id1.privateKey)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('throws if identity not found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'papyrus-test-empty-'))
    try {
      expect(() => loadMemberIdentity(dir)).toThrow(/No member identity found/)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })

  it('computes a deterministic fingerprint', () => {
    const key = 'a'.repeat(64)
    const fp1 = fingerprint(key)
    const fp2 = fingerprint(key)
    expect(fp1).toBe(fp2)
    expect(fp1).toMatch(/^[0-9a-f]{64}$/)
  })
})
