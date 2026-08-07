/**
 * Papyrus identity and authentication types.
 *
 * The hybrid identity model:
 *   SIPRNet  → CAC/PIV only (hardware token, mTLS via PKCS#11)
 *   IL4      → CAC/PIV + FIDO2/WebAuthn
 *   Commercial → FIDO2/WebAuthn + OIDC + SAML
 *
 * Every auth method proves an external identity (hardware / IdP). The daemon
 * then binds that proven identity to an Ed25519 *member key* used for
 * p2panda-auth authorization. The attestation record links the two.
 */

// Re-export core profile types so consumers only need to import from auth.
export type { AuthMethod, NetworkProfile, AuthProviderConfig } from '../profiles/config.js'

import type { AuthMethod, NetworkProfile } from '../profiles/config.js'

/** What the adapter returns after a successful authentication. */
export interface AuthResult {
  method: AuthMethod
  /** Human-readable display name (e.g. "John Doe", "jdoe@example.mil"). */
  displayName: string
  /** Opaque external identity (e.g. x509 subject, WebAuthn credential id, OIDC sub). */
  externalId: string
  /** Raw provenance data for the attestation record. */
  provenance: Record<string, unknown>
}

/** A p2panda-auth member keypair (Ed25519). */
export interface MemberIdentity {
  /** Ed25519 public key (hex). This is the member id in p2panda-auth. */
  publicKey: string
  /** Ed25519 private key (hex). Stored at rest; never sent over the wire. */
  privateKey: string
  /** ISO timestamp of key generation. */
  createdAt: string
}

/**
 * An attestation record binding an external identity to a member key.
 * Stored in `~/.papyrus/identity/attestations.json`. Each record is itself a
 * p2panda document candidate (append-only log, auditable).
 */
export interface AttestationRecord {
  id: string
  /** Which auth method proved this identity. */
  method: AuthMethod
  /** The member public key this identity is bound to. */
  memberPublicKey: string
  /** External identity display name. */
  displayName: string
  /** Opaque external id (x509 subject, OIDC sub, etc.). */
  externalId: string
  /** ISO timestamp of attestation. */
  attestedAt: string
  /** Method-specific provenance (cert chain hash, OIDC issuer, etc.). */
  provenance: Record<string, unknown>
}

/** Offline license data (unsigned payload). */
export interface LicensePayload {
  licenseId: string
  licensee: string
  profile: NetworkProfile
  features: { agents: boolean; crossDomainExport: boolean }
  nodeLimit: number
  /** null = perpetual; ISO date = expiry. */
  expiresAt: string | null
  issuedAt: string
}

/** A signed license file. */
export interface LicenseFile extends LicensePayload {
  /** Ed25519 public key of the signing authority (base64). */
  publicKey: string
  /** Ed25519 signature over canonical JSON of LicensePayload (base64). */
  signature: string
}

/** The result of license validation. */
export interface LicenseStatus {
  valid: boolean
  profile: NetworkProfile
  licensee: string
  features: LicensePayload['features']
  nodeLimit: number
  expiresAt: string | null
  /** Human-readable reason if invalid. */
  reason?: string
}

/** Stored license state on disk (`~/.papyrus/license.json`). */
export interface StoredLicense {
  license: LicenseFile
  activatedAt: string
}

/**
 * The auth adapter interface. Each auth method implements this.
 * Mock implementations live in `./adapter.mock.ts`; the real implementations
 * will call into PKCS#11 (CAC/PIV), WebAuthn server SDK, OIDC library, etc.
 */
export interface AuthAdapter {
  readonly method: AuthMethod
  /** Start an authentication flow (returns challenge / redirect URL). */
  start(): Promise<AuthChallenge>
  /** Complete an authentication flow with the client response. */
  complete(response: AuthResponse): Promise<AuthResult>
}

/** A challenge issued by an auth adapter to the client. */
export interface AuthChallenge {
  method: AuthMethod
  challenge: Record<string, unknown>
}

/** A client response to an auth challenge. */
export interface AuthResponse {
  method: AuthMethod
  data: Record<string, unknown>
}
