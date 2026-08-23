import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Approval, Artifact, Attachment, Elicitation, Environment, Session, SessionEvent } from '@papyrus/contracts'
import { cancelSession, createSession, decideApproval, deleteSession, promptSession, respondElicitation, resumeSession, sessionApprovals, sessionArtifacts, sessionAttachments, sessionElicitations, sessionEvents, sessionPage, uploadAttachment } from './api.js'
import { SelectField } from './SelectField.js'
import { acpContent, ContentMessage } from './AcpSessionContent.js'
import { createPortal } from 'react-dom'
import { Alert, Button, Card, Dialog, DialogContent, DialogHeader, Input, Textarea } from './components/ui/index.js'

interface ToolActivity { id: string; title: string; kind: string; status: string; sequence: number; locations: string[]; terminals: string[] }
interface PlanItem { content: string; status: string; priority: string }
export function SessionHarness({ environments }: { environments: Environment[] }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [elicitations, setElicitations] = useState<Elicitation[]>([])
  const [draftAttachmentIds, setDraftAttachmentIds] = useState<string[]>([])
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const knownArtifactCount = useRef(0)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()
  const [uploading, setUploading] = useState(false)
  const [followingLatest, setFollowingLatest] = useState(true)
  const streamRef = useRef<EventSource | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const selected = sessions.find((session) => session.id === selectedId)
  const messages = useMemo(() => acpContent(events), [events])
  const activeThoughtId = useMemo(() => [...messages].reverse().find((message) => message.role === 'thought')?.id, [messages])
  const artifactGenerating = useMemo(() => running && isArtifactGenerationActive(events), [events, running])

  const loadContext = async (sessionId: string) => {
    const [nextArtifacts, nextApprovals, nextAttachments, nextElicitations] = await Promise.all([sessionArtifacts(sessionId), sessionApprovals(sessionId), sessionAttachments(sessionId), sessionElicitations(sessionId)])
    setArtifacts(nextArtifacts); setApprovals(nextApprovals); setAttachments(nextAttachments); setElicitations(nextElicitations)
  }

  const loadSessions = async (cursor?: string) => {
    const page = await sessionPage(cursor)
    setSessions((current) => cursor ? [...current, ...page.sessions.filter((item) => !current.some((existing) => existing.id === item.id))] : page.sessions)
    setNextCursor(page.nextCursor)
    if (!cursor && !selectedId) setSelectedId(page.sessions[0]?.id)
  }

  useEffect(() => { void loadSessions().catch(showError).finally(() => setLoading(false)) }, [])
  useEffect(() => {
    if (!followingLatest) return
    const frame = requestAnimationFrame(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [messages, running, followingLatest])
  useEffect(() => {
    if (artifactGenerating) setArtifactPanelOpen(true)
  }, [artifactGenerating])
  useEffect(() => {
    if (artifacts.length > knownArtifactCount.current) {
      setSelectedArtifactId(artifacts.at(-1)?.id)
      if (running) setArtifactPanelOpen(true)
    }
    knownArtifactCount.current = artifacts.length
  }, [artifacts, running])

  useEffect(() => {
    streamRef.current?.close()
    setFollowingLatest(true)
    setDraftAttachmentIds([])
    if (!selectedId) { setEvents([]); setArtifacts([]); setApprovals([]); setAttachments([]); setElicitations([]); return }
    let active = true
    void Promise.all([sessionEvents(selectedId), loadContext(selectedId)]).then(([history]) => {
      if (!active) return
      setEvents(history)
      const after = history.at(-1)?.sequence ?? 0
      const stream = new EventSource(`/api/sessions/${encodeURIComponent(selectedId)}/events/stream?after=${after}`)
      stream.addEventListener('session_event', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as SessionEvent
        setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event])
        const update = event.data as { sessionUpdate?: string; status?: string } | undefined
        if (event.kind === 'approval' || event.kind === 'elicitation' || (update?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status ?? ''))) {
          void loadContext(selectedId).catch(showError)
        }
      })
      stream.onerror = () => setError('Live updates were interrupted. Papyrus will retry automatically.')
      streamRef.current = stream
    }).catch(showError)
    return () => { active = false; streamRef.current?.close() }
  }, [selectedId])

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(undefined)
    const form = event.currentTarget; const values = new FormData(form)
    try {
      const environmentId = values.get('environment')
      if (typeof environmentId !== 'string' || !environmentId) throw new Error('Choose an environment')
      const session = await createSession(environmentId, String(values.get('title')))
      setSessions((current) => [session, ...current]); setSelectedId(session.id); setCreating(false); form.reset()
    } catch (cause) { showError(cause) }
  }

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selectedId || running) return
    const form = event.currentTarget; const values = new FormData(form); const prompt = String(values.get('prompt')).trim()
    if (!prompt && draftAttachmentIds.length === 0) return
    form.reset(); setRunning(true); setError(undefined)
    try {
      if (selected?.status === 'stopped' || selected?.status === 'failed' || selected?.status === 'interrupted') await resumeSession(selectedId)
      await promptSession(selectedId, prompt, draftAttachmentIds)
      setDraftAttachmentIds([])
      await Promise.all([loadSessions(), loadContext(selectedId)])
    } catch (cause) { showError(cause) }
    finally { setRunning(false) }
  }

  const cancel = async () => {
    if (!selectedId) return
    try { await cancelSession(selectedId); setRunning(false); await loadSessions() } catch (cause) { showError(cause) }
  }

  const removeSession = async () => {
    if (!selectedId || !selected || !window.confirm(`Permanently delete “${selected.title}” and its durable history?`)) return
    try { await deleteSession(selectedId); setSelectedId(undefined); await loadSessions() } catch (cause) { showError(cause) }
  }

  const addFiles = async (files: FileList | null) => {
    if (!selectedId || !files?.length) return
    setUploading(true); setError(undefined)
    try {
      const uploaded: Attachment[] = []
      for (const file of Array.from(files)) uploaded.push(await uploadAttachment(selectedId, file))
      setAttachments((current) => [...uploaded, ...current])
      setDraftAttachmentIds((current) => [...new Set([...current, ...uploaded.map((item) => item.id)])])
    } catch (cause) { showError(cause) }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  const reviewApproval = async (approvalId: string, decision: 'approved' | 'denied', reason?: string) => {
    if (!selectedId) return
    try { await decideApproval(selectedId, approvalId, decision, reason); await loadContext(selectedId) }
    catch (cause) { showError(cause) }
  }

  function showError(cause: unknown) { setError(cause instanceof Error ? cause.message : 'Session request failed') }

  const historyTarget = document.getElementById('session-history-rail')
  return <section className="session-layout">
    {historyTarget && createPortal(<aside className="session-sidebar">
      <div className="session-sidebar-head"><strong>Durable sessions</strong><Button className="icon-button" onClick={() => setCreating(true)} aria-label="Create session">＋</Button></div>
      {loading ? <div className="empty">Loading sessions…</div> : sessions.length ? <div className="session-list">{sessions.map((session) => <Button key={session.id} className={session.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(session.id)}><strong>{session.title}</strong><span>{session.status} · {new Date(session.updatedAt).toLocaleString()}</span></Button>)}</div> : <div className="empty">No sessions yet.</div>}
      {nextCursor && <Button className="secondary load-more" onClick={() => void loadSessions(nextCursor)}>Load more</Button>}
    </aside>, historyTarget)}
    <div className="conversation-panel">
      {error && <Alert className="error">{error}<Button variant="ghost" onClick={() => setError(undefined)}>×</Button></Alert>}
      <Dialog open={creating} onOpenChange={setCreating}><DialogContent className="create-session-dialog"><form className="create-session" onSubmit={create}><DialogHeader><div><p className="eyebrow">NEW SESSION</p><strong>New durable session</strong></div><Button type="button" variant="ghost" className="icon-button" onClick={() => setCreating(false)} aria-label="Close new session dialog">×</Button></DialogHeader><SelectField name="environment" label="Environment" placeholder="Choose an environment" options={environments.map((environment) => ({ value: environment.id, label: environment.name, ...(environment.description ? { detail: environment.description } : {}) }))} /><label>Session title<Input name="title" required maxLength={256} autoFocus placeholder="Describe the work" /></label><Button className="primary" disabled={!environments.length}>Create session →</Button></form></DialogContent></Dialog>
      {!selected ? <div className="conversation-empty"><h2>Start a session.</h2><p>Choose an authorized environment, describe the work, and retain the complete history on the server.</p><Button className="primary" disabled={!environments.length} onClick={() => setCreating(true)}>New session →</Button></div> : <>
        <div className="conversation-head"><div><strong>{selected.title}</strong><span>{selected.status} · {environmentName(environments, selected.environmentId)}</span></div><div className="session-actions">{(running || selected.status === 'running') ? <Button className="danger" onClick={() => void cancel()}>Cancel run</Button> : <Button className="text-button" onClick={() => void removeSession()}>Delete</Button>}</div></div>
        <div className={`session-content ${artifactPanelOpen ? 'artifact-panel-open' : ''}`}>
          <div className="message-region">
            <div className="messages" ref={messagesRef} aria-live="polite" onScroll={(event) => {
              const element = event.currentTarget
              setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 72)
            }}>{messages.length ? messages.map((message) => <ContentMessage message={message} active={running && message.id === activeThoughtId} key={message.id} />) : <div className="conversation-empty compact"><h2>What should Papyrus do?</h2><p>Attach context or describe the work.</p></div>}<PromptTurnFlow events={events} running={running} />{artifacts.length > 0 && <ArtifactCards artifacts={artifacts} onOpen={(id) => { setSelectedArtifactId(id); setArtifactPanelOpen(true) }} />}</div>
            {!followingLatest && <Button className="jump-latest" onClick={() => { setFollowingLatest(true); messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }) }}>Jump to latest ↓</Button>}
          </div>
          <ArtifactWorkspace artifacts={artifacts} generating={artifactGenerating} open={artifactPanelOpen} selectedId={selectedArtifactId} onOpenChange={setArtifactPanelOpen} onSelect={setSelectedArtifactId} />
        </div>
        <div className="session-footer">
        {approvals.filter((approval) => approval.status === 'pending').map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecision={reviewApproval} />)}
        {elicitations.find((item) => item.status === 'pending') && <ElicitationCard item={elicitations.find((item) => item.status === 'pending')!} onRespond={async (id, response) => { await respondElicitation(selected.id, id, response); await loadContext(selected.id) }} />}
        <form className="composer" onSubmit={send}>
          {draftAttachmentIds.length > 0 && <div className="attachment-chips">{draftAttachmentIds.map((id) => { const attachment = attachments.find((item) => item.id === id); return attachment && <span key={id}><span>↧ {attachment.name} · {formatBytes(attachment.size)}</span><Button type="button" onClick={() => setDraftAttachmentIds((current) => current.filter((item) => item !== id))} aria-label={`Remove ${attachment.name}`}>×</Button></span> })}</div>}
          <Textarea name="prompt" disabled={running} placeholder={draftAttachmentIds.length ? 'Add instructions for these files…' : 'Describe the work to perform…'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
          <Input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="text/*,image/*,.pdf,.json,.xml,.zip,.docx,.xlsx,.pptx" onChange={(event) => void addFiles(event.currentTarget.files)} />
          <div><span>Enter to submit · Shift+Enter for a new line · 10 MB per file</span><div className="composer-actions"><Button type="button" className="attach-button" disabled={running || uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? 'Uploading…' : 'Attach files'}</Button><Button className="primary" disabled={running || uploading}>{running ? 'Running…' : 'Send →'}</Button></div></div>
        </form>
        </div>
      </>}
    </div>
  </section>
}

function ElicitationCard({ item, onRespond }: { item: Elicitation; onRespond: (id: string, response: Record<string, unknown>) => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true)
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    try { await onRespond(item.id, { action: 'accept', content: values }) } finally { setSaving(false) }
  }
  const schema = item.request.requestedSchema as { properties?: Record<string, { title?: string; description?: string; type?: string }> } | undefined
  return <form className="elicitation-card" onSubmit={submit}><div><span>INPUT REQUIRED</span><strong>{String(item.request.message ?? 'The agent needs more information')}</strong></div>{Object.entries(schema?.properties ?? { response: { title: 'Response', type: 'string' } }).map(([name, field]) => <label key={name}>{field.title ?? name}<Input name={name} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} required />{field.description && <small>{field.description}</small>}</label>)}<div><Button type="button" className="secondary" disabled={saving} onClick={() => void onRespond(item.id, { action: 'decline' })}>Decline</Button><Button className="primary" disabled={saving}>{saving ? 'Sending…' : 'Continue →'}</Button></div></form>
}

function environmentName(environments: Environment[], id: string) { return environments.find((environment) => environment.id === id)?.name ?? 'Environment' }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` }

function ArtifactWorkspace({ artifacts, generating, open, selectedId, onOpenChange, onSelect }: { artifacts: Artifact[]; generating: boolean; open: boolean; selectedId: string | undefined; onOpenChange: (open: boolean) => void; onSelect: (id: string) => void }) {
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts.at(-1)
  if (!open) return null
  return <aside className="artifact-workspace" aria-label="Generated artifact preview">
    <div className="artifact-workspace-head"><div><span>ARTIFACT</span><strong>{generating ? 'Generating…' : selected?.name ?? 'Preview'}</strong></div><Button variant="ghost" onClick={() => onOpenChange(false)} aria-label="Close artifact preview">×</Button></div>
    {generating && <div className="artifact-generating"><span className="artifact-orbit" aria-hidden="true" /><div><strong>Building an artifact</strong><span>Structured output will render here as it arrives.</span></div><div className="artifact-skeleton"><i /><i /><i /></div></div>}
    {artifacts.length > 0 && <div className="artifact-browser">
      <nav aria-label="Generated artifacts">{artifacts.map((artifact) => <Button key={artifact.id} variant="ghost" className={artifact.id === selected?.id ? 'selected' : ''} onClick={() => onSelect(artifact.id)}><span>{artifactIcon(artifact)}</span><span><strong>{artifact.name}</strong><small>{artifact.mediaType} · v{artifact.version}</small></span></Button>)}</nav>
      {selected && <div className="artifact-preview">
        <div className="artifact-preview-meta"><span>{selected.mediaType}</span><a href={selected.downloadUrl}>Download ↓</a></div>
        {selected.mediaType.startsWith('image/') ? <img src={`${selected.downloadUrl}?preview=1`} alt={selected.name} />
          : selected.mediaType === 'application/pdf' ? <object data={`${selected.downloadUrl}?preview=1`} type="application/pdf"><a href={selected.downloadUrl}>Open {selected.name}</a></object>
          : <iframe title={selected.name} src={`${selected.downloadUrl}?preview=1`} sandbox="" />}
      </div>}
    </div>}
    {!generating && artifacts.length === 0 && <div className="artifact-empty"><span>▤</span><strong>No outputs yet</strong><p>Generated files, images, structured data, and diffs will open here automatically.</p></div>}
  </aside>
}

function artifactIcon(artifact: Artifact): string {
  if (artifact.mediaType.startsWith('image/')) return '▧'
  if (artifact.kind === 'diff') return 'Δ'
  if (artifact.mediaType.includes('json') || artifact.mediaType.includes('csv')) return '⌗'
  return '▤'
}

function isArtifactGenerationActive(events: SessionEvent[]): boolean {
  const { tools } = projectActivity(events)
  return tools.some((tool) => ['pending', 'in_progress'].includes(tool.status) && (tool.kind === 'edit' || /generate|write|render|export|artifact|image/i.test(tool.title)))
}

function ArtifactCards({ artifacts, onOpen }: { artifacts: Artifact[]; onOpen: (id: string) => void }) {
  return <section className="artifact-cards" aria-label="Generated artifacts">
    <span>GENERATED</span>
    <div>{artifacts.map((artifact) => <Button key={artifact.id} variant="ghost" onClick={() => onOpen(artifact.id)}>
      <span className="artifact-card-icon">{artifactIcon(artifact)}</span>
      <span><strong>{artifact.name}</strong><small>{artifact.mediaType} · version {artifact.version}</small></span>
      <span aria-hidden="true">↗</span>
    </Button>)}</div>
  </section>
}

function PromptTurnFlow({ events, running }: { events: SessionEvent[]; running: boolean }) {
  let turnStart = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'update' && event.data && typeof event.data === 'object' && (event.data as { sessionUpdate?: string }).sessionUpdate === 'user_message_chunk') {
      turnStart = index
      break
    }
  }
  const turnEvents = turnStart >= 0 ? events.slice(turnStart + 1) : []
  const { plan, tools } = projectActivity(turnEvents)
  if (plan.length === 0 && tools.length === 0) return null
  const activeTool = [...tools].reverse().find((tool) => tool.status === 'in_progress' || tool.status === 'pending')
  const status = activeTool ? `Running ${activeTool.title}`
    : running ? 'Continuing with tool results'
    : 'Tool activity complete'
  return <section className="prompt-turn-flow" aria-live="polite">
    <div className="prompt-turn-status"><span className="dot good" /><strong>{status}</strong>{running && <span className="streaming-cursor" aria-hidden="true">▌</span>}</div>
    {plan.length > 0 && <ol className="prompt-turn-plan">{plan.map((item, index) => <li key={`${index}-${item.content}`} className={item.status}><span className={`activity-status ${item.status}`} />{item.content}</li>)}</ol>}
    {tools.length > 0 && <div className="prompt-turn-tools">{tools.map((tool) => <Card key={tool.id} className={`prompt-turn-tool ${tool.status}`}><span className={`tool-kind ${tool.kind}`}>{tool.kind}</span><div><strong>{tool.title}</strong><small>{tool.locations.join(' · ') || tool.id}</small></div><span className={`pill ${tool.status}`}>{tool.status.replace('_', ' ')}</span></Card>)}</div>}
  </section>
}

function projectActivity(events: SessionEvent[]): { plan: PlanItem[]; tools: ToolActivity[] } {
  let plan: PlanItem[] = []
  const tools = new Map<string, ToolActivity>()
  for (const event of events) {
    if (event.kind !== 'update' || !event.data || typeof event.data !== 'object') continue
    const update = event.data as { sessionUpdate?: string; entries?: PlanItem[]; toolCallId?: string; title?: string; kind?: string; status?: string; locations?: Array<{ path?: string }>; content?: Array<{ type?: string; terminalId?: string }> }
    if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) plan = update.entries
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
      const current = tools.get(update.toolCallId)
      tools.set(update.toolCallId, {
        id: update.toolCallId, title: update.title ?? current?.title ?? 'Tool activity', kind: update.kind ?? current?.kind ?? 'other',
        status: update.status ?? current?.status ?? 'pending', sequence: current?.sequence ?? event.sequence,
        locations: update.locations?.flatMap((location) => typeof location.path === 'string' ? [location.path] : []) ?? current?.locations ?? [],
        terminals: update.content?.flatMap((content) => content.type === 'terminal' && content.terminalId ? [content.terminalId] : []) ?? current?.terminals ?? [],
      })
    }
  }
  return { plan, tools: [...tools.values()].sort((left, right) => left.sequence - right.sequence) }
}

function ApprovalCard({ approval, onDecision }: { approval: Approval; onDecision: (id: string, decision: 'approved' | 'denied', reason?: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const decide = async (decision: 'approved' | 'denied') => { setSaving(true); try { await onDecision(approval.id, decision, reason) } finally { setSaving(false) } }
  return <Card className="approval-card"><div><span className="approval-kicker">TOOL PERMISSION</span><strong>{approval.toolTitle}</strong><span>Requested {new Date(approval.requestedAt).toLocaleString()}</span></div><label>Decision rationale (optional)<Textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="Why is this action appropriate or denied?" /></label><div className="approval-actions"><Button className="danger" disabled={saving} onClick={() => void decide('denied')}>Deny</Button><Button className="primary" disabled={saving} onClick={() => void decide('approved')}>{saving ? 'Saving…' : 'Approve'}</Button></div></Card>
}
