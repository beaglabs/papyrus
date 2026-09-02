import { resolve } from 'node:path'
import type { DeploymentProfile, EntraAppRole, PortalPrincipal, ServerMode } from '@papyrus/contracts'
import { ENTRA_APP_ROLES, PROFILES } from '@papyrus/contracts'

export type EntraCloud = 'Public' | 'USGov' | 'USGovDoD'

export interface CyberConfig {
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
  tls?: { certPath: string; keyPath: string; caPath?: string }
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

function profile(value: string | undefined): DeploymentProfile {
  const selected = value ?? 'gcc'
  if (!PROFILES.includes(selected as DeploymentProfile)) throw new Error(`Unsupported PAPYRUS_PROFILE ${selected}`)
  return selected as DeploymentProfile
}

function cloudForProfile(selected: DeploymentProfile, value: string | undefined): EntraCloud {
  const inferred: EntraCloud = selected === 'gcch' || selected === 'government-il4' ? 'USGov' : selected === 'dod' || selected === 'government-il6' ? 'USGovDoD' : 'Public'
  const cloud = value ?? inferred
  if (!['Public', 'USGov', 'USGovDoD'].includes(cloud)) throw new Error(`Unsupported PAPYRUS_ENTRA_CLOUD ${cloud}`)
  return cloud as EntraCloud
}

function authorityHost(cloud: EntraCloud): string {
  return cloud === 'Public' ? 'https://login.microsoftonline.com' : 'https://login.microsoftonline.us'
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

export function loadCyberConfig(env: NodeJS.ProcessEnv = process.env): CyberConfig {
  const mode = (env.PAPYRUS_MODE ?? 'local') as ServerMode
  if (!['local', 'persistent'].includes(mode)) throw new Error(`Unsupported PAPYRUS_MODE ${mode}`)
  const selectedProfile = profile(env.PAPYRUS_PROFILE)
  const host = env.PAPYRUS_HOST ?? '127.0.0.1'
  const port = Number(env.PAPYRUS_PORT ?? 3210)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PAPYRUS_PORT must be a valid TCP port')
  const publicOrigin = parseOrigin(env.PAPYRUS_PUBLIC_ORIGIN ?? `http://${host}:${port}`)
  if (mode === 'persistent' && !publicOrigin.startsWith('https://')) throw new Error('Persistent deployments require an HTTPS PAPYRUS_PUBLIC_ORIGIN')

  const cloud = cloudForProfile(selectedProfile, env.PAPYRUS_ENTRA_CLOUD)
  const tenantId = env.PAPYRUS_ENTRA_TENANT_ID?.trim()
  const clientId = env.PAPYRUS_ENTRA_CLIENT_ID?.trim()
  const development = mode === 'local' ? developmentPrincipal(env.PAPYRUS_DEV_ENTRA_PRINCIPAL) : undefined
  if (mode === 'persistent' && (!tenantId || !clientId)) throw new Error('Persistent deployments require PAPYRUS_ENTRA_TENANT_ID and PAPYRUS_ENTRA_CLIENT_ID')
  if (mode === 'local' && !development && (!tenantId || !clientId)) {
    throw new Error('Local development requires Entra configuration or PAPYRUS_DEV_ENTRA_PRINCIPAL')
  }
  const authority = tenantId ? `${authorityHost(cloud)}/${encodeURIComponent(tenantId)}/v2.0` : undefined
  const dataDir = resolve(env.PAPYRUS_DATA_DIR ?? './papyrus-cyber-data')
  const databasePath = mode === 'local' && env.PAPYRUS_DATABASE_PATH === ':memory:' ? ':memory:' : resolve(env.PAPYRUS_DATABASE_PATH ?? `${dataDir}/cyber.db`)
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
    portalSecret: required('PAPYRUS_PORTAL_SECRET', env.PAPYRUS_PORTAL_SECRET),
    organizationName: env.PAPYRUS_ORGANIZATION_NAME?.trim() || 'Customer Cyber Operations',
    cloud,
    ...(tenantId && clientId && authority ? { entra: {
      tenantId,
      clientId,
      ...(env.PAPYRUS_ENTRA_CLIENT_SECRET?.trim() ? { clientSecret: env.PAPYRUS_ENTRA_CLIENT_SECRET.trim() } : {}),
      scope: env.PAPYRUS_ENTRA_SCOPE?.trim() || `api://${clientId}/access_as_user`,
      authority,
      issuer: authority,
    } } : {}),
    ...(development ? { developmentPrincipal: development } : {}),
    licenseRequired: mode === 'persistent' || env.PAPYRUS_LICENSE_REQUIRED === 'true',
    licenseAuthorities: parseAuthorities(env.PAPYRUS_LICENSE_AUTHORITIES),
    ...(certPath && keyPath ? { tls: {
      certPath: resolve(certPath), keyPath: resolve(keyPath),
      ...(env.PAPYRUS_TLS_CA?.trim() ? { caPath: resolve(env.PAPYRUS_TLS_CA.trim()) } : {}),
    } } : {}),
  }
}
