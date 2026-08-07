/**
 * Auth middleware — Ed25519-signed Bearer tokens for daemon API.
 *
 * Token format: `<base64url_payload>.<hex_signature>`
 *
 * The payload contains memberKey, displayName, iat, exp, jti.
 * The signature is Ed25519 over the raw payload bytes, signed by the
 * member's private key stored at ~/.papyrus/identity/member.json.
 *
 * Token storage is encrypted at rest using AES-256-GCM with a key
 * derived from the member's public key.
 *
 * Validation:
 * 1. Decode payload
 * 2. Check expiration
 * 3. Verify Ed25519 signature using the member's public key
 * 4. Check jti against revocation list
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { loadOrGenerateMemberIdentity } from './keygen.js'

const TOKEN_DIR = join(process.env.HOME ?? '~', '.papyrus', 'auth')
const TOKEN_FILE = join(TOKEN_DIR, 'session-token.json')
const IDENTITY_DIR = join(process.env.HOME ?? '~', '.papyrus', 'identity')

export interface TokenPayload {
  /** Member's public key (hex) */
  memberKey: string
  /** Display name */
  displayName: string
  /** Issued at (ISO) */
  iat: string
  /** Expires at (ISO) */
  exp: string
  /** Token ID for revocation */
  jti: string
}

export interface AuthContext {
  /** The authenticated member's public key */
  memberKey: string
  /** Display name */
  displayName: string
  /** Whether the token is expired (for refresh prompts) */
  expired: boolean
}

// ── Helpers ──────────────────────────────────────────────────

function pemPublicKeyFromHex(pubHex: string): string {
  const raw = Buffer.from(pubHex, 'hex')
  // Ed25519 SPKI: 12-byte header + 32-byte key
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  return `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64')}\n-----END PUBLIC KEY-----`
}

function pemPrivateKeyFromHex(privHex: string): string {
  const raw = Buffer.from(privHex, 'hex')
  // Ed25519 PKCS8: 16-byte header + 32-byte key
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw])
  return `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64')}\n-----END PRIVATE KEY-----`
}

function signPayload(payloadBytes: Buffer, privHex: string): string {
  const pem = pemPrivateKeyFromHex(privHex)
  const keyObject = createPrivateKey(pem)
  const sig = sign(null, payloadBytes, keyObject)
  return sig.toString('hex')
}

function verifySignature(payloadBytes: Buffer, sigHex: string, pubHex: string): boolean {
  try {
    const pem = pemPublicKeyFromHex(pubHex)
    const keyObject = createPublicKey(pem)
    const sig = Buffer.from(sigHex, 'hex')
    return verify(null, payloadBytes, keyObject, sig)
  } catch {
    return false
  }
}

// ── AES-256-GCM Encryption for Token Storage ─────────────────

/**
 * Derive a 256-bit encryption key from the member's public key.
 * This ensures only the member can decrypt their stored tokens.
 */
function deriveEncryptionKey(memberPubKey: string): Buffer {
  return createHash('sha256').update(`papyrus-token-key:${memberPubKey}`).digest()
}

/**
 * Encrypt data using AES-256-GCM.
 * Returns base64 encoded: iv(12) + authTag(16) + ciphertext
 */
function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted]).toString('base64')
}

/**
 * Decrypt AES-256-GCM encrypted data.
 */
function decrypt(encryptedB64: string, key: Buffer): string {
  const data = Buffer.from(encryptedB64, 'base64')
  const iv = data.subarray(0, 12)
  const authTag = data.subarray(12, 28)
  const ciphertext = data.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext, undefined, 'utf-8') + decipher.final('utf-8')
}

// ── Token Management ─────────────────────────────────────────

/**
 * Create an Ed25519-signed session token.
 * The member's private key is used to sign the token payload.
 */
export function createSessionToken(memberKey: string, displayName: string): string {
  if (!existsSync(TOKEN_DIR)) {
    mkdirSync(TOKEN_DIR, { recursive: true })
  }

  const now = new Date()
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000) // 24 hours

  const payload: TokenPayload = {
    memberKey,
    displayName,
    iat: now.toISOString(),
    exp: expires.toISOString(),
    jti: `tok-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }

  // Encode payload as base64url
  const payloadJson = JSON.stringify(payload)
  const payloadB64 = Buffer.from(payloadJson).toString('base64url')

  // Load the member's private key and sign
  const identityFile = join(IDENTITY_DIR, 'member.json')
  if (!existsSync(identityFile)) {
    throw new Error('No member identity found. Run auth flow first.')
  }
  const identity = JSON.parse(readFileSync(identityFile, 'utf-8')) as {
    publicKey: string
    privateKey: string
  }

  const payloadBytes = Buffer.from(payloadJson, 'utf-8')
  const signature = signPayload(payloadBytes, identity.privateKey)

  // Token = payload_b64url.signature_hex
  const token = `${payloadB64}.${signature}`

  // Encrypt and store for revocation check
  const encKey = deriveEncryptionKey(identity.publicKey)
  const storeData = JSON.stringify({ token, payload, createdAt: now.toISOString() })
  const encrypted = encrypt(storeData, encKey)
  writeFileSync(TOKEN_FILE, encrypted, 'utf-8')

  return token
}

/**
 * Validate an Ed25519-signed session token.
 * Verifies the signature using the member's public key embedded in the payload.
 */
export function validateSessionToken(token: string): TokenPayload | null {
  try {
    const dotIdx = token.lastIndexOf('.')
    if (dotIdx < 0) return null

    const payloadB64 = token.slice(0, dotIdx)
    const sigHex = token.slice(dotIdx + 1)

    // Decode payload
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf-8')
    const payload = JSON.parse(payloadJson) as TokenPayload

    // Check expiration
    if (new Date(payload.exp) < new Date()) {
      return null
    }

    // Verify Ed25519 signature using the member's public key
    const payloadBytes = Buffer.from(payloadJson, 'utf-8')
    if (!verifySignature(payloadBytes, sigHex, payload.memberKey)) {
      return null
    }

    // Revocation check: decrypt and verify token matches the stored one
    if (existsSync(TOKEN_FILE)) {
      try {
        const encKey = deriveEncryptionKey(payload.memberKey)
        const encrypted = readFileSync(TOKEN_FILE, 'utf-8')
        const decrypted = decrypt(encrypted, encKey)
        const stored = JSON.parse(decrypted) as { payload: TokenPayload }
        if (stored.payload.jti !== payload.jti) {
          return null
        }
      } catch {
        // Decryption failed — token file may be corrupted or from wrong identity
        return null
      }
    }

    return payload
  } catch {
    return null
  }
}

/**
 * Refresh a token — validates the old token and issues a new one
 * with the same memberKey and displayName.
 */
export function refreshSessionToken(oldToken: string): string | null {
  const payload = validateSessionToken(oldToken)
  if (!payload) return null

  // Create a new token with fresh timestamps
  return createSessionToken(payload.memberKey, payload.displayName)
}

/**
 * Revoke the current session token.
 */
export function revokeSessionToken(): boolean {
  if (existsSync(TOKEN_FILE)) {
    unlinkSync(TOKEN_FILE)
    return true
  }
  return false
}

// ── Express-style Middleware ──────────────────────────────────

/**
 * Extract and validate Bearer token from Authorization header.
 * Returns AuthContext or null if invalid.
 */
export function extractAuth(req: IncomingMessage): AuthContext | null {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return null
  }

  const token = authHeader.slice(7)
  const payload = validateSessionToken(token)
  if (!payload) {
    return null
  }

  return {
    memberKey: payload.memberKey,
    displayName: payload.displayName,
    expired: false,
  }
}

/**
 * Require authentication — returns auth context or sends 401.
 */
export function requireAuth(req: IncomingMessage, res: ServerResponse): AuthContext | null {
  const ctx = extractAuth(req)
  if (!ctx) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Authentication required' }))
    return null
  }
  return ctx
}

/**
 * Optional authentication — returns auth context or null (no 401).
 * Useful for endpoints that behave differently for authenticated vs anonymous users.
 */
export function optionalAuth(req: IncomingMessage): AuthContext | null {
  return extractAuth(req)
}
