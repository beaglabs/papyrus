import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { EntraAppRole, PortalPrincipal } from '@papyrus/contracts'
import { ENTRA_APP_ROLES } from '@papyrus/contracts'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { deriveOrigin, type AgentConfig } from './config.js'

interface OidcDiscovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

interface PendingLogin {
  verifier: string
  nonce: string
  returnTo: string
  expiresAt: number
}

interface IngestionTokenClaims {
  type: 'papyrus-ingestion'
  integrationId: string
  issuedBy: string
  expiresAt: number
  nonce: string
}

export class EntraAuthError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function encoded(value: Buffer | string): string { return Buffer.from(value).toString('base64url') }

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

export function principalFromClaims(payload: JWTPayload, source: PortalPrincipal['source']): PortalPrincipal {
  const oid = typeof payload.oid === 'string' ? payload.oid : typeof payload.sub === 'string' ? payload.sub : undefined
  const tenantId = typeof payload.tid === 'string' ? payload.tid : undefined
  if (!oid || !tenantId) throw new EntraAuthError('INVALID_ENTRA_IDENTITY', 'Entra token is missing oid or tid')
  const roles = stringArray(payload.roles).filter((role): role is EntraAppRole => ENTRA_APP_ROLES.includes(role as EntraAppRole))
  const displayName = typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'Entra user'
  const preferredUsername = typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined
  return {
    oid,
    tenantId,
    displayName,
    ...(preferredUsername ? { preferredUsername } : {}),
    roles,
    groups: stringArray(payload.groups),
    source,
  }
}

export function hasAppRole(principal: PortalPrincipal, role: EntraAppRole): boolean {
  return principal.roles.includes('Papyrus.System.Owner') || principal.roles.includes(role)
}

export class EntraAuthService {
  private readonly pending = new Map<string, PendingLogin>()
  private cachedDiscovery?: OidcDiscovery
  private jwks?: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly config: AgentConfig) {}

  async authenticate(request: IncomingMessage): Promise<PortalPrincipal | undefined> {
    if (this.config.developmentPrincipal) return this.config.developmentPrincipal
    const authorization = request.headers.authorization
    if (authorization?.startsWith('Bearer ')) return this.verifyEntraToken(authorization.slice(7), 'entra')
    const origin = deriveOrigin(request.headers, this.config.publicOrigin)
    const cookie = this.cookie(request, this.cookieName(origin))
    return cookie ? this.verifyPortalCookie(cookie) : undefined
  }

  async verifyTeamsToken(token: string): Promise<PortalPrincipal> {
    return this.verifyEntraToken(token, 'teams-sso')
  }

  issueIngestionToken(integrationId: string, issuedBy: string, lifetimeSeconds = 3_600): { token: string; expiresAt: string } {
    const expiresAt = Date.now() + lifetimeSeconds * 1_000
    const body = encoded(JSON.stringify({
      type: 'papyrus-ingestion', integrationId, issuedBy, expiresAt, nonce: encoded(randomBytes(18)),
    } satisfies IngestionTokenClaims))
    const signature = encoded(createHmac('sha256', this.config.portalSecret).update(`papyrus-ingestion:${body}`).digest())
    return { token: `pap_ing_${body}.${signature}`, expiresAt: new Date(expiresAt).toISOString() }
  }

  verifyIngestionRequest(request: IncomingMessage, integrationId: string): boolean {
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer pap_ing_')) return false
    const token = authorization.slice('Bearer '.length)
    const parts = token.slice('pap_ing_'.length).split('.')
    if (parts.length !== 2) throw new EntraAuthError('INVALID_INGESTION_TOKEN', 'Ingestion token is malformed')
    const [body, suppliedSignature] = parts
    if (!body || !suppliedSignature) throw new EntraAuthError('INVALID_INGESTION_TOKEN', 'Ingestion token is malformed')
    const expectedSignature = createHmac('sha256', this.config.portalSecret).update(`papyrus-ingestion:${body}`).digest()
    let actualSignature: Buffer
    try { actualSignature = Buffer.from(suppliedSignature, 'base64url') }
    catch { throw new EntraAuthError('INVALID_INGESTION_TOKEN', 'Ingestion token signature is malformed') }
    if (actualSignature.length !== expectedSignature.length || !timingSafeEqual(actualSignature, expectedSignature)) {
      throw new EntraAuthError('INVALID_INGESTION_TOKEN', 'Ingestion token signature is invalid')
    }
    let claims: IngestionTokenClaims
    try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as IngestionTokenClaims }
    catch { throw new EntraAuthError('INVALID_INGESTION_TOKEN', 'Ingestion token claims are malformed') }
    if (claims.type !== 'papyrus-ingestion' || claims.integrationId !== integrationId) {
      throw new EntraAuthError('INGESTION_TOKEN_SCOPE_MISMATCH', 'Ingestion token is not valid for this source')
    }
    if (!Number.isFinite(claims.expiresAt) || claims.expiresAt <= Date.now()) throw new EntraAuthError('INGESTION_TOKEN_EXPIRED', 'Ingestion token has expired')
    return true
  }

  async startLogin(returnTo = '/portal', origin = this.config.publicOrigin): Promise<string> {
    if (!this.config.entra) throw new EntraAuthError('ENTRA_NOT_CONFIGURED', 'Microsoft Entra ID is not configured')
    this.prune()
    if (this.pending.size >= 256) throw new EntraAuthError('TOO_MANY_LOGINS', 'Too many pending Entra login requests')
    const safeReturnTo = returnTo.startsWith('/portal') && !returnTo.startsWith('//') ? returnTo : '/portal'
    const discovery = await this.discovery()
    const state = encoded(randomBytes(32))
    const nonce = encoded(randomBytes(32))
    const verifier = encoded(randomBytes(48))
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    this.pending.set(state, { verifier, nonce, returnTo: safeReturnTo, expiresAt: Date.now() + 10 * 60 * 1000 })
    const url = new URL(discovery.authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: this.config.entra.clientId,
      redirect_uri: new URL('/api/auth/entra/callback', origin).toString(),
      response_type: 'code',
      response_mode: 'query',
      scope: `openid profile email ${this.config.entra.scope}`,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    return url.toString()
  }

  async completeLogin(code: string, state: string, origin = this.config.publicOrigin): Promise<{ principal: PortalPrincipal; returnTo: string; cookie: string }> {
    if (!this.config.entra) throw new EntraAuthError('ENTRA_NOT_CONFIGURED', 'Microsoft Entra ID is not configured')
    this.prune()
    const pending = this.pending.get(state)
    this.pending.delete(state)
    if (!pending || pending.expiresAt <= Date.now()) throw new EntraAuthError('INVALID_OIDC_STATE', 'Entra login state is missing or expired')
    const discovery = await this.discovery()
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.entra.clientId,
        redirect_uri: new URL('/api/auth/entra/callback', origin).toString(),
        code_verifier: pending.verifier,
        ...(this.config.entra.clientSecret ? { client_secret: this.config.entra.clientSecret } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new EntraAuthError('OIDC_TOKEN_EXCHANGE_FAILED', `Entra token exchange failed (${response.status})`)
    const tokens = await response.json() as { id_token?: string }
    if (!tokens.id_token) throw new EntraAuthError('OIDC_ID_TOKEN_MISSING', 'Entra response did not include an ID token')
    const principal = await this.verifyEntraToken(tokens.id_token, 'entra', pending.nonce)
    return { principal, returnTo: pending.returnTo, cookie: this.portalCookie(principal, origin) }
  }

  portalCookie(principal: PortalPrincipal, origin = this.config.publicOrigin): string {
    const expiresAt = Date.now() + 60 * 60 * 1000
    const body = encoded(JSON.stringify({ principal, exp: expiresAt }))
    const signature = createHmac('sha256', this.config.portalSecret).update(body).digest('base64url')
    const secure = origin.startsWith('https://')
    return `${this.cookieName(origin)}=${encodeURIComponent(`${body}.${signature}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600; Priority=High${secure ? '; Secure' : ''}`
  }

  clearCookie(origin = this.config.publicOrigin): string {
    const secure = origin.startsWith('https://')
    return `${this.cookieName(origin)}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Priority=High${secure ? '; Secure' : ''}`
  }

  private async verifyEntraToken(token: string, source: PortalPrincipal['source'], nonce?: string): Promise<PortalPrincipal> {
    if (!this.config.entra) throw new EntraAuthError('ENTRA_NOT_CONFIGURED', 'Microsoft Entra ID is not configured')
    const discovery = await this.discovery()
    this.jwks ??= createRemoteJWKSet(new URL(discovery.jwks_uri))
    const result = await jwtVerify(token, this.jwks, {
      issuer: this.config.entra.issuer,
      audience: [this.config.entra.clientId, `api://${this.config.entra.clientId}`],
      ...(nonce ? { requiredClaims: ['nonce'] } : {}),
    })
    if (nonce && result.payload.nonce !== nonce) throw new EntraAuthError('INVALID_OIDC_NONCE', 'Entra token nonce does not match the login request')
    if (result.payload.tid !== this.config.entra.tenantId) throw new EntraAuthError('WRONG_ENTRA_TENANT', 'Entra token belongs to another tenant')
    const principal = principalFromClaims(result.payload, source)
    if (principal.roles.length === 0) {
      const presented = stringArray(result.payload.roles)
      console.warn(presented.length
        ? `[entra] token for ${principal.oid} carries roles Papyrus does not declare: ${presented.join(', ')}`
        : `[entra] token for ${principal.oid} has no roles claim; assign a Papyrus app role on the enterprise application before sign-in`)
    }
    return principal
  }

  private verifyPortalCookie(token: string): PortalPrincipal | undefined {
    const [body, signature] = token.split('.')
    if (!body || !signature) return undefined
    const expected = createHmac('sha256', this.config.portalSecret).update(body).digest()
    let presented: Buffer
    try { presented = Buffer.from(signature, 'base64url') } catch { return undefined }
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return undefined
    try {
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { principal?: PortalPrincipal; exp?: number }
      if (!value.principal || !value.exp || value.exp <= Date.now()) return undefined
      return value.principal
    } catch { return undefined }
  }

  private cookieName(origin = this.config.publicOrigin): string { return origin.startsWith('https://') ? '__Host-papyrus_portal' : 'papyrus_portal' }

  private cookie(request: IncomingMessage, name: string): string | undefined {
    for (const pair of (request.headers.cookie ?? '').split(';')) {
      const separator = pair.indexOf('=')
      if (separator < 0 || pair.slice(0, separator).trim() !== name) continue
      try { return decodeURIComponent(pair.slice(separator + 1).trim()) } catch { return undefined }
    }
    return undefined
  }

  private async discovery(): Promise<OidcDiscovery> {
    if (this.cachedDiscovery) return this.cachedDiscovery
    if (!this.config.entra) throw new EntraAuthError('ENTRA_NOT_CONFIGURED', 'Microsoft Entra ID is not configured')
    const response = await fetch(`${this.config.entra.authority}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new EntraAuthError('OIDC_DISCOVERY_FAILED', `Entra discovery failed (${response.status})`)
    const value = await response.json() as Partial<OidcDiscovery>
    if (!value.authorization_endpoint || !value.token_endpoint || !value.jwks_uri || value.issuer !== this.config.entra.issuer) {
      throw new EntraAuthError('INVALID_OIDC_DISCOVERY', 'Entra discovery metadata is incomplete or has an unexpected issuer')
    }
    this.cachedDiscovery = value as OidcDiscovery
    return this.cachedDiscovery
  }

  private prune(): void {
    const now = Date.now()
    for (const [key, value] of this.pending) if (value.expiresAt <= now) this.pending.delete(key)
  }
}
