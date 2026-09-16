import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DeploymentProfile, ServerMode } from '@papyrus/contracts'
import type { EntraCloud } from './national-cloud.js'

/**
 * Bootstrap is the first-run state: the daemon can start without a portal secret,
 * an Entra tenant, or an activated license, and instead serve a locked-down
 * onboarding flow that collects them. The collected secret and Entra configuration
 * are persisted to `bootstrap.json` under the data directory so a restart does not
 * re-run onboarding, and so the container entrypoint never has to know about them.
 */

export interface BootstrapEntra {
  tenantId: string
  clientId: string
  clientSecret?: string
  scope?: string
}

export interface BootstrapConfig {
  portalSecret: string
  entra: BootstrapEntra
}

/** Non-secret context that is always available from env or baked defaults. */
export interface BootstrapContext {
  mode: ServerMode
  profile: DeploymentProfile
  cloud: EntraCloud
  organizationName: string
  host: string
  port: number
  dataDir: string
  databasePath: string
  toolchainDir: string
  licenseAuthorities: Record<string, string>
  licenseRequired: boolean
}

const FILE = 'bootstrap.json'

export function bootstrapPath(dataDir: string): string {
  return join(dataDir, FILE)
}

export function readBootstrapConfig(dataDir: string): BootstrapConfig | undefined {
  const path = bootstrapPath(dataDir)
  if (!existsSync(path)) return undefined
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<BootstrapConfig>
    if (typeof raw.portalSecret !== 'string' || !raw.portalSecret) return undefined
    if (!raw.entra || typeof raw.entra.tenantId !== 'string' || typeof raw.entra.clientId !== 'string') return undefined
    return {
      portalSecret: raw.portalSecret,
      entra: {
        tenantId: raw.entra.tenantId,
        clientId: raw.entra.clientId,
        ...(typeof raw.entra.clientSecret === 'string' && raw.entra.clientSecret ? { clientSecret: raw.entra.clientSecret } : {}),
        ...(typeof raw.entra.scope === 'string' && raw.entra.scope ? { scope: raw.entra.scope } : {}),
      },
    }
  } catch {
    return undefined
  }
}

export function writeBootstrapConfig(dataDir: string, value: BootstrapConfig): void {
  writeFileSync(bootstrapPath(dataDir), JSON.stringify(value, null, 2), { mode: 0o600 })
}
