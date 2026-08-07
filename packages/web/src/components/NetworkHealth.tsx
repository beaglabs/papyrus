import { tokens } from '@papyrus/core/design'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface NetworkStatus {
  ready: boolean
  nodeId: string | null
  stats: {
    peerCount: number
    projectsVisible: number
    connected: boolean
    relayConnected: boolean
    rtt: number | null
  } | null
}

interface NetworkHealthProps {
  compact?: boolean
  pollIntervalMs?: number
}

export function NetworkHealth({ compact = false, pollIntervalMs = 5000 }: NetworkHealthProps) {
  const [status, setStatus] = useState<NetworkStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const { apiFetch } = useAuth()

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await apiFetch('/api/network/status')
        const data = (await res.json()) as NetworkStatus
        setStatus(data)
      } catch {
        setStatus({ ready: false, nodeId: null, stats: null })
      }
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, pollIntervalMs)
    return () => clearInterval(interval)
  }, [apiFetch, pollIntervalMs])

  if (compact) {
    return (
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.full,
          cursor: 'pointer',
          fontSize: 12,
          color: tokens.color.textMuted,
          transition: 'all 0.15s',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: status?.ready ? tokens.color.success : tokens.color.textDim,
          }}
        />
        {status?.ready ? 'IROH' : 'OFFLINE'}
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        left: 16,
        zIndex: 100,
      }}
    >
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 14px',
          background: tokens.color.surface,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.full,
          cursor: 'pointer',
          fontSize: 12,
          fontFamily: tokens.font.mono,
          color: tokens.color.textMuted,
          boxShadow: tokens.shadow.md,
          transition: 'all 0.15s',
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M5 12.55a11 11 0 0 1 14.08 0" />
          <path d="M1.42 9a16 16 0 0 1 21.16 0" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <circle cx="12" cy="20" r="1" />
        </svg>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: status?.ready ? tokens.color.success : tokens.color.error,
          }}
        />
        {status?.ready ? 'Connected' : 'Offline'}
      </button>

      {/* Expanded panel */}
      {expanded && (
        <div
          style={{
            position: 'absolute',
            bottom: 48,
            left: 0,
            width: 280,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            boxShadow: tokens.shadow.lg,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '12px 16px',
              borderBottom: `1px solid ${tokens.color.border}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke={tokens.color.accent}
              strokeWidth="2"
            >
              <path d="M5 12.55a11 11 0 0 1 14.08 0" />
              <path d="M1.42 9a16 16 0 0 1 21.16 0" />
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
              <circle cx="12" cy="20" r="1" />
            </svg>
            <span style={{ fontWeight: 600, fontSize: 13, color: tokens.color.text }}>Network</span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                fontFamily: tokens.font.mono,
                padding: '2px 6px',
                borderRadius: tokens.radius.full,
                background: status?.ready ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: status?.ready ? tokens.color.success : tokens.color.error,
              }}
            >
              {status?.ready ? 'LIVE' : 'DOWN'}
            </span>
          </div>

          {/* Stats */}
          <div style={{ padding: '12px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <StatItem
                label="Peers"
                value={status?.stats?.peerCount?.toString() ?? '0'}
                color={tokens.color.accent}
              />
              <StatItem
                label="Projects"
                value={status?.stats?.projectsVisible?.toString() ?? '0'}
                color={tokens.color.persona.designer ?? '#a855f7'}
              />
              <StatItem
                label="Relay"
                value={status?.stats?.relayConnected ? 'OK' : 'None'}
                color={status?.stats?.relayConnected ? tokens.color.success : tokens.color.textDim}
              />
              <StatItem
                label="Latency"
                value={status?.stats?.rtt != null ? `${Math.round(status.stats.rtt)}ms` : '--'}
                color={tokens.color.textMuted}
              />
            </div>

            {/* Node ID */}
            {status?.nodeId && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 12,
                  borderTop: `1px solid ${tokens.color.border}`,
                }}
              >
                <div
                  style={{
                    fontSize: 10,
                    color: tokens.color.textDim,
                    marginBottom: 4,
                    fontFamily: tokens.font.mono,
                  }}
                >
                  NODE ID
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: tokens.font.mono,
                    color: tokens.color.textMuted,
                    wordBreak: 'break-all',
                    lineHeight: 1.4,
                  }}
                >
                  {status.nodeId}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function StatItem({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: tokens.color.textDim,
          marginBottom: 2,
          fontFamily: tokens.font.mono,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color }}>{value}</div>
    </div>
  )
}
