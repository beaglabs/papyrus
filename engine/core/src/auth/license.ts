/** Offline Papyrus license primitives. Runtime policy belongs to the daemon LicenseService. */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  LicenseFile,
  LicensePayload,
  LicenseStatus,
  NetworkProfile,
  StoredLicense,
} from './types.js'

const DEFAULT_CONFIG_DIR = join(process.env.HOME ?? '.', '.papyrus')
const LICENSE_FILE = 'license.json'

export function canonicalLicenseJson(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(canonicalLicenseJson).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalLicenseJson((value as Record<string, unknown>)[key])}`).join(',')}}`
}

export function signLicense(payload: LicensePayload, authorityPrivateKeyPem: string): LicenseFile {
  const signature = sign(
    null,
    Buffer.from(canonicalLicenseJson(payload), 'utf8'),
    createPrivateKey(authorityPrivateKeyPem),
  ).toString('base64')
  return { ...payload, signature }
}

export function verifyLicenseSignature(
  license: LicenseFile,
  authorityPublicKeyPem: string,
): boolean {
  try {
    const { signature, ...payload } = license
    return verify(
      null,
      Buffer.from(canonicalLicenseJson(payload), 'utf8'),
      createPublicKey(authorityPublicKeyPem),
      Buffer.from(signature, 'base64'),
    )
  } catch {
    return false
  }
}

export function validateLicense(
  license: LicenseFile,
  activeProfile: NetworkProfile,
  deploymentId: string,
  authorityPublicKeyPem: string,
  now = new Date(),
): LicenseStatus {
  const base = {
    licenseId: license.licenseId,
    profile: license.profile,
    licensee: license.licensee,
    deploymentId,
    expiresAt: license.expiresAt,
  }
  if (!verifyLicenseSignature(license, authorityPublicKeyPem))
    return { ...base, valid: false, reason: 'Invalid signature' }
  if (license.profile !== activeProfile)
    return {
      ...base,
      valid: false,
      reason: `License is for profile "${license.profile}", not "${activeProfile}"`,
    }
  if (license.deploymentId !== deploymentId)
    return { ...base, valid: false, reason: 'License is bound to another deployment' }
  if (license.expiresAt !== null) {
    const expiry = Date.parse(license.expiresAt)
    if (!Number.isFinite(expiry))
      return { ...base, valid: false, reason: 'License expiry is not a valid ISO-8601 timestamp' }
    if (expiry <= now.getTime())
      return { ...base, valid: false, reason: `License expired on ${license.expiresAt}` }
  }
  return { ...base, valid: true }
}

export function loadStoredLicense(dir = DEFAULT_CONFIG_DIR): StoredLicense | null {
  const file = join(dir, LICENSE_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as StoredLicense
  } catch {
    return null
  }
}

export function storeLicense(license: LicenseFile, dir = DEFAULT_CONFIG_DIR): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(dir, LICENSE_FILE),
    JSON.stringify({ license, activatedAt: new Date().toISOString() }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
}
