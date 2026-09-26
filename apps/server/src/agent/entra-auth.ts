import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import type { EntraAppRole, PortalPrincipal } from '@papyrus/contracts'
import { ENTRA_APP_ROLES } from '@papyrus/contracts'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { deriveOrigin, type AgentConfig } from './config.js'
import { graphOrigin, type EntraCloud } from './national-cloud.js'

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

interface GraphUserProfile {
  displayName?: string
  mail?: string
  userPrincipalName?: string
  companyName?: string
  department?: string
  jobTitle?: string
  officeLocation?: string
}

interface StoredIdentityProfile {
  displayName?: string
  preferredUsername?: string
  email?: string
  organizationName?: string
  department?: string
  jobTitle?: string
  officeLocation?: string
  pictureUrl?: string
  updatedAt: string
}

type EnrichedPortalPrincipal = PortalPrincipal & Omit<StoredIdentityProfile, 'updatedAt'>

const DEFAULT_ORGANIZATION_NAME = 'Customer Agent Operations'
const PORTAL_COOKIE_IDENTITY_VERSION = 2
const MAX_PROFILE_PHOTO_BYTES = 128 * 1024
const PROFILE_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export class EntraAuthError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function encoded(value: Buffer | string): string { return Buffer.from(value).toString('base64url') }

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function emailDomain(value: string | undefined): string | undefined {
  if (!value) return undefined
  const at = value.lastIndexOf('@')
  return at > 0 && at < value.length - 1 ? value.slice(at + 1).toLowerCase() : undefined
}

export function graphUserScope(cloud: EntraCloud): string {
  return `${graphOrigin(cloud)}/User.Read`
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
  private readonly profileCache = new Map<string, StoredIdentityProfile | null>()
  private cachedDiscovery?: OidcDiscovery
  private jwks?: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly config: AgentConfig) {
    this.restoreTenantOrganizationName()
  }

  async authenticate(request: IncomingMessage): Promise<PortalPrincipal | undefined> {
    if (this.config.developmentPrincipal) return this.withStoredProfile(this.config.developmentPrincipal)
    const authorization = request.headers.authorization
    if (authorization?.startsWith('Bearer ')) {
      return this.withStoredProfile(await this.verifyEntraToken(authorization.slice(7), 'entra'))
    }
    const origin = deriveOrigin(request.headers, this.config.publicOrigin)
    const cookie = this.cookie(request, this.cookieName(origin))
    const principal = cookie ? this.verifyPortalCookie(cookie) : undefined
    return principal ? this.withStoredProfile(principal) : undefined
  }

  async verifyTeamsToken(token: string): Promise<PortalPrincipal> {
    return this.withStoredProfile(await this.verifyEntraToken(token, 'teams-sso'))
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
    try { actualSignature = Buffer.from(suppliedSignature, 'base64url') } catch { throw new EntraAuthError('INVALID_INGESTION_TOKEN', 'Ingestion token signature is malformed') }
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
    const safeReturnTo = (returnTo.startsWith('/portal') || /^\/a\/[a-f0-9-]{36}$/.test(returnTo)) && !returnTo.startsWith('//') ? returnTo : '/portal'
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
      // The portal is a server-side session, so the authorization code is used for Graph
      // profile enrichment rather than a Papyrus API access token. App roles still arrive
      // on the ID token; Teams SSO continues to use the Papyrus application audience.
      scope: `openid profile email ${graphUserScope(this.config.cloud)}`,
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
    const tokens = await response.json() as { id_token?: string; access_token?: string }
    if (!tokens.id_token) throw new EntraAuthError('OIDC_ID_TOKEN_MISSING', 'Entra response did not include an ID token')
    const principal = await this.verifyEntraToken(tokens.id_token, 'entra', pending.nonce)
    const enriched = tokens.access_token ? await this.enrichFromGraph(principal, tokens.access_token) : await this.withStoredProfile(principal)
    return { principal: enriched, returnTo: pending.returnTo, cookie: this.portalCookie(principal, origin) }
  }

  portalCookie(principal: PortalPrincipal, origin = this.config.publicOrigin): string {
    const expiresAt = Date.now() + 60 * 60 * 1000
    // Keep binary/profile enrichment out of the cookie. The signed cookie carries only the
    // authority-bearing Entra identity; cosmetic Graph data is reattached from local storage.
    const portable: PortalPrincipal = {
      oid: principal.oid,
      tenantId: principal.tenantId,
      displayName: principal.displayName,
      ...(principal.preferredUsername ? { preferredUsername: principal.preferredUsername } : {}),
      roles: principal.roles,
      groups: principal.groups,
      source: principal.source,
    }
    const body = encoded(JSON.stringify({ principal: portable, exp: expiresAt, identityVersion: PORTAL_COOKIE_IDENTITY_VERSION }))
    const signature = encoded(createHmac('sha256', this.config.portalSecret).update(body).digest())
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
      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { principal?: PortalPrincipal; exp?: number; identityVersion?: number }
      // Pre-profile cookies intentionally require one fresh Entra login so Graph can supply the
      // photo/company metadata that did not exist when those sessions were issued.
      if (!value.principal || !value.exp || value.exp <= Date.now() || value.identityVersion !== PORTAL_COOKIE_IDENTITY_VERSION) return undefined
      return value.principal
    } catch { return undefined }
  }

  private profileKey(principal: PortalPrincipal): string {
    return createHash('sha256').update(`${principal.tenantId}:${principal.oid}`).digest('hex')
  }

  private profilePath(principal: PortalPrincipal): string {
    return join(this.config.dataDir, 'identity-profiles', `${this.profileKey(principal)}.json`)
  }

  private tenantOrganizationPath(): string {
    return join(this.config.dataDir, 'identity-profiles', 'tenant-organization.txt')
  }

  private restoreTenantOrganizationName(): void {
    if (this.config.organizationName !== DEFAULT_ORGANIZATION_NAME) return
    try {
      const stored = optionalString(readFileSync(this.tenantOrganizationPath(), 'utf8'))
      if (stored) this.config.organizationName = stored
    } catch { /* first login has not learned tenant branding yet */ }
  }

  private async persistTenantOrganizationName(value: string | undefined): Promise<void> {
    if (!value || this.config.organizationName !== DEFAULT_ORGANIZATION_NAME) return
    this.config.organizationName = value
    const path = this.tenantOrganizationPath()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${value}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  private async readStoredProfile(principal: PortalPrincipal): Promise<StoredIdentityProfile | undefined> {
    const key = this.profileKey(principal)
    if (this.profileCache.has(key)) return this.profileCache.get(key) ?? undefined
    try {
      const parsed = JSON.parse(await readFile(this.profilePath(principal), 'utf8')) as Partial<StoredIdentityProfile>
      const displayName = optionalString(parsed.displayName)
      const preferredUsername = optionalString(parsed.preferredUsername)
      const email = optionalString(parsed.email)
      const organizationName = optionalString(parsed.organizationName)
      const department = optionalString(parsed.department)
      const jobTitle = optionalString(parsed.jobTitle)
      const officeLocation = optionalString(parsed.officeLocation)
      const pictureUrl = typeof parsed.pictureUrl === 'string' && parsed.pictureUrl.startsWith('data:image/') ? parsed.pictureUrl : undefined
      const profile: StoredIdentityProfile = {
        ...(displayName ? { displayName } : {}),
        ...(preferredUsername ? { preferredUsername } : {}),
        ...(email ? { email } : {}),
        ...(organizationName ? { organizationName } : {}),
        ...(department ? { department } : {}),
        ...(jobTitle ? { jobTitle } : {}),
        ...(officeLocation ? { officeLocation } : {}),
        ...(pictureUrl ? { pictureUrl } : {}),
        updatedAt: optionalString(parsed.updatedAt) ?? new Date(0).toISOString(),
      }
      this.profileCache.set(key, profile)
      if (organizationName) await this.persistTenantOrganizationName(organizationName).catch(() => undefined)
      return profile
    } catch {
      this.profileCache.set(key, null)
      return undefined
    }
  }

  private async writeStoredProfile(principal: PortalPrincipal, profile: StoredIdentityProfile): Promise<void> {
    const path = this.profilePath(principal)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, `${JSON.stringify(profile)}\n`, { encoding: 'utf8', mode: 0o600 })
    this.profileCache.set(this.profileKey(principal), profile)
    await this.persistTenantOrganizationName(profile.organizationName)
  }

  private async withStoredProfile(principal: PortalPrincipal): Promise<PortalPrincipal> {
    const profile = await this.readStoredProfile(principal)
    if (!profile) return principal
    return {
      ...principal,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(profile.preferredUsername ? { preferredUsername: profile.preferredUsername } : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.organizationName ? { organizationName: profile.organizationName } : {}),
      ...(profile.department ? { department: profile.department } : {}),
      ...(profile.jobTitle ? { jobTitle: profile.jobTitle } : {}),
      ...(profile.officeLocation ? { officeLocation: profile.officeLocation } : {}),
      ...(profile.pictureUrl ? { pictureUrl: profile.pictureUrl } : {}),
    } as EnrichedPortalPrincipal
  }

  private async enrichFromGraph(principal: PortalPrincipal, accessToken: string): Promise<PortalPrincipal> {
    const origin = graphOrigin(this.config.cloud)
    let user: GraphUserProfile = {}
    try {
      const response = await fetch(`${origin}/v1.0/me?$select=displayName,mail,userPrincipalName,companyName,department,jobTitle,officeLocation`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) user = await response.json() as GraphUserProfile
      else console.warn(`[entra] Microsoft Graph profile lookup failed (${response.status}); continuing with ID-token identity`)
    } catch (cause) {
      console.warn(`[entra] Microsoft Graph profile lookup failed: ${cause instanceof Error ? cause.message : 'unexpected error'}`)
    }

    let pictureUrl: string | undefined
    try {
      const response = await fetch(`${origin}/v1.0/me/photos/48x48/$value`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'image/*' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      })
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
      if (response.ok && contentType && PROFILE_PHOTO_TYPES.has(contentType)) {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.byteLength <= MAX_PROFILE_PHOTO_BYTES) pictureUrl = `data:${contentType};base64,${bytes.toString('base64')}`
        else console.warn(`[entra] Microsoft Graph profile photo exceeded ${MAX_PROFILE_PHOTO_BYTES} bytes and was not cached`)
      }
    } catch (cause) {
      console.warn(`[entra] Microsoft Graph profile photo lookup failed: ${cause instanceof Error ? cause.message : 'unexpected error'}`)
    }

    const displayName = optionalString(user.displayName)
    const mail = optionalString(user.mail)
    const userPrincipalName = optionalString(user.userPrincipalName)
    const preferredUsername = mail ?? userPrincipalName ?? principal.preferredUsername
    const configuredOrganization = this.config.organizationName !== DEFAULT_ORGANIZATION_NAME ? this.config.organizationName : undefined
    const organizationName = optionalString(user.companyName) ?? configuredOrganization ?? emailDomain(preferredUsername)
    const department = optionalString(user.department)
    const jobTitle = optionalString(user.jobTitle)
    const officeLocation = optionalString(user.officeLocation)
    const profile: StoredIdentityProfile = {
      ...(displayName ? { displayName } : {}),
      ...(preferredUsername ? { preferredUsername } : {}),
      ...(mail ? { email: mail } : {}),
      ...(organizationName ? { organizationName } : {}),
      ...(department ? { department } : {}),
      ...(jobTitle ? { jobTitle } : {}),
      ...(officeLocation ? { officeLocation } : {}),
      ...(pictureUrl ? { pictureUrl } : {}),
      updatedAt: new Date().toISOString(),
    }
    try { await this.writeStoredProfile(principal, profile) }
    catch (cause) { console.warn(`[entra] could not persist identity profile: ${cause instanceof Error ? cause.message : 'unexpected error'}`) }
    return {
      ...principal,
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(profile.preferredUsername ? { preferredUsername: profile.preferredUsername } : {}),
      ...(profile.email ? { email: profile.email } : {}),
      ...(profile.organizationName ? { organizationName: profile.organizationName } : {}),
      ...(profile.department ? { department: profile.department } : {}),
      ...(profile.jobTitle ? { jobTitle: profile.jobTitle } : {}),
      ...(profile.officeLocation ? { officeLocation: profile.officeLocation } : {}),
      ...(profile.pictureUrl ? { pictureUrl: profile.pictureUrl } : {}),
    } as EnrichedPortalPrincipal
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
