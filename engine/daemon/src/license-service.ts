import { loadOrGenerateDeploymentIdentity } from '@papyrus/core/auth/deployment-identity'
import { loadStoredLicense, storeLicense, validateLicense } from '@papyrus/core/auth/license'
import type {
  DeploymentIdentity,
  LicenseFile,
  LicenseStatus,
  NetworkProfile,
} from '@papyrus/core/auth/types'

// Mirrors /beag-labs-license-root-public.pem. Keeping the trust anchor in code prevents a
// writable runtime file from silently replacing the licensing authority.
const BEAG_LABS_LICENSE_ROOT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYAUfiyJ2L9bTiEQA5ars9GHc1e1DumZEqDkJnZE3T+c=
-----END PUBLIC KEY-----
`

export class LicenseService {
  readonly identity: DeploymentIdentity
  readonly authorityPublicKeyPem: string
  private status: LicenseStatus

  constructor(
    private readonly profile: NetworkProfile,
    private readonly configDir?: string,
    authorityPublicKeyPem = BEAG_LABS_LICENSE_ROOT_PUBLIC_KEY,
  ) {
    this.identity = loadOrGenerateDeploymentIdentity(configDir)
    this.authorityPublicKeyPem = authorityPublicKeyPem
    this.status = this.evaluate()
  }

  evaluate(now = new Date()): LicenseStatus {
    const stored = loadStoredLicense(this.configDir)
    this.status = stored
      ? validateLicense(
          stored.license,
          this.profile,
          this.identity.deploymentId,
          this.authorityPublicKeyPem,
          now,
        )
      : { valid: false, deploymentId: this.identity.deploymentId, reason: 'No license installed' }
    return this.status
  }

  getStatus(): LicenseStatus {
    return this.evaluate()
  }
  isLicensed(): boolean {
    return this.evaluate().valid
  }

  activationRequest(): Record<string, string> {
    return {
      deploymentId: this.identity.deploymentId,
      deploymentPublicKey: this.identity.publicKeyPem,
      profile: this.profile,
    }
  }

  activate(license: LicenseFile): LicenseStatus {
    const status = validateLicense(
      license,
      this.profile,
      this.identity.deploymentId,
      this.authorityPublicKeyPem,
    )
    if (!status.valid) return status
    storeLicense(license, this.configDir)
    this.status = status
    return status
  }
}
