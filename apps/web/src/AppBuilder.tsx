import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import type { AppConnectorGrant, HostedApp, NamedPolicy } from '@papyrus/contracts'
import { sessionMessages } from './api.js'
import { Alert, Badge, Button, Textarea } from './components/ui/index.js'
import './app-builder.css'

export async function appRequest<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  const value = await response.json() as { error?: string }
  if (!response.ok) throw new Error(value.error ?? 'Request failed')
  return value as T
}

interface ProjectSnapshot { files: Record<string, string>; revision: string }
interface Frame { url: string; ticket: string; nonce: string }
interface AppDetail { app: HostedApp; grants: AppConnectorGrant[]; policies: NamedPolicy[] }

/**
 * The App Link authoring surface intentionally lives inside Links. There is no
 * separate app IDE: Papyrus owns the project and the operator steers it through
 * the same durable session that created it.
 */
export function AppLinkWorkspace({ app, onBack, onChanged }: {
  app: HostedApp
  onBack: () => void
  onChanged?: () => void
}) {
  const [detail, setDetail] = useState<AppDetail>()
  const [error, setError] = useState<string>()
  const [status, setStatus] = useState('Preparing software factory…')
  const [releaseId, setReleaseId] = useState('')
  const [revision, setRevision] = useState('')
  const [frame, setFrame] = useState<Frame>()
  const [publishing, setPublishing] = useState(false)
  const buildRef = useRef({ running: false, seen: '', failed: '' })

  const refreshDetail = async () => {
    const next = await appRequest<AppDetail>(`/api/apps/${encodeURIComponent(app.id)}`)
    setDetail(next)
  }

  useEffect(() => {
    let active = true
    void refreshDetail().catch((cause) => { if (active) setError(message(cause)) })

    const refreshPreview = async () => {
      if (buildRef.current.running) return
      try {
        const project = await appRequest<ProjectSnapshot>(`/api/apps/${encodeURIComponent(app.id)}/files`)
        if (!active) return
        if (project.revision === buildRef.current.seen || project.revision === buildRef.current.failed) return
        buildRef.current.running = true
        setStatus(buildRef.current.seen ? 'Agent changed the app · rebuilding preview…' : 'Building first preview…')
        try {
          const built = await appRequest<{ releaseId: string; revision: string }>(`/api/apps/${encodeURIComponent(app.id)}/build`, 'POST', {})
          const latest = await appRequest<ProjectSnapshot>(`/api/apps/${encodeURIComponent(app.id)}/files`)
          if (latest.revision !== built.revision) return
          const nextFrame = await appRequest<Frame>(`/api/apps/${encodeURIComponent(app.id)}/frame`, 'POST', { releaseId: built.releaseId })
          if (!active) return
          setReleaseId(built.releaseId)
          setRevision(built.revision)
          setFrame(nextFrame)
          buildRef.current.seen = built.revision
          buildRef.current.failed = ''
          setStatus('Preview synchronized with the agent')
          setError(undefined)
        } catch (cause) {
          buildRef.current.failed = project.revision
          if (active) {
            setStatus('Build needs attention · last good preview retained')
            setError(message(cause))
          }
        } finally {
          buildRef.current.running = false
        }
      } catch (cause) {
        if (active) setError(message(cause))
      }
    }

    void refreshPreview()
    const previewTimer = window.setInterval(() => { void refreshPreview() }, 2_500)
    const detailTimer = window.setInterval(() => { void refreshDetail().catch(() => undefined) }, 10_000)
    return () => {
      active = false
      window.clearInterval(previewTimer)
      window.clearInterval(detailTimer)
    }
  }, [app.id])

  const requestPublication = async () => {
    if (!releaseId || publishing) return
    setPublishing(true)
    setError(undefined)
    try {
      await appRequest(`/api/apps/${encodeURIComponent(app.id)}/publish`, 'POST', { releaseId })
      setStatus('Publication proposal sent to Governance')
      await refreshDetail()
      onChanged?.()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setPublishing(false)
    }
  }

  const grants = detail?.grants ?? []
  const policies = detail?.policies ?? []
  const live = Boolean(detail?.app.liveReleaseId ?? app.liveReleaseId)

  return <section className="app-link-workspace">
    <header className="app-link-head">
      <div className="app-link-title-row">
        <Button variant="ghost" onClick={onBack}>← Links</Button>
        <div>
          <p className="eyebrow">APP LINK · AGENTIC SOFTWARE FACTORY</p>
          <h2>{app.name}</h2>
          <p>Prompt Papyrus, watch the isolated preview update, then release an immutable build through Governance.</p>
        </div>
      </div>
      <div className="app-link-actions">
        <Badge className={live ? 'status-good' : ''}>{live ? 'LIVE' : 'DRAFT'}</Badge>
        <Button disabled={!releaseId || publishing} onClick={() => void requestPublication()}>{publishing ? 'Requesting…' : 'Request publication'}</Button>
        {live && <a className="app-open-live" href={`/a/${encodeURIComponent(app.id)}`} target="_blank" rel="noreferrer">Open live ↗</a>}
      </div>
    </header>

    {error && <Alert className="error"><strong>Factory attention</strong><span>{error}</span></Alert>}

    <div className="app-link-grid">
      <AppConversation app={app} onActivity={() => {
        buildRef.current.failed = ''
        setStatus('Papyrus is updating the app…')
      }} />
      <section className="app-factory-preview">
        <div className="app-panel-head">
          <div><span className="app-panel-kicker">LIVE PREVIEW</span><strong>{status}</strong></div>
          <div className="app-factory-dots"><span /><span /><span /></div>
        </div>
        <div className="app-preview-stage">
          {frame
            ? <AppFrame frame={frame} appId={app.id} />
            : <div className="app-preview-empty"><span>▣</span><strong>Waiting for the first successful build</strong><p>Papyrus creates the project, reads the connected sources it needs, writes the app, and builds it here.</p></div>}
        </div>
        <div className="app-build-strip">
          <span><small>REVISION</small>{revision ? revision.slice(0, 10) : '—'}</span>
          <span><small>AUTH</small>Inherited Entra</span>
          <span><small>RUNTIME GRANTS</small>{grants.filter((grant) => grant.operations.length).length}</span>
          <span><small>POLICIES</small>{policies.length}</span>
          <Button variant="ghost" onClick={() => { buildRef.current.failed = ''; buildRef.current.seen = ''; setStatus('Rebuilding preview…') }}>Rebuild</Button>
        </div>
      </section>
    </div>

    <section className="app-link-governance">
      <div>
        <p className="eyebrow">PRODUCTION BOUNDARY</p>
        <h3>Connector access and policy stay governed</h3>
        <p>The authoring session can read only its attached connectors. A live App Link receives only explicit operations approved through Governance; the agent cannot promote preview authority into production.</p>
      </div>
      <div className="app-runtime-summary">
        {grants.length === 0 && <span className="app-runtime-empty">No production connector grants</span>}
        {grants.map((grant) => <span className="app-runtime-chip" key={grant.integrationId}><strong>{grant.integrationId}</strong>{grant.operations.length ? grant.operations.join(', ') : 'revoked'}</span>)}
        {policies.map((policy) => <span className="app-runtime-chip policy" key={policy.id}><strong>{policy.name}</strong>v{policy.version}</span>)}
      </div>
    </section>
  </section>
}

function AppConversation({ app, onActivity }: { app: HostedApp; onActivity: () => void }) {
  const [initial, setInitial] = useState<UIMessage[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    setInitial(undefined)
    setError(undefined)
    sessionMessages(app.sessionId).then((messages) => { if (active) setInitial(messages) }).catch((cause) => { if (active) setError(message(cause)) })
    return () => { active = false }
  }, [app.sessionId])

  return <section className="app-agent-panel">
    <div className="app-panel-head">
      <div><span className="app-panel-kicker">PAPYRUS</span><strong>Build this App Link with the agent</strong></div>
      <Badge>SESSION {app.sessionId.slice(0, 8)}</Badge>
    </div>
    {error && <Alert className="error">{error}</Alert>}
    {initial === undefined
      ? <div className="app-conversation-loading"><span /><span /><span /></div>
      : <AppChat key={`${app.sessionId}:${initial.length}`} app={app} initial={initial} onActivity={onActivity} />}
  </section>
}

function AppChat({ app, initial, onActivity }: { app: HostedApp; initial: UIMessage[]; onActivity: () => void }) {
  const [prompt, setPrompt] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({
    api: '/api/agent/chat',
    credentials: 'same-origin',
    prepareSendMessagesRequest: ({ messages }) => ({ body: { threadId: app.sessionId, messages: messages.slice(-1) } }),
  }), [app.sessionId])
  const chat = useChat({ id: app.sessionId, messages: initial, transport })
  const working = chat.status === 'streaming' || chat.status === 'submitted'

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [chat.messages, working])

  const submit = async () => {
    const text = prompt.trim()
    if (!text || working) return
    setPrompt('')
    onActivity()
    await chat.sendMessage({
      text: `Continue the App Link "${app.name}" (${app.id}) that belongs to this session. Use the agentic app factory and app_factory_code when useful; inspect session connectors instead of inventing data. Do not bypass Governance for publication or production connector authority. Requested change: ${text}`,
    })
  }

  return <>
    <div ref={listRef} className="app-conversation" aria-live="polite">
      {chat.messages.length === 0 && <div className="app-chat-welcome"><span>✦</span><strong>Describe the app you want.</strong><p>Papyrus will own the structure, gather from connected sources, write the project, and keep iterating in this same session.</p></div>}
      {chat.messages.map((messageItem) => <article className={`app-chat-message ${messageItem.role}`} key={messageItem.id}>
        <small>{messageItem.role === 'user' ? 'YOU' : 'PAPYRUS'}</small>
        {messageItem.parts.map((part, index) => part.type === 'text' ? <p key={index}>{part.text}</p> : isToolPart(part) ? <div className="app-tool-event" key={index}>Factory operation · {toolName(part.type)}</div> : null)}
      </article>)}
      {working && <div className="app-agent-working"><span /><span /><span /> Papyrus is building</div>}
      {chat.error && <Alert className="error">{chat.error.message}</Alert>}
    </div>
    <form className="app-prompt" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Change the app, connect data, add a view, fix the layout…" rows={4} />
      <div className="app-prompt-foot">
        <span>AgentFS · Code Mode · session-scoped connectors</span>
        {working
          ? <Button type="button" onClick={() => chat.stop()}>Stop</Button>
          : <Button className="primary" type="submit" disabled={!prompt.trim()}>Send ↑</Button>}
      </div>
    </form>
  </>
}

function AppFrame({ frame, appId }: { frame: Frame; appId: string }) {
  const iframe = useRef<HTMLIFrameElement>(null)
  const form = useRef<HTMLFormElement>(null)
  const target = useRef(`frame-${crypto.randomUUID()}`)

  useEffect(() => {
    form.current?.submit()
    const receive = async (event: MessageEvent) => {
      const data = event.data
      if (event.source !== iframe.current?.contentWindow || event.origin !== 'null' || !data?.papyrusApp || data.nonce !== frame.nonce) return
      try {
        const result = await appRequest(
          `/api/apps/${encodeURIComponent(appId)}/${data.operation === 'proposeAction' ? 'actions' : 'invoke'}`,
          'POST',
          data.operation === 'proposeAction'
            ? { ...data.input, integrationId: data.integrationId, nonce: frame.nonce }
            : { ...data, nonce: frame.nonce },
        )
        iframe.current?.contentWindow?.postMessage({ nonce: frame.nonce, id: data.id, result }, '*')
      } catch (cause) {
        iframe.current?.contentWindow?.postMessage({ nonce: frame.nonce, id: data.id, error: message(cause) }, '*')
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [frame, appId])

  return <>
    <iframe ref={iframe} name={target.current} sandbox="allow-scripts" title="App Link preview" />
    <form ref={form} method="POST" target={target.current} action={frame.url}>
      <input type="hidden" name="ticket" value={frame.ticket} />
      <input type="hidden" name="nonce" value={frame.nonce} />
    </form>
  </>
}

function isToolPart(part: UIMessage['parts'][number]): boolean {
  return typeof part.type === 'string' && (part.type.startsWith('tool-') || part.type === 'dynamic-tool')
}

function toolName(type: string): string {
  return type.replace(/^tool-/, '').replace(/_/g, ' ')
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
