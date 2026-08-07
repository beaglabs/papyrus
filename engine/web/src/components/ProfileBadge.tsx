import { tokens } from '@papyrus/core/design'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { CredentialManager } from './CredentialManager'

interface OrgInfo {
  org: {
    id: string
    name: string
    domain: string
    profile: string
  } | null
  membership: {
    role: string
    email: string
    displayName: string | null
    avatarUrl: string | null
  } | null
}

export function ProfileBadge() {
  const { apiFetch, user, logout } = useAuth()
  const [orgInfo, setOrgInfo] = useState<OrgInfo | null>(null)
  const [expanded, setExpanded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    apiFetch('/api/orgs/me')
      .then((r) => r.json())
      .then(setOrgInfo)
      .catch(() => {})
  }, [apiFetch])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const displayName = orgInfo?.membership?.displayName ?? user?.displayName ?? 'User'
  const email = orgInfo?.membership?.email ?? ''
  const avatarUrl = orgInfo?.membership?.avatarUrl
  const orgName = orgInfo?.org?.name ?? ''
  const role = orgInfo?.membership?.role
  const initials = displayName
    .split(' ')
    .map((w) => w.charAt(0))
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {/* Avatar button */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'none',
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.full,
          padding: '4px 10px 4px 4px',
          cursor: 'pointer',
          transition: 'border-color 0.15s',
        }}
      >
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={displayName}
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <div
            style={{
              width: 28,
              height: 28,
              borderRadius: '50%',
              background: tokens.color.accent,
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              fontWeight: 700,
              color: '#fff',
            }}
          >
            {initials}
          </div>
        )}
        <span style={{ fontSize: 12, fontWeight: 600, color: tokens.color.text }}>
          {displayName}
        </span>
      </button>

      {/* Dropdown */}
      {expanded && (
        <div
          style={{
            position: 'absolute',
            top: 44,
            right: 0,
            width: 280,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            boxShadow: tokens.shadow.lg,
            overflow: 'hidden',
            zIndex: 10000,
          }}
        >
          {/* User info */}
          <div style={{ padding: '16px', borderBottom: `1px solid ${tokens.color.border}` }}>
            <div
              style={{ fontSize: 14, fontWeight: 700, color: tokens.color.text, marginBottom: 2 }}
            >
              {displayName}
            </div>
            {email && <div style={{ fontSize: 12, color: tokens.color.textMuted }}>{email}</div>}
            {orgName && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: tokens.radius.sm,
                    background: `${tokens.color.accent}15`,
                    color: tokens.color.accent,
                    fontFamily: tokens.font.mono,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                  }}
                >
                  {role ?? 'member'}
                </span>
                <span style={{ fontSize: 11, color: tokens.color.textDim }}>{orgName}</span>
              </div>
            )}
          </div>

          <CredentialManager />

          {/* Actions */}
          <div style={{ padding: '8px' }}>
            <button
              type="button"
              onClick={() => {
                setExpanded(false)
                logout()
              }}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'none',
                border: 'none',
                borderRadius: tokens.radius.sm,
                color: tokens.color.textMuted,
                fontSize: 13,
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span>{'\u{1F511}'}</span>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
