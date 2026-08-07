import { tokens } from '@papyrus/core/design'
/**
 * Toolbar — minimal top bar for canvas view.
 */
import type { PresenceInfo } from '@papyrus/core/sync/protocol'

interface ToolbarProps {
  projectName: string
  connected: boolean
  presence: Map<string, PresenceInfo>
}

export function Toolbar({ projectName, connected, presence }: ToolbarProps) {
  const peers = [...presence.values()]
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '10px 20px',
        background: tokens.color.surface,
        borderBottom: `1px solid ${tokens.color.border}`,
        zIndex: 10,
      }}
    >
      <span style={{ fontFamily: tokens.font.mono, fontSize: 12, color: tokens.color.textMuted }}>
        {projectName}
      </span>
      <div style={{ flex: 1 }} />
      <div className="presence-avatars">
        {peers.map((p) => (
          <div
            key={p.peerId}
            className="presence-avatar"
            style={{ background: p.color }}
            title={p.displayName}
          >
            {p.displayName.charAt(0)}
          </div>
        ))}
      </div>
      <div className="conn-status">
        <span className={`conn-dot ${connected ? 'live' : 'offline'}`} />
        {connected ? 'LIVE' : 'OFFLINE'}
      </div>
    </header>
  )
}
