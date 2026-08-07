import { tokens } from '@papyrus/core/design'
import { useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

const FREE_EMAIL_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'aol.com',
  'icloud.com',
  'protonmail.com',
  'zoho.com',
]

const PROFILES: Record<string, { label: string; hint: string }> = {
  'siprnet-il6': { label: 'SIPRNet (IL6)', hint: 'Requires a .mil or .gov email address.' },
  'niprnet-il4': { label: 'NIPRNet (IL4)', hint: 'Requires a .mil, .gov, or business email.' },
  commercial: { label: 'Commercial', hint: 'Requires a business email address.' },
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { apiFetch, user, logout } = useAuth()
  const [step, setStep] = useState<'profile' | 'org'>('profile')
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [avatarUrl, setAvatarUrl] = useState('')
  const [email, setEmail] = useState('')
  const [orgName, setOrgName] = useState('')
  const [domain, setDomain] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const avatarInputRef = useRef<HTMLInputElement>(null)

  const profile =
    (import.meta as unknown as { env?: { VITE_PAPYRUS_PROFILE?: string } }).env
      ?.VITE_PAPYRUS_PROFILE ?? 'commercial'
  const profileInfo = PROFILES[profile] ?? {
    label: 'Commercial',
    hint: 'Requires a business email address.',
  }

  async function handleProfileNext() {
    if (!displayName.trim()) {
      setError('Display name is required')
      return
    }
    setError('')
    setStep('org')
  }

  function handleAvatar(file: File | undefined) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('Profile picture must be an image')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Profile picture must be smaller than 2 MB')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setAvatarUrl(typeof reader.result === 'string' ? reader.result : '')
      setError('')
    }
    reader.readAsDataURL(file)
  }

  async function handleSubmit() {
    if (!email.trim() || !orgName.trim() || !domain.trim()) {
      setError('All fields are required')
      return
    }

    setLoading(true)
    setError('')

    try {
      const res = await apiFetch('/api/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          displayName: displayName.trim(),
          orgName: orgName.trim(),
          domain: domain.trim(),
          avatarUrl,
        }),
      })

      if (!res.ok) {
        const data = (await res.json()) as { error?: string }
        throw new Error(data.error ?? 'Onboarding failed')
      }

      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

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
          width: 480,
          background: tokens.color.surface,
          borderRadius: 16,
          border: `1px solid ${tokens.color.border}`,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '32px 40px 24px',
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <img
              src="/papyrus-logo.svg"
              alt=""
              style={{ width: 42, height: 42, objectFit: 'contain' }}
            />
            <span
              style={{
                fontSize: 14,
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: tokens.color.text,
              }}
            >
              PAPYRUS
            </span>
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: tokens.color.text, marginBottom: 4 }}>
            {step === 'profile' ? 'Set up your profile' : 'Tell us about your organization'}
          </h1>
          <p style={{ fontSize: 13, color: tokens.color.textDim }}>
            {step === 'profile' ? 'This is how others will see you.' : profileInfo.hint}
          </p>
        </div>

        {/* Body */}
        <div style={{ padding: '24px 40px' }}>
          {step === 'profile' ? (
            <>
              <div style={{ display: 'grid', justifyItems: 'center', gap: 10, marginBottom: 24 }}>
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  aria-label="Choose profile picture"
                  style={{
                    width: 104,
                    height: 104,
                    borderRadius: '50%',
                    border: `3px solid ${tokens.color.black}`,
                    boxShadow: '5px 5px 0 #111',
                    background: avatarUrl
                      ? `url(${avatarUrl}) center / cover`
                      : tokens.color.accent,
                    color: tokens.color.black,
                    fontSize: 30,
                    fontWeight: 800,
                    cursor: 'pointer',
                    overflow: 'hidden',
                  }}
                >
                  {!avatarUrl && (displayName.trim().charAt(0).toUpperCase() || '+')}
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(event) => handleAvatar(event.target.files?.[0])}
                  style={{ display: 'none' }}
                />
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  style={avatarBtn}
                >
                  {avatarUrl ? 'Change photo' : 'Add profile photo'}
                </button>
                <span style={{ color: tokens.color.textDim, fontSize: 11 }}>
                  PNG, JPG, WebP or GIF · 2 MB max
                </span>
              </div>
              <Field label="Display Name">
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="John Smith"
                  style={inputStyle}
                />
              </Field>
              <button type="button" onClick={handleProfileNext} style={primaryBtn}>
                Continue
              </button>
            </>
          ) : (
            <>
              <Field label="Work Email">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="john.smith@agency.gov"
                  style={inputStyle}
                />
                <p style={hintStyle}>{profileInfo.hint}</p>
              </Field>
              <Field label="Organization Name">
                <input
                  type="text"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="Defense Information Systems Agency"
                  style={inputStyle}
                />
              </Field>
              <Field label="Email Domain">
                <input
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="disa.mil"
                  style={inputStyle}
                />
                <p style={hintStyle}>All users with this email domain can join your org.</p>
              </Field>

              {error && <div style={errorStyle}>{error}</div>}

              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => setStep('profile')} style={secondaryBtn}>
                  Back
                </button>
                <button type="button" onClick={handleSubmit} disabled={loading} style={primaryBtn}>
                  {loading ? 'Setting up...' : 'Complete Setup'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '12px 40px',
            borderTop: `1px solid ${tokens.color.border}`,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontFamily: tokens.font.mono,
              color: tokens.color.textDim,
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            {profileInfo.label}
          </span>
          <button
            type="button"
            onClick={logout}
            style={{
              background: 'none',
              border: 'none',
              color: tokens.color.textDim,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  background: tokens.color.bg,
  border: `2px solid ${tokens.color.border}`,
  borderRadius: 8,
  color: tokens.color.text,
  fontSize: 14,
  fontFamily: tokens.font.body,
  outline: 'none',
  boxSizing: 'border-box',
}

const primaryBtn: React.CSSProperties = {
  flex: 1,
  padding: '12px 16px',
  background: tokens.color.accent,
  border: `2px solid ${tokens.color.black}`,
  borderRadius: 8,
  color: tokens.color.black,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  marginTop: 16,
  boxShadow: '4px 4px 0 #111',
}

const avatarBtn: React.CSSProperties = {
  padding: '7px 12px',
  background: tokens.color.surface,
  border: `2px solid ${tokens.color.black}`,
  borderRadius: 999,
  color: tokens.color.text,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
}

const secondaryBtn: React.CSSProperties = {
  padding: '12px 16px',
  background: 'transparent',
  border: `1px solid ${tokens.color.border}`,
  borderRadius: 8,
  color: tokens.color.textMuted,
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  marginTop: 16,
}

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: tokens.color.textDim,
  marginTop: 4,
  fontFamily: tokens.font.mono,
}

const errorStyle: React.CSSProperties = {
  marginBottom: 12,
  padding: '10px 12px',
  background: 'rgba(239,68,68,0.1)',
  border: '1px solid rgba(239,68,68,0.3)',
  borderRadius: 8,
  color: '#ef4444',
  fontSize: 12,
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: 'block',
          fontSize: 12,
          fontWeight: 600,
          color: tokens.color.textDim,
          marginBottom: 6,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}
