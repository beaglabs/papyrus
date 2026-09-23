import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLASSIFICATION_BANNER_FEATURE,
  CLASSIFICATION_LEVELS,
  type ClassificationLevel,
  type DeploymentProfile,
  type LicensePayload,
  type LicenseStatus,
  type SignedLicense,
} from '@papyrus/contracts'

interface LicenseDatabase {
  sqlite: {
    prepare(sql: string): {
      get(...parameters: unknown[]): unknown
      run(...parameters: unknown[]): unknown
    }
  }
}

const LEGACY_GOVERNMENT_PROFILES = new Set(['government-il4', 'government-il6', 'gcc', 'gcch', 'dod', 'restricted'])

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

function configuredClassification(value: string | undefined = process.env.PAPYRUS_CLASSIFICATION): ClassificationLevel | undefined {
  const selected = value?.trim().toLowerCase()
  if (!selected) return undefined
  if (!CLASSIFICATION_LEVELS.includes(selected as ClassificationLevel)) {
    throw new Error(`Unsupported PAPYRUS_CLASSIFICATION ${value}. Expected one of: ${CLASSIFICATION_LEVELS.join(', ')}`)
  }
  return selected as ClassificationLevel
}

export function signLicense(payload: LicensePayload, keyId: string, privateKeyPem: string): SignedLicense {
  return { ...payload, keyId, signature: sign('sha256', Buffer.from(canonical(payload)), privateKeyPem).toString('base64') }
}

export class LicenseService {
  readonly deploymentId: string
  private readonly publicKeyPem: string
  private readonly classification: ClassificationLevel | undefined

  constructor(
    private readonly db: LicenseDatabase,
    private readonly dataDir: string,
    private readonly profile: DeploymentProfile,
    private readonly authorities: Record<string, string>,
    private readonly required: boolean,
  ) {
    this.classification = configuredClassification()
    const identityDir = join(dataDir, 'identity')
    const publicPath = join(identityDir, 'deployment-public.pem')
    const privatePath = join(identityDir, 'deployment-private.pem')
    if (!existsSync(publicPath) || !existsSync(privatePath)) {
      mkdirSync(identityDir, { recursive: true, mode: 0o700 })
      const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
      writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    }
    this.publicKeyPem = readFileSync(publicPath, 'utf8')
    this.deploymentId = createHash('sha256').update(this.publicKeyPem).digest('hex')
  }

  activationRequest(): { deploymentId: string; profile: DeploymentProfile; publicKeyPem: string } {
    return { deploymentId: this.deploymentId, profile: this.profile, publicKeyPem: this.publicKeyPem }
  }

  /** Signs a canonical payload with the deployment P-256 identity key. */
  signCheckpoint(payload: unknown): string {
    const privateKey = readFileSync(join(this.dataDir, 'identity', 'deployment-private.pem'), 'utf8')
    return sign('sha256', Buffer.from(canonical(payload)), privateKey).toString('base64')
  }

  /** Verifies a checkpoint signature against the deployment public key. */
  verifyCheckpoint(payload: unknown, signature: string): boolean {
    return verify('sha256', Buffer.from(canonical(payload)), this.publicKeyPem, Buffer.from(signature, 'base64'))
  }

  activate(document: SignedLicense): LicenseStatus {
    const status = this.validate(document)
    if (!status.valid) return status
    this.db.sqlite.prepare(`INSERT INTO licenses(id,document_json,activated_at) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET document_json=excluded.document_json,activated_at=excluded.activated_at`)
      .run(JSON.stringify(document), new Date().toISOString())
    return status
  }

  status(): LicenseStatus {
    const row = this.db.sqlite.prepare('SELECT document_json FROM licenses WHERE id=1').get() as { document_json: string } | undefined
    if (!row) return { valid: !this.required, deploymentId: this.deploymentId, ...(!this.required ? {} : { reason: 'No license activated' }) }
    return this.validate(JSON.parse(row.document_json) as SignedLicense)
  }

  has(feature: string): boolean {
    const status = this.status()
    return Boolean(status.valid && status.license?.features.includes(feature))
  }

  require(feature: string): void {
    const status = this.status()
    if (!status.valid) throw new Error(status.reason ?? 'License invalid')
    if (status.license && !status.license.features.includes(feature)) throw new Error(`License does not entitle ${feature}`)
  }

  /**
   * Classification display remains a paid/signed capability, but the customer-owned
   * deployment chooses the marking with PAPYRUS_CLASSIFICATION. A license cannot force
   * a banner onto a system where that variable is unset, and the variable cannot create
   * a banner unless the signed license includes classification-banners.
   */
  private effectiveFeatures(features: string[]): string[] {
    const effective = features.filter((feature) => !feature.startsWith('classification:'))
    if (this.classification && effective.includes(CLASSIFICATION_BANNER_FEATURE)) {
      effective.push(`classification:${this.classification}`)
    }
    return effective
  }

  private validate(document: SignedLicense): LicenseStatus {
    const { signature, keyId, ...payload } = document
    const authority = this.authorities[keyId]
    if (!authority) return { valid: false, deploymentId: this.deploymentId, reason: `Unknown license authority ${keyId}` }
    if (payload.deploymentId !== this.deploymentId) return { valid: false, deploymentId: this.deploymentId, reason: 'License belongs to another deployment' }

    const licensedProfiles = payload.profiles as string[]
    const profileAllowed = licensedProfiles.includes(this.profile) ||
      (this.profile === 'government' && licensedProfiles.some((candidate) => LEGACY_GOVERNMENT_PROFILES.has(candidate)))
    if (!profileAllowed) return { valid: false, deploymentId: this.deploymentId, reason: `License does not permit ${this.profile}` }

    if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) return { valid: false, deploymentId: this.deploymentId, reason: `License expired at ${payload.expiresAt}` }
    if (!verify('sha256', Buffer.from(canonical(payload)), authority, Buffer.from(signature, 'base64'))) {
      return { valid: false, deploymentId: this.deploymentId, reason: 'Invalid license signature' }
    }
    return {
      valid: true,
      deploymentId: this.deploymentId,
      license: { ...payload, features: this.effectiveFeatures(payload.features), keyId },
    }
  }
}
