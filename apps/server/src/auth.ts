import { createHash, createHmac, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Principal } from '@papyrus/contracts'
import type { ServerConfig } from './config.js'
import type { PapyrusDatabase } from './db.js'

interface OidcDiscovery {
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  issuer: string
}

interface PendingOidc { verifier: string; nonce: string; expiresAt: number; nativeTransactionId?: string }
interface PendingNativeOidc { exchangeDigest: Buffer; expiresAt: number; userId?: string }

export type AuthenticationMethod = 'oidc' | 'mtls' | 'mtls-proxy'

export interface AuthenticationChallenge {
  error: 'authentication_required'
  code: 'UNAUTHENTICATED'
  methods: AuthenticationMethod[]
  login_url?: string
  native_start_url?: string
}

export interface NativeOidcStart {
  login_url: string
  transaction_id: string
  exchange_token: string
  token_url: string
  expires_in: number
}

export type NativeOidcExchange =
  | { status: 'pending'; retry_after: number }
  | { status: 'complete'; access_token: string; token_type: 'Bearer'; expires_in: number }

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function normalizeFingerprint(value: string): string {
  return value.replaceAll(':', '').toLowerCase()
}

function certificateName(certificate: X509Certificate): { displayName: string; email?: string } {
  const commonName = certificate.subject.match(/(?:^|\n)CN=([^\n]+)/)?.[1]
  const email = certificate.subjectAltName?.match(/(?:^|,\s*)email:([^,]+)/i)?.[1]
    ?? certificate.subject.match(/(?:^|\n)emailAddress=([^\n]+)/)?.[1]
  return {
    displayName: commonName ?? email ?? certificate.fingerprint256,
    ...(email ? { email } : {}),
  }
}

function isCertificateCurrent(certificate: X509Certificate): boolean {
  const now = Date.now()
  return Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) >= now
}

export class AuthService {
  private readonly pendingOidc = new Map<string, PendingOidc>()
  private readonly pendingNativeOidc = new Map<string, PendingNativeOidc>()

  constructor(private readonly config: ServerConfig, private readonly db: PapyrusDatabase) {}

  issueSession(userId: string): string {
    const body = base64url(JSON.stringify({ userId, v: this.db.getTokenVersion(userId), exp: Date.now() + 8 * 60 * 60 * 1000 }))
    const signature = createHmac('sha256', this.config.sessionSecret).update(body).digest('base64url')
    return `${body}.${signature}`
  }

  sessionCookie(token: string): string {
    const secure = this.config.publicOrigin.startsWith('https://')
    const name = secure ? '__Host-papyrus_session' : 'papyrus_session'
    return `${name}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800; Priority=High${secure ? '; Secure' : ''}`
  }

  clearSessionCookie(): string {
    const secure = this.config.publicOrigin.startsWith('https://')
    const name = secure ? '__Host-papyrus_session' : 'papyrus_session'
    return `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Priority=High${secure ? '; Secure' : ''}`
  }

  challenge(): AuthenticationChallenge {
    const methods: AuthenticationMethod[] = []
    if (this.config.oidc) methods.push('oidc')
    if (this.config.profile.startsWith('government')) methods.push('mtls')
    if (this.config.identityProxy) methods.push('mtls-proxy')
    return {
      error: 'authentication_required',
      code: 'UNAUTHENTICATED',
      methods,
      ...(this.config.oidc ? {
        login_url: new URL('/api/auth/oidc/start', this.config.publicOrigin).toString(),
        native_start_url: new URL('/api/auth/oidc/native/start', this.config.publicOrigin).toString(),
      } : {}),
    }
  }

  /** Invalidates every outstanding session for a user by bumping their token version. */
  revokeSessions(userId: string): void {
    this.db.incrementTokenVersion(userId)
  }

  authenticate(request: IncomingMessage): Principal | undefined {
    const forwarded = this.principalFromTrustedProxy(request)
    if (forwarded) return forwarded
    if (this.config.profile.startsWith('government')) return this.principalFromSocket(request.socket as TLSSocket)

    const authorization = request.headers.authorization
    const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
    const token = bearer
      ?? this.cookie(request, '__Host-papyrus_session')
      ?? this.cookie(request, 'papyrus_session')
    return token ? this.principalFromSession(token) : undefined
  }

  async startOidc(): Promise<string> {
    return this.beginOidc()
  }

  async startNativeOidc(): Promise<NativeOidcStart> {
    this.prunePendingOidc()
    if (this.pendingNativeOidc.size >= 256) throw new Error('Too many pending native OIDC requests')
    const transactionId = base64url(randomBytes(32))
    const exchangeToken = base64url(randomBytes(32))
    const expiresAt = Date.now() + 10 * 60 * 1000
    this.pendingNativeOidc.set(transactionId, {
      exchangeDigest: createHash('sha256').update(exchangeToken).digest(),
      expiresAt,
    })
    try {
      const loginUrl = await this.beginOidc(transactionId)
      return {
        login_url: loginUrl,
        transaction_id: transactionId,
        exchange_token: exchangeToken,
        token_url: new URL('/api/auth/oidc/native/token', this.config.publicOrigin).toString(),
        expires_in: 600,
      }
    } catch (error) {
      this.pendingNativeOidc.delete(transactionId)
      throw error
    }
  }

  exchangeNativeOidc(transactionId: string, exchangeToken: string): NativeOidcExchange | undefined {
    this.prunePendingOidc()
    const transaction = this.pendingNativeOidc.get(transactionId)
    if (!transaction) return undefined
    const presented = createHash('sha256').update(exchangeToken).digest()
    if (!timingSafeEqual(presented, transaction.exchangeDigest)) return undefined
    if (!transaction.userId) return { status: 'pending', retry_after: 2 }
    this.pendingNativeOidc.delete(transactionId)
    return {
      status: 'complete',
      access_token: this.issueSession(transaction.userId),
      token_type: 'Bearer',
      expires_in: 28_800,
    }
  }

  private async beginOidc(nativeTransactionId?: string): Promise<string> {
    if (this.config.profile !== 'commercial') throw new Error('OIDC is available only in the commercial profile')
    if (!this.config.oidc) throw new Error('OIDC is not configured')
    this.prunePendingOidc()
    if (this.pendingOidc.size >= 256) throw new Error('Too many pending OIDC requests')
    const discovery = await this.discovery()
    const state = base64url(randomBytes(32))
    const nonce = base64url(randomBytes(32))
    const verifier = base64url(randomBytes(48))
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    this.pendingOidc.set(state, {
      verifier,
      nonce,
      expiresAt: Date.now() + 10 * 60 * 1000,
      ...(nativeTransactionId ? { nativeTransactionId } : {}),
    })
    const url = new URL(discovery.authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: this.config.oidc.clientId, redirect_uri: this.config.oidc.redirectUri,
      response_type: 'code', scope: 'openid profile email', state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256',
    }).toString()
    return url.toString()
  }

  async completeOidc(code: string, state: string): Promise<Principal> {
    if (this.config.profile !== 'commercial') throw new Error('OIDC is available only in the commercial profile')
    if (!this.config.oidc) throw new Error('OIDC is not configured')
    const pending = this.pendingOidc.get(state)
    this.pendingOidc.delete(state)
    if (!pending || pending.expiresAt <= Date.now()) throw new Error('OIDC state is missing or expired')
    const discovery = await this.discovery()
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: this.config.oidc.redirectUri,
        client_id: this.config.oidc.clientId, code_verifier: pending.verifier,
        ...(this.config.oidc.clientSecret ? { client_secret: this.config.oidc.clientSecret } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`OIDC token exchange failed (${response.status})`)
    const tokens = await response.json() as { id_token?: string }
    if (!tokens.id_token) throw new Error('OIDC response did not include an ID token')
    const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
      issuer: discovery.issuer, audience: this.config.oidc.clientId,
    })
    if (verified.payload.nonce !== pending.nonce) throw new Error('OIDC nonce mismatch')
    if (!verified.payload.sub) throw new Error('OIDC token has no subject')
    const principal = this.db.upsertUser({
      externalId: `oidc:${discovery.issuer}:${verified.payload.sub}`,
      displayName: String(verified.payload.name ?? verified.payload.preferred_username ?? verified.payload.email ?? verified.payload.sub),
      ...(verified.payload.email ? { email: String(verified.payload.email) } : {}), authMethod: 'oidc',
    })
    if (pending.nativeTransactionId) {
      const transaction = this.pendingNativeOidc.get(pending.nativeTransactionId)
      if (transaction && transaction.expiresAt > Date.now()) transaction.userId = principal.id
    }
    return principal
  }

  /** Resolves a directly presented, CA-validated mTLS certificate. */
  principalFromSocket(socket: TLSSocket): Principal | undefined {
    if (!socket.authorized || !socket.encrypted || typeof socket.getPeerX509Certificate !== 'function') return undefined
    const certificate = socket.getPeerX509Certificate()
    if (!certificate?.fingerprint256 || !isCertificateCurrent(certificate)) return undefined
    return this.principalFromCertificate(certificate)
  }

  /**
   * Accepts a forwarded end-user certificate only across an authenticated mTLS
   * connection from an explicitly allowlisted identity proxy. The proxy must
   * validate the end-user certificate chain and revocation status before forwarding.
   */
  principalFromTrustedProxy(request: IncomingMessage): Principal | undefined {
    const proxy = this.config.identityProxy
    if (!proxy) return undefined
    const value = request.headers[proxy.certificateHeader]
    if (typeof value !== 'string' || value.length === 0 || value.length > 16_384) return undefined
    const socket = request.socket as TLSSocket
    if (!socket.authorized || !socket.encrypted || typeof socket.getPeerX509Certificate !== 'function') return undefined
    const peer = socket.getPeerX509Certificate()
    if (!peer?.fingerprint256 || !proxy.allowedProxyFingerprints.includes(normalizeFingerprint(peer.fingerprint256))) return undefined
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined
    try {
      const certificate = new X509Certificate(Buffer.from(value, 'base64'))
      if (!certificate.fingerprint256 || !isCertificateCurrent(certificate)) return undefined
      return this.principalFromCertificate(certificate)
    } catch {
      return undefined
    }
  }

  private principalFromSession(token: string): Principal | undefined {
    const [body, signature] = token.split('.')
    if (!body || !signature) return undefined
    const expected = createHmac('sha256', this.config.sessionSecret).update(body).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined
    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { userId: string; v?: number; exp: number }
      if (payload.exp <= Date.now()) return undefined
      if ((payload.v ?? 0) !== this.db.getTokenVersion(payload.userId)) return undefined
      return this.db.getPrincipal(payload.userId)
    } catch { return undefined }
  }

  private principalFromCertificate(certificate: X509Certificate): Principal {
    const identity = certificateName(certificate)
    return this.db.upsertUser({
      externalId: `x509:${certificate.fingerprint256}`,
      displayName: identity.displayName,
      ...(identity.email ? { email: identity.email } : {}),
      authMethod: 'mtls',
    })
  }

  private async discovery(): Promise<OidcDiscovery> {
    const issuer = this.config.oidc?.issuer.replace(/\/$/, '')
    if (!issuer) throw new Error('OIDC is not configured')
    const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`)
    const discovery = await response.json() as OidcDiscovery
    if (discovery.issuer !== this.config.oidc?.issuer) throw new Error('OIDC discovery issuer mismatch')
    for (const [name, value] of Object.entries({ authorization_endpoint: discovery.authorization_endpoint, token_endpoint: discovery.token_endpoint, jwks_uri: discovery.jwks_uri })) {
      if (typeof value !== 'string') throw new Error(`OIDC discovery is missing ${name}`)
      const endpoint = new URL(value)
      if (this.config.mode === 'persistent' && endpoint.protocol !== 'https:') throw new Error(`OIDC ${name} must use HTTPS`)
    }
    return discovery
  }

  private prunePendingOidc(): void {
    const now = Date.now()
    for (const [state, pending] of this.pendingOidc) if (pending.expiresAt <= now) this.pendingOidc.delete(state)
    for (const [id, pending] of this.pendingNativeOidc) if (pending.expiresAt <= now) this.pendingNativeOidc.delete(id)
  }

  private cookie(request: IncomingMessage, name: string): string | undefined {
    const cookies = request.headers.cookie?.split(';').map((item) => item.trim().split('=')) ?? []
    const value = cookies.find(([key]) => key === name)?.[1]
    if (!value) return undefined
    try { return decodeURIComponent(value) }
    catch { return undefined }
  }
}
