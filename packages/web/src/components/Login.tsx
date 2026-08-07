import { tokens } from '@papyrus/core/design'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

export function Login() {
  const { login, loading } = useAuth()
  const [error, setError] = useState('')
  const [autoSigningIn, setAutoSigningIn] = useState(true)

  const API = `${window.location.protocol}//${window.location.hostname}:${window.location.port}`

  // Auto-sign-in using the daemon's local member identity
  useEffect(() => {
    async function autoLogin() {
      try {
        // 1. Fetch the local member identity (no auth required — local daemon)
        const idRes = await fetch(`${API}/api/auth/local-identity`)
        if (!idRes.ok) throw new Error('Failed to get local identity')
        const { memberKey } = (await idRes.json()) as { memberKey: string }

        if (!memberKey) throw new Error('No member key')

        // 2. Fetch CSRF token
        const csrfRes = await fetch(`${API}/api/auth/csrf-token`)
        const { csrfToken } = (await csrfRes.json()) as { csrfToken: string }

        // 3. Sign in
        await login(memberKey, 'Local User', csrfToken)
      } catch (err) {
        setAutoSigningIn(false)
        setError(err instanceof Error ? err.message : 'Auto-login failed')
      }
    }
    autoLogin()
  }, [login, API])

  if (loading || autoSigningIn) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: tokens.color.bg,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            border: `3px solid ${tokens.color.border}`,
            borderTopColor: tokens.color.accent,
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
        <div style={{ color: tokens.color.textDim, fontSize: 13, fontFamily: tokens.font.mono }}>
          Connecting to Papyrus...
        </div>
      </div>
    )
  }

  // Only shown if auto-login fails
  return (
    <div
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 400,
          padding: 40,
          background: tokens.color.surface,
          borderRadius: 16,
          border: `1px solid ${tokens.color.border}`,
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              width: 48,
              height: 48,
              background: tokens.color.accent,
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              fontWeight: 800,
              fontSize: 24,
              color: tokens.color.bg,
              margin: '0 auto 16px',
            }}
          >
            P
          </div>
          <div style={{ fontSize: 18, fontWeight: 700, color: tokens.color.text, marginBottom: 4 }}>
            PAPYRUS
          </div>
          <div style={{ fontSize: 13, color: tokens.color.textDim }}>
            Couldn't auto-connect. Make sure the daemon is running.
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '10px 12px',
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 8,
              color: '#ef4444',
              fontSize: 12,
              fontFamily: tokens.font.mono,
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            width: '100%',
            padding: '12px 16px',
            background: tokens.color.accent,
            border: 'none',
            borderRadius: 8,
            color: '#fff',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Retry Connection
        </button>

        <div style={{ marginTop: 16, fontSize: 12, color: tokens.color.textDim, textAlign: 'center' }}>
          Start the daemon with: <code style={{ color: tokens.color.accent }}>pnpm --filter @papyrus/daemon start</code>
        </div>
      </div>
    </div>
  )
}
