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
  roles: Role[]
  authMethod: 'oidc' | 'mtls' | 'development'
}

export interface Workspace {
  id: string
  name: string
  description: string
  createdAt: string
}

export interface Session {
  id: string
  ownerId: string
  workspaceId: string
  agent: string
  title: string
  status: 'ready' | 'running' | 'stopped' | 'failed'
  createdAt: string
  updatedAt: string
}

export interface McpServer {
  id: string
  name: string
  transport: 'http'
  endpoint: string
  enabled: boolean
  createdAt: string
}

export interface ToolGrant {
  id: string
  workspaceId: string
  mcpServerId: string
  toolName: string
  effect: 'allow'
  createdAt: string
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
