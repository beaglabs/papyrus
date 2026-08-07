/**
 * Ed25519 member key generation and storage.
 *
 * On first auth, the daemon generates an Ed25519 keypair. The public key
 * becomes the member's identity in p2panda-auth; the private key is stored at
 * `~/.papyrus/identity/member.json`. For P1 this file is plaintext; production
 * would encrypt at rest (e.g. OS keychain, or a passphrase-derived key).
 *
 * Uses Node built-in `crypto` (Ed25519 supported since Node 15). No deps.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemberIdentity } from './types.js'

const DEFAULT_IDENTITY_DIR = join(process.env.HOME ?? '~', '.papyrus', 'identity')
const MEMBER_KEY_FILE = 'member.json'

/**
 * Derive the hex-encoded Ed25519 public key from a PEM private key string.
 * Used by tests and utilities.
 */
export function publicKeyFromPrivate(pem: string): string {
  const keyObject = createPrivateKey(pem)
  const pub = createPublicKey(keyObject)
  const spki = pub.export({ type: 'spki', format: 'der' })
  // Ed25519 SPKI: public key bytes start at offset 12 (32 bytes)
  const raw = spki.subarray(12, 44)
  return raw.toString('hex')
}

/** Generate a new Ed25519 member identity. */
export function generateMemberIdentity(): MemberIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const pubHex = publicKeyFromPrivate(privateKey)
  const privHex = createPrivateKey(privateKey)
    .export({ type: 'pkcs8', format: 'der' })
    .subarray(16, 48)
    .toString('hex')

  return {
    publicKey: pubHex,
    privateKey: privHex,
    createdAt: new Date().toISOString(),
  }
}

/** Load the member identity from disk, or generate if absent. */
export function loadOrGenerateMemberIdentity(dir = DEFAULT_IDENTITY_DIR): MemberIdentity {
  const file = join(dir, MEMBER_KEY_FILE)
  if (existsSync(file)) {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as MemberIdentity
    if (data.publicKey && data.privateKey && data.createdAt) return data
  }
  const identity = generateMemberIdentity()
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(identity, null, 2), 'utf-8')
  return identity
}

/** Load an existing member identity. Throws if not found. */
export function loadMemberIdentity(dir = DEFAULT_IDENTITY_DIR): MemberIdentity {
  const file = join(dir, MEMBER_KEY_FILE)
  if (!existsSync(file)) {
    throw new Error(`No member identity found at ${file}. Run a papyrus auth flow first.`)
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as MemberIdentity
}

/** Check whether a member identity exists on disk. */
export function hasMemberIdentity(dir = DEFAULT_IDENTITY_DIR): boolean {
  const file = join(dir, MEMBER_KEY_FILE)
  return existsSync(file)
}

/** Compute the SHA-256 fingerprint of a member public key (hex). */
export function fingerprint(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex')
}
