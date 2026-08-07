/**
 * Offline license management.
 *
 * Papyrus licenses are Ed25519-signed, profile-bound JSON files. The signing
 * authority's public key is embedded in the license. The daemon verifies the
 * signature at activation and periodically re-validates. For SIPRNet this must
 * work entirely offline — no revocation check, no OCSP.
 *
 * License file layout:
 *   { LicensePayload, publicKey: base64, signature: base64 }
 *
 * Signature covers the canonical JSON of LicensePayload only (deterministic
 * stringify: sorted keys, no whitespace).
 *
 * Uses `crypto.sign()` / `crypto.verify()` (not `createSign`) because Ed25519
 * uses its own internal hash — not pluggable like RSA/ECDSA.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LicenseFile,
  LicensePayload,
  LicenseStatus,
  NetworkProfile,
  StoredLicense,
} from './types.js'

const DEFAULT_CONFIG_DIR = join(process.env.HOME ?? '~', '.papyrus')
const LICENSE_FILE = 'license.json'

/** Deterministic JSON stringify (sorted keys, no whitespace) for signing. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const pairs = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  )
  return `{${pairs.join(',')}}`
}

/** Build the Ed25519 SPKI DER from a raw 32-byte public key (base64). */
function ed25519SpkiDer(pubBase64: string): Buffer {
  const raw = Buffer.from(pubBase64, 'base64')
  const header = Buffer.from('302a300506032b6570032100', 'hex')
  return Buffer.concat([header, raw])
}

/** Sign a license payload. Returns the signed LicenseFile. */
export function signLicense(payload: LicensePayload, authorityPrivateKeyPem: string): LicenseFile {
  const canonical = Buffer.from(canonicalJson(payload), 'utf-8')
  const keyObj = createPrivateKey(authorityPrivateKeyPem)
  const signature = sign(null, canonical, keyObj).toString('base64')

  // Derive the public key from the private key for embedding.
  const pubKeyObj = createPublicKey(keyObj)
  const pubSpki = pubKeyObj.export({ type: 'spki', format: 'der' })
  // Ed25519 SPKI: raw 32-byte public key starts at offset 12
  const pubRaw = Buffer.isBuffer(pubSpki) ? pubSpki.subarray(12, 44).toString('base64') : ''

  return { ...payload, publicKey: pubRaw, signature }
}

/** Verify a license file's signature against its embedded public key. */
export function verifyLicenseSignature(license: LicenseFile): boolean {
  const { publicKey, signature, ...payload } = license
  const canonical = Buffer.from(canonicalJson(payload as LicensePayload), 'utf-8')
  const spki = ed25519SpkiDer(publicKey)
  const pubKeyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  const sigBuf = Buffer.from(signature, 'base64')
  return verify(null, canonical, pubKeyObj, sigBuf)
}

/** Validate a license: signature + profile + expiry. */
export function validateLicense(
  license: LicenseFile,
  activeProfile: NetworkProfile,
): LicenseStatus {
  if (!verifyLicenseSignature(license)) {
    return {
      valid: false,
      profile: license.profile,
      licensee: license.licensee,
      features: license.features,
      nodeLimit: license.nodeLimit,
      expiresAt: license.expiresAt,
      reason: 'Invalid signature',
    }
  }
  if (license.profile !== activeProfile) {
    return {
      valid: false,
      profile: license.profile,
      licensee: license.licensee,
      features: license.features,
      nodeLimit: license.nodeLimit,
      expiresAt: license.expiresAt,
      reason: `License bound to profile "${license.profile}" but active profile is "${activeProfile}"`,
    }
  }
  if (license.expiresAt !== null && new Date(license.expiresAt) < new Date()) {
    return {
      valid: false,
      profile: license.profile,
      licensee: license.licensee,
      features: license.features,
      nodeLimit: license.nodeLimit,
      expiresAt: license.expiresAt,
      reason: `License expired on ${license.expiresAt}`,
    }
  }
  return {
    valid: true,
    profile: license.profile,
    licensee: license.licensee,
    features: license.features,
    nodeLimit: license.nodeLimit,
    expiresAt: license.expiresAt,
  }
}

/** Load the stored license from disk. Returns null if not activated. */
export function loadStoredLicense(dir = DEFAULT_CONFIG_DIR): StoredLicense | null {
  const file = join(dir, LICENSE_FILE)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf-8')) as StoredLicense
}

/** Store a license to disk (after activation). */
export function storeLicense(license: LicenseFile, dir = DEFAULT_CONFIG_DIR): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, LICENSE_FILE)
  const stored: StoredLicense = { license, activatedAt: new Date().toISOString() }
  writeFileSync(file, JSON.stringify(stored, null, 2), 'utf-8')
}

/** Generate an Ed25519 keypair for a license authority (dev/testing). */
export function generateAuthorityKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKeyPem: publicKey, privateKeyPem: privateKey }
}
