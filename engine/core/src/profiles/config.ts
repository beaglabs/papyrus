/**
 * Network-profile-driven configuration.
 *
 * `PAPYRUS_PROFILE` (or a config file) selects one of three environments. The
 * profile gates which auth methods are offered, which LLM endpoint is used,
 * what sync is permitted, and which features are enabled. This is the single
 * switch the auth UI and the daemon read to enforce "CAC/PIV only on SIPRNet,
 * FIDO2/WebAuthn only on commercial".
 */
export type NetworkProfile = 'commercial' | 'niprnet-il4' | 'siprnet-il6'

export type AuthMethod = 'cac-piv' | 'webauthn' | 'oidc' | 'saml'

export interface LLMConfig {
  /** OpenAI-compatible base URL (on-prem model server for IL6). */
  endpoint: string
  model: string
  /** Name of the env var holding the key — never the key itself. */
  apiKeyEnv?: string
}

/** Adapter-specific config per auth method. */
export interface CACPIVConfig {
  caBundle?: string
}

export interface WebAuthnConfig {
  rpName: string
  rpId: string
  origin: string
}

export interface OIDCConfig {
  issuer: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
}

export interface SAMLConfig {
  entryPoint: string
  issuer: string
  cert: string
}

export interface AuthProviderConfig {
  cacPiv?: CACPIVConfig
  webauthn?: WebAuthnConfig
  oidc?: OIDCConfig
  saml?: SAMLConfig
}

export interface PapyrusConfig {
  profile: NetworkProfile
  auth: { allowed: AuthMethod[]; providers: AuthProviderConfig }
  llm: LLMConfig | null
  sync: { peers: string[]; allowInternet: boolean }
  features: { agents: boolean; crossDomainExport: boolean }
}

export const PROFILE_ENV_VAR = 'PAPYRUS_PROFILE'

/** Generic env shape so `core` stays free of Node-specific types (it runs in the browser too). */
export type Env = Record<string, string | undefined>

export function authMethodsFor(profile: NetworkProfile): AuthMethod[] {
  switch (profile) {
    case 'siprnet-il6':
      return ['cac-piv']
    case 'niprnet-il4':
      return ['cac-piv', 'webauthn']
    case 'commercial':
      return ['webauthn', 'oidc', 'saml']
  }
}

export function resolveProfile(env: Env): NetworkProfile {
  const raw = env[PROFILE_ENV_VAR]?.toLowerCase()
  if (raw === 'siprnet-il6' || raw === 'siprnet' || raw === 'il6') return 'siprnet-il6'
  if (raw === 'niprnet-il4' || raw === 'niprnet' || raw === 'il4') return 'niprnet-il4'
  return 'commercial'
}
