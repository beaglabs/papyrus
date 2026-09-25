import { useEffect, useState } from 'react'
import codexLogo from './assets/acp/openai.svg'
import claudeLogo from './assets/acp/claudecode-color.svg'
import openCodeLogo from './assets/acp/opencode.svg'
import { Button } from './components/ui/index.js'
import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from './components/ui/avatar.js'
import { BorderBeam } from './components/ui/border-beam.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from './components/ui/dialog.js'
import './acp-session-connect.css'
import './acp-header-layout.css'

type HarnessId = 'codex' | 'claude' | 'opencode'
type HarnessState = 'opening' | 'connected' | 'available' | 'error' | 'closed' | 'disconnected'

interface HarnessStatus {
  harnessId: HarnessId
  name: string
  available: boolean
  connected: boolean
  state: HarnessState
  mode?: 'explicit' | 'opportunistic'
  externalSessionId?: string
  lastError?: string
  scopeId: string
}

const HARNESSES: Array<{ id: HarnessId; name: string; logo: string; description: string; fallback: string }> = [
  { id: 'codex', name: 'Codex', logo: codexLogo, description: 'OpenAI Codex coding harness', fallback: 'CX' },
  { id: 'claude', name: 'Claude', logo: claudeLogo, description: 'Claude Code coding harness', fallback: 'CL' },
  { id: 'opencode', name: 'OpenCode', logo: openCodeLogo, description: 'OpenCode ACP coding harness', fallback: 'OC' },
]

export function AcpSessionConnect({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [statusByHarness, setStatusByHarness] = useState<Partial<Record<HarnessId, HarnessStatus>>>({})
  const [busyHarness, setBusyHarness] = useState<HarnessId>()

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    void request<{ harnesses: HarnessStatus[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/acp`, { signal: controller.signal })
      .then((payload) => setStatusByHarness(Object.fromEntries(payload.harnesses.map((item) => [item.harnessId, item])) as Partial<Record<HarnessId, HarnessStatus>>))
      .catch((cause) => {
        if (controller.signal.aborted) return
        setError(errorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [open, sessionId])

  const connectHarness = async (id: HarnessId) => {
    setBusyHarness(id)
    setError(undefined)
    try {
      const payload = await request<{ harness: HarnessStatus }>(`/api/sessions/${encodeURIComponent(sessionId)}/acp/${id}/connect`, { method: 'POST' })
      setStatusByHarness((current) => ({ ...current, [id]: payload.harness }))
    } catch (cause) {
      const message = errorMessage(cause)
      let attachedToHarness = false
      setStatusByHarness((current) => {
        const previous = current[id]
        if (!previous) return current
        attachedToHarness = true
        return { ...current, [id]: { ...previous, state: 'error', lastError: message } }
      })
      if (!attachedToHarness) setError(message)
    } finally {
      setBusyHarness(undefined)
    }
  }

  const disconnectHarness = async (id: HarnessId) => {
    setBusyHarness(id)
    try {
      await request(`/api/sessions/${encodeURIComponent(sessionId)}/acp/${id}/disconnect`, { method: 'DELETE' })
      setStatusByHarness((current) => {
        const previous = current[id]
        if (!previous) return current
        const next: HarnessStatus = { ...previous, connected: false, state: 'closed' }
        delete next.externalSessionId
        return { ...current, [id]: next }
      })
    } catch (cause) {
      setStatusByHarness((current) => {
        const previous = current[id]
        return previous ? { ...current, [id]: { ...previous, lastError: errorMessage(cause) } } : current
      })
    } finally {
      setBusyHarness(undefined)
    }
  }

  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger className="acp-header-trigger" aria-label="Connect this Papyrus session to a coding harness">
      <span className="acp-header-trigger-label">ACP</span>
      <BorderBeam className="acp-avatar-stack-beam">
        <AvatarGroup className="acp-brand-avatar-group" aria-label="Codex, Claude and OpenCode">
          {HARNESSES.map((harness) => <BrandAvatar key={harness.id} harness={harness} size="sm" />)}
        </AvatarGroup>
      </BorderBeam>
      <span className="acp-header-trigger-arrow" aria-hidden="true">↗</span>
    </DialogTrigger>

    <DialogContent className="acp-dialog-content">
      <DialogHeader className="acp-dialog-head">
        <p className="eyebrow">AGENT CLIENT PROTOCOL</p>
        <DialogTitle>Open this session in a coding harness</DialogTitle>
        <DialogDescription>
          Each connection is isolated to your authenticated Entra identity and this Papyrus session. Papyrus can also delegate coding work to connected ACP harnesses when they materially help.
        </DialogDescription>
      </DialogHeader>

      <div className="acp-dialog-harnesses">
        {loading && <div className="acp-dialog-loading"><span /><span /><span /> Checking local ACP harnesses…</div>}
        {!loading && error && <div className="acp-dialog-error"><strong>Unable to load ACP status</strong><span>{error}</span></div>}
        {!loading && !error && HARNESSES.map((descriptor) => {
          const status = statusByHarness[descriptor.id]
          const busy = busyHarness === descriptor.id
          return <article className={`acp-harness-card${status?.connected ? ' is-connected' : ''}${status && !status.available ? ' is-unavailable' : ''}`} key={descriptor.id}>
            <div className="acp-harness-identity">
              <BorderBeam className="acp-dialog-avatar-beam"><BrandAvatar harness={descriptor} size="lg" /></BorderBeam>
              <span><strong>{descriptor.name}</strong><small>{descriptor.description}</small></span>
            </div>
            <div className="acp-harness-actions">
              <span className={`acp-harness-state ${status?.connected ? 'connected' : status?.available ? 'available' : 'unavailable'}`}>
                {status?.connected ? 'CONNECTED' : status?.available ? 'AVAILABLE' : 'NOT INSTALLED'}
              </span>
              <Button type="button" variant="default" size="sm" className="acp-harness-open" disabled={!status?.available || status.connected || busy} onClick={() => void connectHarness(descriptor.id)}>
                {busy ? 'Working…' : status?.connected ? 'Session open ✓' : `Open in ${descriptor.name} →`}
              </Button>
              {status?.connected && <Button type="button" variant="neutral" size="sm" className="acp-harness-disconnect" disabled={busy} onClick={() => void disconnectHarness(descriptor.id)}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button>}
            </div>
            {status?.lastError && <p className="acp-harness-error">{status.lastError}</p>}
            {status?.connected && status.externalSessionId && <p className="acp-harness-scope">ACP session {status.externalSessionId}</p>}
          </article>
        })}
      </div>

      <DialogFooter className="acp-dialog-foot">ACP permissions remain fail-closed behind Papyrus governance.</DialogFooter>
    </DialogContent>
  </Dialog>
}

function BrandAvatar({ harness, size }: { harness: (typeof HARNESSES)[number]; size: 'sm' | 'lg' }) {
  return <Avatar size={size} className="acp-brand-avatar" title={harness.name}>
    <AvatarImage src={harness.logo} alt={`${harness.name} logo`} />
    <AvatarFallback>{harness.fallback}</AvatarFallback>
  </Avatar>
}

async function request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'same-origin', headers: { accept: 'application/json', ...init?.headers } })
  const payload = await response.json().catch(() => null) as T | { error?: string }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : `Request failed (${response.status})`
    throw new Error(message)
  }
  return payload as T
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Unexpected ACP error'
}
