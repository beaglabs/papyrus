import type {
  AgentActionProposal,
  AgentActionReceipt,
  AgentLink,
  LinkInbound,
  PortalOverview,
  PortalPrincipal,
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
  agent: AgentStatus
  sessions: AgentSession[]
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
  links?: { validation: 'local-static' | 'kitesurf' }
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

export type ObservabilityTraceStatus = 'success' | 'error' | 'running'
export type ObservabilityLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface ObservabilityPagination {
  total: number
  page: number
  perPage: number
  hasMore: boolean
}

export interface ObservabilityStorageInfo {
  provider: 'libsql'
  database: string
}

export interface ObservabilitySpan {
  [key: string]: unknown
  traceId: string
  spanId: string
  parentSpanId?: string | null
  name: string
  spanType: string
  isEvent?: boolean
  startedAt: string
  endedAt?: string | null
  error?: unknown
  status?: ObservabilityTraceStatus
  entityType?: string | null
  entityId?: string | null
  entityName?: string | null
  input?: unknown
  output?: unknown
  attributes?: Record<string, unknown> | null
  metadata?: Record<string, unknown> | null
}

export interface ObservabilityLogRecord {
  [key: string]: unknown
  logId?: string | null
  timestamp: string
  level: ObservabilityLogLevel
  message: string
  data?: Record<string, unknown> | null
  traceId?: string | null
  spanId?: string | null
  entityType?: string | null
  entityId?: string | null
  entityName?: string | null
  metadata?: Record<string, unknown> | null
}

export interface ObservabilityTraceList {
  storage: ObservabilityStorageInfo
  pagination: ObservabilityPagination
  traces: ObservabilitySpan[]
}

export interface ObservabilityTraceDetail {
  storage: ObservabilityStorageInfo
  traceId: string
  spans: ObservabilitySpan[]
}

export interface ObservabilityLogList {
  storage: ObservabilityStorageInfo
  pagination: ObservabilityPagination
  logs: ObservabilityLogRecord[]
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
  const [me, overview, agent, sessions, models] = await Promise.all([
    api<PortalPrincipal>('/api/me'),
    api<PortalOverview>('/api/portal/overview'),
    api<AgentStatus>('/api/agent/status'),
    api<{ sessions: AgentSession[] }>('/api/sessions'),
    api<{ profiles: ModelProfile[] }>('/api/model-profiles'),
  ])
  return { config, me, overview, agent, sessions: sessions.sessions, models: models.profiles }
}

export async function publicConfig(): Promise<PublicConfig> { return api('/api/config/public') }

export async function observabilityTraces(input: {
  page?: number
  perPage?: number
  status?: ObservabilityTraceStatus
  traceId?: string
} = {}): Promise<ObservabilityTraceList> {
  const params = new URLSearchParams({
    page: String(input.page ?? 0),
    perPage: String(input.perPage ?? 50),
  })
  if (input.status) params.set('status', input.status)
  if (input.traceId?.trim()) params.set('traceId', input.traceId.trim())
  return api<ObservabilityTraceList>(`/api/observability/traces?${params}`)
}

export async function observabilityTrace(traceId: string): Promise<ObservabilityTraceDetail> {
  return api<ObservabilityTraceDetail>(`/api/observability/traces/${encodeURIComponent(traceId)}`)
}

export async function observabilityLogs(input: {
  page?: number
  perPage?: number
  level?: ObservabilityLogLevel
  traceId?: string
} = {}): Promise<ObservabilityLogList> {
  const params = new URLSearchParams({
    page: String(input.page ?? 0),
    perPage: String(input.perPage ?? 50),
  })
  if (input.level) params.set('level', input.level)
  if (input.traceId?.trim()) params.set('traceId', input.traceId.trim())
  return api<ObservabilityLogList>(`/api/observability/logs?${params}`)
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

export interface WorkspaceLibraryPage {
  files: WorkspaceLibraryFile[]
  total: number
  offset: number
  limit: number
  nextOffset?: number
}

export async function listLinks(): Promise<AgentLink[]> {
  return (await api<{ links: AgentLink[] }>('/api/links')).links
}

export async function linkInbounds(id: string): Promise<LinkInbound[]> {
  return (await api<{ inbounds: LinkInbound[] }>(`/api/links/${encodeURIComponent(id)}/inbounds`)).inbounds
}

export function publicLinkUrl(link: Pick<AgentLink, 'publicPath'>): string {
  return new URL(link.publicPath, window.location.origin).toString()
}

export async function workspaceFilesPage(query = '', offset = 0, limit = 100): Promise<WorkspaceLibraryPage> {
  const params = new URLSearchParams({ offset: String(offset), limit: String(limit) })
  if (query.trim()) params.set('q', query.trim())
  return api<WorkspaceLibraryPage>(`/api/workspace/files?${params}`)
}

export async function workspaceFiles(query = ''): Promise<WorkspaceLibraryFile[]> {
  return (await workspaceFilesPage(query)).files
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
