import { createHash, randomBytes } from 'node:crypto'

interface ResourceMetadata { resource?: string; authorization_servers?: string[]; scopes_supported?: string[] }
interface AuthorizationMetadata { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; code_challenge_methods_supported?: string[]; scopes_supported?: string[] }

export interface McpOAuthRegistration {
  issuer: string
  tokenEndpoint: string
  clientId: string
  clientSecret?: string
  verifier: string
  state: string
  resource: string
  authorizationUrl: string
}

export async function registerRemoteMcp(endpoint: string, redirectUri: string, clientName: string): Promise<McpOAuthRegistration | undefined> {
  const resource = secureUrl(endpoint, 'MCP endpoint').toString()
  const challenge = await fetch(resource, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'papyrus-auth-discovery', method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'papyrus', version: '0.1.0' } } }), redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  if (challenge.ok) return undefined
  if (challenge.status !== 401) throw new Error(`MCP discovery failed with HTTP ${challenge.status}`)
  const metadataUrl = resourceMetadataUrl(challenge.headers.get('www-authenticate')) ?? wellKnownResource(resource)
  const protectedResource = await json<ResourceMetadata>(metadataUrl)
  const issuer = protectedResource.authorization_servers?.[0]
  if (!issuer) throw new Error('MCP protected-resource metadata did not identify an authorization server')
  const authorization = await authorizationMetadata(issuer)
  if (!authorization.code_challenge_methods_supported?.includes('S256')) throw new Error('MCP authorization server does not advertise PKCE S256 support')
  if (!authorization.registration_endpoint) throw new Error('MCP authorization server does not support Dynamic Client Registration')
  const registration = await postJson<{ client_id: string; client_secret?: string }>(secureUrl(authorization.registration_endpoint, 'registration endpoint').toString(), {
    client_name: clientName, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'web',
  })
  if (!registration.client_id) throw new Error('Dynamic Client Registration did not return a client_id')
  const verifier = randomBytes(48).toString('base64url')
  const state = randomBytes(32).toString('base64url')
  const params = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirectUri, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource })
  const scopes = protectedResource.scopes_supported ?? authorization.scopes_supported
  if (scopes?.length) params.set('scope', scopes.join(' '))
  return { issuer: authorization.issuer, tokenEndpoint: authorization.token_endpoint, clientId: registration.client_id, ...(registration.client_secret ? { clientSecret: registration.client_secret } : {}), verifier, state, resource, authorizationUrl: `${authorization.authorization_endpoint}?${params}` }
}

export async function exchangeMcpCode(pending: Record<string, unknown>, code: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: String(pending.redirect_uri), client_id: String(pending.client_id), code_verifier: String(pending.verifier), resource: String(pending.resource) })
  if (pending.client_secret) body.set('client_secret', String(pending.client_secret))
  const response = await fetch(secureUrl(String(pending.token_endpoint), 'token endpoint'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  const payload = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description ?? `OAuth token exchange failed (${response.status})`)
  return { accessToken: payload.access_token, ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}), ...(payload.expires_in ? { expiresAt: new Date(Date.now() + payload.expires_in * 1000).toISOString() } : {}) }
}

async function authorizationMetadata(issuer: string): Promise<AuthorizationMetadata> {
  const url = secureUrl(issuer, 'authorization issuer')
  const suffix = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')
  for (const path of [`/.well-known/oauth-authorization-server${suffix}`, `/.well-known/openid-configuration${suffix}`]) {
    try { const metadata = await json<AuthorizationMetadata>(new URL(path, url).toString()); if (metadata.issuer === issuer) return metadata } catch { /* try OIDC discovery */ }
  }
  throw new Error('Unable to discover OAuth authorization-server metadata')
}

async function json<T>(url: string): Promise<T> { const response = await fetch(secureUrl(url, 'metadata URL'), { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) }); if (!response.ok) throw new Error(`Metadata discovery failed (${response.status})`); return await response.json() as T }
async function postJson<T>(url: string, body: unknown): Promise<T> { const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) }); const payload = await response.json() as T & { error_description?: string }; if (!response.ok) throw new Error(payload.error_description ?? `Dynamic Client Registration failed (${response.status})`); return payload }
function resourceMetadataUrl(header: string | null): string | undefined { const match = header?.match(/resource_metadata="([^"]+)"/i); return match?.[1] }
function wellKnownResource(endpoint: string): string { const url = new URL(endpoint); return new URL(`/.well-known/oauth-protected-resource${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}`, url).toString() }
function secureUrl(value: string, label: string): URL { const url = new URL(value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname))) throw new Error(`${label} must use HTTPS (HTTP is allowed only on loopback)`); return url }
