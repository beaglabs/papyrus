import type { PresenceInfo, ServerMsg } from '@papyrus/core/sync/protocol'
/**
 * usePresence — tracks connected peers from WebSocket presence messages.
 */
import { useEffect, useState } from 'react'

export function usePresence(): Map<string, PresenceInfo> {
  const [presence, setPresence] = useState<Map<string, PresenceInfo>>(new Map())

  useEffect(() => {
    function handlePresence(event: Event) {
      const detail = (event as CustomEvent<ServerMsg>).detail
      if (!detail) return

      if (detail.type === 'presence:update') {
        setPresence((prev) => {
          const next = new Map(prev)
          next.set(detail.data.peerId, detail.data)
          return next
        })
      } else if (detail.type === 'presence:leave') {
        setPresence((prev) => {
          const next = new Map(prev)
          next.delete(detail.data.peerId)
          return next
        })
      } else if (detail.type === 'canvas:state') {
        setPresence(() => {
          const next = new Map<string, PresenceInfo>()
          for (const p of detail.data.presence) {
            next.set(p.peerId, p)
          }
          return next
        })
      }
    }

    window.addEventListener('papyrus:presence', handlePresence)
    return () => window.removeEventListener('papyrus:presence', handlePresence)
  }, [])

  return presence
}
