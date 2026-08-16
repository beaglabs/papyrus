import { resolve } from 'node:path'
import type { DeploymentProfile, ServerMode } from '@papyrus/contracts'

export interface ServerConfig {
  mode: ServerMode
  profile: DeploymentProfile
  host: string
  port: number
  dataDir: string
  databasePath: string
  publicOrigin: string
  bootstrapSecret?: string
  sessionSecret: string
  devIdentity?: string
  oidc?: {
    issuer: string
    clientId: string
    clientSecret?: string
    redirectUri: string
  }
  tls?: { certPath: string; keyPath: string; caPath: string; crlPath?: string }
  licenseRequired: boolean
  licenseAuthorities: Record<string, string>
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function loadConfig(env = process.env): ServerConfig {
  const mode = (env.PAPYRUS_MODE ?? 'local') as ServerMode
  const profile = (env.PAPYRUS_PROFILE ?? 'commercial') as DeploymentProfile
  if (!['local', 'persistent'].includes(mode)) throw new Error('PAPYRUS_MODE must be local or persistent')
  if (!['commercial', 'government-il4', 'government-il6'].includes(profile)) throw new Error('Invalid PAPYRUS_PROFILE')
  const host = env.PAPYRUS_HOST ?? (mode === 'local' ? '127.0.0.1' : '0.0.0.0')
  const port = Number(env.PAPYRUS_PORT ?? 3210)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid PAPYRUS_PORT')
  const dataDir = resolve(env.PAPYRUS_DATA_DIR ?? '.papyrus')
  const sessionSecret = env.PAPYRUS_SESSION_SECRET ?? ''
  if (mode === 'persistent' && sessionSecret.length < 32) throw new Error('Persistent mode requires PAPYRUS_SESSION_SECRET with at least 32 characters')
  if (env.PAPYRUS_DEV_IDENTITY && host !== '127.0.0.1' && host !== '::1') {
    throw new Error('PAPYRUS_DEV_IDENTITY is restricted to a loopback listener')
  }

  const oidc = env.PAPYRUS_OIDC_ISSUER ? {
    issuer: env.PAPYRUS_OIDC_ISSUER,
    clientId: required('PAPYRUS_OIDC_CLIENT_ID', env.PAPYRUS_OIDC_CLIENT_ID),
    ...(env.PAPYRUS_OIDC_CLIENT_SECRET ? { clientSecret: env.PAPYRUS_OIDC_CLIENT_SECRET } : {}),
    redirectUri: required('PAPYRUS_OIDC_REDIRECT_URI', env.PAPYRUS_OIDC_REDIRECT_URI),
  } : undefined
  const tls = env.PAPYRUS_TLS_CERT ? {
    certPath: env.PAPYRUS_TLS_CERT,
    keyPath: required('PAPYRUS_TLS_KEY', env.PAPYRUS_TLS_KEY),
    caPath: required('PAPYRUS_TLS_CA', env.PAPYRUS_TLS_CA),
    ...(env.PAPYRUS_TLS_CRL ? { crlPath: env.PAPYRUS_TLS_CRL } : {}),
  } : undefined
  if (profile.startsWith('government') && !tls && !env.PAPYRUS_DEV_IDENTITY) {
    throw new Error('Government profiles require direct mTLS configuration')
  }
  const publicOrigin = env.PAPYRUS_PUBLIC_ORIGIN ?? `http://${host}:${port}`
  if (mode === 'persistent' && !tls && !publicOrigin.startsWith('https://')) {
    throw new Error('Persistent mode requires direct TLS or an HTTPS PAPYRUS_PUBLIC_ORIGIN behind an approved TLS boundary')
  }

  let licenseAuthorities: Record<string, string> = {}
  if (env.PAPYRUS_LICENSE_AUTHORITIES_JSON) {
    licenseAuthorities = JSON.parse(env.PAPYRUS_LICENSE_AUTHORITIES_JSON) as Record<string, string>
  }
  return {
    mode,
    profile,
    host,
    port,
    dataDir,
    databasePath: resolve(dataDir, 'papyrus.db'),
    publicOrigin,
    ...(env.PAPYRUS_BOOTSTRAP_SECRET ? { bootstrapSecret: env.PAPYRUS_BOOTSTRAP_SECRET } : {}),
    sessionSecret: sessionSecret || 'local-development-only-change-me',
    ...(env.PAPYRUS_DEV_IDENTITY ? { devIdentity: env.PAPYRUS_DEV_IDENTITY } : {}),
    ...(oidc ? { oidc } : {}),
    ...(tls ? { tls } : {}),
    licenseRequired: env.PAPYRUS_LICENSE_REQUIRED ? env.PAPYRUS_LICENSE_REQUIRED === 'true' : mode === 'persistent',
    licenseAuthorities,
  }
}
