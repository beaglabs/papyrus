import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { Alert, Button, Input } from './components/ui/index.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog.js'
import './connector-mentions.css'

type ConnectorStatus = 'connected' | 'degraded' | 'available' | 'needs_setup' | 'pending'

interface SessionConnector {
  catalogId: string
  name: string
  vendor: string
  description: string
  initials: string
  accent: string
  authority: 'read_only' | 'bidirectional' | 'controlled_actions'
  integrationClass: string
  capabilities: string[]
  authSchemes: string[]
  syncMode: 'none' | 'pull' | 'push' | 'hybrid'
  status: ConnectorStatus
  integrationId?: string
  integrationState?: string
  health?: string
  requiresCredentialReference: boolean
  requiresEndpoint: boolean
  setupMessage?: string
}

interface ConnectorResponse {
  sessionId: string
  connector: SessionConnector
}

/**
 * Session connector autocomplete lives above the existing composer rather than inside the
 * attachment picker. Library already has an explicit button; `@` is therefore reserved for
 * runtime capabilities. The layer intentionally talks only to session-scoped connector routes
 * and never handles secret material — setup accepts opaque vault/certificate references only.
 */
export function ConnectorMentionLayer() {
  const [anchor, setAnchor] = useState<HTMLInputElement | null>(null)
  const [mention, setMention] = useState<string>()
  const [sessionId, setSessionId] = useState<string>()
  const [search, setSearch] = useState('')
  const [connectors, setConnectors] = useState<SessionConnector[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<SessionConnector>()
  const [dialogOpen, setDialogOpen] = useState(false)

  const open = Boolean(anchor && sessionId && mention !== undefined)

  useEffect(() => {
    const update = (target: EventTarget | null) => {
      if (!(target instanceof HTMLInputElement) || !target.classList.contains('composer-prompt-input')) return
      const nextMention = mentionQuery(target.value)
      setAnchor(target)
      setMention(nextMention)
      setSessionId(activeSessionId())
      if (nextMention !== undefined) setSearch(nextMention)
    }

    const onInput = (event: Event) => update(event.target)
    const onFocus = (event: FocusEvent) => update(event.target)
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setMention(undefined)
      setDialogOpen(false)
    }
    document.addEventListener('input', onInput, true)
    document.addEventListener('focusin', onFocus, true)
    document.addEventListener('keydown', onKey, true)

    const tuneComposer = () => {
      for (const input of document.querySelectorAll<HTMLInputElement>('.composer-prompt-input')) {
        input.placeholder = 'Ask Papyrus… Type @ to add a connector.'
      }
    }
    tuneComposer()
    const observer = new MutationObserver(tuneComposer)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('focusin', onFocus, true)
      document.removeEventListener('keydown', onKey, true)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    document.body.classList.toggle('connector-mention-active', open)
    return () => document.body.classList.remove('connector-mention-active')
  }, [open])

  useEffect(() => {
    if (!open || !sessionId) return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(undefined)
      void request<{ connectors: SessionConnector[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/connectors?q=${encodeURIComponent(search)}`,
        { signal: controller.signal },
      ).then((value) => setConnectors(value.connectors)).catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(errorMessage(cause, 'Unable to load connectors'))
      }).finally(() => setLoading(false))
    }, 100)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [open, search, sessionId])

  const portalTarget = anchor?.parentElement ?? null
  const dropdown = open && portalTarget ? createPortal(
    <div className="connector-mention-menu" role="listbox" aria-label="Session connectors">
      <div className="connector-mention-head">
        <div>
          <p className="eyebrow">SESSION CONNECTORS</p>
          <strong>Add a runtime connection</strong>
        </div>
        <span className="connector-session-label">This session</span>
      </div>
      <div className="connector-search-row">
        <span aria-hidden="true">⌕</span>
        <Input
          autoFocus
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search connectors…"
          aria-label="Search connectors"
        />
      </div>
      {error && <Alert className="error connector-mention-error">{error}</Alert>}
      {loading && <div className="connector-mention-loading"><span /><span /><span /></div>}
      {!loading && !error && connectors.length === 0 && <div className="connector-mention-empty">No connectors match “{search}”.</div>}
      {!loading && connectors.slice(0, 14).map((connector) => <button
        type="button"
        role="option"
        aria-selected={connector.status === 'connected'}
        className="connector-option"
        key={connector.catalogId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void choose(connector)}
      >
        <span className="connector-mark" style={{ '--connector-accent': connector.accent } as React.CSSProperties}>{connector.initials}</span>
        <span className="connector-copy">
          <span className="connector-title"><strong>{connector.name}</strong><small>{connector.vendor}</small></span>
          <span className="connector-description">{connector.description}</span>
          <span className="connector-capabilities">{connector.capabilities.slice(0, 3).join(' · ')}</span>
        </span>
        <span className={`connector-status ${connector.status}`}><i />{statusLabel(connector)}</span>
      </button>)}
      <div className="connector-mention-foot"><span>@ adds a connector to this Mastra session.</span><span>Library files use the Library button.</span></div>
    </div>,
    portalTarget,
  ) : null

  async function choose(connector: SessionConnector): Promise<void> {
    if (!sessionId || !anchor) return
    setError(undefined)
    if (connector.status === 'connected' || connector.status === 'degraded') {
      insertMention(anchor, connector.name)
      setMention(undefined)
      return
    }
    if (connector.status === 'available') {
      setLoading(true)
      try {
        const value = await request<ConnectorResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/connectors/${encodeURIComponent(connector.catalogId)}/connect`,
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ integrationId: connector.integrationId }) },
        )
        setConnectors((current) => replaceConnector(current, value.connector))
        insertMention(anchor, value.connector.name)
        setMention(undefined)
      } catch (cause) {
        setError(errorMessage(cause, `Unable to connect ${connector.name}`))
      } finally {
        setLoading(false)
      }
      return
    }
    setSelected(connector)
    setDialogOpen(true)
  }

  return <>
    {dropdown}
    <ConnectorSetupDialog
      open={dialogOpen}
      connector={selected}
      sessionId={sessionId}
      onOpenChange={setDialogOpen}
      onConnected={(connector) => {
        setConnectors((current) => replaceConnector(current, connector))
        setSelected(connector)
        if ((connector.status === 'connected' || connector.status === 'degraded') && anchor) {
          insertMention(anchor, connector.name)
          setMention(undefined)
          setDialogOpen(false)
        }
      }}
    />
  </>
}

function ConnectorSetupDialog({ open, connector, sessionId, onOpenChange, onConnected }: {
  open: boolean
  connector: SessionConnector | undefined
  sessionId: string | undefined
  onOpenChange: (open: boolean) => void
  onConnected: (connector: SessionConnector) => void
}) {
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [credentialRef, setCredentialRef] = useState('')
  const [settingsText, setSettingsText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<SessionConnector>()

  useEffect(() => {
    if (!connector || !open) return
    setName(connector.name)
    setEndpoint('')
    setCredentialRef('')
    setSettingsText('')
    setError(undefined)
    setResult(connector)
  }, [connector?.catalogId, open])

  const active = result ?? connector
  const schemes = useMemo(() => active?.authSchemes.map(authLabel).join(' · ') ?? '', [active?.authSchemes])
  if (!connector) return null

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!sessionId) return
    setBusy(true)
    setError(undefined)
    try {
      let settings: Record<string, unknown> = {}
      if (settingsText.trim()) {
        const parsed = JSON.parse(settingsText) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Advanced settings must be a JSON object.')
        settings = parsed as Record<string, unknown>
      }
      const response = await request<ConnectorResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/connectors/${encodeURIComponent(connector.catalogId)}/setup`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, endpoint, credentialRef, settings }),
        },
      )
      setResult(response.connector)
      onConnected(response.connector)
    } catch (cause) {
      setError(errorMessage(cause, `Unable to set up ${connector.name}`))
    } finally {
      setBusy(false)
    }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="connector-setup-dialog">
      <DialogHeader>
        <div className="connector-setup-title-row">
          <span className="connector-mark large" style={{ '--connector-accent': connector.accent } as React.CSSProperties}>{connector.initials}</span>
          <div>
            <DialogTitle>Connect {connector.name}</DialogTitle>
            <DialogDescription>{connector.description}</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="connector-setup-meta">
        <span><strong>Session scope</strong><small>Only this Mastra session receives the connector authority.</small></span>
        <span><strong>{authorityLabel(connector.authority)}</strong><small>{connector.syncMode === 'none' ? 'On-demand' : `${connector.syncMode} events/state`}</small></span>
        <span><strong>Authentication</strong><small>{schemes || 'No authentication'}</small></span>
      </div>

      {active?.status === 'pending' && <Alert className="connector-pending-alert">
        <strong>Setup saved — activation is still pending.</strong>
        <span>{active.setupMessage ?? `Integration state: ${active.integrationState ?? 'pending'}. Retry after the required driver or approval is available.`}</span>
      </Alert>}
      {error && <Alert className="error">{error}</Alert>}

      <form className="connector-setup-form" onSubmit={(event) => void submit(event)}>
        {connector.status !== 'pending' && <>
          <label><span>Connection name</span><Input value={name} onChange={(event) => setName(event.target.value)} required /></label>
          <label><span>Endpoint {connector.requiresEndpoint ? '' : <small>optional</small>}</span><Input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required={connector.requiresEndpoint} placeholder="https://service.example.mil" /></label>
          {(connector.requiresCredentialReference || connector.authSchemes.some((scheme) => ['vault_reference', 'certificate', 'managed_identity'].includes(scheme))) && <label>
            <span>Credential reference {connector.requiresCredentialReference ? '' : <small>optional</small>}</span>
            <Input value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} required={connector.requiresCredentialReference} placeholder="vault://connectors/service" />
            <small>Opaque reference only. Papyrus never accepts the secret itself here.</small>
          </label>}
          <label><span>Advanced settings <small>optional JSON</small></span><textarea value={settingsText} onChange={(event) => setSettingsText(event.target.value)} placeholder={'{\n  "tenant": "example"\n}'} /></label>
        </>}
        <DialogFooter>
          <Button type="button" variant="neutral" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="primary" type="submit" disabled={busy}>{busy ? 'Connecting…' : connector.status === 'pending' ? 'Retry activation' : 'Set up & connect'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

function activeSessionId(): string | undefined {
  const value = new URLSearchParams(window.location.search).get('session')?.trim()
  return value || undefined
}

function mentionQuery(value: string): string | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value)
  return match ? match[1] ?? '' : undefined
}

function insertMention(input: HTMLInputElement, name: string): void {
  const match = /(?:^|\s)@[^\s@]*$/.exec(input.value)
  if (!match) return
  const at = input.value.lastIndexOf('@', match.index + match[0].length)
  const next = `${input.value.slice(0, at)}@${name.replace(/\s+/g, '')} `
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, next)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.focus()
  input.setSelectionRange(next.length, next.length)
}

function statusLabel(connector: SessionConnector): string {
  if (connector.status === 'connected') return 'Connected'
  if (connector.status === 'degraded') return 'Degraded'
  if (connector.status === 'available') return 'Ready to connect'
  if (connector.status === 'pending') return connector.integrationState === 'awaiting_approval' ? 'Awaiting approval' : 'Setup pending'
  return 'Needs setup'
}

function authorityLabel(authority: SessionConnector['authority']): string {
  if (authority === 'read_only') return 'Read only'
  if (authority === 'controlled_actions') return 'Governed actions'
  return 'Bidirectional'
}

function authLabel(value: string): string {
  return ({
    entra: 'Microsoft Entra',
    certificate: 'Certificate',
    managed_identity: 'Managed identity',
    oauth: 'OAuth',
    mTLS: 'mTLS',
    vault_reference: 'Vault reference',
    none: 'None',
  } as Record<string, string>)[value] ?? value
}

function replaceConnector(items: SessionConnector[], next: SessionConnector): SessionConnector[] {
  return items.map((item) => item.catalogId === next.catalogId ? next : item)
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Request failed (${response.status})`)
  return payload as T
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
