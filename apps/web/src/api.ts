import type { AdminOverview, Approval, Artifact, Attachment, Elicitation, Environment, McpServer, Principal, ResearchSource, Role, Session, SessionEvent, SessionRun } from '@papyrus/contracts'

export interface Health {
  topology: 'on-premises'
  profile: string
  cedar: string
  bootstrapRequired: boolean
}

export interface AuthenticationChallenge {
  error: 'authentication_required'
  code: 'UNAUTHENTICATED'
  methods: Array<'oidc' | 'mtls' | 'mtls-proxy'>
  login_url?: string
}

export interface ShellData {
  me: Principal
  health: Health
  environments: Environment[]
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

export class AuthenticationRequired extends ApiError {
  constructor(readonly challenge: AuthenticationChallenge, readonly health: Health) {
    super(401, challenge.code, 'Authentication required')
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    credentials: 'same-origin',
  })
  const result = await response.json().catch(() => null) as T | { error?: string; code?: string }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('papyrus:unauthenticated'))
    const message = result && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
      ? result.error
      : `Request failed (${response.status})`
    const code = result && typeof result === 'object' && 'code' in result && typeof result.code === 'string'
      ? result.code
      : 'REQUEST_FAILED'
    throw new ApiError(response.status, code, message)
  }
  return result as T
}

export async function loadShell(): Promise<ShellData> {
  const health = await api<Health>('/api/health')
  const meResponse = await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (meResponse.status === 401) {
    const challenge = await meResponse.json() as AuthenticationChallenge
    throw new AuthenticationRequired(challenge, health)
  }
  if (!meResponse.ok) throw new ApiError(meResponse.status, 'IDENTITY_FAILED', 'Unable to load identity')
  const me = await meResponse.json() as Principal
  const environments = me.roles.length ? await api<Environment[]>('/api/environments') : []
  return { me, health, environments }
}

export async function logout(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' })
}

export interface SessionPage {
  sessions: Session[]
  nextCursor?: string
}

export async function sessionPage(cursor?: string): Promise<SessionPage> {
  const query = new URLSearchParams({ limit: '50' })
  if (cursor) query.set('cursor', cursor)
  return api(`/api/sessions?${query}`)
}

export async function createSession(environmentId: string, title: string): Promise<Session> {
  return api('/api/sessions', { method: 'POST', body: JSON.stringify({ environmentId, title }) })
}

export async function sessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  let after = 0
  for (;;) {
    const page = await api<{ events: SessionEvent[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/events?after=${after}&limit=1000`)
    events.push(...page.events)
    if (page.events.length < 1000) return events
    after = page.events.at(-1)?.sequence ?? after
  }
}

export async function promptSession(sessionId: string, prompt: string, attachmentIds: string[] = []): Promise<{ stopReason: string }> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, { method: 'POST', body: JSON.stringify({ prompt, attachmentIds }) })
}

export async function sessionAttachments(sessionId: string): Promise<Attachment[]> {
  return (await api<{ attachments: Attachment[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`)).attachments
}

export async function uploadAttachment(sessionId: string, file: File): Promise<Attachment> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST', body: file,
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-papyrus-file-name': encodeURIComponent(file.name) },
  })
}

export async function cancelSession(sessionId: string): Promise<{ cancelled: boolean }> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' })
}

export async function resumeSession(sessionId: string): Promise<Session> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' })
}

export async function deleteSession(sessionId: string): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

export async function setSessionMode(sessionId: string, modeId: 'ask' | 'governed'): Promise<void> {
  await api(`/api/sessions/${encodeURIComponent(sessionId)}/mode`, { method: 'POST', body: JSON.stringify({ modeId }) })
}

export async function sessionRuns(sessionId: string): Promise<SessionRun[]> {
  return (await api<{ runs: SessionRun[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/runs`)).runs
}

export async function sessionArtifacts(sessionId: string): Promise<Artifact[]> {
  return (await api<{ artifacts: Artifact[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/artifacts`)).artifacts
}

export async function sessionApprovals(sessionId: string): Promise<Approval[]> {
  return (await api<{ approvals: Approval[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/approvals`)).approvals
}

export async function decideApproval(sessionId: string, approvalId: string, decision: 'approved' | 'denied', reason?: string): Promise<Approval> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: 'POST', body: JSON.stringify({ decision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }),
  })
}

export async function sessionElicitations(sessionId: string): Promise<Elicitation[]> {
  return (await api<{ elicitations: Elicitation[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/elicitations`)).elicitations
}

export async function respondElicitation(sessionId: string, elicitationId: string, response: Record<string, unknown>): Promise<Elicitation> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/elicitations/${encodeURIComponent(elicitationId)}/response`, { method: 'POST', body: JSON.stringify(response) })
}

export async function sessionSources(sessionId: string): Promise<ResearchSource[]> {
  return (await api<{ sources: ResearchSource[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/sources`)).sources
}

export async function researchSources(): Promise<ResearchSource[]> {
  return (await api<{ sources: ResearchSource[] }>('/api/sources')).sources
}

export async function adminOverview(): Promise<AdminOverview> { return api('/api/admin/overview') }
export async function addUserRole(userId: string, role: Role): Promise<Principal> {
  return api(`/api/users/${encodeURIComponent(userId)}/roles`, { method: 'POST', body: JSON.stringify({ role }) })
}
export async function revokeUserSessions(userId: string): Promise<void> {
  await api(`/api/users/${encodeURIComponent(userId)}/revoke-sessions`, { method: 'POST' })
}
export async function createEnvironmentAdmin(name: string, description: string): Promise<Environment> {
  return api('/api/environments', { method: 'POST', body: JSON.stringify({ name, description }) })
}
export async function assignEnvironment(principalId: string, environmentId: string): Promise<void> {
  await api('/api/assignments', { method: 'POST', body: JSON.stringify({ principalId, environmentId }) })
}
export async function addMcpServer(name: string, endpoint: string): Promise<{ server: McpServer; authorizationUrl?: string }> {
  return api('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ name, endpoint }) })
}
export async function setMcpServerEnabled(serverId: string, enabled: boolean): Promise<McpServer> {
  return api(`/api/mcp/servers/${encodeURIComponent(serverId)}/state`, { method: 'POST', body: JSON.stringify({ enabled }) })
}
export async function grantMcpServer(environmentId: string, mcpServerId: string): Promise<void> {
  await api('/api/mcp/environment-grants', { method: 'POST', body: JSON.stringify({ environmentId, mcpServerId }) })
}
export async function revokeToolGrant(grantId: string): Promise<void> {
  await api(`/api/mcp/grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' })
}
