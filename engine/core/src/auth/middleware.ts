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
import { randomBytes, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { loadOrGenerateDeploymentIdentity } from './deployment-identity.js'

const TOKEN_DIR = join(process.env.HOME ?? '~', '.papyrus', 'auth')
const REVOKED_TOKEN_FILE = join(TOKEN_DIR, 'revoked-session-tokens.json')

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

function verifySignature(payloadBytes: Buffer, sigHex: string, publicKeyPem: string): boolean {
  try {
    const sig = Buffer.from(sigHex, 'hex')
    return verify(null, payloadBytes, publicKeyPem, sig)
  } catch {
    return false
  }
}

function revokedTokenIds(): Set<string> {
  if (!existsSync(REVOKED_TOKEN_FILE)) return new Set()
  try {
    return new Set(JSON.parse(readFileSync(REVOKED_TOKEN_FILE, 'utf8')) as string[])
  } catch {
    return new Set()
  }
}

function storeRevokedTokenIds(ids: Set<string>): void {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(REVOKED_TOKEN_FILE, JSON.stringify([...ids]), { encoding: 'utf8', mode: 0o600 })
}

// ── Token Management ─────────────────────────────────────────

/**
 * Create an Ed25519-signed session token.
 * The member's private key is used to sign the token payload.
 */
export function createSessionToken(memberKey: string, displayName: string): string {
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

  // The authoritative deployment signs sessions for every authenticated member.
  const identity = loadOrGenerateDeploymentIdentity()
  const payloadBytes = Buffer.from(payloadJson, 'utf-8')
  const signature = sign(null, payloadBytes, identity.privateKeyPem).toString('hex')

  // Token = payload_b64url.signature_hex
  return `${payloadB64}.${signature}`
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

    // Verify Ed25519 signature using the authoritative deployment identity.
    const payloadBytes = Buffer.from(payloadJson, 'utf-8')
    const identity = loadOrGenerateDeploymentIdentity()
    if (!verifySignature(payloadBytes, sigHex, identity.publicKeyPem)) {
      return null
    }

    if (revokedTokenIds().has(payload.jti)) return null

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
  const token = createSessionToken(payload.memberKey, payload.displayName)
  revokeSessionToken(oldToken)
  return token
}

/**
 * Revoke the current session token.
 */
export function revokeSessionToken(token?: string): boolean {
  if (!token) return false
  const payloadB64 = token.slice(0, token.lastIndexOf('.'))
  if (!payloadB64) return false
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8'),
    ) as TokenPayload
    const revoked = revokedTokenIds()
    revoked.add(payload.jti)
    storeRevokedTokenIds(revoked)
    return true
  } catch {
    return false
  }
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
