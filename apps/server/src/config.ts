import { getFips } from 'node:crypto'
import { resolve } from 'node:path'
import type { DeploymentProfile, ServerMode } from '@papyrus/contracts'
import type { AgentConfigEntry } from './agents.js'
import { loadFileConfig } from './config-file.js'

export interface ServerConfig {
  mode: ServerMode
  profile: DeploymentProfile
  host: string
  port: number
  dataDir: string
  databasePath: string
  publicOrigin: string
  promptTimeoutMs: number
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
  gateway?: { host: string; port: number; devToken?: string; defaultAgent?: string; tls?: { certPath: string; keyPath: string; caPath: string } }
  runtimeWorkerToken?: string
  runtimeWorkerTls?: { certPath: string; keyPath: string; caPath: string }
  agents?: Record<string, AgentConfigEntry>
  licenseRequired: boolean
  licenseAuthorities: Record<string, string>
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

export interface RuntimeCheckInput {
  profile: DeploymentProfile
  mode: ServerMode
  nodeVersion?: string
  fipsEnabled?: boolean
}

/** Fails closed on unsupported runtimes and logs guidance for the rest. */
export function assertRuntime(input: RuntimeCheckInput): void {
  const nodeVersion = input.nodeVersion ?? process.versions.node
  const fipsEnabled = input.fipsEnabled ?? getFips() === 1
  const major = Number(nodeVersion.split('.')[0])
  if (!Number.isInteger(major) || major < 24) {
    if (input.mode === 'persistent') throw new Error(`Persistent mode requires Node.js 24+ (current: ${nodeVersion})`)
    console.warn(`[papyrus] Node.js ${nodeVersion} is below the supported major (24).`)
  }
  if (input.profile.startsWith('government') && !fipsEnabled) {
    throw new Error('Government profiles require a FIPS-validated OpenSSL runtime (start Node with --enable-fips)')
  }
  if (input.profile === 'commercial' && input.mode === 'persistent' && !fipsEnabled) {
    console.warn('[papyrus] FIPS mode is not enabled; enable --enable-fips for regulated deployments.')
  }
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
  const promptTimeoutMs = Number(env.PAPYRUS_PROMPT_TIMEOUT_MS ?? 600_000)
  if (!Number.isInteger(promptTimeoutMs) || promptTimeoutMs < 0) throw new Error('Invalid PAPYRUS_PROMPT_TIMEOUT_MS')
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

  const runtimeWorkerTls = env.PAPYRUS_RUNTIME_MTLS_CERT ? {
    certPath: env.PAPYRUS_RUNTIME_MTLS_CERT,
    keyPath: required('PAPYRUS_RUNTIME_MTLS_KEY', env.PAPYRUS_RUNTIME_MTLS_KEY),
    caPath: required('PAPYRUS_RUNTIME_MTLS_CA', env.PAPYRUS_RUNTIME_MTLS_CA),
  } : undefined

  const gateway = env.PAPYRUS_GATEWAY_ENABLED === 'true' ? {
    host: env.PAPYRUS_GATEWAY_HOST ?? '127.0.0.1',
    port: Number(env.PAPYRUS_GATEWAY_PORT ?? 3220),
    ...(env.PAPYRUS_GATEWAY_DEV_TOKEN ? { devToken: env.PAPYRUS_GATEWAY_DEV_TOKEN } : {}),
    ...(env.PAPYRUS_GATEWAY_DEFAULT_AGENT ? { defaultAgent: env.PAPYRUS_GATEWAY_DEFAULT_AGENT } : {}),
    ...(env.PAPYRUS_GATEWAY_TLS_CERT ? {
      tls: {
        certPath: env.PAPYRUS_GATEWAY_TLS_CERT,
        keyPath: required('PAPYRUS_GATEWAY_TLS_KEY', env.PAPYRUS_GATEWAY_TLS_KEY),
        caPath: required('PAPYRUS_GATEWAY_TLS_CA', env.PAPYRUS_GATEWAY_TLS_CA),
      },
    } : {}),
  } : undefined
  if (gateway && !Number.isInteger(gateway.port) || (gateway && (gateway.port < 1 || gateway.port > 65_535))) throw new Error('Invalid PAPYRUS_GATEWAY_PORT')
  if (gateway && !gateway.tls && !gateway.devToken && gateway.host !== '127.0.0.1' && gateway.host !== '::1') {
    throw new Error('Gateway requires mTLS or a dev token when listening on a non-loopback address')
  }

  const fileConfig = loadFileConfig(env.PAPYRUS_CONFIG_FILE ?? 'papyrus.yaml')

  let licenseAuthorities: Record<string, string> = { ...(fileConfig.licenseAuthorities ?? {}) }
  if (env.PAPYRUS_LICENSE_AUTHORITIES_JSON) {
    Object.assign(licenseAuthorities, JSON.parse(env.PAPYRUS_LICENSE_AUTHORITIES_JSON) as Record<string, string>)
  }
  let agents: Record<string, AgentConfigEntry> | undefined = fileConfig.agents ? { ...fileConfig.agents } : undefined
  if (env.PAPYRUS_AGENTS_JSON) {
    Object.assign(agents ??= {}, JSON.parse(env.PAPYRUS_AGENTS_JSON) as Record<string, AgentConfigEntry>)
  }
  assertRuntime({ profile, mode })
  return {
    mode,
    profile,
    host,
    port,
    dataDir,
    databasePath: resolve(dataDir, 'papyrus.db'),
    publicOrigin,
    promptTimeoutMs,
    ...(env.PAPYRUS_BOOTSTRAP_SECRET ? { bootstrapSecret: env.PAPYRUS_BOOTSTRAP_SECRET } : {}),
    sessionSecret: sessionSecret || 'local-development-only-change-me',
    ...(env.PAPYRUS_DEV_IDENTITY ? { devIdentity: env.PAPYRUS_DEV_IDENTITY } : {}),
    ...(oidc ? { oidc } : {}),
    ...(tls ? { tls } : {}),
    ...(gateway ? { gateway } : {}),
    ...(env.PAPYRUS_RUNTIME_WORKER_TOKEN ? { runtimeWorkerToken: env.PAPYRUS_RUNTIME_WORKER_TOKEN } : {}),
    ...(runtimeWorkerTls ? { runtimeWorkerTls } : {}),
    ...(agents ? { agents } : {}),
    licenseRequired: env.PAPYRUS_LICENSE_REQUIRED ? env.PAPYRUS_LICENSE_REQUIRED === 'true' : mode === 'persistent',
    licenseAuthorities,
  }
}
