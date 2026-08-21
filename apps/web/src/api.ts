import type { Principal, Workspace } from '@papyrus/contracts'

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
