import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Approval, Artifact, Attachment, ResearchSource, Session, SessionEvent, SessionRun, Workspace } from '@papyrus/contracts'
import { cancelSession, createSession, decideApproval, promptSession, resumeSession, sessionApprovals, sessionArtifacts, sessionAttachments, sessionEvents, sessionPage, sessionRuns, sessionSources, uploadAttachment } from './api.js'
import { SourceList } from './Sources.js'

interface ConversationMessage { id: string; role: 'user' | 'agent'; text: string; sequence: number }
interface ToolActivity { id: string; title: string; kind: string; status: string; sequence: number; locations: string[] }
interface PlanItem { content: string; status: string; priority: string }
type SessionTab = 'conversation' | 'activity' | 'approvals' | 'sources' | 'artifacts'

export function SessionHarness({ workspaces }: { workspaces: Workspace[] }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [runs, setRuns] = useState<SessionRun[]>([])
  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [sources, setSources] = useState<ResearchSource[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [draftAttachmentIds, setDraftAttachmentIds] = useState<string[]>([])
  const [tab, setTab] = useState<SessionTab>('conversation')
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
  const messages = useMemo(() => conversation(events), [events])
  const activity = useMemo(() => projectActivity(events), [events])

  const loadContext = async (sessionId: string) => {
    const [nextRuns, nextArtifacts, nextApprovals, nextSources, nextAttachments] = await Promise.all([sessionRuns(sessionId), sessionArtifacts(sessionId), sessionApprovals(sessionId), sessionSources(sessionId), sessionAttachments(sessionId)])
    setRuns(nextRuns); setArtifacts(nextArtifacts); setApprovals(nextApprovals); setSources(nextSources); setAttachments(nextAttachments)
  }

  const loadSessions = async (cursor?: string) => {
    const page = await sessionPage(cursor)
    setSessions((current) => cursor ? [...current, ...page.sessions.filter((item) => !current.some((existing) => existing.id === item.id))] : page.sessions)
    setNextCursor(page.nextCursor)
    if (!cursor && !selectedId) setSelectedId(page.sessions[0]?.id)
  }

  useEffect(() => { void loadSessions().catch(showError).finally(() => setLoading(false)) }, [])
  useEffect(() => {
    if (tab !== 'conversation' || !followingLatest) return
    const frame = requestAnimationFrame(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [messages, running, tab, followingLatest])
  useEffect(() => {
    streamRef.current?.close()
    setFollowingLatest(true)
    setDraftAttachmentIds([])
    if (!selectedId) { setEvents([]); setRuns([]); setArtifacts([]); setApprovals([]); setSources([]); setAttachments([]); return }
    let active = true
    void Promise.all([sessionEvents(selectedId), loadContext(selectedId)]).then(([history]) => {
      if (!active) return
      setEvents(history)
      const after = history.at(-1)?.sequence ?? 0
      const stream = new EventSource(`/api/sessions/${encodeURIComponent(selectedId)}/events/stream?after=${after}`)
      stream.addEventListener('session_event', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as SessionEvent
        setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event])
        if (event.kind === 'approval') {
          void loadContext(selectedId).catch(showError)
          if ((event.data as { status?: string } | undefined)?.status === 'pending') setTab('approvals')
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
      const session = await createSession(String(values.get('workspace')), String(values.get('title')))
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
      {creating && <form className="create-session" onSubmit={create}><div><strong>New governed session</strong><button type="button" className="icon-button" onClick={() => setCreating(false)}>×</button></div><label>Workspace<select name="workspace" required>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label><label>Session title<input name="title" required maxLength={256} autoFocus placeholder="Research current policy guidance" /></label><button className="primary" disabled={!workspaces.length}>Create session →</button></form>}
      {!selected ? <div className="conversation-empty"><h2>Start a governed session.</h2><p>Choose an authorized workspace, describe the work, and retain the complete history on the server.</p><button className="primary" disabled={!workspaces.length} onClick={() => setCreating(true)}>New session →</button></div> : <>
        <div className="conversation-head"><div><strong>{selected.title}</strong><span>{selected.status} · {workspaceName(workspaces, selected.workspaceId)}</span></div><div className="session-actions"><div className="session-tabs">{(['conversation', 'activity', 'approvals', 'sources', 'artifacts'] as SessionTab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}{item === 'approvals' && approvals.filter((approval) => approval.status === 'pending').length ? ` ${approvals.filter((approval) => approval.status === 'pending').length}` : item === 'sources' && sources.length ? ` ${sources.length}` : item === 'artifacts' && artifacts.length ? ` ${artifacts.length}` : ''}</button>)}</div>{(running || selected.status === 'running') && <button className="danger" onClick={() => void cancel()}>Cancel run</button>}</div></div>
        {tab === 'conversation' && <div className="message-region">
          <div className="messages" ref={messagesRef} aria-live="polite" onScroll={(event) => {
            const element = event.currentTarget
            setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 72)
          }}>{messages.length ? messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === 'user' ? 'YOU' : 'PAPYRUS'}</span><p>{message.text}</p></article>) : <div className="conversation-empty compact"><h2>What work should Papyrus begin?</h2><p>The runtime and tools are selected by deployment policy.</p></div>}{running && <div className="working"><span className="dot good" />Working under policy…</div>}</div>
          {!followingLatest && <button className="jump-latest" onClick={() => { setFollowingLatest(true); messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }) }}>Jump to latest ↓</button>}
        </div>}
        {tab === 'activity' && <ActivityView plan={activity.plan} tools={activity.tools} runs={runs} />}
        {tab === 'approvals' && <ApprovalView approvals={approvals} onDecision={reviewApproval} />}
        {tab === 'sources' && <SourceList sources={sources} />}
        {tab === 'artifacts' && <ArtifactView artifacts={artifacts} />}
        <form className="composer" onSubmit={send}>
          {draftAttachmentIds.length > 0 && <div className="attachment-chips">{draftAttachmentIds.map((id) => { const attachment = attachments.find((item) => item.id === id); return attachment && <span key={id}><span>↧ {attachment.name} · {formatBytes(attachment.size)}</span><button type="button" onClick={() => setDraftAttachmentIds((current) => current.filter((item) => item !== id))} aria-label={`Remove ${attachment.name}`}>×</button></span> })}</div>}
          <textarea name="prompt" disabled={running} placeholder={draftAttachmentIds.length ? 'Add instructions for these files…' : 'Describe the work to perform…'} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
          <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="text/*,image/*,.pdf,.json,.xml,.zip,.docx,.xlsx,.pptx" onChange={(event) => void addFiles(event.currentTarget.files)} />
          <div><span>Enter to submit · Shift+Enter for a new line · 10 MB per file</span><div className="composer-actions"><button type="button" className="attach-button" disabled={running || uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? 'Uploading…' : 'Attach files'}</button><button className="primary" disabled={running || uploading}>{running ? 'Running…' : 'Send →'}</button></div></div>
        </form>
      </>}
    </div>
  </section>
}

function conversation(events: SessionEvent[]): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>()
  for (const event of events) {
    if (event.kind !== 'update' || !event.data || typeof event.data !== 'object') continue
    const update = event.data as { sessionUpdate?: string; messageId?: string; content?: { type?: string; text?: string } }
    const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : update.sessionUpdate === 'agent_message_chunk' ? 'agent' : undefined
    if (!role || update.content?.type !== 'text' || typeof update.content.text !== 'string') continue
    const id = update.messageId ?? `${role}_${event.sequence}`
    const current = messages.get(id)
    messages.set(id, { id, role, text: `${current?.text ?? ''}${update.content.text}`, sequence: current?.sequence ?? event.sequence })
  }
  return [...messages.values()].sort((left, right) => left.sequence - right.sequence)
}

function workspaceName(workspaces: Workspace[], id: string) { return workspaces.find((workspace) => workspace.id === id)?.name ?? 'Workspace' }
function formatBytes(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB` }

function projectActivity(events: SessionEvent[]): { plan: PlanItem[]; tools: ToolActivity[] } {
  let plan: PlanItem[] = []
  const tools = new Map<string, ToolActivity>()
  for (const event of events) {
    if (event.kind !== 'update' || !event.data || typeof event.data !== 'object') continue
    const update = event.data as { sessionUpdate?: string; entries?: PlanItem[]; toolCallId?: string; title?: string; kind?: string; status?: string; locations?: Array<{ path?: string }> }
    if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) plan = update.entries
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
      const current = tools.get(update.toolCallId)
      tools.set(update.toolCallId, {
        id: update.toolCallId, title: update.title ?? current?.title ?? 'Tool activity', kind: update.kind ?? current?.kind ?? 'other',
        status: update.status ?? current?.status ?? 'pending', sequence: current?.sequence ?? event.sequence,
        locations: update.locations?.flatMap((location) => typeof location.path === 'string' ? [location.path] : []) ?? current?.locations ?? [],
      })
    }
  }
  return { plan, tools: [...tools.values()].sort((left, right) => left.sequence - right.sequence) }
}

function ActivityView({ plan, tools, runs }: { plan: PlanItem[]; tools: ToolActivity[]; runs: SessionRun[] }) {
  return <div className="activity-view">
    <section><div className="section-label">PLAN</div>{plan.length ? <div className="plan-list">{plan.map((item, index) => <div className="plan-item" key={`${index}-${item.content}`}><span className={`activity-status ${item.status}`} /> <strong>{item.content}</strong><small>{item.status} · {item.priority}</small></div>)}</div> : <div className="empty">The runtime has not reported a structured plan.</div>}</section>
    <section><div className="section-label">TOOL ACTIVITY</div>{tools.length ? <div className="tool-list">{tools.map((tool) => <article key={tool.id}><span className={`tool-kind ${tool.kind}`}>{tool.kind}</span><div><strong>{tool.title}</strong><small>{tool.locations.join(' · ') || tool.id}</small></div><span className={`pill ${tool.status}`}>{tool.status}</span></article>)}</div> : <div className="empty">No governed tool activity yet.</div>}</section>
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
