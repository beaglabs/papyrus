import { getFips } from 'node:crypto'
import { resolve } from 'node:path'
import type { DeploymentProfile, ServerMode } from '@papyrus/contracts'
import type { AgentConfigEntry } from './agents.js'
import { CONNECTOR_PROFILES, type ConnectorProfile } from './catalog.js'
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
  identityProxy?: { certificateHeader: string; allowedProxyFingerprints: string[] }
  gateway?: {
    host: string
    port: number
    devToken?: string
    defaultAgent?: string
    maxRequestBodyBytes?: number
    maxConnections?: number
    connectionIdleMs?: number
    requestTimeoutMs?: number
    tls?: { certPath: string; keyPath: string; caPath: string }
  }
  runtimeWorkerToken?: string
  runtimeWorkerTls?: { certPath: string; keyPath: string; caPath: string }
  agents?: Record<string, AgentConfigEntry>
  connectors?: ConnectorProfile[]
  licenseRequired: boolean
  licenseAuthorities: Record<string, string>
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function boundedInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]' || hostname === 'localhost'
}

function isLoopbackListener(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '::1'
}

function parseOrigin(name: string, value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) origin without a path, query, fragment, or credentials`)
  }
  return url.origin
}

function validateOidcUrl(name: string, value: string, mode: ServerMode): URL {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not include credentials, a query, or a fragment`)
  if (mode === 'persistent' && url.protocol !== 'https:') throw new Error(`${name} must use HTTPS in persistent mode`)
  if (url.protocol !== 'https:' && !(mode === 'local' && url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new Error(`${name} must use HTTPS (loopback HTTP is allowed only in local mode)`)
  }
  return url
}

function normalizeFingerprints(value: string): string[] {
  const fingerprints = [...new Set(value.split(',').map((item) => item.trim().replaceAll(':', '').toLowerCase()).filter(Boolean))]
  if (fingerprints.length === 0 || fingerprints.some((item) => !/^[a-f0-9]{64}$/.test(item))) {
    throw new Error('PAPYRUS_IDENTITY_PROXY_ALLOW_FINGERPRINTS must contain comma-separated SHA-256 certificate fingerprints')
  }
  return fingerprints
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
  const originHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const publicOrigin = parseOrigin('PAPYRUS_PUBLIC_ORIGIN', env.PAPYRUS_PUBLIC_ORIGIN ?? `http://${originHost}:${port}`)

  if (env.PAPYRUS_DEV_IDENTITY && (mode !== 'local' || !isLoopback(host))) {
    throw new Error('PAPYRUS_DEV_IDENTITY is restricted to local mode on a loopback listener')
  }

  const oidc = env.PAPYRUS_OIDC_ISSUER ? {
    issuer: validateOidcUrl('PAPYRUS_OIDC_ISSUER', env.PAPYRUS_OIDC_ISSUER, mode).toString().replace(/\/$/, ''),
    clientId: required('PAPYRUS_OIDC_CLIENT_ID', env.PAPYRUS_OIDC_CLIENT_ID),
    ...(env.PAPYRUS_OIDC_CLIENT_SECRET ? { clientSecret: env.PAPYRUS_OIDC_CLIENT_SECRET } : {}),
    redirectUri: required('PAPYRUS_OIDC_REDIRECT_URI', env.PAPYRUS_OIDC_REDIRECT_URI),
  } : undefined
  if (oidc) {
    const redirect = validateOidcUrl('PAPYRUS_OIDC_REDIRECT_URI', oidc.redirectUri, mode)
    if (redirect.origin !== publicOrigin || redirect.pathname !== '/api/auth/oidc/callback') {
      throw new Error('PAPYRUS_OIDC_REDIRECT_URI must use PAPYRUS_PUBLIC_ORIGIN and path /api/auth/oidc/callback')
    }
  }

  const sessionSecret = env.PAPYRUS_SESSION_SECRET ?? ''
  if ((mode === 'persistent' || oidc) && sessionSecret.length < 32) {
    throw new Error('Persistent or OIDC mode requires PAPYRUS_SESSION_SECRET with at least 32 characters')
  }

  const tls = env.PAPYRUS_TLS_CERT ? {
    certPath: env.PAPYRUS_TLS_CERT,
    keyPath: required('PAPYRUS_TLS_KEY', env.PAPYRUS_TLS_KEY),
    caPath: required('PAPYRUS_TLS_CA', env.PAPYRUS_TLS_CA),
    ...(env.PAPYRUS_TLS_CRL ? { crlPath: env.PAPYRUS_TLS_CRL } : {}),
  } : undefined

  const proxyFingerprints = env.PAPYRUS_IDENTITY_PROXY_ALLOW_FINGERPRINTS
  const proxyHeader = env.PAPYRUS_IDENTITY_PROXY_CERT_HEADER
  if (proxyHeader && !proxyFingerprints) throw new Error('PAPYRUS_IDENTITY_PROXY_CERT_HEADER requires PAPYRUS_IDENTITY_PROXY_ALLOW_FINGERPRINTS')
  const identityProxy = proxyFingerprints ? {
    certificateHeader: (proxyHeader ?? 'x-papyrus-client-certificate').toLowerCase(),
    allowedProxyFingerprints: normalizeFingerprints(proxyFingerprints),
  } : undefined
  if (identityProxy && !/^[a-z0-9-]+$/.test(identityProxy.certificateHeader)) throw new Error('Invalid PAPYRUS_IDENTITY_PROXY_CERT_HEADER')
  if (identityProxy && !tls) throw new Error('Trusted identity proxy federation requires direct Papyrus TLS for the authenticated proxy hop')

  if (profile.startsWith('government') && !tls && !env.PAPYRUS_DEV_IDENTITY) {
    throw new Error('Government profiles require direct mTLS configuration')
  }
  if (mode === 'persistent' && !tls && !publicOrigin.startsWith('https://')) {
    throw new Error('Persistent mode requires direct TLS or an HTTPS PAPYRUS_PUBLIC_ORIGIN behind an approved TLS boundary')
  }
  if (mode === 'persistent' && profile === 'commercial' && !oidc && !identityProxy) {
    throw new Error('Persistent commercial mode requires OIDC or a trusted identity proxy')
  }

  const runtimeWorkerTls = env.PAPYRUS_RUNTIME_MTLS_CERT ? {
    certPath: env.PAPYRUS_RUNTIME_MTLS_CERT,
    keyPath: required('PAPYRUS_RUNTIME_MTLS_KEY', env.PAPYRUS_RUNTIME_MTLS_KEY),
    caPath: required('PAPYRUS_RUNTIME_MTLS_CA', env.PAPYRUS_RUNTIME_MTLS_CA),
  } : undefined

  const gateway = env.PAPYRUS_GATEWAY_ENABLED === 'true' ? {
    host: env.PAPYRUS_GATEWAY_HOST ?? '127.0.0.1',
    port: Number(env.PAPYRUS_GATEWAY_PORT ?? 3220),
    maxRequestBodyBytes: boundedInteger('PAPYRUS_GATEWAY_MAX_REQUEST_BODY_BYTES', env.PAPYRUS_GATEWAY_MAX_REQUEST_BODY_BYTES, 1_048_576, 1_024, 16_777_216),
    maxConnections: boundedInteger('PAPYRUS_GATEWAY_MAX_CONNECTIONS', env.PAPYRUS_GATEWAY_MAX_CONNECTIONS, 128, 1, 10_000),
    connectionIdleMs: boundedInteger('PAPYRUS_GATEWAY_CONNECTION_IDLE_MS', env.PAPYRUS_GATEWAY_CONNECTION_IDLE_MS, 900_000, 1_000, 86_400_000),
    requestTimeoutMs: boundedInteger('PAPYRUS_GATEWAY_REQUEST_TIMEOUT_MS', env.PAPYRUS_GATEWAY_REQUEST_TIMEOUT_MS, 30_000, 1_000, 600_000),
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
  if (gateway && (!Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65_535)) throw new Error('Invalid PAPYRUS_GATEWAY_PORT')
  if (gateway?.devToken && (mode !== 'local' || !isLoopbackListener(gateway.host))) {
    throw new Error('PAPYRUS_GATEWAY_DEV_TOKEN is restricted to local mode on a loopback listener')
  }
  if (gateway?.devToken && gateway.devToken.length < 32) throw new Error('PAPYRUS_GATEWAY_DEV_TOKEN must contain at least 32 characters')
  if (gateway && !gateway.tls && !isLoopbackListener(gateway.host)) throw new Error('Gateway requires mTLS on a non-loopback listener')

  const fileConfig = loadFileConfig(env.PAPYRUS_CONFIG_FILE ?? 'papyrus.yaml', env)

  const licenseAuthorities: Record<string, string> = { ...(fileConfig.licenseAuthorities ?? {}) }
  if (env.PAPYRUS_LICENSE_AUTHORITIES_JSON) {
    Object.assign(licenseAuthorities, JSON.parse(env.PAPYRUS_LICENSE_AUTHORITIES_JSON) as Record<string, string>)
  }
  const agents: Record<string, AgentConfigEntry> | undefined = fileConfig.agents ? { ...fileConfig.agents } : undefined
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
    ...(identityProxy ? { identityProxy } : {}),
    ...(gateway ? { gateway } : {}),
    ...(env.PAPYRUS_RUNTIME_WORKER_TOKEN ? { runtimeWorkerToken: env.PAPYRUS_RUNTIME_WORKER_TOKEN } : {}),
    ...(runtimeWorkerTls ? { runtimeWorkerTls } : {}),
    ...(agents ? { agents } : {}),
    ...(fileConfig.connectors ? { connectors: fileConfig.connectors.map((id) => CONNECTOR_PROFILES[id] as ConnectorProfile) } : {}),
    // Licensing is a deployment invariant: persistent mode always requires a valid license.
    // Local mode remains usable for development without a production bypass flag.
    licenseRequired: mode === 'persistent',
    licenseAuthorities,
  }
}
