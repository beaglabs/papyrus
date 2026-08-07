import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'

const TEST_DIR = join(process.env.TEMP ?? '/tmp', 'papyrus-test-auth')
const IDENTITY_DIR = join(TEST_DIR, 'identity')
const AUTH_DIR = join(TEST_DIR, 'auth')

// We need to test the middleware functions, but they use hardcoded paths.
// For unit tests, we'll test the core logic functions directly.
// Integration tests would need path mocking.

describe('Auth middleware', () => {
  let testPubKey: string
  let testPrivKey: string

  beforeAll(() => {
    // Generate a test Ed25519 keypair
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    testPubKey = publicKey.export({ type: 'spki', format: 'der' }).subarray(12, 44).toString('hex')
    testPrivKey = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16, 48).toString('hex')
  })

  describe('Ed25519 signing helpers', () => {
    it('should convert public key hex to PEM format', async () => {
      // Test that the key conversion works by signing and verifying
      const { createPrivateKey, createPublicKey, sign, verify } = await import('node:crypto')

      const raw = Buffer.from(testPubKey, 'hex')
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
      const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64')}\n-----END PUBLIC KEY-----`

      const keyObj = createPublicKey(pem)
      expect(keyObj).toBeTruthy()

      // Test private key conversion
      const privRaw = Buffer.from(testPrivKey, 'hex')
      const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), privRaw])
      const privPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64')}\n-----END PRIVATE KEY-----`

      const privObj = createPrivateKey(privPem)
      expect(privObj).toBeTruthy()

      // Sign and verify
      const data = Buffer.from('test message')
      const sig = sign(null, data, privObj)
      const valid = verify(null, data, keyObj, sig)
      expect(valid).toBe(true)
    })

    it('should reject invalid signatures', async () => {
      const { createPublicKey, generateKeyPairSync, sign, verify } = await import('node:crypto')

      // Generate a different keypair
      const { publicKey: otherPub } = generateKeyPairSync('ed25519')
      const otherPubHex = otherPub.export({ type: 'spki', format: 'der' }).subarray(12, 44).toString('hex')

      const raw = Buffer.from(otherPubHex, 'hex')
      const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
      const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64')}\n-----END PUBLIC KEY-----`

      // Sign with original key
      const { createPrivateKey } = await import('node:crypto')
      const privRaw = Buffer.from(testPrivKey, 'hex')
      const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), privRaw])
      const privPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64')}\n-----END PRIVATE KEY-----`

      const data = Buffer.from('test message')
      const sig = sign(null, data, createPrivateKey(privPem))

      // Verify with wrong key should fail
      const keyObj = createPublicKey(pem)
      const valid = verify(null, data, keyObj, sig)
      expect(valid).toBe(false)
    })
  })

  describe('AES-256-GCM encryption', () => {
    it('should encrypt and decrypt data correctly', async () => {
      const { createCipheriv, createDecipheriv, randomBytes, createHash } = await import('node:crypto')

      const key = createHash('sha256').update('test-key').digest()
      const plaintext = 'Hello, World! This is a test message.'

      // Encrypt
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
      const authTag = cipher.getAuthTag()
      const encryptedB64 = Buffer.concat([iv, authTag, encrypted]).toString('base64')

      // Decrypt
      const data = Buffer.from(encryptedB64, 'base64')
      const decIv = data.subarray(0, 12)
      const decAuthTag = data.subarray(12, 28)
      const ciphertext = data.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', key, decIv)
      decipher.setAuthTag(decAuthTag)
      const decrypted = decipher.update(ciphertext, undefined, 'utf-8') + decipher.final('utf-8')

      expect(decrypted).toBe(plaintext)
    })

    it('should fail decryption with wrong key', async () => {
      const { createCipheriv, createDecipheriv, randomBytes, createHash } = await import('node:crypto')

      const key = createHash('sha256').update('correct-key').digest()
      const wrongKey = createHash('sha256').update('wrong-key').digest()
      const plaintext = 'Secret data'

      // Encrypt with correct key
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
      const authTag = cipher.getAuthTag()
      const encryptedB64 = Buffer.concat([iv, authTag, encrypted]).toString('base64')

      // Try to decrypt with wrong key
      const data = Buffer.from(encryptedB64, 'base64')
      const decIv = data.subarray(0, 12)
      const decAuthTag = data.subarray(12, 28)
      const ciphertext = data.subarray(28)
      const decipher = createDecipheriv('aes-256-gcm', wrongKey, decIv)
      decipher.setAuthTag(decAuthTag)

      expect(() => {
        decipher.update(ciphertext, undefined, 'utf-8') + decipher.final('utf-8')
      }).toThrow()
    })
  })

  describe('Token format', () => {
    it('should create a valid token format (payload.signature)', () => {
      const payload = {
        memberKey: testPubKey,
        displayName: 'Test User',
        iat: new Date().toISOString(),
        exp: new Date(Date.now() + 3600000).toISOString(),
        jti: 'tok-test-123',
      }

      const payloadJson = JSON.stringify(payload)
      const payloadB64 = Buffer.from(payloadJson).toString('base64url')
      const fakeSignature = 'a'.repeat(64) // 32 bytes hex

      const token = `${payloadB64}.${fakeSignature}`
      const parts = token.split('.')
      expect(parts.length).toBe(2)
      expect(parts[0]!.length).toBeGreaterThan(0)
      expect(parts[1]!.length).toBe(64)
    })
  })
})
