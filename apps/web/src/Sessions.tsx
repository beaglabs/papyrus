import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Approval, Artifact, Attachment, Elicitation, Session, SessionEvent } from '@papyrus/contracts'
import { cancelSession, createSession, decideApproval, deleteSession, promptSession, respondElicitation, resumeSession, sessionApprovals, sessionArtifacts, sessionAttachments, sessionElicitations, sessionEvents, sessionPage, uploadAttachment } from './api.js'
import { acpContent, ContentBlock, ContentMessage } from './AcpSessionContent.js'
import { createPortal } from 'react-dom'
import { Alert, Button, Card, Input, Textarea } from './components/ui/index.js'

interface ToolActivity { id: string; title: string; kind: string; status: string; sequence: number; locations: string[]; terminals: string[]; output: Array<Record<string, unknown>> }
interface PlanItem { content: string; status: string; priority: string }
interface PromptTurnGroup { runId: string; sequence: number; events: SessionEvent[] }
export function SessionHarness({ newSessionRequest, onActivate }: { newSessionRequest: number; onActivate: () => void }) {
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
  const [pendingTurn, setPendingTurn] = useState<{ prompt: string; attachments: Attachment[] }>()
  const [error, setError] = useState<string>()
  const [liveError, setLiveError] = useState<string>()
  const [uploading, setUploading] = useState(false)
  const [followingLatest, setFollowingLatest] = useState(true)
  const streamRef = useRef<EventSource | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const newPromptRef = useRef<HTMLTextAreaElement | null>(null)
  const selected = sessions.find((session) => session.id === selectedId)
  const turns = useMemo(() => promptTurns(events), [events])
  const activeRunId = useMemo(() => [...events].reverse().find((event) => event.runId)?.runId, [events])
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
  useEffect(() => { if (!pendingTurn) setRunning(selected?.status === 'running') }, [selectedId, selected?.status, pendingTurn])
  const handledNewSessionRequest = useRef(newSessionRequest)
  useEffect(() => {
    if (handledNewSessionRequest.current === newSessionRequest) return
    handledNewSessionRequest.current = newSessionRequest
    streamRef.current?.close()
    setSelectedId(undefined)
    setPendingTurn(undefined)
    setRunning(false)
    setError(undefined)
    setDraftAttachmentIds([])
    requestAnimationFrame(() => newPromptRef.current?.focus())
  }, [newSessionRequest])
  useEffect(() => {
    if (!followingLatest) return
    const frame = requestAnimationFrame(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [events, running, followingLatest])
  useEffect(() => {
    if (artifactGenerating) setArtifactPanelOpen(true)
    else if (artifacts.length === 0) setArtifactPanelOpen(false)
  }, [artifactGenerating, artifacts.length])
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
    setLiveError(undefined)
    if (!selectedId) { setEvents([]); setArtifacts([]); setApprovals([]); setAttachments([]); setElicitations([]); return }
    setEvents([])
    let active = true
    let stream: EventSource | undefined
    const reconcile = async () => {
      const [history] = await Promise.all([sessionEvents(selectedId), loadContext(selectedId), loadSessions()])
      if (!active) return
      setEvents((current) => mergeSessionEvents(current, history))
    }
    void Promise.all([sessionEvents(selectedId), loadContext(selectedId)]).then(([history]) => {
      if (!active) return
      setEvents(history)
      const after = history.at(-1)?.sequence ?? 0
      stream = new EventSource(`/api/sessions/${encodeURIComponent(selectedId)}/events/stream?after=${after}`)
      stream.addEventListener('session_event', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as SessionEvent
        setEvents((current) => mergeSessionEvents(current, [event]))
        const update = event.data as { sessionUpdate?: string; status?: string; error?: string } | undefined
        if (update?.sessionUpdate === 'user_message_chunk' || update?.sessionUpdate === 'run_started' || event.kind === 'session') {
          setPendingTurn(undefined)
          setRunning(true)
        }
        const terminalRun = update?.sessionUpdate === 'run_completed' && ['completed', 'cancelled', 'failed', 'interrupted'].includes(update.status ?? '')
        if (event.kind === 'complete' || terminalRun) {
          setRunning(false)
          setPendingTurn(undefined)
          if (update?.status === 'failed' && update.error) setError(update.error)
          void Promise.all([loadSessions(), loadContext(selectedId)]).catch(showError)
        } else if (event.kind === 'approval' || event.kind === 'elicitation' || (update?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(update.status ?? ''))) {
          void loadContext(selectedId).catch(showError)
        }
      })
      stream.onopen = () => setLiveError(undefined)
      stream.onerror = () => setLiveError('Live updates are reconnecting. Persisted events will be replayed automatically.')
      streamRef.current = stream
    }).catch(showError)
    const restore = () => { if (document.visibilityState === 'visible') void reconcile().catch(showError) }
    document.addEventListener('visibilitychange', restore)
    window.addEventListener('focus', restore)
    return () => {
      active = false
      stream?.close()
      document.removeEventListener('visibilitychange', restore)
      window.removeEventListener('focus', restore)
    }
  }, [selectedId])

  const startNewSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const prompt = String(new FormData(form).get('prompt')).trim()
    if (!prompt || running) return
    form.reset()
    setPendingTurn({ prompt, attachments: [] })
    setFollowingLatest(true)
    setRunning(true)
    setError(undefined)
    try {
      const session = await createSession(sessionTitle(prompt))
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)])
      setSelectedId(session.id)
      await promptSession(session.id, prompt, [])
      await loadSessions()
    } catch (cause) {
      setPendingTurn(undefined)
      setRunning(false)
      showError(cause)
    }
  }

  const beginNewSession = () => {
    streamRef.current?.close()
    setSelectedId(undefined)
    setPendingTurn(undefined)
    setRunning(false)
    setError(undefined)
    setDraftAttachmentIds([])
    onActivate()
    requestAnimationFrame(() => newPromptRef.current?.focus())
  }

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!selectedId || running) return
    const form = event.currentTarget; const values = new FormData(form); const prompt = String(values.get('prompt')).trim()
    if (!prompt && draftAttachmentIds.length === 0) return
    const submittedAttachments = draftAttachmentIds.flatMap((id) => { const attachment = attachments.find((item) => item.id === id); return attachment ? [attachment] : [] })
    form.reset(); setPendingTurn({ prompt, attachments: submittedAttachments }); setFollowingLatest(true); setRunning(true); setError(undefined)
    try {
      if (selected?.status === 'stopped' || selected?.status === 'failed' || selected?.status === 'interrupted') await resumeSession(selectedId)
      await promptSession(selectedId, prompt, draftAttachmentIds)
      setDraftAttachmentIds([])
      await loadSessions()
    } catch (cause) {
      setPendingTurn(undefined)
      setRunning(false)
      showError(cause)
    }
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
      <div className="session-sidebar-head"><Button variant="ghost" className="new-chat-button" onClick={beginNewSession}><span aria-hidden="true">＋</span> New chat</Button><strong>History</strong></div>
      {loading ? <div className="empty">Loading sessions…</div> : sessions.length ? <div className="session-list">{sessions.map((session) => <Button key={session.id} className={session.id === selectedId ? 'selected' : ''} onClick={() => { setPendingTurn(undefined); setSelectedId(session.id); onActivate() }}><strong>{session.title}</strong><span>{session.status} · {new Date(session.updatedAt).toLocaleString()}</span></Button>)}</div> : <div className="empty">No sessions yet.</div>}
      {nextCursor && <Button className="secondary load-more" onClick={() => void loadSessions(nextCursor)}>Load more</Button>}
    </aside>, historyTarget)}
    <div className={`conversation-panel ${selected ? '' : 'new-session-panel'}`}>
      {(error || liveError) && <Alert className={error ? 'error' : 'connection-notice'}>{error ?? liveError}<Button variant="ghost" onClick={() => { setError(undefined); setLiveError(undefined) }}>×</Button></Alert>}
      {!selected ? <div className="new-session-home"><div className="new-session-intro"><p className="eyebrow">NEW DURABLE SESSION</p><h2>What should we work on?</h2><p>Your first prompt creates the session automatically and keeps the complete governed history.</p></div><form className="new-session-composer" onSubmit={startNewSession}><Textarea ref={newPromptRef} name="prompt" disabled={running} placeholder="Describe the work to perform…" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /><div className="new-session-controls"><span className="new-session-note">Your deployment’s approved runtime and access assignments are applied automatically.</span><Button className="primary" disabled={running}>{running ? 'Starting…' : 'Start →'}</Button></div></form></div> : <>
        <div className="conversation-head"><div><strong>{selected.title}</strong><span>{selected.status}</span></div><div className="session-actions">{(running || selected.status === 'running') ? <Button className="danger" onClick={() => void cancel()}>Cancel run</Button> : <Button className="text-button" onClick={() => void removeSession()}>Delete</Button>}</div></div>
        <div className={`session-content ${artifactPanelOpen ? 'artifact-panel-open' : ''}`}>
          <div className="message-region">
            <div className="messages" ref={messagesRef} aria-live="polite" onScroll={(event) => {
              const element = event.currentTarget
              setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 72)
            }}>{turns.length ? turns.map((turn) => <DurablePromptTurn key={turn.runId} turn={turn} running={running && turn.runId === activeRunId} />) : !pendingTurn && <div className="conversation-empty compact"><h2>What should Papyrus do?</h2><p>Attach context or describe the work.</p></div>}{pendingTurn && <><ContentMessage message={pendingContent(pendingTurn)} /><PromptTurnFlow events={[]} running submitted /></>}{artifacts.length > 0 && <ArtifactCards artifacts={artifacts} onOpen={(id) => { setSelectedArtifactId(id); setArtifactPanelOpen(true) }} />}</div>
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

function pendingContent(turn: { prompt: string; attachments: Attachment[] }) {
  return {
    id: 'pending-user-turn',
    role: 'user' as const,
    sequence: Number.MAX_SAFE_INTEGER,
    blocks: [
      ...(turn.prompt ? [{ type: 'text', text: turn.prompt }] : []),
      ...turn.attachments.map((attachment) => ({ type: 'resource_link', uri: attachment.downloadUrl, name: attachment.name, title: attachment.name, mimeType: attachment.mediaType, size: attachment.size })),
    ],
  }
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

function sessionTitle(prompt: string) { const title = prompt.replace(/\s+/g, ' ').trim(); return title.length > 72 ? `${title.slice(0, 69)}…` : title }
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

function PromptTurnFlow({ events, running, submitted }: { events: SessionEvent[]; running: boolean; submitted: boolean }) {
  let turnStart = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'update' && event.data && typeof event.data === 'object' && (event.data as { sessionUpdate?: string }).sessionUpdate === 'user_message_chunk') {
      turnStart = index
      break
    }
  }
  const turnEvents = submitted ? [] : turnStart >= 0 ? events.slice(turnStart + 1) : []
  const { plan, tools } = projectActivity(turnEvents)
  if (!running && plan.length === 0 && tools.length === 0) return null
  const activeTool = [...tools].reverse().find((tool) => tool.status === 'in_progress' || tool.status === 'pending')
  const hasModelStream = turnEvents.some((event) => event.kind === 'update' && event.data && typeof event.data === 'object' && ['agent_thought_chunk', 'agent_message_chunk'].includes(String((event.data as { sessionUpdate?: string }).sessionUpdate)))
  const status = activeTool ? `Running ${activeTool.title}`
    : running && hasModelStream ? 'Receiving model stream'
    : running && submitted ? 'Starting governed turn'
    : running ? 'Waiting for model stream'
    : 'Tool activity complete'
  return <section className="prompt-turn-flow" aria-live="polite">
    <div className="prompt-turn-status"><span className="dot good" /><strong>{status}</strong>{running && <span className="streaming-cursor" aria-hidden="true">▌</span>}</div>
    {plan.length > 0 && <ol className="prompt-turn-plan">{plan.map((item, index) => <li key={`${index}-${item.content}`} className={item.status}><span className={`activity-status ${item.status}`} />{item.content}</li>)}</ol>}
    {tools.length > 0 && <div className="prompt-turn-tools">{tools.map((tool) => <Card key={tool.id} className={`prompt-turn-tool ${tool.status}`}><span className={`tool-kind ${tool.kind}`}>{tool.kind}</span><div><strong>{tool.title}</strong><small>{tool.locations.join(' · ') || tool.id}</small>{tool.output.length > 0 && <div className="tool-live-output">{tool.output.map((block, index) => <ContentBlock key={index} block={block} />)}</div>}</div><span className={`pill ${tool.status}`}>{tool.status.replace('_', ' ')}</span></Card>)}</div>}
  </section>
}

function projectActivity(events: SessionEvent[]): { plan: PlanItem[]; tools: ToolActivity[] } {
  let plan: PlanItem[] = []
  const tools = new Map<string, ToolActivity>()
  for (const event of events) {
    if (event.kind !== 'update' || !event.data || typeof event.data !== 'object') continue
    const update = event.data as { sessionUpdate?: string; entries?: PlanItem[]; toolCallId?: string; title?: string; kind?: string; status?: string; locations?: Array<{ path?: string }>; content?: Array<{ type?: string; terminalId?: string; content?: unknown }> }
    if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) plan = update.entries
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
      const current = tools.get(update.toolCallId)
      tools.set(update.toolCallId, {
        id: update.toolCallId, title: update.title ?? current?.title ?? 'Tool activity', kind: update.kind ?? current?.kind ?? 'other',
        status: update.status ?? current?.status ?? 'pending', sequence: current?.sequence ?? event.sequence,
        locations: update.locations?.flatMap((location) => typeof location.path === 'string' ? [location.path] : []) ?? current?.locations ?? [],
        terminals: update.content?.flatMap((content) => content.type === 'terminal' && content.terminalId ? [content.terminalId] : []) ?? current?.terminals ?? [],
        output: update.content?.flatMap((content) => content.type === 'content' && content.content && typeof content.content === 'object' && !Array.isArray(content.content) ? [content.content as Record<string, unknown>] : []) ?? current?.output ?? [],
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
