import { tokens } from '@papyrus/core/design'
import { startRegistration } from '@simplewebauthn/browser'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Credential {
  credentialId: string
  aaguid?: string
  createdAt: string
}

async function json<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error(
      `Expected JSON from the Papyrus daemon, received ${contentType || 'another response type'}`,
    )
  }
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body
}

export function CredentialManager() {
  const { user, apiFetch } = useAuth()
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setCredentials(await json<Credential[]>(await apiFetch('/api/auth/webauthn/credentials')))
  }, [apiFetch])

  useEffect(() => {
    load().catch(() => {})
  }, [load])

  async function addPasskey() {
    if (!user) return
    setBusy(true)
    setError('')
    try {
      const start = await json<{ options: Parameters<typeof startRegistration>[0] }>(
        await apiFetch('/api/auth/webauthn/register/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: user.displayName }),
        }),
      )
      const credential = await startRegistration(start.options)
      await json(
        await apiFetch('/api/auth/webauthn/register/finish', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential, origin: window.location.origin }),
        }),
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not register passkey')
    } finally {
      setBusy(false)
    }
  }

  async function removePasskey(credentialId: string) {
    setBusy(true)
    setError('')
    try {
      await json(
        await apiFetch('/api/auth/webauthn/credentials', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credentialId }),
        }),
      )
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove passkey')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, borderBottom: `1px solid ${tokens.color.border}` }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <strong style={{ color: tokens.color.text, fontSize: 12 }}>Passkeys</strong>
        <button
          type="button"
          disabled={busy}
          onClick={addPasskey}
          style={{
            background: 'none',
            border: 0,
            color: tokens.color.accent,
            cursor: busy ? 'wait' : 'pointer',
            fontSize: 12,
          }}
        >
          + Add
        </button>
      </div>
      {error && (
        <div role="alert" style={{ color: '#ef4444', fontSize: 11, marginBottom: 8 }}>
          {error}
        </div>
      )}
      {credentials.length === 0 ? (
        <div style={{ color: tokens.color.textDim, fontSize: 11 }}>No passkeys registered</div>
      ) : (
        credentials.map((credential) => (
          <div
            key={credential.credentialId}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  color: tokens.color.textMuted,
                  fontFamily: tokens.font.mono,
                  fontSize: 10,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {credential.credentialId}
              </div>
              <div style={{ color: tokens.color.textDim, fontSize: 10 }}>
                {new Date(credential.createdAt).toLocaleDateString()}
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => removePasskey(credential.credentialId)}
              aria-label="Remove passkey"
              style={{
                background: 'none',
                border: 0,
                color: '#ef4444',
                cursor: 'pointer',
                fontSize: 11,
              }}
            >
              Remove
            </button>
          </div>
        ))
      )}
    </div>
  )
}
