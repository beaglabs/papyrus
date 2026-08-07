import { tokens } from '@papyrus/core/design'
import { startAuthentication } from '@simplewebauthn/browser'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface AuthConfig {
  profile: string
  methods: { local: boolean; webauthn: boolean; oidc: boolean; saml: boolean; cac: boolean }
}

const API = window.location.origin

async function responseJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error(
      `Papyrus daemon returned ${contentType || 'a non-JSON response'} for ${response.url}. Is the daemon running on port 3777?`,
    )
  }
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Authentication failed (${response.status})`)
  return body
}

export function Login() {
  const { login, acceptSession } = useAuth()
  const [config, setConfig] = useState<AuthConfig | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch(`${API}/api/auth/config`)
      .then((response) => responseJson<AuthConfig>(response))
      .then(setConfig)
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : 'Could not load auth configuration'),
      )
  }, [])

  async function localIdentity(): Promise<{ memberKey: string }> {
    return responseJson(await fetch(`${API}/api/auth/local-identity`))
  }

  async function run(name: string, action: () => Promise<void>) {
    setBusy(name)
    setError('')
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed')
    } finally {
      setBusy(null)
    }
  }

  const localSignIn = () =>
    run('local', async () => {
      const { memberKey } = await localIdentity()
      const { csrfToken } = await responseJson<{ csrfToken: string }>(
        await fetch(`${API}/api/auth/csrf-token`),
      )
      await login(memberKey, 'Local User', csrfToken)
    })

  const passkeySignIn = () =>
    run('webauthn', async () => {
      const { memberKey } = await localIdentity()
      const start = await responseJson<{ options: Parameters<typeof startAuthentication>[0] }>(
        await fetch(`${API}/api/auth/webauthn/authenticate/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberKey }),
        }),
      )
      const credential = await startAuthentication(start.options)
      const session = await responseJson<{ token: string; memberKey: string; displayName: string }>(
        await fetch(`${API}/api/auth/webauthn/authenticate/finish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberKey, credential, origin: window.location.origin }),
        }),
      )
      acceptSession(session)
    })

  const cacSignIn = () =>
    run('cac', async () => {
      const session = await responseJson<{ token: string; memberKey: string; displayName: string }>(
        await fetch(`${API}/api/auth/cac/verify`, { method: 'POST' }),
      )
      acceptSession(session)
    })

  const button = (label: string, method: string, onClick: () => void, primary = false) => (
    <button
      type="button"
      disabled={Boolean(busy)}
      onClick={onClick}
      style={{
        width: '100%',
        padding: '12px 16px',
        background: primary ? tokens.color.accent : tokens.color.surface,
        border: `1px solid ${primary ? tokens.color.accent : tokens.color.border}`,
        borderRadius: 8,
        color: primary ? '#fff' : tokens.color.text,
        fontSize: 14,
        fontWeight: 600,
        cursor: busy ? 'wait' : 'pointer',
        opacity: busy && busy !== method ? 0.5 : 1,
      }}
    >
      {busy === method ? 'Connecting…' : label}
    </button>
  )

  return (
    <main
      style={{
        minHeight: '100vh',
        background: tokens.color.bg,
        display: 'grid',
        placeItems: 'center',
        padding: 24,
      }}
    >
      <section
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 40,
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: 16,
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            margin: '0 auto 16px',
            background: tokens.color.accent,
            color: tokens.color.bg,
            borderRadius: 8,
            display: 'grid',
            placeItems: 'center',
            fontWeight: 800,
            fontSize: 24,
          }}
        >
          P
        </div>
        <h1
          style={{
            textAlign: 'center',
            color: tokens.color.text,
            fontSize: 20,
            letterSpacing: '0.08em',
          }}
        >
          PAPYRUS
        </h1>
        <p
          style={{
            textAlign: 'center',
            color: tokens.color.textDim,
            fontSize: 13,
            margin: '8px 0 24px',
          }}
        >
          {config
            ? `${config.profile.toUpperCase()} identity profile`
            : 'Loading identity profile…'}
        </p>
        {error && (
          <div
            role="alert"
            style={{
              padding: 12,
              marginBottom: 16,
              color: '#ef4444',
              background: 'rgba(239,68,68,.1)',
              border: '1px solid rgba(239,68,68,.3)',
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: 'grid', gap: 10 }}>
          {config?.methods.cac && button('Sign in with CAC / PIV', 'cac', cacSignIn, true)}
          {config?.methods.webauthn &&
            button('Sign in with a passkey', 'webauthn', passkeySignIn, !config.methods.cac)}
          {config?.methods.oidc &&
            button('Sign in with OIDC', 'oidc', () =>
              window.location.assign(`${API}/api/auth/oidc/authorize`),
            )}
          {config?.methods.saml &&
            button('Sign in with SAML', 'saml', () =>
              window.location.assign(`${API}/api/auth/saml/authorize`),
            )}
          {config?.methods.local && button('Continue with local identity', 'local', localSignIn)}
        </div>
        {config && !Object.values(config.methods).some(Boolean) && (
          <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>
            No authentication method is configured for this profile.
          </p>
        )}
      </section>
    </main>
  )
}
