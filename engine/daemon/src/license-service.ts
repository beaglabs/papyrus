import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOrGenerateDeploymentIdentity } from '@papyrus/core/auth/deployment-identity'
import { loadStoredLicense, storeLicense, validateLicense } from '@papyrus/core/auth/license'
import type { DeploymentIdentity, LicenseFile, LicenseStatus, NetworkProfile } from '@papyrus/core/auth/types'

const AUTHORITY_KEY_NAME = 'beag-labs-license-root-public.pem'

function findAuthorityKey(): string {
  const candidates = [
    join(process.cwd(), AUTHORITY_KEY_NAME),
    join(import.meta.dirname ?? '.', '../../../', AUTHORITY_KEY_NAME),
  ]
  const path = candidates.find(existsSync)
  if (!path) throw new Error(`Pinned licensing authority key not found: ${AUTHORITY_KEY_NAME}`)
  return readFileSync(path, 'utf8')
}

export class LicenseService {
  readonly identity: DeploymentIdentity
  readonly authorityPublicKeyPem: string
  private status: LicenseStatus

  constructor(
    private readonly profile: NetworkProfile,
    private readonly configDir?: string,
    authorityPublicKeyPem = findAuthorityKey(),
  ) {
    this.identity = loadOrGenerateDeploymentIdentity(configDir)
    this.authorityPublicKeyPem = authorityPublicKeyPem
    this.status = this.evaluate()
  }

  evaluate(now = new Date()): LicenseStatus {
    const stored = loadStoredLicense(this.configDir)
    this.status = stored
      ? validateLicense(stored.license, this.profile, this.identity.deploymentId, this.authorityPublicKeyPem, now)
      : { valid: false, deploymentId: this.identity.deploymentId, reason: 'No license installed' }
    return this.status
  }

  getStatus(): LicenseStatus { return this.evaluate() }
  isLicensed(): boolean { return this.evaluate().valid }

  activationRequest(): Record<string, string> {
    return { deploymentId: this.identity.deploymentId, deploymentPublicKey: this.identity.publicKeyPem, profile: this.profile }
  }

  activate(license: LicenseFile): LicenseStatus {
    const status = validateLicense(license, this.profile, this.identity.deploymentId, this.authorityPublicKeyPem)
    if (!status.valid) return status
    storeLicense(license, this.configDir)
    this.status = status
    return status
  }
}
