export const ROLES = ['Owner', 'Admin', 'User', 'Auditor'] as const
export type Role = (typeof ROLES)[number]

export const PROFILES = ['commercial', 'government-il4', 'government-il6', 'gcc', 'gcch', 'dod', 'restricted', 'disconnected'] as const
export type DeploymentProfile = (typeof PROFILES)[number]
export type ServerMode = 'local' | 'persistent'

export interface Principal {
  id: string
  externalId: string
  displayName: string
  email?: string
  pictureUrl?: string
  roles: Role[]
  authMethod: 'oidc' | 'mtls'
}

export const GOVERNMENT_IDENTITY_KINDS = ['edipi', 'upn', 'piv_uuid', 'fasc_n', 'issuer_subject'] as const
export const INVITATION_IDENTITY_KINDS = ['email', ...GOVERNMENT_IDENTITY_KINDS] as const
export type GovernmentIdentityKind = (typeof GOVERNMENT_IDENTITY_KINDS)[number]
export type InvitationIdentityKind = (typeof INVITATION_IDENTITY_KINDS)[number]

export interface Invitation {
  id: string
  identityKind: InvitationIdentityKind
  identityValue: string
  displayName: string
  email?: string
  role: Role
  authMethod: 'oidc' | 'mtls'
  status: 'pending' | 'accepted' | 'cancelled' | 'expired'
  invitedBy: string
  acceptedBy?: string
  createdAt: string
  expiresAt: string
  acceptedAt?: string
  cancelledAt?: string
}

export interface Environment {
  id: string
  name: string
  description: string
  createdAt: string
}

export const SESSION_SURFACES = ['general', 'ide', 'research', 'document', 'data'] as const
export type SessionSurface = (typeof SESSION_SURFACES)[number]

export interface SessionConfigOption {
  id: 'papyrus.surface'
  name: string
  description: string
  category: '_papyrus_surface'
  type: 'select'
  currentValue: SessionSurface
  options: Array<{ value: SessionSurface; name: string; description: string }>
}

export interface Session {
  id: string
  ownerId: string
  environmentId: string
  agent: string
  title: string
  cwd: string
  surface: SessionSurface
  status: 'ready' | 'running' | 'stopped' | 'failed' | 'interrupted'
  createdAt: string
  updatedAt: string
}

export interface SessionRun {
  id: string
  sessionId: string
  actorId: string
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  stopReason?: string
  error?: string
  startedAt: string
  completedAt?: string
}

export interface SessionEvent {
  sequence: number
  sessionId: string
  runId?: string
  kind: string
  occurredAt: string
  data: unknown
}

export interface Artifact {
  id: string
  sessionId: string
  runId?: string
  name: string
  kind: 'resource' | 'diff'
  mediaType: string
  version: number
  sequence: number
  createdAt: string
  downloadUrl: string
}

export interface Attachment {
  id: string
  sessionId: string
  name: string
  mediaType: string
  size: number
  sha256: string
  createdAt: string
  downloadUrl: string
}

export interface Approval {
  id: string
  sessionId: string
  runId: string
  requesterId: string
  toolTitle: string
  status: 'pending' | 'approved' | 'denied' | 'cancelled'
  requestedAt: string
  decidedAt?: string
  decidedBy?: string
  reason?: string
}

export interface Elicitation {
  id: string
  sessionId: string
  runId: string
  status: 'pending' | 'accepted' | 'declined' | 'cancelled'
  request: Record<string, unknown>
  response?: Record<string, unknown>
  requestedAt: string
  respondedAt?: string
}

export interface ResearchSource {
  id: string
  sessionId: string
  runId?: string
  title: string
  url: string
  host: string
  excerpt?: string
  preview?: string
  previewMediaType?: string
  sequence: number
  capturedAt: string
}

export const APPROVED_SOURCE_KINDS = ['upload', 'directory', 'domain', 'mcp', 'package', 'api'] as const
export type ApprovedSourceKind = (typeof APPROVED_SOURCE_KINDS)[number]

export interface ApprovedSource {
  id: string
  name: string
  kind: ApprovedSourceKind
  locator: string
  mode: 'snapshot' | 'live'
  status: 'ready' | 'indexing' | 'error'
  assignedUserIds: string[]
  documentCount: number
  createdAt: string
  updatedAt: string
}

export interface SourceCitation {
  sourceId: string
  sourceName: string
  uri: string
  title: string
  location?: string
  sha256: string
}

export interface SourceSearchResult {
  chunkId: string
  content: string
  score: number
  citation: SourceCitation
}

export type McpOauthRegistrationMethod = 'preregistered' | 'cimd' | 'dcr'

export interface McpOauthClient {
  issuer: string
  clientId: string
  hasClientSecret: boolean
  scopes?: string
  registrationMethod: McpOauthRegistrationMethod
  metadataUrl?: string
  createdAt: string
  updatedAt: string
}

export interface McpServer {
  id: string
  name: string
  transport: 'http'
  endpoint: string
  enabled: boolean
  oauthStatus: 'not_required' | 'configuration_required' | 'authorization_required' | 'connected' | 'error'
  oauthIssuer?: string
  oauthError?: string
  oauthRegistrationMethod?: McpOauthRegistrationMethod
  oauthScope?: string
  createdAt: string
}

export interface ToolGrant {
  id: string
  environmentId: string
  mcpServerId: string
  effect: 'allow'
  createdAt: string
}

export interface AdminEnvironment extends Environment {
  assignedUserIds: string[]
}

export interface AdminOverview {
  deployment: {
    topology: 'on-premises'
    profile: DeploymentProfile
    publicOrigin: string
    authentication: 'oidc' | 'mtls' | 'trusted-proxy' | 'none'
    organizationName: string
    organizationDomain?: string
    mtlsConfigured: boolean
    identityProxyConfigured: boolean
    gatewayConfigured: boolean
    licenseRequired: boolean
  }
  users: Principal[]
  invitations: Invitation[]
  environments: AdminEnvironment[]
  sources: ApprovedSource[]
  mcpServers: McpServer[]
  mcpOauthClients: McpOauthClient[]
  toolGrants: ToolGrant[]
  license: LicenseStatus
}

export interface AuditEvent {
  sequence: number
  id: string
  occurredAt: string
  actorId: string | null
  action: string
  resourceType: string
  resourceId: string
  decision: 'allow' | 'deny' | 'info'
  policyVersion: string
  metadata: Record<string, unknown>
  previousHash: string
  hash: string
}

export interface LicensePayload {
  licenseId: string
  licensee: string
  deploymentId: string
  profiles: DeploymentProfile[]
  features: string[]
  issuedAt: string
  expiresAt: string | null
}

export interface SignedLicense extends LicensePayload {
  signature: string
  keyId: string
}

export interface LicenseStatus {
  valid: boolean
  deploymentId: string
  license?: Omit<SignedLicense, 'signature'>
  reason?: string
}

export interface ActivitySummary {
  sessions: number
  prompts: number
  toolCalls: number
  deniedActions: number
}

export interface ApiError {
  error: string
  code: string
  requestId: string
}

/**
 * Agent-twin contracts intentionally live beside the legacy ACP contracts
 * while the experiment branch proves the replacement runtime. The daemon
 * entrypoint and portal consume only these contracts; they do not create
 * Papyrus users, invitations, workspaces, or sessions.
 */
export const ENTRA_APP_ROLES = [
  'Papyrus.Integration.View',
  'Papyrus.Integration.Manage',
  'Papyrus.Security.Manage',
  'Papyrus.Action.Approve',
  'Papyrus.Audit.View',
  'Papyrus.System.Owner',
] as const
export type EntraAppRole = (typeof ENTRA_APP_ROLES)[number]

export interface PortalPrincipal {
  oid: string
  tenantId: string
  displayName: string
  preferredUsername?: string
  roles: EntraAppRole[]
  groups: string[]
  source: 'entra' | 'teams-sso' | 'development'
}

export const INTEGRATION_CLASSES = [
  'human_interface',
  'evidence_source',
  'terrain_source',
  'action_executor',
  'agent_peer',
  'infrastructure',
] as const
export type IntegrationClass = (typeof INTEGRATION_CLASSES)[number]

export const INTEGRATION_STATES = [
  'draft',
  'tested',
  'awaiting_approval',
  'active',
  'degraded',
  'disabled',
] as const
export type IntegrationState = (typeof INTEGRATION_STATES)[number]
export type IntegrationAuthority = 'read_only' | 'bidirectional' | 'controlled_actions'
export type IntegrationRisk = 'low' | 'moderate' | 'high' | 'critical'

export interface ObservationSchemaProfile {
  id: string
  label: string
  description: string
  evidenceType: string
  example: Record<string, unknown>
  canonicalExample?: {
    evidenceType: string
    subject: string
    terrain: {
      entities: TerrainEntityInput[]
      relationships?: TerrainRelationshipInput[]
    }
  }
}

export interface ObservationProtocolProfile {
  acceptsCanonicalTerrain: boolean
  schemas: ObservationSchemaProfile[]
}

export interface IntegrationCatalogEntry {
  id: string
  name: string
  vendor: string
  description: string
  integrationClass: IntegrationClass
  authority: IntegrationAuthority
  risk: IntegrationRisk
  capabilities: string[]
  evidenceTypes: string[]
  syncMode: 'none' | 'pull' | 'push' | 'hybrid'
  observationProtocol?: ObservationProtocolProfile
  authSchemes: Array<'entra' | 'certificate' | 'managed_identity' | 'oauth' | 'mTLS' | 'vault_reference' | 'none'>
  supportedProfiles: DeploymentProfile[]
  licenseFeature: string
  accent: string
  initials: string
}

export interface IntegrationConfiguration {
  id: string
  catalogId: string
  name: string
  integrationClass: IntegrationClass
  authority: IntegrationAuthority
  risk: IntegrationRisk
  state: IntegrationState
  endpoint?: string
  scope: string
  credentialRef?: string
  settings: Record<string, string | number | boolean>
  health: 'unknown' | 'healthy' | 'degraded' | 'unreachable'
  lastEvidenceAt?: string
  lastSyncAt?: string
  lastSyncError?: string
  lastTestedAt?: string
  createdByOid: string
  createdAt: string
  updatedAt: string
  version: number
}

export const MODEL_GATEWAY_KINDS = ['openai-compatible', 'azure-openai', 'ollama', 'custom'] as const
export type ModelGatewayKind = (typeof MODEL_GATEWAY_KINDS)[number]
export const MODEL_AUTH_SCHEMES = ['none', 'api_key', 'entra', 'credential_ref'] as const
export type ModelAuthScheme = (typeof MODEL_AUTH_SCHEMES)[number]
export type ModelProfileState = 'active' | 'disabled' | 'error'

/** Public model configuration metadata. Secret material is never represented here. */
export interface ModelProfile {
  id: string
  name: string
  gatewayKind: ModelGatewayKind
  provider: string
  model: string
  baseUrl: string
  authScheme: ModelAuthScheme
  credentialRef?: string
  scope: string
  capabilities: string[]
  state: ModelProfileState
  isDefault: boolean
  lastTestedAt?: string
  lastTestError?: string
  createdByOid: string
  createdAt: string
  updatedAt: string
  version: number
}

export interface IntegrationEvent {
  sequence: number
  integrationId: string
  actorOid: string
  action: string
  occurredAt: string
  data: Record<string, unknown>
  previousHash: string
  hash: string
}

export interface PortalOverview {
  deployment: {
    profile: DeploymentProfile
    topology: 'customer-hosted'
    identityAuthority: 'Microsoft Entra ID'
    runtime: 'Starlings'
    license: LicenseStatus
  }
  posture: {
    integrations: number
    healthy: number
    degraded: number
    awaitingApproval: number
    evidenceSources: number
    actionExecutors: number
  }
}

export interface AgentObservation {
  id: string
  sourceIntegrationId: string
  sourceRecordId: string
  observedAt: string
  receivedAt: string
  schema?: string
  evidenceType: string
  subject: string
  classification?: string
  payload: Record<string, unknown>
  provenance: { sourceRecordId?: string; sha256: string }
  processedAt?: string
}

export interface TerrainEntityInput {
  externalId: string
  kind: string
  label: string
  attributes?: Record<string, unknown>
  confidence?: number
}

export interface TerrainRelationshipInput {
  externalId?: string
  kind: string
  sourceExternalId: string
  targetExternalId: string
  attributes?: Record<string, unknown>
  confidence?: number
}

export interface ObservationInput {
  sourceRecordId: string
  observedAt: string
  schema?: string
  evidenceType: string
  subject: string
  classification?: string
  payload: Record<string, unknown>
  terrain?: {
    entities: TerrainEntityInput[]
    relationships?: TerrainRelationshipInput[]
  }
}

export interface TerrainEntity {
  id: string
  externalId: string
  kind: string
  label: string
  attributes: Record<string, unknown>
  confidence: number
  firstSeen: string
  lastSeen: string
  sourceIntegrationIds: string[]
  evidenceIds: string[]
}

export interface TerrainRelationship {
  id: string
  externalId: string
  kind: string
  sourceId: string
  targetId: string
  attributes: Record<string, unknown>
  confidence: number
  firstSeen: string
  lastSeen: string
  sourceIntegrationIds: string[]
  evidenceIds: string[]
}

export interface TerrainSnapshot {
  generatedAt: string
  entities: TerrainEntity[]
  relationships: TerrainRelationship[]
  observationCount: number
  unresolvedClaims: number
}

export interface SyncJob {
  id: string
  integrationId: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  attempt: number
  runAfter: string
  lockedBy?: string
  lockedAt?: string
  startedAt?: string
  completedAt?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export interface SyncCheckpoint {
  integrationId: string
  cursor?: string
  updatedAt: string
}

export interface AgentClaim {
  id: string
  operatorId: string
  subject: string
  predicate: string
  object: unknown
  confidence: number
  evidenceIds: string[]
  contradictsClaimIds: string[]
  publishedAt: string
}

export interface AgentInvestigation {
  id: string
  title: string
  trigger: 'email' | 'teams' | 'manual' | 'signal' | 'schedule'
  triggerIntegrationId?: string
  triggerMessageId?: string
  mastraThreadId?: string
  status: 'open' | 'analyzing' | 'action_proposed' | 'awaiting_approval' | 'executing' | 'resolved' | 'abandoned'
  summary?: string
  claimIds: string[]
  proposalIds: string[]
  createdAt: string
  updatedAt: string
}

export interface AgentActionProposal {
  id: string
  investigationId: string
  proposedByOperatorId: string
  executorIntegrationId: string
  action: string
  target: string
  parameters?: Record<string, unknown>
  rationaleClaimIds: string[]
  simulationId?: string
  status: 'proposed' | 'approved' | 'denied' | 'expired' | 'executing' | 'executed' | 'failed'
  requiredRole: 'Papyrus.Action.Approve'
  approvedByOid?: string
  approvedAt?: string
  deniedByOid?: string
  deniedAt?: string
  denialReason?: string
  expiresAt?: string
  idempotencyKey: string
  proposedAt: string
  decidedAt?: string
}

export interface AgentActionJob {
  id: string
  proposalId: string
  investigationId: string
  executorIntegrationId: string
  action: string
  target: string
  parameters?: Record<string, unknown>
  idempotencyKey: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  attempt: number
  maxAttempts: number
  lockedBy?: string
  lockedAt?: string
  leaseExpiresAt?: string
  startedAt?: string
  completedAt?: string
  error?: string
  /** When set, the job must not be claimed until this instant (retry backoff). */
  runAfter?: string
  createdAt: string
  updatedAt: string
}

export interface AgentActionAttempt {
  id: string
  jobId: string
  attempt: number
  workerId: string
  startedAt: string
  completedAt?: string
  success: boolean
  error?: string
  resultJson?: string
}

export interface AgentActionReceipt {
  id: string
  jobId: string
  proposalId: string
  investigationId: string
  executorIntegrationId: string
  action: string
  target: string
  result: 'success' | 'partial' | 'failure'
  message: string
  evidenceObservationId?: string
  executedAt: string
}

export const LINK_TYPES = ['webpage', 'api', 'webhook'] as const
export type LinkType = (typeof LINK_TYPES)[number]
export type LinkState = 'live' | 'disabled' | 'failed'

/**
 * Public-link metadata lives in the Papyrus database, while the content
 * authority remains AgentFS. blobPath always identifies the immutable source
 * snapshot that was approved for publication.
 */
export interface AgentLink {
  id: string
  name: string
  slug: string
  type: LinkType
  state: LinkState
  blobPath: string
  mediaType: string
  sourceSha256: string
  publicPath: string
  workflowId?: string
  scheduleId?: string
  /** Mastra thread/resource target for a session-scoped Link. Required for webhook Links. */
  threadId?: string
  resourceId?: string
  /** Optional immutable webhook identity mark, captured with the approved Link snapshot. */
  logoPath?: string
  logoMediaType?: string
  logoText?: string
  createdByOid: string
  createdAt: string
  updatedAt: string
  lastPingAt?: string
  pingCount: number
  inboundCount: number
  validationProvider?: 'local-static' | 'kitesurf'
  validatedAt?: string
}

export interface LinkInbound {
  id: string
  linkId: string
  blobPath: string
  method: string
  contentType?: string
  receivedAt: string
  size: number
  sha256: string
}

export interface AgentSignal {
  id: string
  type: 'new_claim' | 'contradiction' | 'evidence_threshold' | 'approval_decision' | 'execution_receipt' | 'investigation_created' | 'action_proposed' | 'stale_investigation' | 'posture_review' | 'external_signal'
  investigationId?: string
  proposalId?: string
  claimId?: string
  payload: Record<string, unknown>
  emittedAt: string
}
