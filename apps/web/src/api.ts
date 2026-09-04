import type {
  AgentActionProposal,
  AgentActionReceipt,
  IntegrationCatalogEntry,
  IntegrationConfiguration,
  IntegrationEvent,
  PortalOverview,
  PortalPrincipal,
  SyncJob,
  ModelProfile,
} from '@papyrus/contracts'
import type { UIMessage } from 'ai'

export interface PublicConfig {
  organizationName: string
  profile: string
  cloud: 'Public' | 'USGov' | 'USGovDoD'
  entraConfigured: boolean
  developmentIdentity: boolean
  loginUrl: string
}

export interface PortalData {
  config: PublicConfig
  me: PortalPrincipal
  overview: PortalOverview
  catalog: IntegrationCatalogEntry[]
  integrations: IntegrationConfiguration[]
  agent: AgentStatus
  sessions: AgentSession[]
  schedules: AgentSchedule[]
  workflows: WorkflowSummary[]
  models: ModelProfile[]
}

export interface AgentStatus {
  ready: boolean
  agentReady: boolean
  durable: boolean
  model: string | null
  mode: 'starlings' | 'centralized'
  workspace?: {
    filesystem: 'agentfs-sdk'
    storage: 'local-sqlite'
    programmableRuntime: 'enclave-strict'
    processSandbox: 'nono-ts'
    isolation: 'landlock' | 'seatbelt' | 'unsupported'
    network: 'blocked'
    rawShell: false
  }
  signalBacklog: Record<'pending' | 'delivering' | 'delivered' | 'failed', number>
}

export interface WorkspaceLibraryFile {
  path: string
  name: string
  mediaType: string
  size: number
  sha256?: string
  updatedAt: string
  source: 'library' | 'upload'
}

export interface AgentSession {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  attention: boolean
  kind: 'operator_session' | 'signal_session' | string
}

export interface AgentSchedule {
  id: string
  name?: string
  cron: string
  prompt: string
  timezone?: string
  threadId?: string
  status: 'active' | 'paused'
  nextFireAt: number
  lastFireAt?: number
}

export interface WorkflowSummary {
  id: string
  name: string
  description: string
  trigger: string
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export class AuthenticationRequired extends ApiError {
  constructor() { super(401, 'ENTRA_AUTHENTICATION_REQUIRED', 'Microsoft Entra authentication is required') }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  const result = await response.json().catch(() => null) as T | { error?: string; code?: string }
  if (!response.ok) {
    if (response.status === 401) throw new AuthenticationRequired()
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : `Request failed (${response.status})`
    const code = result && typeof result === 'object' && 'code' in result && typeof result.code === 'string' ? result.code : 'REQUEST_FAILED'
    throw new ApiError(response.status, code, message)
  }
  return result as T
}

export async function loadPortal(): Promise<PortalData> {
  const config = await api<PublicConfig>('/api/config/public')
  const [me, overview, plugins, agent, sessions, schedules, workflows, models] = await Promise.all([
    api<PortalPrincipal>('/api/me'),
    api<PortalOverview>('/api/portal/overview'),
    api<{ catalog: IntegrationCatalogEntry[]; configured: IntegrationConfiguration[] }>('/api/plugins'),
    api<AgentStatus>('/api/agent/status'),
    api<{ sessions: AgentSession[] }>('/api/sessions'),
    api<{ schedules: AgentSchedule[] }>('/api/schedules'),
    api<{ workflows: WorkflowSummary[] }>('/api/workflows'),
    api<{ profiles: ModelProfile[] }>('/api/model-profiles'),
  ])
  return { config, me, overview, catalog: plugins.catalog, integrations: plugins.configured, agent, sessions: sessions.sessions, schedules: schedules.schedules, workflows: workflows.workflows, models: models.profiles }
}

export async function publicConfig(): Promise<PublicConfig> { return api('/api/config/public') }

export async function createIntegration(input: {
  catalogId: string
  name: string
  endpoint?: string
  scope?: string
  credentialRef?: string
  settings: Record<string, string | number | boolean>
}): Promise<IntegrationConfiguration> {
  return api('/api/integrations', { method: 'POST', body: JSON.stringify(input) })
}

export async function connectPlugin(input: Parameters<typeof createIntegration>[0]): Promise<{ plugin: IntegrationConfiguration; notice?: string }> {
  return api('/api/plugins/connect', { method: 'POST', body: JSON.stringify(input) })
}

export async function createSession(title = 'New session'): Promise<AgentSession> {
  return api('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) })
}

export async function deleteSession(id: string): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function sessionMessages(id: string): Promise<UIMessage[]> {
  return (await api<{ messages: UIMessage[] }>(`/api/sessions/${encodeURIComponent(id)}/messages`)).messages
}

export async function setSessionAttention(id: string, attention: boolean): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(id)}/attention`, { method: 'POST', body: JSON.stringify({ attention }) })
}

export async function createSessionProposal(id: string, input: {
  executorIntegrationId: string
  action: string
  target: string
  rationaleClaimIds?: string[]
  parameters?: Record<string, unknown>
}): Promise<AgentActionProposal> {
  return api(`/api/sessions/${encodeURIComponent(id)}/proposals`, { method: 'POST', body: JSON.stringify(input) })
}

export async function approveSkill(id: string): Promise<unknown> {
  return api(`/api/skills/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' })
}

export async function workspaceFiles(query = ''): Promise<WorkspaceLibraryFile[]> {
  const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''
  return (await api<{ files: WorkspaceLibraryFile[] }>(`/api/workspace/files${suffix}`)).files
}

export async function uploadWorkspaceAttachment(input: {
  name: string
  mediaType?: string
  dataBase64: string
}): Promise<WorkspaceLibraryFile> {
  return (await api<{ file: WorkspaceLibraryFile }>('/api/workspace/attachments', {
    method: 'POST',
    body: JSON.stringify(input),
  })).file
}

export function workspaceFileContentUrl(path: string, download = false): string {
  return `/api/workspace/files/content?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`
}

export async function createSchedule(input: { name: string; cron: string; prompt: string; timezone?: string; threadId: string }): Promise<AgentSchedule> {
  return api('/api/schedules', { method: 'POST', body: JSON.stringify(input) })
}

export async function deleteSchedule(id: string): Promise<void> {
  await api(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function runWorkflow(id: string, input: Record<string, unknown>): Promise<unknown> {
  return api(`/api/workflows/${encodeURIComponent(id)}/runs`, { method: 'POST', body: JSON.stringify(input) })
}

export async function createModelProfile(input: Record<string, unknown>): Promise<ModelProfile> {
  return (await api<{ profile: ModelProfile }>('/api/model-profiles', { method: 'POST', body: JSON.stringify(input) })).profile
}

export async function testModelProfile(id: string): Promise<ModelProfile> {
  return (await api<{ profile: ModelProfile }>(`/api/model-profiles/${encodeURIComponent(id)}?action=test`, { method: 'POST', body: '{}' })).profile
}

export async function setDefaultModelProfile(id: string): Promise<ModelProfile> {
  return (await api<{ profile: ModelProfile }>(`/api/model-profiles/${encodeURIComponent(id)}?action=default`, { method: 'POST', body: '{}' })).profile
}

export async function disableModelProfile(id: string): Promise<ModelProfile> {
  return (await api<{ profile: ModelProfile }>(`/api/model-profiles/${encodeURIComponent(id)}?action=disable`, { method: 'POST', body: '{}' })).profile
}

export async function deleteModelProfile(id: string): Promise<void> {
  await api(`/api/model-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function transitionIntegration(id: string, action: 'test' | 'submit' | 'activate' | 'disable', reason?: string): Promise<IntegrationConfiguration> {
  return api(`/api/integrations/${encodeURIComponent(id)}/${action}`, {
    method: 'POST', body: JSON.stringify(reason ? { reason } : {}),
  })
}

export async function deleteIntegration(id: string): Promise<void> {
  await api(`/api/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function issueIngestionToken(id: string): Promise<{ token: string; expiresAt: string }> {
  return api(`/api/integrations/${encodeURIComponent(id)}/ingestion-token`, { method: 'POST', body: '{}' })
}

export async function integrationEvents(id: string): Promise<IntegrationEvent[]> {
  return (await api<{ events: IntegrationEvent[] }>(`/api/integrations/${encodeURIComponent(id)}/events`)).events
}

export async function requestIntegrationSync(id: string): Promise<SyncJob> {
  return api(`/api/integrations/${encodeURIComponent(id)}/sync`, { method: 'POST', body: '{}' })
}

export async function logout(): Promise<void> { await api('/api/auth/logout', { method: 'POST', body: '{}' }) }

export async function approveProposal(id: string): Promise<AgentActionProposal> {
  return api(`/api/proposals/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' })
}

export async function denyProposal(id: string, reason?: string): Promise<AgentActionProposal> {
  return api(`/api/proposals/${encodeURIComponent(id)}/deny`, { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) })
}

export async function listReceipts(): Promise<AgentActionReceipt[]> {
  return (await api<{ receipts: AgentActionReceipt[] }>('/api/receipts')).receipts
}
