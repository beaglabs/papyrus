import { createHash, randomBytes } from 'node:crypto'
import type { McpOauthRegistrationMethod } from '@papyrus/contracts'

interface ResourceMetadata {
  resource?: string
  authorization_servers?: string[]
  scopes_supported?: string[]
}

interface AuthorizationMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  scopes_supported?: string[]
  client_id_metadata_document_supported?: boolean
}

export interface McpOauthClientCredentials {
  clientId: string
  clientSecret?: string
  scopes?: string
}

export interface McpOAuthRegistration {
  issuer: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  verifier: string
  state: string
  resource: string
  authorizationUrl: string
  registrationMethod: McpOauthRegistrationMethod
  scope?: string
}

export type McpOAuthPreparation =
  | { kind: 'not_required' }
  | { kind: 'authorization_required'; registration: McpOAuthRegistration }
  | { kind: 'configuration_required'; issuer: string; resource: string; reason: string }

export interface PrepareRemoteMcpOptions {
  clientMetadataUrl?: string
  resolveClient?: (issuer: string) => McpOauthClientCredentials | undefined | Promise<McpOauthClientCredentials | undefined>
}

export function normalizeMcpEndpoint(endpoint: string): string {
  const url = secureUrl(endpoint, 'MCP endpoint')
  if (url.hostname === 'mcp.atlassian.com' && url.pathname.replace(/\/$/, '') === '/v1/mcp') url.pathname = '/v1/mcp/authv2'
  return url.toString()
}

export async function prepareRemoteMcp(
  endpoint: string,
  redirectUri: string,
  clientName: string,
  options: PrepareRemoteMcpOptions = {},
): Promise<McpOAuthPreparation> {
  const resource = normalizeMcpEndpoint(endpoint)
  const challenge = await fetch(resource, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'papyrus-auth-discovery', method: 'ping' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })
  if (challenge.ok) return { kind: 'not_required' }
  if (challenge.status !== 401) throw new Error(`MCP discovery failed with HTTP ${challenge.status}`)

  const protectedResource = await discoverResourceMetadata(resource, challenge.headers.get('www-authenticate'))
  const issuer = protectedResource.authorization_servers?.[0]
  if (!issuer) throw new Error('MCP protected-resource metadata did not identify an authorization server')

  const authorization = await authorizationMetadata(issuer)
  if (authorization.code_challenge_methods_supported && !authorization.code_challenge_methods_supported.includes('S256')) {
    throw new Error('MCP authorization server does not advertise PKCE S256 support')
  }

  const preregistered = await options.resolveClient?.(authorization.issuer)
  let clientId: string
  let clientSecret: string | undefined
  let scope: string | undefined
  let registrationMethod: McpOauthRegistrationMethod

  if (preregistered) {
    clientId = preregistered.clientId
    clientSecret = preregistered.clientSecret
    scope = preregistered.scopes?.trim() || undefined
    registrationMethod = 'preregistered'
  } else if (authorization.client_id_metadata_document_supported && options.clientMetadataUrl) {
    clientId = secureUrl(options.clientMetadataUrl, 'client metadata URL').toString()
    registrationMethod = 'cimd'
  } else if (authorization.registration_endpoint) {
    const registration = await postJson<{ client_id: string; client_secret?: string }>(
      secureUrl(authorization.registration_endpoint, 'registration endpoint').toString(),
      {
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
      },
    )
    if (!registration.client_id) throw new Error('Dynamic Client Registration did not return a client_id')
    clientId = registration.client_id
    clientSecret = registration.client_secret
    registrationMethod = 'dcr'
  } else {
    return {
      kind: 'configuration_required',
      issuer: authorization.issuer,
      resource,
      reason: 'The authorization server requires a pre-registered OAuth client and does not advertise CIMD or Dynamic Client Registration.',
    }
  }

  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource,
  })
  if (scope) params.set('scope', scope)

  return {
    kind: 'authorization_required',
    registration: {
      issuer: authorization.issuer,
      tokenEndpoint: authorization.token_endpoint,
      clientId,
      ...(clientSecret ? { clientSecret } : {}),
      verifier,
      state,
      resource,
      authorizationUrl: `${authorization.authorization_endpoint}?${params}`,
      registrationMethod,
      ...(scope ? { scope } : {}),
    },
  }
}

export async function exchangeMcpCode(
  pending: Record<string, unknown>,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: String(pending.redirect_uri),
    client_id: String(pending.client_id),
    code_verifier: String(pending.verifier),
    resource: String(pending.resource),
  })
  if (pending.client_secret) body.set('client_secret', String(pending.client_secret))
  return await tokenRequest(String(pending.token_endpoint), body)
}

export async function refreshMcpToken(input: {
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  refreshToken: string
  resource: string
  scope?: string
}): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId,
    resource: input.resource,
  })
  if (input.clientSecret) body.set('client_secret', input.clientSecret)
  if (input.scope) body.set('scope', input.scope)
  return await tokenRequest(input.tokenEndpoint, body)
}

export function mcpClientMetadata(publicOrigin: string): Record<string, unknown> {
  const origin = secureUrl(publicOrigin, 'Papyrus public origin')
  const clientId = new URL('/.well-known/mcp-client.json', origin).toString()
  return {
    client_id: clientId,
    client_name: 'Papyrus',
    client_uri: origin.origin,
    redirect_uris: [new URL('/api/mcp/oauth/callback', origin).toString()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

async function discoverResourceMetadata(resource: string, header: string | null): Promise<ResourceMetadata> {
  const explicit = resourceMetadataUrl(header)
  const candidates = explicit ? [explicit] : wellKnownResourceCandidates(resource)
  let lastError: unknown
  for (const candidate of candidates) {
    try { return await json<ResourceMetadata>(candidate) }
    catch (error) { lastError = error }
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}.` : ''
  throw new Error(`MCP endpoint requires OAuth, but protected-resource metadata could not be discovered.${detail} Use the provider's OAuth-capable MCP endpoint.`)
}

async function authorizationMetadata(issuer: string): Promise<AuthorizationMetadata> {
  const url = secureUrl(issuer, 'authorization issuer')
  const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  const candidates = [
    new URL(`/.well-known/oauth-authorization-server${suffix}`, url.origin).toString(),
    new URL(`${suffix || ''}/.well-known/openid-configuration`, url.origin).toString(),
  ]
  for (const candidate of candidates) {
    try {
      const metadata = await json<AuthorizationMetadata>(candidate)
      if (metadata.issuer === issuer) return metadata
    } catch { /* try the next standards-defined discovery location */ }
  }
  throw new Error('Unable to discover OAuth authorization-server metadata')
}

async function tokenRequest(
  endpoint: string,
  body: URLSearchParams,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const response = await fetch(secureUrl(endpoint, 'token endpoint'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json() as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error_description?: string
    error?: string
  }
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description ?? payload.error ?? `OAuth token exchange failed (${response.status})`)
  }
  return {
    accessToken: payload.access_token,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    ...(payload.expires_in ? { expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString() } : {}),
  }
}

async function json<T>(url: string): Promise<T> {
  const response = await fetch(secureUrl(url, 'metadata URL'), {
    headers: { accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Metadata discovery failed (${response.status})`)
  return await response.json() as T
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await response.json() as T & { error_description?: string }
  if (!response.ok) throw new Error(payload.error_description ?? `Dynamic Client Registration failed (${response.status})`)
  return payload
}

function resourceMetadataUrl(header: string | null): string | undefined {
  const match = header?.match(/resource_metadata="([^"]+)"/i)
  return match?.[1]
}

function wellKnownResourceCandidates(endpoint: string): string[] {
  const url = new URL(endpoint)
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  const candidates = [new URL(`/.well-known/oauth-protected-resource${path}`, url.origin).toString()]
  if (path) candidates.push(new URL('/.well-known/oauth-protected-resource', url.origin).toString())
  return candidates
}

function secureUrl(value: string, label: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname))) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only on loopback)`)
  }
  return url
}
