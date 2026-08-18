import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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

interface PendingOidc { verifier: string; nonce: string; expiresAt: number }

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

export class AuthService {
  private readonly pendingOidc = new Map<string, PendingOidc>()

  constructor(private readonly config: ServerConfig, private readonly db: PapyrusDatabase) {}

  issueSession(userId: string): string {
    const body = base64url(JSON.stringify({ userId, v: this.db.getTokenVersion(userId), exp: Date.now() + 8 * 60 * 60 * 1000 }))
    const signature = createHmac('sha256', this.config.sessionSecret).update(body).digest('base64url')
    return `${body}.${signature}`
  }

  /** Invalidates every outstanding session for a user by bumping their token version. */
  revokeSessions(userId: string): void {
    this.db.incrementTokenVersion(userId)
  }

  authenticate(request: IncomingMessage): Principal | undefined {
    if (this.config.devIdentity) {
      const parts = this.config.devIdentity.split(':')
      return this.db.upsertUser({ externalId: `dev:${parts[0]}`, displayName: parts[1] ?? parts[0] ?? 'Developer', authMethod: 'development' })
    }
    if (this.config.profile.startsWith('government')) return this.fromClientCertificate(request)
    const token = this.cookie(request, 'papyrus_session')
    if (!token) return undefined
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

  async startOidc(): Promise<string> {
    if (this.config.profile !== 'commercial') throw new Error('OIDC is available only in the commercial profile')
    if (!this.config.oidc) throw new Error('OIDC is not configured')
    const discovery = await this.discovery()
    const state = base64url(randomBytes(24))
    const nonce = base64url(randomBytes(24))
    const verifier = base64url(randomBytes(48))
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    this.pendingOidc.set(state, { verifier, nonce, expiresAt: Date.now() + 10 * 60 * 1000 })
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
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: this.config.oidc.redirectUri,
        client_id: this.config.oidc.clientId, code_verifier: pending.verifier,
        ...(this.config.oidc.clientSecret ? { client_secret: this.config.oidc.clientSecret } : {}),
      }),
    })
    if (!response.ok) throw new Error(`OIDC token exchange failed (${response.status})`)
    const tokens = await response.json() as { id_token?: string }
    if (!tokens.id_token) throw new Error('OIDC response did not include an ID token')
    const verified = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(discovery.jwks_uri)), {
      issuer: discovery.issuer, audience: this.config.oidc.clientId,
    })
    if (verified.payload.nonce !== pending.nonce) throw new Error('OIDC nonce mismatch')
    if (!verified.payload.sub) throw new Error('OIDC token has no subject')
    return this.db.upsertUser({
      externalId: `oidc:${discovery.issuer}:${verified.payload.sub}`,
      displayName: String(verified.payload.name ?? verified.payload.preferred_username ?? verified.payload.email ?? verified.payload.sub),
      ...(verified.payload.email ? { email: String(verified.payload.email) } : {}), authMethod: 'oidc',
    })
  }

  private async discovery(): Promise<OidcDiscovery> {
    const issuer = this.config.oidc?.issuer.replace(/\/$/, '')
    if (!issuer) throw new Error('OIDC is not configured')
    const response = await fetch(`${issuer}/.well-known/openid-configuration`)
    if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`)
    const discovery = await response.json() as OidcDiscovery
    if (discovery.issuer !== this.config.oidc?.issuer) throw new Error('OIDC discovery issuer mismatch')
    return discovery
  }

  private fromClientCertificate(request: IncomingMessage): Principal | undefined {
    return this.principalFromSocket(request.socket as TLSSocket)
  }

  /** Resolves a mTLS peer certificate to a local Principal (upserting on first sight). */
  principalFromSocket(socket: TLSSocket): Principal | undefined {
    if (!socket.authorized || typeof socket.getPeerCertificate !== 'function') return undefined
    const certificate = socket.getPeerCertificate()
    if (!certificate?.fingerprint256 || !certificate.subject) return undefined
    const subject = certificate.subject as unknown as Record<string, string | undefined>
    const commonName = subject.CN
    const email = subject.emailAddress
    return this.db.upsertUser({
      externalId: `x509:${certificate.fingerprint256}`,
      displayName: commonName ?? email ?? certificate.fingerprint256,
      ...(email ? { email } : {}), authMethod: 'mtls',
    })
  }

  private cookie(request: IncomingMessage, name: string): string | undefined {
    const cookies = request.headers.cookie?.split(';').map((item) => item.trim().split('=')) ?? []
    const value = cookies.find(([key]) => key === name)?.[1]
    return value ? decodeURIComponent(value) : undefined
  }
}
