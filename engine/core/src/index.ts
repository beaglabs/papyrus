// @papyrus/core — shared domain types.

// Design tokens
export { tokens } from './design/tokens.js'
export type { DesignTokens } from './design/tokens.js'

// Profiles & config (single source of truth for NetworkProfile, AuthMethod, PapyrusConfig, etc.)
export {
  type NetworkProfile,
  type AuthMethod,
  type LLMConfig,
  type PapyrusConfig,
  type AuthProviderConfig,
  type CACPIVConfig,
  type WebAuthnConfig,
  type OIDCConfig,
  type SAMLConfig,
  type Env,
  PROFILE_ENV_VAR,
  authMethodsFor,
  resolveProfile,
} from './profiles/config.js'

export { defaultConfig } from './profiles/defaults.js'

// Node registry & catalog
export type {
  NodeTypeSpec,
  FieldSpec,
  FieldType,
  FlowRole,
  NodeCategory,
  CanvasNodeDoc,
  EdgeDoc,
} from './nodes/types.js'
export {
  getNodeType,
  listNodeTypes,
  nodeTypesForProfile,
  isReviewable,
  validateFields,
  newNode,
} from './nodes/registry.js'
export { AI_SKILL_NODE, AI_SKILLS } from './nodes/catalog/ai-skill.js'
export type { SkillSpec } from './nodes/catalog/ai-skill.js'

// Auth & identity (re-exports NetworkProfile/AuthMethod from profiles — do NOT use export * here)
export type {
  AuthResult,
  MemberIdentity,
  AttestationRecord,
  LicensePayload,
  LicenseFile,
  LicenseStatus,
  StoredLicense,
  DeploymentIdentity,
  AuthAdapter,
  AuthChallenge,
  AuthResponse,
} from './auth/types.js'

export {
  generateMemberIdentity,
  loadOrGenerateMemberIdentity,
  loadMemberIdentity,
  hasMemberIdentity,
  fingerprint,
  publicKeyFromPrivate,
} from './auth/keygen.js'

export {
  signLicense,
  verifyLicenseSignature,
  validateLicense,
  loadStoredLicense,
  storeLicense,
  canonicalLicenseJson,
} from './auth/license.js'

export { deploymentFingerprint, loadOrGenerateDeploymentIdentity } from './auth/deployment-identity.js'

export { createAdapter, adaptersForProfile, WebAuthnAdapter, OIDCAdapter, CACPIVAdapter, SAMLAdapter } from './auth/adapter.js'

// Sync protocol (browser-safe)
export type { PresenceInfo, ServerMsg, ClientMsg } from './sync/protocol.js'
export { PRESENCE_COLORS } from './sync/protocol.js'

// Config loader (Node-only — not safe for browser imports)
export {
  resolveConfig,
  loadConfigFile,
  resolveConfigPath,
  CONFIG_ENV,
  validateConfig,
} from './config/loader.js'
