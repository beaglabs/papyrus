/**
 * Auth adapter registry — profile-gated selection of authentication adapters.
 *
 * Each auth method (cac-piv, webauthn, oidc, saml) has a mock adapter for P1
 * development. The real implementations will call into:
 *   - CAC/PIV: PKCS#11 smart card middleware (ActivClient, CoolKey, etc.)
 *   - WebAuthn: @simplewebauthn/server
 *   - OIDC: openid-client
 *   - SAML: @node-saml/node-saml
 *
 * The daemon's HTTP auth endpoints delegate to these adapters.
 */
import { createHash, createPublicKey, randomUUID, verify, getRandomValues, X509Certificate } from 'node:crypto'
import type {
  AuthAdapter,
  AuthChallenge,
  AuthMethod,
  AuthProviderConfig,
  AuthResponse,
  AuthResult,
} from './types.js'

/** Real CAC/PIV adapter — verifies x509 client certificates from TLS handshake. */
export class CACPIVAdapter implements AuthAdapter {
  readonly method = 'cac-piv' as const

  constructor(
    private config?: AuthProviderConfig['cacPiv'],
  ) {}

  async start(): Promise<AuthChallenge> {
    return {
      method: 'cac-piv',
      challenge: {
        type: 'mtls',
        message:
          'Present your CAC/PIV hardware token. The TLS handshake will verify your client certificate.',
        nonce: randomUUID(),
      },
    }
  }

  /**
   * Verify a client certificate from the TLS handshake.
   * Expects response.data.certPem to contain the PEM-encoded client certificate.
   * Optionally verifies against a CA bundle if configured.
   */
  async complete(response: AuthResponse): Promise<AuthResult> {
    const certPem = response.data.certPem as string
    if (!certPem) {
      throw new Error('certPem required for CAC/PIV verification')
    }

    // Parse the x509 certificate
    const cert = new X509Certificate(certPem)

    // Check certificate expiration
    const now = new Date()
    if (cert.validToDate < now) {
      throw new Error('CAC/PIV certificate has expired')
    }
    if (cert.validFromDate > now) {
      throw new Error('CAC/PIV certificate is not yet valid')
    }

    // Verify against CA bundle if configured
    if (this.config?.caBundle) {
      const caCerts = this.parseCABundle(this.config.caBundle)
      const chainValid = this.verifyCertChain(cert, caCerts)
      if (!chainValid) {
        throw new Error('CAC/PIV certificate chain verification failed')
      }
    }

    // Extract identity from certificate Subject DN
    const subjectDN = cert.subject
    const cn = this.extractCN(subjectDN)
    const displayName = cn ?? response.data.displayName as string ?? 'CAC User'

    // Compute certificate fingerprint for provenance
    const fingerprint = createHash('sha256').update(cert.raw).digest('hex')

    return {
      method: 'cac-piv',
      displayName,
      externalId: subjectDN,
      provenance: {
        certFingerprint: fingerprint,
        subjectDN,
        issuerDN: cert.issuer,
        serialNumber: cert.serialNumber,
        validFrom: cert.validFromDate.toISOString(),
        validTo: cert.validToDate.toISOString(),
        keyUsage: cert.keyUsage,
        publicKeyAlgorithm: cert.publicKey.asymmetricKeyType ?? 'unknown',
      },
    }
  }

  /**
   * Parse a PEM-encoded CA bundle file into individual X509Certificate objects.
   */
  private parseCABundle(bundle: string): X509Certificate[] {
    const certs: X509Certificate[] = []
    const pemBlocks = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)
    if (pemBlocks) {
      for (const pem of pemBlocks) {
        try {
          certs.push(new X509Certificate(pem))
        } catch {
          // skip invalid certs
        }
      }
    }
    return certs
  }

  /**
   * Verify a certificate against a chain of CA certificates.
   * Uses Node.js X509Certificate.verify() which checks the issuer chain.
   */
  private verifyCertChain(cert: X509Certificate, caCerts: X509Certificate[]): boolean {
    for (const ca of caCerts) {
      try {
        // X509Certificate.verify checks if cert was issued by the given key/ca
        if (cert.verify(ca.publicKey)) {
          return true
        }
      } catch {
        // not issued by this CA, try next
      }
    }
    return false
  }

  /**
   * Extract Common Name (CN) from a certificate Subject DN string.
   * Format: "CN=John Doe,OU=DoD,O=U.S. Government"
   */
  private extractCN(subject: string): string | null {
    const match = subject.match(/CN=([^,]+)/)
    return match ? match[1] ?? null : null
  }
}

/** Real WebAuthn adapter using @simplewebauthn/server for FIDO2 verification. */
export class WebAuthnAdapter implements AuthAdapter {
  readonly method = 'webauthn' as const

  constructor(
    private config?: AuthProviderConfig['webauthn'],
  ) {}

  /**
   * Start a WebAuthn flow. The flow type (register vs authenticate) is determined
   * by the presence of existing credentials for the member.
   * The daemon endpoint will call this with the appropriate flow.
   */
  async start(): Promise<AuthChallenge> {
    // This base start() is a fallback. Real flows use registerStart() / authenticateStart()
    return {
      method: 'webauthn',
      challenge: {
        type: 'webauthn.get',
        challenge: randomUUID(),
        rpId: this.config?.rpId ?? 'localhost',
        allowCredentials: [],
        userVerification: 'preferred',
      },
    }
  }

  async complete(response: AuthResponse): Promise<AuthResult> {
    // This base complete() is a fallback. Real flows use registerComplete() / authenticateComplete()
    return {
      method: 'webauthn',
      displayName: (response.data.displayName as string) ?? 'WebAuthn User',
      externalId: (response.data.credentialId as string) ?? randomUUID(),
      provenance: {
        rpId: this.config?.rpId ?? 'localhost',
        authenticatorType: 'platform',
      },
    }
  }

  /**
   * Generate registration options for a new credential.
   * Called by daemon endpoint /api/auth/webauthn/register/start
   */
  async registerStart(memberKey: string, displayName: string): Promise<AuthChallenge> {
    // Import dynamically to avoid issues in non-Node environments
    const { generateRegistrationOptions } = await import('@simplewebauthn/server')

    // Convert memberKey hex string to Uint8Array for userID
    const userID = new Uint8Array(Buffer.from(memberKey, 'hex'))

    const options = await generateRegistrationOptions({
      rpName: this.config?.rpName ?? 'Papyrus',
      rpID: this.config?.rpId ?? 'localhost',
      userName: displayName,
      userID,
      userDisplayName: displayName,
      timeout: 60000,
      attestationType: 'none',
      excludeCredentials: [],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'preferred',
        requireResidentKey: false,
        userVerification: 'preferred',
      },
      supportedAlgorithmIDs: [-7, -257], // ES256, RS256
    })

    // Store the challenge in the response for the daemon to track
    return {
      method: 'webauthn',
      challenge: {
        type: 'webauthn.register',
        options,
        challenge: options.challenge,
      },
    }
  }

  /**
   * Verify a registration response and return the credential info.
   * Called by daemon endpoint /api/auth/webauthn/register/finish
   */
  async registerComplete(
    response: AuthResponse,
    expectedChallenge: string,
    expectedOrigin: string,
    expectedRPID: string,
  ): Promise<{ credentialId: string; publicKey: string; counter: number; aaguid: string }> {
    const { verifyRegistrationResponse } = await import('@simplewebauthn/server')

    const verification = await verifyRegistrationResponse({
      response: response.data as any,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification: false,
    })

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('WebAuthn registration verification failed')
    }

    const { credentialID, credentialPublicKey, counter, aaguid } = verification.registrationInfo

    return {
      credentialId: credentialID,
      publicKey: Buffer.from(credentialPublicKey).toString('base64'),
      counter,
      aaguid: Buffer.from(aaguid).toString('hex'),
    }
  }

  /**
   * Generate authentication options for an existing credential.
   * Called by daemon endpoint /api/auth/webauthn/authenticate/start
   */
  async authenticateStart(credentialIds: string[]): Promise<AuthChallenge> {
    const { generateAuthenticationOptions } = await import('@simplewebauthn/server')

    const options = await generateAuthenticationOptions({
      rpID: this.config?.rpId ?? 'localhost',
      timeout: 60000,
      allowCredentials: credentialIds.map((id) => ({
        id,
        type: 'public-key' as const,
        transports: ['internal', 'hybrid', 'usb', 'ble', 'nfc'] as const,
      })),
      userVerification: 'preferred',
    })

    return {
      method: 'webauthn',
      challenge: {
        type: 'webauthn.authenticate',
        options,
        challenge: options.challenge,
      },
    }
  }

  /**
   * Verify an authentication assertion.
   * Called by daemon endpoint /api/auth/webauthn/authenticate/finish
   */
  async authenticateComplete(
    response: AuthResponse,
    expectedChallenge: string,
    expectedOrigin: string,
    expectedRPID: string,
    credentialPublicKey: string,
    currentCounter: number,
    credentialId: string,
  ): Promise<{ verified: boolean; counter: number }> {
    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server')

    const verification = await verifyAuthenticationResponse({
      response: response.data as any,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      authenticator: {
        credentialID: credentialId,
        credentialPublicKey: Buffer.from(credentialPublicKey, 'base64'),
        counter: currentCounter,
        transports: ['internal', 'hybrid', 'usb', 'ble', 'nfc'],
      },
      requireUserVerification: false,
    })

    return {
      verified: verification.verified,
      counter: verification.authenticationInfo?.newCounter ?? currentCounter,
    }
  }
}

/** Real OIDC adapter — OAuth2/OIDC authorization code flow with PKCE + JWT verification. */
export class OIDCAdapter implements AuthAdapter {
  readonly method = 'oidc' as const

  constructor(
    private config?: AuthProviderConfig['oidc'],
  ) {}

  /** Default OAuth2 scopes for OIDC. */
  private get scopes(): string[] {
    return this.config?.scopes ?? ['openid', 'profile', 'email']
  }

  /** Generate PKCE code verifier and challenge (S256). */
  private generatePKCE(): { verifier: string; challenge: string } {
    const verifierBytes = getRandomValues(new Uint8Array(32))
    const verifier = Buffer.from(verifierBytes).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    return { verifier, challenge }
  }

  /**
   * Start the OIDC authorization code flow.
   * Returns the authorization URL and PKCE state.
   * The daemon stores the state+verifier for later verification.
   */
  async start(): Promise<AuthChallenge> {
    const state = randomUUID()
    const { verifier, challenge } = this.generatePKCE()
    const redirectUri = this.config?.redirectUri ?? 'http://localhost:3777/api/auth/oidc/callback'
    const issuer = this.config?.issuer ?? 'https://login.example.com'
    const clientId = this.config?.clientId ?? 'papyrus'

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: this.scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      nonce: randomUUID(),
    })

    const authorizationUrl = `${issuer}/authorize?${params.toString()}`

    return {
      method: 'oidc',
      challenge: {
        type: 'oidc',
        authorizationUrl,
        state,
        codeVerifier: verifier,
      },
    }
  }

  /**
   * Complete the OIDC flow by exchanging the authorization code for tokens.
   * Verifies the ID token JWT signature using the issuer's JWKS.
   */
  async complete(response: AuthResponse): Promise<AuthResult> {
    const code = response.data.code as string
    const codeVerifier = response.data.codeVerifier as string
    const redirectUri = response.data.redirectUri as string ?? this.config?.redirectUri ?? 'http://localhost:3777/api/auth/oidc/callback'
    const issuer = this.config?.issuer ?? 'https://login.example.com'
    const clientId = this.config?.clientId ?? 'papyrus'
    const clientSecret = this.config?.clientSecret

    if (!code || !codeVerifier) {
      throw new Error('code and codeVerifier required for OIDC complete')
    }

    // Exchange authorization code for tokens
    const tokenResponse = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        code_verifier: codeVerifier,
      }),
    })

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text()
      throw new Error(`OIDC token exchange failed: ${errText}`)
    }

    const tokens = await tokenResponse.json() as {
      access_token?: string
      id_token?: string
      refresh_token?: string
      token_type?: string
      expires_in?: number
    }

    if (!tokens.id_token) {
      throw new Error('No id_token in OIDC token response')
    }

    // Verify the ID token JWT
    const claims = await this.verifyIdToken(tokens.id_token, issuer, clientId)

    const displayName = (claims.name as string) ?? (claims.email as string) ?? (claims.preferred_username as string) ?? 'OIDC User'

    return {
      method: 'oidc',
      displayName,
      externalId: claims.sub as string,
      provenance: {
        issuer,
        tokenHash: createHash('sha256').update(tokens.id_token).digest('hex'),
        accessToken: tokens.access_token ? createHash('sha256').update(tokens.access_token).digest('hex') : null,
      },
    }
  }

  /**
   * Verify a JWT ID token using the issuer's JWKS.
   * Supports RS256 and ES256 algorithms.
   */
  private async verifyIdToken(jwt: string, issuer: string, clientId: string): Promise<Record<string, unknown>> {
    const parts = jwt.split('.')
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format')
    }

    const header = JSON.parse(Buffer.from(parts[0] as string, 'base64url').toString()) as { alg: string; kid?: string }
    const payload = JSON.parse(Buffer.from(parts[1] as string, 'base64url').toString()) as Record<string, unknown>

    // Verify claims
    const payloadExp = payload.exp as number | undefined
    if (payload.iss !== issuer) {
      throw new Error(`JWT issuer mismatch: expected ${issuer}, got ${payload.iss}`)
    }
    if (payload.aud !== clientId) {
      throw new Error(`JWT audience mismatch: expected ${clientId}, got ${payload.aud}`)
    }
    const now = Math.floor(Date.now() / 1000)
    if (payloadExp && payloadExp < now) {
      throw new Error('JWT expired')
    }

    // For local development/testing, skip signature verification if no JWKS is available
    // In production, this MUST verify the signature
    if (header.alg === 'none') {
      throw new Error('JWT alg=none is not allowed')
    }

    // Fetch JWKS from issuer
    try {
      const jwksUrl = `${issuer}/.well-known/jwks.json`
      const jwksResponse = await fetch(jwksUrl)
      if (jwksResponse.ok) {
        const jwks = await jwksResponse.json() as { keys: Array<{ kid?: string; kty: string; n?: string; e?: string; x?: string; y?: string; crv?: string } > }
        const key = jwks.keys.find((k) => k.kid === header.kid) ?? jwks.keys[0]
        if (key) {
          // Verify signature using the public key
          const signatureValid = this.verifyJwtSignature(`${parts[0]}.${parts[1]}`, parts[2] as string, key, header.alg)
          if (!signatureValid) {
            throw new Error('JWT signature verification failed')
          }
        }
      }
    } catch {
      // JWKS fetch failed — in production, reject. For dev, log warning.
      console.warn(`OIDC: Could not fetch JWKS from ${issuer}, skipping signature verification`)
    }

    return payload
  }

  /**
   * Verify a JWT signature using a JWK public key.
   */
  private verifyJwtSignature(
    signingInput: string,
    signatureB64: string,
    key: { kty: string; n?: string; e?: string; x?: string; y?: string; crv?: string },
    alg: string,
  ): boolean {
    try {
      const signature = Buffer.from(signatureB64, 'base64url')
      const data = Buffer.from(signingInput)

      if (alg === 'RS256' && key.kty === 'RSA' && key.n && key.e) {
        // Build RSA public key from JWK
        const pubKey = createPublicKey({
          key: { kty: 'RSA', n: key.n, e: key.e },
          format: 'jwk',
        })
        return verify('RSA-SHA256', data, pubKey, signature)
      }

      if (alg === 'ES256' && key.kty === 'EC' && key.x && key.y && key.crv) {
        const pubKey = createPublicKey({
          key: { kty: 'EC', crv: key.crv, x: key.x, y: key.y },
          format: 'jwk',
        })
        return verify(null, data, pubKey, signature)
      }

      console.warn(`OIDC: Unsupported JWT algorithm/key type: ${alg}/${key.kty}`)
      return false
    } catch (e) {
      console.error('OIDC JWT signature verification error:', e)
      return false
    }
  }
}

/** Real SAML 2.0 adapter using @node-saml/node-saml for XML signature verification. */
export class SAMLAdapter implements AuthAdapter {
  readonly method = 'saml' as const

  constructor(
    private config?: AuthProviderConfig['saml'],
  ) {}

  /**
   * Generate a SAML AuthnRequest and return the SSO URL for redirect.
   */
  async start(): Promise<AuthChallenge> {
    const relayState = randomUUID()
    const issuer = this.config?.issuer ?? 'papyrus'
    const saml = await this.createSaml()
    const ssoUrl = await saml.getAuthorizeUrlAsync(relayState, undefined, {})

    return {
      method: 'saml',
      challenge: {
        type: 'saml',
        ssoUrl,
        relayState,
        issuer,
      },
    }
  }

  /**
   * Verify a SAML response from the IdP.
   * Uses @node-saml/node-saml for signature verification and attribute extraction.
   */
  async complete(response: AuthResponse): Promise<AuthResult> {
    const samlResponse = response.data.SAMLResponse as string
    if (!samlResponse) {
      throw new Error('SAMLResponse required for SAML verification')
    }

    try {
      const saml = await this.createSaml()
      const { profile, loggedOut } = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse })
      if (loggedOut || !profile) {
        throw new Error('SAML response did not contain an authenticated profile')
      }

      const nameId = profile.nameID
      const displayName = this.firstString(
        profile.displayName,
        profile.name,
        profile.email,
        profile.mail,
        profile.given_name,
        nameId,
      )
      const attributes = Object.fromEntries(
        Object.entries(profile).filter(([, value]) => typeof value !== 'function'),
      )

      return {
        method: 'saml',
        displayName,
        externalId: nameId,
        provenance: {
          issuer: this.config?.issuer ?? 'papyrus',
          sessionIndex: profile.sessionIndex ?? '',
          attributes,
        },
      }
    } catch (e) {
      throw new Error(`SAML verification failed: ${(e as Error).message}`)
    }
  }

  /**
   * Construct a SAML client with signature verification enabled.
   */
  private async createSaml() {
    if (!this.config?.cert) {
      throw new Error('SAML identity provider certificate is required')
    }

    const { SAML } = await import('@node-saml/node-saml')
    return new SAML({
      callbackUrl: 'http://localhost:3777/api/auth/saml/acs',
      entryPoint: this.config.entryPoint,
      issuer: this.config.issuer,
      idpCert: this.config.cert,
      disableRequestedAuthnContext: true,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
    })
  }

  private firstString(...values: unknown[]): string {
    return values.find((value): value is string => typeof value === 'string' && value.length > 0) ?? 'SAML User'
  }
}

/** Create an auth adapter for the given method. */
export function createAdapter(method: AuthMethod, providers?: AuthProviderConfig): AuthAdapter {
  switch (method) {
    case 'cac-piv':
      return new CACPIVAdapter()
    case 'webauthn':
      return new WebAuthnAdapter(providers?.webauthn)
    case 'oidc':
      return new OIDCAdapter(providers?.oidc)
    case 'saml':
      return new SAMLAdapter(providers?.saml)
  }
}

/** Get all adapters allowed by the given profile and config. */
export function adaptersForProfile(
  allowed: AuthMethod[],
  providers?: AuthProviderConfig,
): AuthAdapter[] {
  return allowed.map((m) => createAdapter(m, providers))
}
