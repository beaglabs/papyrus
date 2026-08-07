import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react'

interface AuthUser {
  memberKey: string
  displayName: string
}

export interface AuthSession extends AuthUser {
  token: string
}

interface AuthContextType {
  user: AuthUser | null
  token: string | null
  loading: boolean
  /** Role in the currently active project (null if no project selected) */
  projectRole: 'owner' | 'editor' | 'viewer' | null
  login: (memberKey: string, displayName: string, csrfToken?: string) => Promise<void>
  acceptSession: (session: AuthSession) => void
  logout: () => Promise<void>
  refresh: () => Promise<void>
  /** Fetch and set the user's role for a specific project */
  loadProjectRole: (projectId: string) => Promise<'owner' | 'editor' | 'viewer' | null>
  /** Clear project role (when leaving a project) */
  clearProjectRole: () => void
  apiFetch: (path: string, init?: RequestInit) => Promise<Response>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('papyrus_token'))
  const [loading, setLoading] = useState(true)
  const [projectRole, setProjectRole] = useState<'owner' | 'editor' | 'viewer' | null>(null)

  const API = `${window.location.protocol}//${window.location.hostname}:${window.location.port}`

  const acceptSession = useCallback((session: AuthSession) => {
    localStorage.setItem('papyrus_token', session.token)
    setToken(session.token)
    setUser({ memberKey: session.memberKey, displayName: session.displayName })
  }, [])

  // OIDC and SAML callbacks return the session through the same-origin redirect.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const callbackToken = params.get('token')
    if (!callbackToken) return

    localStorage.setItem('papyrus_token', callbackToken)
    setToken(callbackToken)
    params.delete('token')
    params.delete('displayName')
    const query = params.toString()
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
    )
  }, [])

  // Validate token on mount
  useEffect(() => {
    if (!token) {
      setLoading(false)
      return
    }

    fetch(`${API}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error('Invalid token')
        return r.json() as Promise<{ memberKey: string; displayName: string }>
      })
      .then((data) => {
        setUser({
          memberKey: data.memberKey,
          displayName: data.displayName,
        })
        setLoading(false)
      })
      .catch(() => {
        localStorage.removeItem('papyrus_token')
        setToken(null)
        setUser(null)
        setLoading(false)
      })
  }, [token, API])

  const login = useCallback(
    async (memberKey: string, displayName: string, csrfToken?: string) => {
      const res = await fetch(`${API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberKey, displayName, csrfToken }),
      })

      if (!res.ok) {
        const err = (await res.json()) as { error: string }
        throw new Error(err.error ?? 'Login failed')
      }

      const data = (await res.json()) as { token: string; memberKey: string; displayName: string }
      acceptSession(data)
    },
    [API, acceptSession],
  )

  const logout = useCallback(async () => {
    if (token) {
      await fetch(`${API}/api/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
    localStorage.removeItem('papyrus_token')
    setToken(null)
    setUser(null)
    setProjectRole(null)
  }, [token, API])

  const refresh = useCallback(async () => {
    if (!token) return

    const res = await fetch(`${API}/api/auth/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!res.ok) {
      await logout()
      return
    }

    const data = (await res.json()) as { token: string }
    localStorage.setItem('papyrus_token', data.token)
    setToken(data.token)
  }, [token, API, logout])

  const loadProjectRole = useCallback(
    async (projectId: string): Promise<'owner' | 'editor' | 'viewer' | null> => {
      if (!token) return null

      const res = await fetch(`${API}/api/auth/me?projectId=${projectId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!res.ok) {
        if (res.status === 401) {
          // Token expired — trigger re-login
          await logout()
          return null
        }
        return null
      }
      const data = (await res.json()) as { role: string | null }
      const role = (data.role as 'owner' | 'editor' | 'viewer' | null) ?? 'viewer'
      setProjectRole(role)
      return role
    },
    [token, API, logout],
  )

  const clearProjectRole = useCallback(() => {
    setProjectRole(null)
  }, [])

  const apiFetch = useCallback(
    async (path: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers)
      if (token) {
        headers.set('Authorization', `Bearer ${token}`)
      }
      const res = await fetch(`${API}${path}`, { ...init, headers })

      // If 401, token expired — clear auth and notify
      if (res.status === 401) {
        localStorage.removeItem('papyrus_token')
        setToken(null)
        setUser(null)
        setProjectRole(null)
        // Dispatch event for toast notification
        window.dispatchEvent(
          new CustomEvent('papyrus:auth-expired', {
            detail: { message: 'Your session has expired. Please sign in again.' },
          }),
        )
      }

      return res
    },
    [token, API],
  )

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        projectRole,
        login,
        acceptSession,
        logout,
        refresh,
        loadProjectRole,
        clearProjectRole,
        apiFetch,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
