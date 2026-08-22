export const ROLES = ['Owner', 'Admin', 'User', 'Auditor'] as const
export type Role = (typeof ROLES)[number]

export const PROFILES = ['commercial', 'government-il4', 'government-il6'] as const
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

export interface McpServer {
  id: string
  name: string
  transport: 'http'
  endpoint: string
  enabled: boolean
  oauthStatus: 'not_required' | 'authorization_required' | 'connected' | 'error'
  oauthIssuer?: string
  oauthError?: string
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
  mcpServers: McpServer[]
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
