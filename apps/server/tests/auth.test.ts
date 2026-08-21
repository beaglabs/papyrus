import { createHmac, X509Certificate } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { testContext } from './helpers.js'

function cookieRequest(token: string): IncomingMessage {
  return { headers: { cookie: `papyrus_session=${encodeURIComponent(token)}` } } as unknown as IncomingMessage
}

const PROXY_CERTIFICATE = 'MIIDGzCCAgOgAwIBAgIUZPnAYpYadyoiAMAf+KtpuwWterkwDQYJKoZIhvcNAQELBQAwHTEbMBkGA1UEAwwSUGFweXJ1cy1UZXN0LVByb3h5MB4XDTI2MDgyMDIyMjc0NFoXDTM2MDgxNzIyMjc0NFowHTEbMBkGA1UEAwwSUGFweXJ1cy1UZXN0LVByb3h5MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0yXjXjzhNAc6bk/Gl5GRgAQ5JGWIWCI1yQZvbiGwObVmUWnkr66D9dIWuLm2/VdvmQjuML9ZicHyeRVBnuodlFrCa8mnl1CysrGjYyeCtIIXiLSjeFBZpUg98C51gH0BJLizJcWZN9lFtNaKGhklGJORhPWiEKQ+YPUpK1FRBAppRlpAERsDO3PWVD46eblzSCyL20vi41FPTbHz20lsWLyy1H8oMewvrva4/iQ2Ntqe74aIcSWcTz+5CWE09uBoApTSbcSBsc36To6DEajrXufPJHlRffEmNNtj2FVVA7UdA+pV18/39zjKwFLRT1/bv4QTfh37r4PrjFBLCCbVZQIDAQABo1MwUTAdBgNVHQ4EFgQUD3BhvoOF5gCpoCahlKn4k7KMB7wwHwYDVR0jBBgwFoAUD3BhvoOF5gCpoCahlKn4k7KMB7wwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAjNsz8UiR18e8gDAAIeSpIpfi2EukbNe82Jd95x+4pQCOHNFksm0OiG46urVwKhnDWDZqadFcHTJHe8s7m47iwGnQZqsQlIsq46dar/8nXG5d3jdu2mJxeWZdFMHvwtj11z2i++lvlK4PW8ck+p9DC5Qtr1vJaCbyEykUiTxHU3U3WJJk2PLP/zy8vHlOpnQuM6pdg1TM8RiO8WOBGzUFcS7PlUjyiHSxEyLIIDhlFqxdU0VL/WaHtCJAjFjjuB1ZPfK8V3dNjPbjabuuX/KduL0d0bAQP5jfwOlLKHSCggcteINxjMU45ajbEi+RuXXjhyjMS/qluH1/dRneLebtnA=='
const USER_CERTIFICATE = 'MIIDVTCCAj2gAwIBAgIUIxkWnUs544/MeAIioc6Nn6m7NlowDQYJKoZIhvcNAQELBQAwOjEWMBQGA1UEAwwNVGVzdC1DQUMtVXNlcjEgMB4GCSqGSIb3DQEJARYRdXNlckBleGFtcGxlLnRlc3QwHhcNMjYwODIwMjIyNzQ0WhcNMzYwODE3MjIyNzQ0WjA6MRYwFAYDVQQDDA1UZXN0LUNBQy1Vc2VyMSAwHgYJKoZIhvcNAQkBFhF1c2VyQGV4YW1wbGUudGVzdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMmSvDO4XKPhjSLDGhDABfNYpSRBdOqA1+Jk5bL+cFH53N81dNb+noWKOka9rCYROBX6NwRmF1NG6eZecOuIsbt9chyqeJSw9guWDruIDQK1ObVr81zag/WTexPEcEXB5+UTf46Ko+Lg6YM3z103EMnZYCkAaBDYyunKwro64AlBwMzTsnespo3zzCkM7l0TZdIyoRUvgjl5/midvntch+bxW431YDB8ph0PtcryObpNB88x4NNAg6vX1slnn+8E3AfTQtgUHstC8Y6gpqLK9J8cfpB116FweW2XsfM3gPNqAS2yIqV87Lo1QfZpazZ7fP+Pa7yDdXEpQeDT5ZZRed8CAwEAAaNTMFEwHQYDVR0OBBYEFL79VjTOPCrQ0hRm8aYCajvfIesWMB8GA1UdIwQYMBaAFL79VjTOPCrQ0hRm8aYCajvfIesWMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBABN3UNJw+yuYJd8a4yX+Kh2pt0guH1juzqV1D+VAd3/bedjpDFGILJP2+OsMZZGpJ1oI7vIirFKvwYCLXUaYIHy8iC6TrIRwFFFcIKf7BnjkxzvIUpxlJPptoC3TaeqqmE59IuBIULTdHxBiPQIWMxMQfMY/8y5dVwOHzp9EP9+yalxIxToV46Y/s+2nGyvAz9iDwB2PtcB5d4rNiGEEFVl3AVLs9KHAd9wnHRur0mAAIXFhBqbn59IhCORzLFXOnEpXrsVaRnX1jEzTswvpB2lz6gR1jT/sjRxrowWdU16yJ7CX3/kc5GdtIwtGb5uxXNFA/8nSD5TU9EZxRe3wKuU='

function bearerRequest(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage
}

function base64url(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function sign(ctx: ReturnType<typeof testContext>, body: string): string {
  return createHmac('sha256', ctx.config.sessionSecret).update(body).digest('base64url')
}

describe('session authentication', () => {
  it('authenticates a valid session and rejects a tampered signature', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const token = ctx.auth.issueSession(user.id)
      expect(ctx.auth.authenticate(cookieRequest(token))?.id).toBe(user.id)
      const [body, signature] = token.split('.')
      const flipped = signature[0] === 'A' ? 'B' : 'A'
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${flipped}${signature.slice(1)}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('rejects an expired session', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const body = base64url(JSON.stringify({ userId: user.id, v: 0, exp: Date.now() - 1_000 }))
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${sign(ctx, body)}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('rejects a session signed with the wrong secret', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const body = base64url(JSON.stringify({ userId: user.id, v: 0, exp: Date.now() + 60_000 }))
      const wrong = createHmac('sha256', 'a-different-secret-that-is-also-long-enough').update(body).digest('base64url')
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${wrong}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('revokes outstanding sessions by bumping the token version', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      const token = ctx.auth.issueSession(user.id)
      expect(ctx.auth.authenticate(cookieRequest(token))?.id).toBe(user.id)
      ctx.auth.revokeSessions(user.id)
      expect(ctx.auth.authenticate(cookieRequest(token))).toBeUndefined()
      const fresh = ctx.auth.issueSession(user.id)
      expect(ctx.auth.authenticate(cookieRequest(fresh))?.id).toBe(user.id)
    } finally { ctx.dispose() }
  })

  it('rejects a stale version carried in a forged token', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:sub', displayName: 'Alice', authMethod: 'oidc' })
      ctx.auth.revokeSessions(user.id) // version becomes 1
      const body = base64url(JSON.stringify({ userId: user.id, v: 0, exp: Date.now() + 60_000 }))
      expect(ctx.auth.authenticate(cookieRequest(`${body}.${sign(ctx, body)}`))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('accepts the same revocable session token as a bearer credential for daemon clients', () => {
    const ctx = testContext()
    try {
      const user = ctx.db.upsertUser({ externalId: 'oidc:issuer:native', displayName: 'Native Client', authMethod: 'oidc' })
      const token = ctx.auth.issueSession(user.id)
      expect(ctx.auth.authenticate(bearerRequest(token))?.id).toBe(user.id)
      ctx.auth.revokeSessions(user.id)
      expect(ctx.auth.authenticate(bearerRequest(token))).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('describes the configured authentication methods without exposing IdP tokens', () => {
    const ctx = testContext()
    try {
      ctx.config.oidc = {
        issuer: 'https://identity.example.test',
        clientId: 'papyrus',
        redirectUri: 'http://127.0.0.1:3210/api/auth/oidc/callback',
      }
      expect(ctx.auth.challenge()).toEqual({
        error: 'authentication_required',
        code: 'UNAUTHENTICATED',
        methods: ['oidc', 'development'],
        login_url: 'http://127.0.0.1:3210/api/auth/oidc/start',
        native_start_url: 'http://127.0.0.1:3210/api/auth/oidc/native/start',
      })
    } finally { ctx.dispose() }
  })

  it('uses a __Host cookie with secure BFF attributes on HTTPS', () => {
    const ctx = testContext()
    try {
      ctx.config.publicOrigin = 'https://papyrus.example.test'
      expect(ctx.auth.sessionCookie('token')).toBe('__Host-papyrus_session=token; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800; Priority=High; Secure')
      expect(ctx.auth.clearSessionCookie()).toContain('__Host-papyrus_session=;')
    } finally { ctx.dispose() }
  })

  it('starts a PKCE browser handoff that a native client can poll without URL credentials', async () => {
    const ctx = testContext()
    try {
      ctx.config.oidc = {
        issuer: 'https://identity.example.test',
        clientId: 'papyrus',
        redirectUri: 'http://127.0.0.1:3210/api/auth/oidc/callback',
      }
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
        issuer: 'https://identity.example.test',
        authorization_endpoint: 'https://identity.example.test/authorize',
        token_endpoint: 'https://identity.example.test/token',
        jwks_uri: 'https://identity.example.test/jwks',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))

      const started = await ctx.auth.startNativeOidc()
      const login = new URL(started.login_url)
      expect(login.origin).toBe('https://identity.example.test')
      expect(login.searchParams.get('code_challenge_method')).toBe('S256')
      expect(login.searchParams.get('code_challenge')).toBeTruthy()
      expect(login.searchParams.get('nonce')).toBeTruthy()
      expect(started.token_url).toBe('http://127.0.0.1:3210/api/auth/oidc/native/token')
      expect(ctx.auth.exchangeNativeOidc(started.transaction_id, 'wrong-token')).toBeUndefined()
      expect(ctx.auth.exchangeNativeOidc(started.transaction_id, started.exchange_token)).toEqual({
        status: 'pending',
        retry_after: 2,
      })
    } finally {
      vi.unstubAllGlobals()
      ctx.dispose()
    }
  })
})

describe('CAC/PIV federation', () => {
  it('accepts a forwarded user certificate only from an allowlisted mTLS proxy', () => {
    const ctx = testContext()
    try {
      const proxyCertificate = new X509Certificate(Buffer.from(PROXY_CERTIFICATE, 'base64'))
      ctx.config.identityProxy = {
        certificateHeader: 'x-papyrus-client-certificate',
        allowedProxyFingerprints: [proxyCertificate.fingerprint256.replaceAll(':', '').toLowerCase()],
      }
      const request = {
        headers: { 'x-papyrus-client-certificate': USER_CERTIFICATE },
        socket: { authorized: true, encrypted: true, getPeerX509Certificate: () => proxyCertificate },
      } as unknown as IncomingMessage
      const principal = ctx.auth.authenticate(request)
      expect(principal?.displayName).toBe('Test-CAC-User')
      expect(principal?.authMethod).toBe('mtls')

      ctx.config.identityProxy.allowedProxyFingerprints = ['0'.repeat(64)]
      expect(ctx.auth.authenticate(request)).toBeUndefined()
    } finally { ctx.dispose() }
  })

  it('rejects a spoofed forwarded certificate over an unauthenticated socket', () => {
    const ctx = testContext()
    try {
      const proxyCertificate = new X509Certificate(Buffer.from(PROXY_CERTIFICATE, 'base64'))
      ctx.config.identityProxy = {
        certificateHeader: 'x-papyrus-client-certificate',
        allowedProxyFingerprints: [proxyCertificate.fingerprint256.replaceAll(':', '').toLowerCase()],
      }
      const request = {
        headers: { 'x-papyrus-client-certificate': USER_CERTIFICATE },
        socket: { authorized: false, encrypted: false, getPeerX509Certificate: () => proxyCertificate },
      } as unknown as IncomingMessage
      expect(ctx.auth.authenticate(request)).toBeUndefined()
    } finally { ctx.dispose() }
  })
})
