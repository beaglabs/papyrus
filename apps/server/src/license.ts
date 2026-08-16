import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeploymentProfile, LicensePayload, LicenseStatus, SignedLicense } from '@papyrus/contracts'
import type { PapyrusDatabase } from './db.js'

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export function signLicense(payload: LicensePayload, keyId: string, privateKeyPem: string): SignedLicense {
  return { ...payload, keyId, signature: sign(null, Buffer.from(canonical(payload)), privateKeyPem).toString('base64') }
}

export class LicenseService {
  readonly deploymentId: string
  private readonly publicKeyPem: string

  constructor(
    private readonly db: PapyrusDatabase,
    dataDir: string,
    private readonly profile: DeploymentProfile,
    private readonly authorities: Record<string, string>,
    private readonly required: boolean,
  ) {
    const identityDir = join(dataDir, 'identity')
    const publicPath = join(identityDir, 'deployment-public.pem')
    const privatePath = join(identityDir, 'deployment-private.pem')
    if (!existsSync(publicPath) || !existsSync(privatePath)) {
      mkdirSync(identityDir, { recursive: true, mode: 0o700 })
      const pair = generateKeyPairSync('ed25519')
      writeFileSync(publicPath, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 })
      writeFileSync(privatePath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
    }
    this.publicKeyPem = readFileSync(publicPath, 'utf8')
    this.deploymentId = createHash('sha256').update(this.publicKeyPem).digest('hex')
  }

  activationRequest(): { deploymentId: string; profile: DeploymentProfile; publicKeyPem: string } {
    return { deploymentId: this.deploymentId, profile: this.profile, publicKeyPem: this.publicKeyPem }
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

  require(feature: string): void {
    const status = this.status()
    if (!status.valid) throw new Error(status.reason ?? 'License invalid')
    if (status.license && !status.license.features.includes(feature)) throw new Error(`License does not entitle ${feature}`)
  }

  private validate(document: SignedLicense): LicenseStatus {
    const { signature, keyId, ...payload } = document
    const authority = this.authorities[keyId]
    if (!authority) return { valid: false, deploymentId: this.deploymentId, reason: `Unknown license authority ${keyId}` }
    if (payload.deploymentId !== this.deploymentId) return { valid: false, deploymentId: this.deploymentId, reason: 'License belongs to another deployment' }
    if (!payload.profiles.includes(this.profile)) return { valid: false, deploymentId: this.deploymentId, reason: `License does not permit ${this.profile}` }
    if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) return { valid: false, deploymentId: this.deploymentId, reason: `License expired at ${payload.expiresAt}` }
    if (!verify(null, Buffer.from(canonical(payload)), authority, Buffer.from(signature, 'base64'))) {
      return { valid: false, deploymentId: this.deploymentId, reason: 'Invalid license signature' }
    }
    return { valid: true, deploymentId: this.deploymentId, license: { ...payload, keyId } }
  }
}
