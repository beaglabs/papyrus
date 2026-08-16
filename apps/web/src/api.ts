import type { ActivitySummary, AuditEvent, McpServer, Principal, Runtime, Session, Workspace } from '@papyrus/contracts'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
    credentials: 'same-origin',
  })
  const result = await response.json().catch(() => null) as T | { error?: string }
  if (!response.ok) throw new Error(result && typeof result === 'object' && 'error' in result ? result.error : `Request failed (${response.status})`)
  return result as T
}

export interface DashboardData {
  me: Principal
  health: { mode: string; profile: string; cedar: string; bootstrapRequired: boolean; goose: { available: boolean; version?: string; reason?: string } }
  activity: ActivitySummary
  workspaces: Workspace[]
  runtimes: Runtime[]
  sessions: Session[]
  users: Principal[]
  mcpServers: McpServer[]
}

export async function dashboard(): Promise<DashboardData> {
  const [me, health] = await Promise.all([api<Principal>('/api/me'), api<DashboardData['health']>('/api/health')])
  if (me.roles.length === 0) return { me, health, activity: { sessions: 0, prompts: 0, toolCalls: 0, deniedActions: 0 }, workspaces: [], runtimes: [], sessions: [], users: [], mcpServers: [] }
  const canAdmin = me.roles.some((role) => ['Owner', 'Admin'].includes(role))
  const [activity, workspaces, runtimes, sessions, users, mcpServers] = await Promise.all([
    api<ActivitySummary>('/api/activity'), api<Workspace[]>('/api/workspaces'), api<Runtime[]>('/api/runtimes'), api<Session[]>('/api/sessions'),
    canAdmin ? api<Principal[]>('/api/users') : Promise.resolve([]),
    canAdmin ? api<McpServer[]>('/api/mcp/servers') : Promise.resolve([]),
  ])
  return { me, health, activity, workspaces, runtimes, sessions, users, mcpServers }
}

export async function auditEvents(): Promise<{ integrity: { valid: boolean; brokenAt?: number }; events: AuditEvent[] }> {
  return api('/api/audit')
}
