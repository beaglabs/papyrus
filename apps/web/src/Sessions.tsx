import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from 'react'
import type { Approval, Artifact, Attachment, Elicitation, Environment, ResearchSource, Session, SessionEvent, SessionRun, SessionSurface } from '@papyrus/contracts'
import { cancelSession, createSession, decideApproval, deleteSession, promptSession, respondElicitation, resumeSession, sessionApprovals, sessionArtifacts, sessionAttachments, sessionElicitations, sessionEvents, sessionPage, sessionRuns, sessionSources, setSessionConfigOption, uploadAttachment } from './api.js'
import { SourceList } from './Sources.js'
import { SelectField } from './SelectField.js'
import { acpContent, ContentMessage, type AcpContentItem } from './AcpSessionContent.js'

interface ToolActivity { id: string; title: string; kind: string; status: string; sequence: number; locations: string[]; terminals: string[] }
interface PlanItem { content: string; status: string; priority: string }
export function SessionHarness({ environments }: { environments: Environment[] }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [runs, setRuns] = useState<SessionRun[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [sources, setSources] = useState<ResearchSource[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [elicitations, setElicitations] = useState<Elicitation[]>([])
  const [draftAttachmentIds, setDraftAttachmentIds] = useState<string[]>([])
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
  const activity = useMemo(() => projectActivity(events), [events])
  const surface = selected?.surface ?? 'general'

  const loadContext = async (sessionId: string) => {
    const [nextRuns, nextArtifacts, nextApprovals, nextSources, nextAttachments, nextElicitations] = await Promise.all([sessionRuns(sessionId), sessionArtifacts(sessionId), sessionApprovals(sessionId), sessionSources(sessionId), sessionAttachments(sessionId), sessionElicitations(sessionId)])
    setRuns(nextRuns); setArtifacts(nextArtifacts); setApprovals(nextApprovals); setSources(nextSources); setAttachments(nextAttachments); setElicitations(nextElicitations)
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
  }, [messages, running, surface, followingLatest])

  useEffect(() => {
    streamRef.current?.close()
    setFollowingLatest(true)
    setDraftAttachmentIds([])
    if (!selectedId) { setEvents([]); setRuns([]); setArtifacts([]); setApprovals([]); setSources([]); setAttachments([]); setElicitations([]); return }
    let active = true
    void Promise.all([sessionEvents(selectedId), loadContext(selectedId)]).then(([history]) => {
      if (!active) return
      setEvents(history)
      const after = history.at(-1)?.sequence ?? 0
      const stream = new EventSource(`/api/sessions/${encodeURIComponent(selectedId)}/events/stream?after=${after}`)
      stream.addEventListener('session_event', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as SessionEvent
        setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event])
        if (event.kind === 'approval' || event.kind === 'elicitation') {
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
      const surface = String(values.get('surface') ?? 'general') as SessionSurface
      const session = await createSession(environmentId, String(values.get('title')), surface)
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

  const changeSurface = async (nextSurface: SessionSurface) => {
    if (!selectedId || !selected) return
    try {
      await setSessionConfigOption(selectedId, 'papyrus.surface', nextSurface)
      setSessions((current) => current.map((session) => session.id === selectedId ? { ...session, surface: nextSurface, updatedAt: new Date().toISOString() } : session))
    } catch (cause) { showError(cause) }
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

  return <section className="session-layout">
    <aside className="session-sidebar">
      <div className="session-sidebar-head"><strong>Durable sessions</strong><button className="icon-button" onClick={() => setCreating(true)} aria-label="Create session">＋</button></div>
      {loading ? <div className="empty">Loading sessions…</div> : sessions.length ? <div className="session-list">{sessions.map((session) => <button key={session.id} className={session.id === selectedId ? 'selected' : ''} onClick={() => setSelectedId(session.id)}><strong>{session.title}</strong><span>{session.status} · {new Date(session.updatedAt).toLocaleString()}</span></button>)}</div> : <div className="empty">No sessions yet.</div>}
      {nextCursor && <button className="secondary load-more" onClick={() => void loadSessions(nextCursor)}>Load more</button>}
    </aside>
    <div className="conversation-panel">
      {error && <div className="error">{error}<button onClick={() => setError(undefined)}>×</button></div>}
      {creating && <form className="create-session" onSubmit={create}><div><strong>New durable session</strong><button type="button" className="icon-button" onClick={() => setCreating(false)}>×</button></div><SelectField name="environment" label="Environment" placeholder="Choose an environment" options={environments.map((environment) => ({ value: environment.id, label: environment.name, ...(environment.description ? { detail: environment.description } : {}) }))} /><SelectField name="surface" label="Work surface" placeholder="Choose a work surface" options={surfaceOptions()} /><label>Session title<input name="title" required maxLength={256} autoFocus placeholder="Describe the work" /></label><button className="primary" disabled={!environments.length}>Create session →</button></form>}
      {!selected ? <div className="conversation-empty"><h2>Start a governed session.</h2><p>Choose an authorized environment, describe the work, and retain the complete history on the server.</p><button className="primary" disabled={!environments.length} onClick={() => setCreating(true)}>New session →</button></div> : <>
        <div className="conversation-head"><div><strong>{selected.title}</strong><span>{selected.status} · {surfaceLabel(surface)} · {environmentName(environments, selected.environmentId)}</span></div><div className="session-actions"><SurfaceControl value={surface} disabled={running} onChange={changeSurface} />{(running || selected.status === 'running') ? <button className="danger" onClick={() => void cancel()}>Cancel run</button> : <button className="text-button" onClick={() => void removeSession()}>Delete</button>}</div></div>
        <div className="session-content">
          <SessionSurfaceWorkspace
            surface={surface}
            messages={messages}
            messagesRef={messagesRef}
            followingLatest={followingLatest}
            setFollowingLatest={setFollowingLatest}
            running={running}
            activity={activity}
            runs={runs}
            attachments={attachments}
            artifacts={artifacts}
            approvals={approvals}
            sources={sources}
            onDecision={reviewApproval}
          />
        </div>
        <div className="session-footer">
        {elicitations.find((item) => item.status === 'pending') && <ElicitationCard item={elicitations.find((item) => item.status === 'pending')!} onRespond={async (id, response) => { await respondElicitation(selected.id, id, response); await loadContext(selected.id) }} />}
        <form className="composer" onSubmit={send}>
          {draftAttachmentIds.length > 0 && <div className="attachment-chips">{draftAttachmentIds.map((id) => { const attachment = attachments.find((item) => item.id === id); return attachment && <span key={id}><span>↧ {attachment.name} · {formatBytes(attachment.size)}</span><button type="button" onClick={() => setDraftAttachmentIds((current) => current.filter((item) => item !== id))} aria-label={`Remove ${attachment.name}`}>×</button></span> })}</div>}
          <textarea name="prompt" disabled={running} placeholder={draftAttachmentIds.length ? 'Add instructions for these files…' : 'Describe the work to perform…'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="text/*,image/*,.pdf,.json,.xml,.zip,.docx,.xlsx,.pptx" onChange={(event) => void addFiles(event.currentTarget.files)} />
          <div><span>Enter to submit · Shift+Enter for a new line · 10 MB per file</span><div className="composer-actions"><button type="button" className="attach-button" disabled={running || uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? 'Uploading…' : 'Attach files'}</button><button className="primary" disabled={running || uploading}>{running ? 'Running…' : 'Send →'}</button></div></div>
        </form>
        </div>
      </>}
    </div>
  </section>
}

function SessionSurfaceWorkspace({
  surface, messages, messagesRef, followingLatest, setFollowingLatest, running, activity, runs,
  attachments, artifacts, approvals, sources, onDecision,
}: {
  surface: SessionSurface
  messages: AcpContentItem[]
  messagesRef: RefObject<HTMLDivElement | null>
  followingLatest: boolean
  setFollowingLatest: (value: boolean) => void
  running: boolean
  activity: { plan: PlanItem[]; tools: ToolActivity[] }
  runs: SessionRun[]
  attachments: Attachment[]
  artifacts: Artifact[]
  approvals: Approval[]
  sources: ResearchSource[]
  onDecision: (id: string, decision: 'approved' | 'denied', reason?: string) => Promise<void>
}) {
  const conversation = <ConversationSurface messages={messages} messagesRef={messagesRef} followingLatest={followingLatest} setFollowingLatest={setFollowingLatest} running={running} />

  if (surface === 'general') return conversation
  if (surface === 'ide') return <div className="surface-workspace ide-surface">
    <section className="surface-pane ide-files"><AttachmentView title="Session files" items={attachments} empty="No repository files have been attached or emitted." /></section>
    <section className="surface-pane ide-editor"><SurfaceEmpty title="No file selected." detail="Select a file emitted by an ACP worker or attached to this session to preview it here." /></section>
    <section className="surface-pane ide-results"><div className="surface-pane-label">CHANGES AND TESTS</div>{artifacts.some((item) => item.kind === 'diff') ? <ArtifactView artifacts={artifacts.filter((item) => item.kind === 'diff')} /> : <SurfaceEmpty title="No changes yet." detail="Diffs and structured test results emitted by the worker will appear here." />}</section>
    <section className="surface-pane ide-conversation">{conversation}</section>
  </div>
  if (surface === 'research') return <div className="surface-workspace research-surface">
    <section className="surface-pane research-conversation">{conversation}</section>
    <section className="surface-pane research-sources"><SourceList sources={sources} /></section>
    <section className="surface-pane research-activity"><ActivityView plan={activity.plan} tools={activity.tools} runs={runs} /></section>
  </div>
  if (surface === 'document') return <div className="surface-workspace document-surface">
    <section className="surface-pane document-preview"><AttachmentView title="Documents" items={attachments} empty="Attach a PDF, Word file, solicitation, policy, or contract to begin review." /></section>
    <section className="surface-pane document-findings"><SurfaceEmpty title="No document findings." detail="Structured findings will appear beside the authoritative document rather than being flattened into chat." /></section>
    <section className="surface-pane document-citations"><SourceList sources={sources} /></section>
    <section className="surface-pane document-conversation">{conversation}</section>
  </div>
  return <div className="surface-workspace data-surface">
    <section className="surface-pane data-input"><AttachmentView title="Input data" items={attachments} empty="Attach CSV, XML, SOAP, copybook, JSON, or another supported input." /></section>
    <section className="surface-pane data-schema"><SurfaceEmpty title="No detected schema." detail="A Sieve-compatible MCP server can emit a structured schema here." /></section>
    <section className="surface-pane data-pipeline"><SurfaceEmpty title="No transformation pipeline." detail="Mappings, deterministic transformation steps, and validation results will appear here." /></section>
    <section className="surface-pane data-output"><ArtifactView artifacts={artifacts} /></section>
    <section className="surface-pane data-conversation">{conversation}</section>
  </div>
}

function ConversationSurface({ messages, messagesRef, followingLatest, setFollowingLatest, running }: {
  messages: AcpContentItem[]
  messagesRef: RefObject<HTMLDivElement | null>
  followingLatest: boolean
  setFollowingLatest: (value: boolean) => void
  running: boolean
}) {
  return <div className="message-region">
    <div className="messages" ref={messagesRef} aria-live="polite" onScroll={(event) => {
      const element = event.currentTarget
      setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 72)
    }}>{messages.length ? messages.map((message) => <ContentMessage message={message} key={message.id} />) : <div className="conversation-empty compact"><h2>What work should Papyrus begin?</h2><p>The runtime and tools are selected by deployment policy.</p></div>}{running && <div className="working"><span className="dot good" />Working under policy…</div>}</div>
    {!followingLatest && <button className="jump-latest" onClick={() => { setFollowingLatest(true); messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }) }}>Jump to latest ↓</button>}
  </div>
}


function SurfaceControl({ value, disabled, onChange }: { value: SessionSurface; disabled: boolean; onChange: (surface: SessionSurface) => Promise<void> }) {
  return <label className="surface-control"><span>Surface</span><select value={value} disabled={disabled} onChange={(event) => void onChange(event.target.value as SessionSurface)}>{surfaceOptions().map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
}

function surfaceOptions() {
  return [
    { value: 'general', label: 'General use', detail: 'Conversation and governed activity' },
    { value: 'ide', label: 'IDE', detail: 'Repository and software engineering' },
    { value: 'research', label: 'Research', detail: 'Sources, citations, and retrieval' },
    { value: 'document', label: 'Document', detail: 'PDF, policy, contract, and CUI review' },
    { value: 'data', label: 'Data', detail: 'Schema, mapping, transformation, and validation' },
  ]
}
function surfaceLabel(surface: SessionSurface) { return surfaceOptions().find((option) => option.value === surface)?.label ?? surface }
function SurfaceEmpty({ title, detail }: { title: string; detail: string }) {
  return <div className="surface-empty"><h2>{title}</h2><p>{detail}</p></div>
}

function AttachmentView({ title, items, empty }: { title: string; items: Attachment[]; empty: string }) {
  return <div className="surface-collection"><div className="section-label">{title.toUpperCase()}</div>{items.length ? items.map((item) => <article key={item.id}><div><strong>{item.name}</strong><span>{item.mediaType} · {formatBytes(item.size)}</span></div><span className="pill completed">input</span></article>) : <div className="empty">{empty}</div>}</div>
}

function ElicitationCard({ item, onRespond }: { item: Elicitation; onRespond: (id: string, response: Record<string, unknown>) => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSaving(true)
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    try { await onRespond(item.id, { action: 'accept', content: values }) } finally { setSaving(false) }
  }
  const schema = item.request.requestedSchema as { properties?: Record<string, { title?: string; description?: string; type?: string }> } | undefined
  return <form className="elicitation-card" onSubmit={submit}><div><span>INPUT REQUIRED</span><strong>{String(item.request.message ?? 'The agent needs more information')}</strong></div>{Object.entries(schema?.properties ?? { response: { title: 'Response', type: 'string' } }).map(([name, field]) => <label key={name}>{field.title ?? name}<input name={name} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'} required />{field.description && <small>{field.description}</small>}</label>)}<div><button type="button" className="secondary" disabled={saving} onClick={() => void onRespond(item.id, { action: 'decline' })}>Decline</button><button className="primary" disabled={saving}>{saving ? 'Sending…' : 'Continue →'}</button></div></form>
}

function environmentName(environments: Environment[], id: string) { return environments.find((environment) => environment.id === id)?.name ?? 'Environment' }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` }

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

function ActivityView({ plan, tools, runs }: { plan: PlanItem[]; tools: ToolActivity[]; runs: SessionRun[] }) {
  return <div className="activity-view">
    <section><div className="section-label">PLAN</div>{plan.length ? <div className="plan-list">{plan.map((item, index) => <div className="plan-item" key={`${index}-${item.content}`}><span className={`activity-status ${item.status}`} /> <strong>{item.content}</strong><small>{item.status} · {item.priority}</small></div>)}</div> : <div className="empty">The runtime has not reported a structured plan.</div>}</section>
    <section><div className="section-label">TOOL ACTIVITY</div>{tools.length ? <div className="tool-list">{tools.map((tool) => <article key={tool.id}><span className={`tool-kind ${tool.kind}`}>{tool.kind}</span><div><strong>{tool.title}</strong><small>{tool.locations.join(' · ') || tool.id}</small>{tool.terminals.map((terminal) => <code className="terminal-ref" key={terminal}>terminal · {terminal}</code>)}</div><span className={`pill ${tool.status}`}>{tool.status}</span></article>)}</div> : <div className="empty">No governed tool activity yet.</div>}</section>
    <section><div className="section-label">RUN HISTORY</div><div className="run-list">{runs.map((run) => <div key={run.id}><span className={`activity-status ${run.status}`} /><strong>{run.status}</strong><small>{new Date(run.startedAt).toLocaleString()}{run.stopReason ? ` · ${run.stopReason}` : ''}</small></div>)}</div></section>
  </div>
}

function ArtifactView({ artifacts }: { artifacts: Artifact[] }) {
  return <div className="artifact-view">{artifacts.length ? artifacts.map((artifact) => <article key={artifact.id}><div className={`artifact-icon ${artifact.kind}`}>{artifact.kind === 'diff' ? 'Δ' : '↧'}</div><div><strong>{artifact.name}</strong><span>{artifact.mediaType} · version {artifact.version} · {new Date(artifact.createdAt).toLocaleString()}</span></div><a className="secondary" href={artifact.downloadUrl}>Download</a></article>) : <div className="conversation-empty"><h2>No artifacts yet.</h2><p>Embedded resources and file results emitted by governed tools will appear here with durable versions.</p></div>}</div>
}

function ApprovalView({ approvals, onDecision }: { approvals: Approval[]; onDecision: (id: string, decision: 'approved' | 'denied', reason?: string) => Promise<void> }) {
  const pending = approvals.filter((approval) => approval.status === 'pending')
  const history = approvals.filter((approval) => approval.status !== 'pending')
  return <div className="approval-view">
    <section><div className="section-label">REQUIRES HUMAN DECISION</div>{pending.length ? <div className="approval-list">{pending.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecision={onDecision} />)}</div> : <div className="empty">No tool calls are waiting for approval.</div>}</section>
    <section><div className="section-label">DECISION HISTORY</div>{history.length ? <div className="approval-list history">{history.map((approval) => <article key={approval.id}><div><strong>{approval.toolTitle}</strong><span>Requested {new Date(approval.requestedAt).toLocaleString()}{approval.decidedAt ? ` · decided ${new Date(approval.decidedAt).toLocaleString()}` : ''}</span>{approval.reason && <p>{approval.reason}</p>}</div><span className={`pill ${approval.status}`}>{approval.status}</span></article>)}</div> : <div className="empty">No approval decisions have been recorded.</div>}</section>
  </div>
}

function ApprovalCard({ approval, onDecision }: { approval: Approval; onDecision: (id: string, decision: 'approved' | 'denied', reason?: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const decide = async (decision: 'approved' | 'denied') => { setSaving(true); try { await onDecision(approval.id, decision, reason) } finally { setSaving(false) } }
  return <article className="approval-card"><div><span className="approval-kicker">TOOL PERMISSION</span><strong>{approval.toolTitle}</strong><span>Requested {new Date(approval.requestedAt).toLocaleString()}</span></div><label>Decision rationale (optional)<textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="Why is this action appropriate or denied?" /></label><div className="approval-actions"><button className="danger" disabled={saving} onClick={() => void decide('denied')}>Deny</button><button className="primary" disabled={saving} onClick={() => void decide('approved')}>{saving ? 'Saving…' : 'Approve'}</button></div></article>
}
