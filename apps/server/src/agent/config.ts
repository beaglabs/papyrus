import { resolve } from 'node:path'
import type { DeploymentProfile, EntraAppRole, PortalPrincipal, ServerMode } from '@papyrus/contracts'
import { ENTRA_APP_ROLES, PROFILES } from '@papyrus/contracts'
import { authorityHost, isEntraCloud, type EntraCloud } from './national-cloud.js'
import { readBootstrapConfig, type BootstrapContext } from './bootstrap.js'

export type { EntraCloud } from './national-cloud.js'
export type SandboxRuntime = 'bwrap' | 'seatbelt'

export interface AgentConfig {
  mode: ServerMode
  profile: DeploymentProfile
  host: string
  port: number
  publicOrigin: string
  dataDir: string
  databasePath: string
  portalSecret: string
  organizationName: string
  cloud: EntraCloud
  sandboxRuntime?: SandboxRuntime
  agentfsId?: string
  /**
   * Root of the workspace toolchain that ships inside the appliance image (pandoc,
   * LibreOffice, ffmpeg). The sandbox grants this path read-only access, because a
   * program the sandbox cannot read is a program agent commands cannot execute.
   */
  toolchainDir?: string
  entra?: {
    tenantId: string
    clientId: string
    clientSecret?: string
    scope: string
    authority: string
    issuer: string
  }
  developmentPrincipal?: PortalPrincipal
  licenseRequired: boolean
  licenseAuthorities: Record<string, string>
  kitesurf?: { accountId: string; apiTokenEnv: string }
  tls?: { certPath: string; keyPath: string; caPath?: string }
  /**
   * Absolute path to an operator-installed browser. Absent means no browser is
   * available and device console rendering refuses; Papyrus never downloads one.
   */
  browser?: { executablePath: string }
}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function parseOrigin(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PAPYRUS_PUBLIC_ORIGIN must be an HTTP(S) origin without path, query, fragment, or credentials')
  }
  return url.origin
}

/**
 * Derive the request origin from the proxy headers (`X-Forwarded-Proto` /
 * `X-Forwarded-Host`) or the raw `Host` header, falling back to the configured
 * origin. The `Host` header never says http vs https, so the scheme comes from
 * `X-Forwarded-Proto` (behind a TLS-terminating proxy) or from the fallback.
 */
export function deriveOrigin(headers: Record<string, string | string[] | undefined>, fallback: string): string {
  const first = (value: string | string[] | undefined): string | undefined => {
    if (Array.isArray(value)) return value[0]?.trim() || undefined
    return value?.trim() || undefined
  }
  const host = first(headers['x-forwarded-host']) ?? first(headers.host)
  const proto = first(headers['x-forwarded-proto']) ?? (fallback.startsWith('https://') ? 'https' : 'http')
  if (!host) return fallback
  return `${proto}://${host}`
}

function profile(value: string | undefined): DeploymentProfile {
  const selected = value ?? 'commercial'
  if (!PROFILES.includes(selected as DeploymentProfile)) throw new Error(`Unsupported PAPYRUS_PROFILE ${selected}`)
  return selected as DeploymentProfile
}

/** National cloud is an identity/network setting, not a deployment profile. */
function cloud(value: string | undefined): EntraCloud {
  const selected = value ?? 'Public'
  if (!isEntraCloud(selected)) throw new Error(`Unsupported PAPYRUS_ENTRA_CLOUD ${selected}`)
  return selected
}

function parseAuthorities(value: string | undefined): Record<string, string> {
  if (!value) return {}
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PAPYRUS_LICENSE_AUTHORITIES must be a JSON object')
  return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, item]) => {
    if (typeof item !== 'string' || !item.includes('BEGIN PUBLIC KEY')) throw new Error(`License authority ${key} is not a PEM public key`)
    return [key, item]
  }))
}

function developmentPrincipal(value: string | undefined): PortalPrincipal | undefined {
  if (!value) return undefined
  const parsed = JSON.parse(value) as Partial<PortalPrincipal>
  if (!parsed.oid || !parsed.tenantId || !parsed.displayName || !Array.isArray(parsed.roles)) {
    throw new Error('PAPYRUS_DEV_ENTRA_PRINCIPAL must include oid, tenantId, displayName, and roles')
  }
  const roles = parsed.roles.filter((role): role is EntraAppRole => ENTRA_APP_ROLES.includes(role as EntraAppRole))
  return {
    oid: parsed.oid,
    tenantId: parsed.tenantId,
    displayName: parsed.displayName,
    ...(parsed.preferredUsername ? { preferredUsername: parsed.preferredUsername } : {}),
    roles,
    groups: Array.isArray(parsed.groups) ? parsed.groups.filter((group): group is string => typeof group === 'string') : [],
    source: 'development',
  }
}

export type BootstrapMissing = 'portalSecret' | 'entra'
export type LoadedConfig =
  | { phase: 'bootstrap'; context: BootstrapContext; missing: BootstrapMissing[] }
  | { phase: 'ready'; config: AgentConfig }

/** Non-secret context available from env or baked defaults, without secret/Entra. */
export function bootstrapContext(env: NodeJS.ProcessEnv = process.env): BootstrapContext {
  const mode = (env.PAPYRUS_MODE ?? 'local') as ServerMode
  const selectedProfile = profile(env.PAPYRUS_PROFILE)
  const host = env.PAPYRUS_HOST ?? '127.0.0.1'
  const port = Number(env.PAPYRUS_PORT ?? 3210)
  const selectedCloud = cloud(env.PAPYRUS_ENTRA_CLOUD)
  const dataDir = resolve(env.PAPYRUS_DATA_DIR ?? './papyrus-agent-data')
  const databasePath = resolve(env.PAPYRUS_DATABASE_PATH ?? `${dataDir}/agent.db`)
  return {
    mode,
    profile: selectedProfile,
    cloud: selectedCloud,
    organizationName: env.PAPYRUS_ORGANIZATION_NAME?.trim() || 'Customer Agent Operations',
    host,
    port,
    dataDir,
    databasePath,
    toolchainDir: env.PAPYRUS_TOOLCHAIN_DIR?.trim() || '/opt/papyrus/toolchain',
    licenseAuthorities: parseAuthorities(env.PAPYRUS_LICENSE_AUTHORITIES),
    licenseRequired: mode === 'persistent' || env.PAPYRUS_LICENSE_REQUIRED === 'true',
  }
}

/**
 * Resolve the full configuration, or report that onboarding is required. The
 * portal secret and Entra configuration may come from the environment or from the
 * persisted `bootstrap.json`, so a completed onboarding survives a restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const context = bootstrapContext(env)
  const persisted = readBootstrapConfig(context.dataDir)

  const portalSecret = env.PAPYRUS_PORTAL_SECRET?.trim() || persisted?.portalSecret
  const tenantId = env.PAPYRUS_ENTRA_TENANT_ID?.trim() || persisted?.entra.tenantId
  const clientId = env.PAPYRUS_ENTRA_CLIENT_ID?.trim() || persisted?.entra.clientId
  const clientSecret = env.PAPYRUS_ENTRA_CLIENT_SECRET?.trim() || persisted?.entra.clientSecret
  const scope = env.PAPYRUS_ENTRA_SCOPE?.trim() || persisted?.entra.scope

  const development = context.mode === 'local' ? developmentPrincipal(env.PAPYRUS_DEV_ENTRA_PRINCIPAL) : undefined
  const entraConfigured = Boolean(tenantId && clientId)
  const entraSatisfied = entraConfigured || Boolean(development)

  const missing: BootstrapMissing[] = []
  if (!portalSecret) missing.push('portalSecret')
  if (!entraSatisfied) missing.push('entra')

  if (missing.length === 0 && portalSecret) {
    const config = loadAgentConfig(env, {
      portalSecret,
      ...(entraConfigured && tenantId && clientId
        ? { entra: { tenantId, clientId, ...(clientSecret ? { clientSecret } : {}), ...(scope ? { scope } : {}) } }
        : {}),
    })
    return { phase: 'ready', config }
  }
  return { phase: 'bootstrap', context, missing }
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env, resolved: { portalSecret?: string; entra?: { tenantId: string; clientId: string; clientSecret?: string; scope?: string } } = {}): AgentConfig {
  const mode = (env.PAPYRUS_MODE ?? 'local') as ServerMode
  if (!['local', 'persistent'].includes(mode)) throw new Error(`Unsupported PAPYRUS_MODE ${mode}`)
  const selectedProfile = profile(env.PAPYRUS_PROFILE)
  const host = env.PAPYRUS_HOST ?? '127.0.0.1'
  const port = Number(env.PAPYRUS_PORT ?? 3210)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PAPYRUS_PORT must be a valid TCP port')
  const configuredOrigin = env.PAPYRUS_PUBLIC_ORIGIN?.trim()
  const publicOrigin = parseOrigin(configuredOrigin ?? `http://${host}:${port}`)
  // An explicit non-HTTPS origin is a configuration error for persistent mode, but
  // an unset origin is derived per-request from the proxy/host headers, so the
  // operator does not have to hardcode it when a TLS-terminating proxy is in front.
  if (mode === 'persistent' && configuredOrigin && !publicOrigin.startsWith('https://')) throw new Error('Persistent deployments require an HTTPS PAPYRUS_PUBLIC_ORIGIN')

  const selectedCloud = cloud(env.PAPYRUS_ENTRA_CLOUD)
  const sandboxRuntimeValue = env.PAPYRUS_SANDBOX_RUNTIME?.trim()
  if (sandboxRuntimeValue && sandboxRuntimeValue !== 'bwrap' && sandboxRuntimeValue !== 'seatbelt') {
    throw new Error('PAPYRUS_SANDBOX_RUNTIME must be bwrap or seatbelt')
  }
  const sandboxRuntime = sandboxRuntimeValue as SandboxRuntime | undefined
  const agentfsId = env.PAPYRUS_AGENTFS_ID?.trim() || 'papyrus-workspace'
  if (!/^[a-zA-Z0-9_-]+$/.test(agentfsId)) throw new Error('PAPYRUS_AGENTFS_ID must contain only letters, numbers, hyphens, and underscores')
  const tenantId = env.PAPYRUS_ENTRA_TENANT_ID?.trim() || resolved.entra?.tenantId
  const clientId = env.PAPYRUS_ENTRA_CLIENT_ID?.trim() || resolved.entra?.clientId
  const clientSecret = env.PAPYRUS_ENTRA_CLIENT_SECRET?.trim() || resolved.entra?.clientSecret
  const scopeOverride = env.PAPYRUS_ENTRA_SCOPE?.trim() || resolved.entra?.scope
  const development = mode === 'local' ? developmentPrincipal(env.PAPYRUS_DEV_ENTRA_PRINCIPAL) : undefined
  if (mode === 'persistent' && (!tenantId || !clientId)) throw new Error('Persistent deployments require PAPYRUS_ENTRA_TENANT_ID and PAPYRUS_ENTRA_CLIENT_ID')
  if (mode === 'local' && !development && (!tenantId || !clientId)) {
    throw new Error('Local development requires Entra configuration or PAPYRUS_DEV_ENTRA_PRINCIPAL')
  }
  const authority = tenantId ? `${authorityHost(selectedCloud)}/${encodeURIComponent(tenantId)}/v2.0` : undefined
  const dataDir = resolve(env.PAPYRUS_DATA_DIR ?? './papyrus-agent-data')
  const databasePath = mode === 'local' && env.PAPYRUS_DATABASE_PATH === ':memory:' ? ':memory:' : resolve(env.PAPYRUS_DATABASE_PATH ?? `${dataDir}/agent.db`)
  const kitesurfAccountId = env.PAPYRUS_KITESURF_ACCOUNT_ID?.trim()
  const kitesurfTokenEnv = env.PAPYRUS_KITESURF_API_TOKEN_ENV?.trim()
  if (Boolean(kitesurfAccountId) !== Boolean(kitesurfTokenEnv)) throw new Error('PAPYRUS_KITESURF_ACCOUNT_ID and PAPYRUS_KITESURF_API_TOKEN_ENV must be configured together')
  if (kitesurfAccountId && selectedProfile !== 'commercial') throw new Error('Kitesurf validation is available only in the commercial profile; government and disconnected profiles remain external-browser deny-by-default')

  const certPath = env.PAPYRUS_TLS_CERT?.trim()
  const keyPath = env.PAPYRUS_TLS_KEY?.trim()
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('PAPYRUS_TLS_CERT and PAPYRUS_TLS_KEY must be configured together')

  return {
    mode,
    profile: selectedProfile,
    host,
    port,
    publicOrigin,
    dataDir,
    databasePath,
    portalSecret: required('PAPYRUS_PORTAL_SECRET', env.PAPYRUS_PORTAL_SECRET?.trim() || resolved.portalSecret),
    organizationName: env.PAPYRUS_ORGANIZATION_NAME?.trim() || 'Customer Agent Operations',
    cloud: selectedCloud,
    ...(sandboxRuntime ? { sandboxRuntime } : {}),
    agentfsId,
    // Ships in the appliance image. An absent directory is harmless — the sandbox
    // skips a granted path that does not exist — so a development host still runs.
    toolchainDir: env.PAPYRUS_TOOLCHAIN_DIR?.trim() || '/opt/papyrus/toolchain',
    ...(tenantId && clientId && authority ? { entra: {
      tenantId,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      scope: scopeOverride || `api://${clientId}/access_as_user`,
      authority,
      issuer: authority,
    } } : {}),
    ...(development ? { developmentPrincipal: development } : {}),
    licenseRequired: mode === 'persistent' || env.PAPYRUS_LICENSE_REQUIRED === 'true',
    licenseAuthorities: parseAuthorities(env.PAPYRUS_LICENSE_AUTHORITIES),
    ...(kitesurfAccountId && kitesurfTokenEnv ? { kitesurf: { accountId: kitesurfAccountId, apiTokenEnv: kitesurfTokenEnv } } : {}),
    ...(certPath && keyPath ? { tls: {
      certPath: resolve(certPath), keyPath: resolve(keyPath),
      ...(env.PAPYRUS_TLS_CA?.trim() ? { caPath: resolve(env.PAPYRUS_TLS_CA.trim()) } : {}),
    } } : {}),
    // Read once, at the edge, like every other environment value. The render path
    // takes a resolved config so nothing deep in the browser boundary reads process
    // state it cannot be tested with.
    ...(env.PAPYRUS_BROWSER_EXECUTABLE?.trim() ? { browser: { executablePath: resolve(env.PAPYRUS_BROWSER_EXECUTABLE.trim()) } } : {}),
  }
}
