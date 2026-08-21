import type { Approval, Artifact, Principal, ResearchSource, Session, SessionEvent, SessionRun, Workspace } from '@papyrus/contracts'

export interface Health {
  mode: string
  profile: string
  cedar: string
  bootstrapRequired: boolean
}

export interface AuthenticationChallenge {
  error: 'authentication_required'
  code: 'UNAUTHENTICATED'
  methods: Array<'oidc' | 'mtls' | 'mtls-proxy' | 'development'>
  login_url?: string
}

export interface ShellData {
  me: Principal
  health: Health
  workspaces: Workspace[]
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
  const workspaces = me.roles.length ? await api<Workspace[]>('/api/workspaces') : []
  return { me, health, workspaces }
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

export async function createSession(workspaceId: string, title: string): Promise<Session> {
  return api('/api/sessions', { method: 'POST', body: JSON.stringify({ workspaceId, title }) })
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

export async function promptSession(sessionId: string, prompt: string): Promise<{ stopReason: string }> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/prompts`, { method: 'POST', body: JSON.stringify({ prompt }) })
}

export async function cancelSession(sessionId: string): Promise<{ cancelled: boolean }> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: 'POST' })
}

export async function resumeSession(sessionId: string): Promise<Session> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, { method: 'POST' })
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

export async function sessionSources(sessionId: string): Promise<ResearchSource[]> {
  return (await api<{ sources: ResearchSource[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/sources`)).sources
}

export async function researchSources(): Promise<ResearchSource[]> {
  return (await api<{ sources: ResearchSource[] }>('/api/sources')).sources
}
