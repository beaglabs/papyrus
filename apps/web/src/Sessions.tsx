import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Approval, Artifact, Attachment, Elicitation, Session, SessionEvent } from '@papyrus/contracts'
import { cancelSession, clearSessionGoal, createSession, decideApproval, deleteSession, promptSession, respondElicitation, resumeSession, sendBrowserInput, sessionApprovals, sessionArtifacts, sessionAttachments, sessionElicitations, sessionEvents, sessionGoal, sessionPage, setSessionGoal, uploadAttachment, type MastraGoal } from './api.js'
import { acpContent, ContentMessage } from './AcpSessionContent.js'
import { ToolActivityGroup, displayToolTitle, projectActivity, type ToolActivity } from './SessionActivity.js'
import { createPortal } from 'react-dom'
import { Alert, Button, Input, Textarea } from './components/ui/index.js'

export { projectActivity } from './SessionActivity.js'

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
  const [browserPanelOpen, setBrowserPanelOpen] = useState(false)
  const [goalPanelOpen, setGoalPanelOpen] = useState(false)
  const [goal, setGoal] = useState<MastraGoal | null>(null)
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>()
  const artifactContext = useRef<{ sessionId?: string; ids: Set<string> }>({ ids: new Set() })
  const [loading, setLoading] = useState(true)
  const [runPending, setRunning] = useState(false)
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
  const running = Boolean(pendingTurn) || (latestRunRunning(events.filter((event) => event.sessionId === selectedId)) ?? runPending)
  const turns = useMemo(() => promptTurns(events), [events])
  const activeRunId = useMemo(() => [...events].reverse().find((event) => event.runId)?.runId, [events])
  const browserState = useMemo(() => latestBrowserState(events), [events])
  const pendingInput = elicitations.some((item) => item.status === 'pending')
  const artifactGenerating = useMemo(() => running && isArtifactGenerationActive(activeRunId ? events.filter((event) => event.runId === activeRunId) : []), [activeRunId, events, running])

  const loadContext = async (sessionId: string) => {
    const [nextArtifacts, nextApprovals, nextAttachments, nextElicitations, nextGoal] = await Promise.all([sessionArtifacts(sessionId), sessionApprovals(sessionId), sessionAttachments(sessionId), sessionElicitations(sessionId), sessionGoal(sessionId)])
    const previous = artifactContext.current
    const sameSession = previous.sessionId === sessionId
    const newlyCreated = sameSession ? nextArtifacts.filter((artifact) => !previous.ids.has(artifact.id)) : []
    artifactContext.current = { sessionId, ids: new Set(nextArtifacts.map((artifact) => artifact.id)) }
    setArtifacts(nextArtifacts); setApprovals(nextApprovals); setAttachments(nextAttachments); setElicitations(nextElicitations)
    setGoal(nextGoal)
    const newest = newlyCreated.at(-1)
    if (newest) {
      setSelectedArtifactId(newest.id)
      setArtifactPanelOpen(true)
    }
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
    setBrowserPanelOpen(false)
    setGoalPanelOpen(false)
    requestAnimationFrame(() => newPromptRef.current?.focus())
  }, [newSessionRequest])
  useEffect(() => {
    if (!followingLatest) return
    const frame = requestAnimationFrame(() => messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [events, running, followingLatest])
  useEffect(() => {
    if (browserState === 'active') {
      setBrowserPanelOpen(true)
      setArtifactPanelOpen(false)
    } else if (browserState === 'completed' || browserState === 'failed') setBrowserPanelOpen(false)
  }, [browserState])

  useEffect(() => {
    streamRef.current?.close()
    setFollowingLatest(true)
    setDraftAttachmentIds([])
    setLiveError(undefined)
    setArtifactPanelOpen(false)
    setSelectedArtifactId(undefined)
    if (!selectedId) { setEvents([]); setArtifacts([]); setApprovals([]); setAttachments([]); setElicitations([]); return }
    setEvents([])
    let active = true
    let stream: EventSource | undefined
    const reconcile = async () => {
      const [history] = await Promise.all([sessionEvents(selectedId), loadContext(selectedId), loadSessions()])
      if (!active) return
      setEvents((current) => mergeSessionEvents(current, history))
      if (hasAcceptedTurn(history)) setPendingTurn(undefined)
    }
    void Promise.all([sessionEvents(selectedId), loadContext(selectedId)]).then(([history]) => {
      if (!active) return
      setEvents(history)
      if (hasAcceptedTurn(history)) {
        setPendingTurn(undefined)
        setRunning(!hasTerminalRun(history))
      }
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
  const pendingApprovals = approvals.filter((approval) => approval.status === 'pending')
  const pendingElicitation = elicitations.find((item) => item.status === 'pending')

  return <section className="session-layout session-v2">
    {historyTarget && createPortal(<aside className="session-sidebar">
      <div className="session-sidebar-head"><strong>History</strong></div>
      {loading
        ? <div className="empty">Loading sessions…</div>
        : sessions.length
          ? <div className="session-list">{sessions.map((session) => <SessionHistoryItem key={session.id} session={session} selected={session.id === selectedId} onClick={() => { setPendingTurn(undefined); setSelectedId(session.id); onActivate() }} />)}</div>
          : <div className="empty">No sessions yet.</div>}
      {nextCursor && <Button className="secondary load-more" onClick={() => void loadSessions(nextCursor)}>Load more</Button>}
    </aside>, historyTarget)}

    <div className={`conversation-panel ${selected ? '' : 'new-session-panel'}`}>
      {(error || liveError) && <Alert className={error ? 'error' : 'connection-notice'}>{error ?? liveError}<Button variant="ghost" onClick={() => { setError(undefined); setLiveError(undefined) }}>×</Button></Alert>}

      {!selected
        ? <div className="new-session-home">
            <div className="new-session-intro">
              <p className="eyebrow">NEW SESSION</p>
              <h2>What should Papyrus do?</h2>
              <p>Start with the work. Papyrus will keep the durable governed history, tools, approvals, and outputs attached to this session.</p>
            </div>
            <form className="new-session-composer" onSubmit={startNewSession}>
              <Textarea ref={newPromptRef} name="prompt" disabled={running} placeholder="Describe the work to perform…" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              <div className="new-session-controls">
                <span className="new-session-note">Approved runtime and access policy are applied automatically.</span>
                <Button className="primary" disabled={running}>{running ? 'Starting…' : 'Start →'}</Button>
              </div>
            </form>
          </div>
        : <>
          <SessionHeader
            session={selected}
            running={running}
            pendingInput={pendingInput}
            browserActive={browserState === 'active'}
            browserOpen={browserPanelOpen}
            onOpenBrowser={() => setBrowserPanelOpen(true)}
            onDelete={() => void removeSession()}
          />

          <div className={`session-content ${artifactPanelOpen ? 'artifact-panel-open' : ''}`}>
            <div className="message-region">
              <div className="messages" ref={messagesRef} aria-live="polite" onScroll={(event) => {
                const element = event.currentTarget
                setFollowingLatest(element.scrollHeight - element.scrollTop - element.clientHeight < 72)
              }}>
                {turns.length
                  ? turns.map((turn) => <DurablePromptTurn key={turn.runId} turn={turn} running={running && turn.runId === activeRunId} />)
                  : !pendingTurn && <div className="conversation-empty compact"><h2>Ready for work</h2><p>Send a prompt, attach context, or set a durable goal.</p></div>}
                {pendingTurn && <><ContentMessage message={pendingContent(pendingTurn)} /><PromptTurnFlow events={[]} running submitted /></>}
                {artifacts.length > 0 && <ArtifactCards artifacts={artifacts} onOpen={(id) => { setSelectedArtifactId(id); setArtifactPanelOpen(true); setBrowserPanelOpen(false) }} />}
              </div>
              {!followingLatest && <Button className="jump-latest" onClick={() => { setFollowingLatest(true); messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'smooth' }) }}>Latest ↓</Button>}
            </div>

            {browserPanelOpen && <BrowserWorkspace sessionId={selected.id} onClose={() => setBrowserPanelOpen(false)} onError={showError} />}
            {!browserPanelOpen && <ArtifactWorkspace artifacts={artifacts} generating={artifactGenerating} open={artifactPanelOpen} selectedId={selectedArtifactId} onOpenChange={setArtifactPanelOpen} />}
          </div>

          <div className="session-footer">
            <div className="session-footer-inner">
              {pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} onDecision={reviewApproval} />)}
              {pendingElicitation && <ElicitationCard item={pendingElicitation} onRespond={async (id, response) => { await respondElicitation(selected.id, id, response); await loadContext(selected.id) }} />}
              <SessionGoal sessionId={selected.id} goal={goal} editing={goalPanelOpen} onChange={setGoal} onEditingChange={setGoalPanelOpen} />

              <form className="composer" onSubmit={send}>
                {draftAttachmentIds.length > 0 && <div className="attachment-chips">{draftAttachmentIds.map((id) => {
                  const attachment = attachments.find((item) => item.id === id)
                  return attachment && <span key={id}><span>↧ {attachment.name} · {formatBytes(attachment.size)}</span><Button type="button" onClick={() => setDraftAttachmentIds((current) => current.filter((item) => item !== id))} aria-label={`Remove ${attachment.name}`}>×</Button></span>
                })}</div>}

                <Textarea name="prompt" rows={1} disabled={running} placeholder={draftAttachmentIds.length ? 'Add instructions for these files…' : running ? 'Papyrus is working…' : 'Message Papyrus…'} onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }} />
                <Input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="text/*,image/*,.pdf,.json,.xml,.zip,.docx,.xlsx,.pptx" onChange={(event) => void addFiles(event.currentTarget.files)} />

                <div className="session-composer-bottom">
                  <div className="session-composer-tools">
                    <Button type="button" variant="neutral" disabled={running} onClick={() => setGoalPanelOpen((open) => !open)}>{goal?.objective ? 'Goal' : '+ Goal'}</Button>
                    <Button type="button" variant="neutral" disabled={running || uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? 'Uploading…' : '+ Attach'}</Button>
                  </div>
                  <span className="session-composer-hint">Enter to send · Shift+Enter for newline</span>
                  {running
                    ? <Button type="button" className="session-stop" onClick={() => void cancel()}>Stop</Button>
                    : <Button className="primary" disabled={uploading}>Send ↑</Button>}
                </div>
              </form>
            </div>
          </div>
        </>}
    </div>
  </section>
}

function SessionHeader({ session, running, pendingInput, browserActive, browserOpen, onOpenBrowser, onDelete }: {
  session: Session
  running: boolean
  pendingInput: boolean
  browserActive: boolean
  browserOpen: boolean
  onOpenBrowser: () => void
  onDelete: () => void
}) {
  const state = pendingInput ? 'waiting' : running ? 'running' : session.status === 'running' ? 'ready' : session.status
  const label = pendingInput ? 'Waiting for input' : running ? 'Running' : session.status === 'running' ? 'Ready' : session.status.replaceAll('_', ' ')
  return <div className="conversation-head">
    <div>
      <strong>{session.title}</strong>
      <span className="session-head-status"><span className={`session-head-dot ${state}`} aria-hidden="true" />{label}</span>
    </div>
    <div className="session-actions">
      {browserActive && !browserOpen && <Button variant="ghost" onClick={onOpenBrowser}>Open browser</Button>}
      {!running && <Button variant="ghost" onClick={onDelete}>Delete</Button>}
    </div>
  </div>
}

function SessionHistoryItem({ session, selected, onClick }: { session: Session; selected: boolean; onClick: () => void }) {
  return <Button className={`session-history-item ${selected ? 'selected' : ''}`} onClick={onClick}>
    <span className={`session-history-status ${session.status}`} aria-hidden="true" />
    <span className="session-history-copy">
      <strong>{session.title}</strong>
      <small>{session.status.replaceAll('_', ' ')} · {new Date(session.updatedAt).toLocaleString()}</small>
    </span>
  </Button>
}

function SessionGoal({ sessionId, goal, editing, onChange, onEditingChange }: {
  sessionId: string
  goal: MastraGoal | null
  editing: boolean
  onChange: (goal: MastraGoal | null) => void
  onEditingChange: (editing: boolean) => void
}) {
  if (editing) return <GoalEditor sessionId={sessionId} goal={goal} onChange={onChange} onClose={() => onEditingChange(false)} />
  if (!goal) return null
  return <div className="session-goal-bar">
    <span className="session-goal-mark" aria-hidden="true" />
    <span className="session-goal-copy"><small>Goal</small><strong>{goal.objective}</strong></span>
    <Button type="button" variant="ghost" onClick={() => onEditingChange(true)}>Edit</Button>
  </div>
}

function GoalEditor({ sessionId, goal, onChange, onClose }: { sessionId: string; goal: MastraGoal | null; onChange: (goal: MastraGoal | null) => void; onClose: () => void }) {
  const [objective, setObjective] = useState(goal?.objective ?? '')
  const [saving, setSaving] = useState(false)
  useEffect(() => setObjective(goal?.objective ?? ''), [goal?.objective])
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!objective.trim()) return
    setSaving(true)
    try {
      onChange(await setSessionGoal(sessionId, objective.trim()))
      onClose()
    } finally {
      setSaving(false)
    }
  }
  return <form className="session-goal-editor" onSubmit={save}>
    <div className="session-goal-editor-head">
      <div><small>Durable goal</small><strong>Keep Papyrus aimed at an outcome across turns.</strong></div>
      <Button type="button" variant="ghost" onClick={onClose}>×</Button>
    </div>
    <Textarea value={objective} onChange={(event) => setObjective(event.currentTarget.value)} placeholder="Define the outcome…" maxLength={4000} />
    <div className="session-goal-editor-actions">
      {goal && <Button type="button" variant="ghost" disabled={saving} onClick={() => void clearSessionGoal(sessionId).then(() => { onChange(null); onClose() })}>Clear</Button>}
      <Button className="primary" disabled={saving || !objective.trim()}>{saving ? 'Saving…' : 'Save goal'}</Button>
    </div>
  </form>
}

function BrowserWorkspace({ sessionId, onClose, onError }: { sessionId: string; onClose: () => void; onError: (error: unknown) => void }) {
  const [frame, setFrame] = useState<{ data: string; viewport?: { width: number; height: number } }>()
  const [url, setUrl] = useState('Launching session browser…')
  const [connected, setConnected] = useState(false)
  const surfaceRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/browser/stream`)
    source.onopen = () => setConnected(true)
    source.addEventListener('frame', (message) => setFrame(JSON.parse((message as MessageEvent<string>).data)))
    source.addEventListener('url', (message) => {
      const next = JSON.parse((message as MessageEvent<string>).data) as string | { url?: string }
      setUrl(typeof next === 'string' ? next : next.url ?? '')
    })
    source.addEventListener('browser_error', (message) => onError(new Error((JSON.parse((message as MessageEvent<string>).data) as { error: string }).error)))
    source.onerror = () => setConnected(false)
    return () => source.close()
  }, [sessionId])

  const mouse = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!frame?.viewport) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) * frame.viewport.width / rect.width
    const y = (event.clientY - rect.top) * frame.viewport.height / rect.height
    await sendBrowserInput(sessionId, { kind: 'mouse', event: { type: 'mousePressed', x, y, button: 'left', clickCount: 1 } })
    await sendBrowserInput(sessionId, { kind: 'mouse', event: { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 } })
  }

  const keyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!event.key || event.metaKey || event.ctrlKey || event.altKey) return
    event.preventDefault()
    void sendBrowserInput(sessionId, { kind: 'keyboard', event: { type: 'keyDown', key: event.key, code: event.code, text: event.key.length === 1 ? event.key : undefined } }).catch(onError)
  }

  return <aside className="session-sidecar browser-workspace" aria-label="Session browser">
    <div className="browser-workspace-head">
      <span className={`browser-live-dot ${connected ? 'is-live' : ''}`} aria-hidden="true" />
      <div><small>{connected ? 'Live browser' : 'Connecting'}</small><strong>Browser workspace</strong></div>
      <Button variant="ghost" onClick={onClose} aria-label="Close browser workspace">×</Button>
    </div>
    <div className="browser-workspace-url" title={url}>{url}</div>
    <div className="browser-workspace-frame">
      <div className="browser-workspace-surface" ref={surfaceRef} tabIndex={0} onKeyDown={keyboard}>
        {frame
          ? <img src={`data:image/jpeg;base64,${frame.data}`} alt="Live browser viewport" onClick={(event) => void mouse(event).catch(onError)} draggable={false} />
          : <div className="browser-workspace-loading"><span /><strong>Starting browser</strong><small>The isolated session viewport will appear here.</small></div>}
      </div>
    </div>
    <div className="browser-workspace-foot">Click to interact · focus to type · isolated to this session</div>
  </aside>
}

function mergeSessionEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  const merged = new Map(current.map((event) => [event.sequence, event]))
  for (const event of incoming) merged.set(event.sequence, event)
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence)
}

export function hasAcceptedTurn(events: SessionEvent[]): boolean {
  return events.some((event) => {
    const update = event.data as { sessionUpdate?: string } | undefined
    return update?.sessionUpdate === 'run_started' || update?.sessionUpdate === 'user_message_chunk'
  })
}

function hasTerminalRun(events: SessionEvent[]): boolean {
  return latestRunRunning(events) === false
}

export function latestRunRunning(events: SessionEvent[]): boolean | undefined {
  const latestRunId = [...events].reverse().find((event) => event.runId)?.runId
  if (!latestRunId) return undefined
  for (const event of [...events].reverse()) {
    if (event.runId !== latestRunId) continue
    const update = event.data as { sessionUpdate?: string; status?: string } | undefined
    if (event.kind === 'complete' || (update?.sessionUpdate === 'run_completed' && ['completed', 'cancelled', 'failed', 'interrupted'].includes(update.status ?? ''))) return false
    if (update?.sessionUpdate === 'run_started' || update?.sessionUpdate === 'user_message_chunk' || event.kind === 'session') return true
  }
  return undefined
}

export function latestBrowserState(events: SessionEvent[]): 'active' | 'completed' | 'failed' | undefined {
  for (const event of [...events].reverse()) {
    const update = event.data as { sessionUpdate?: string; status?: string } | undefined
    if (update?.sessionUpdate === 'browser_state' && (update.status === 'active' || update.status === 'completed' || update.status === 'failed')) return update.status
  }
  return undefined
}

function promptTurns(events: SessionEvent[]): PromptTurnGroup[] {
  const turns = new Map<string, PromptTurnGroup>()
  for (const event of events) {
    if (!event.runId) continue
    const turn = turns.get(event.runId) ?? { runId: event.runId, sequence: event.sequence, events: [] }
    turn.sequence = Math.min(turn.sequence, event.sequence)
    turn.events.push(event)
    turns.set(event.runId, turn)
  }
  return [...turns.values()].map((turn) => ({ ...turn, events: [...turn.events].sort((left, right) => left.sequence - right.sequence) }))
    .sort((left, right) => left.sequence - right.sequence)
}

export function DurablePromptTurn({ turn, running }: { turn: PromptTurnGroup; running: boolean }) {
  const messages = acpContent(turn.events)
  const { tools } = projectActivity(turn.events)
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')?.sequence ?? -1
  const activeThoughtId = [...messages].reverse().find((message) => message.role === 'thought' && message.sequence > lastUser)?.id
  const lifecycle = [...turn.events].reverse().find((event) => event.kind === 'run')?.data as { sessionUpdate?: string; status?: string; error?: string } | undefined
  const timeline = [
    ...messages.map((message) => ({ type: 'message' as const, sequence: message.sequence, id: `message:${message.id}`, message })),
    ...tools.map((tool) => ({ type: 'tool' as const, sequence: tool.sequence, id: `tool:${tool.id}`, tool })),
  ].sort((left, right) => left.sequence - right.sequence || (left.type === 'message' ? -1 : 1))

  return <section className="durable-prompt-turn" data-run-id={turn.runId}>
    {timeline.map((item) => item.type === 'message'
      ? <ContentMessage message={item.message} active={running && item.message.id === activeThoughtId} key={item.id} />
      : <div className="inline-tool-activity" key={item.id}><ToolActivityCard tool={item.tool} active={running && (item.tool.status === 'pending' || item.tool.status === 'in_progress')} /></div>)}
    <PromptTurnFlow events={turn.events} running={running} submitted={false} showTools={false} />
    {lifecycle?.sessionUpdate === 'run_completed' && lifecycle.status && lifecycle.status !== 'completed' && <div className={`turn-outcome ${lifecycle.status}`}><strong>{lifecycle.status}</strong>{lifecycle.error && <span>{lifecycle.error}</span>}</div>}
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

export function ArtifactWorkspace({ artifacts, generating, open, selectedId, onOpenChange }: { artifacts: Artifact[]; generating: boolean; open: boolean; selectedId: string | undefined; onOpenChange: (open: boolean) => void }) {
  const selected = artifacts.find((artifact) => artifact.id === selectedId) ?? artifacts.at(-1)
  if (!open || (!generating && artifacts.length === 0)) return null
  return <aside className="artifact-workspace" aria-label="Generated artifact preview">
    <div className="artifact-workspace-head"><div><span>ARTIFACT</span><strong>{selected?.name ?? (generating ? 'Generating…' : 'Preview')}</strong></div><Button variant="ghost" onClick={() => onOpenChange(false)} aria-label="Close artifact preview">×</Button></div>
    {generating && !selected && <div className="artifact-generating"><span className="artifact-orbit" aria-hidden="true" /><div><strong>Building an artifact</strong><span>Structured output will render here as it arrives.</span></div><div className="artifact-skeleton"><i /><i /><i /></div></div>}
      {selected && <div className="artifact-preview">
        <div className="artifact-preview-meta"><span>{selected.mediaType}</span><a href={selected.downloadUrl}>Download ↓</a></div>
        {selected.mediaType.startsWith('image/') ? <img src={`${selected.downloadUrl}?preview=1`} alt={selected.name} />
          : selected.mediaType === 'application/pdf' ? <object data={`${selected.downloadUrl}?preview=1`} type="application/pdf"><a href={selected.downloadUrl}>Open {selected.name}</a></object>
          : <iframe title={selected.name} src={`${selected.downloadUrl}?preview=1`} sandbox="" />}
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

export function isArtifactGenerationActive(events: SessionEvent[]): boolean {
  const { tools } = projectActivity(events)
  return tools.some((tool) => ['pending', 'in_progress', 'completed'].includes(tool.status) && isArtifactTool(tool))
}

function isArtifactTool(tool: Pick<ToolActivity, 'kind' | 'title'>): boolean {
  return tool.kind === 'edit' || /generate|create.*pdf|write|render|export|artifact|image/i.test(tool.title)
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

export function PromptTurnFlow({ events, running, submitted, showTools = true }: { events: SessionEvent[]; running: boolean; submitted: boolean; showTools?: boolean }) {
  let turnStart = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.kind === 'update' && event.data && typeof event.data === 'object' && (event.data as { sessionUpdate?: string }).sessionUpdate === 'user_message_chunk') {
      turnStart = index
      break
    }
  }
  const turnEvents = submitted ? [] : turnStart >= 0 ? events.slice(turnStart + 1) : events
  const { plan, tools } = projectActivity(turnEvents)
  if (!running && plan.length === 0 && (!showTools || tools.length === 0)) return null
  const activeTools = tools.filter((tool) => tool.status === 'in_progress' || tool.status === 'pending')
  const hasModelStream = turnEvents.some((event) => event.kind === 'update' && event.data && typeof event.data === 'object' && ['agent_thought_chunk', 'agent_message_chunk'].includes(String((event.data as { sessionUpdate?: string }).sessionUpdate)))
  const failedTool = [...tools].reverse().find((tool) => tool.status === 'failed')
  const latestTool = tools.at(-1)
  const latestArtifactTool = [...tools].reverse().find((tool) => isArtifactTool(tool))
  const outcome = [...events].reverse().find((event) => (event.data as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'run_completed')?.data as { status?: string } | undefined
  const status = activeTools.length > 1 ? `${activeTools.length} tools active`
    : activeTools[0] ? `${activeTools[0].status === 'pending' ? 'Preparing' : 'Running'} ${activeTools[0].title}`
    : running && latestTool?.status === 'failed' ? `Recovering after ${latestTool.title} failed`
    : running && latestArtifactTool?.status === 'completed' ? `${latestArtifactTool.title} complete · finalizing artifact`
    : running && submitted ? 'Starting…'
    : running && hasModelStream ? 'Working…'
    : running ? 'Working…'
    : outcome?.status && outcome.status !== 'completed' ? `Turn ${outcome.status}`
    : failedTool ? `${failedTool.title} failed`
    : 'Turn status unavailable'
  const displayTools = [...tools.filter((tool) => !activeTools.includes(tool)), ...activeTools]
  const showStatus = running || Boolean(failedTool) || Boolean(outcome?.status && outcome.status !== 'completed')
  if (!showStatus && plan.length === 0 && (!showTools || displayTools.length === 0)) return null
  return <section className="prompt-turn-flow" aria-live="polite">
    {showStatus && <div className="prompt-turn-status" role="status"><span className={running || activeTools.length ? 'tool-spinner' : failedTool || outcome?.status === 'failed' ? 'dot bad' : 'dot good'} aria-hidden="true" /><strong>{status}</strong>{running && <span className="streaming-cursor" aria-hidden="true">▌</span>}</div>}
    {plan.length > 0 && <ol className="prompt-turn-plan">{plan.map((item, index) => <li key={`${index}-${item.content}`} className={item.status}><span className={`activity-status ${item.status}`} />{item.content}</li>)}</ol>}
    {showTools && displayTools.length > 0 && <div className="prompt-turn-tools">{displayTools.map((tool) => <ToolActivityCard key={tool.id} tool={tool} active={activeTools.includes(tool)} />)}</div>}
  </section>
}

interface BrowserToolPreview {
  url?: string
  title?: string
  text?: string
}

export function browserToolPreview(tool: Pick<ToolActivity, 'title' | 'output'>): BrowserToolPreview | undefined {
  if (!/browser/i.test(tool.title)) return undefined
  for (const block of [...tool.output].reverse()) {
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    try {
      const parsed = JSON.parse(block.text) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      const value = parsed as Record<string, unknown>
      const preview = {
        ...(typeof value.url === 'string' ? { url: value.url } : {}),
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
        ...(typeof value.text === 'string' ? { text: value.text } : {}),
      }
      if (preview.url || preview.title || preview.text) return preview
    } catch {
      // Browser MCP/native tools may return plain text; keep the generic summary.
    }
  }
  return undefined
}

function ToolActivityCard({ tool, active }: { tool: ToolActivity; active: boolean }) {
  const browser = browserToolPreview(tool)
  const summary = toolSummary(tool, browser)
  const hasDetail = active || tool.status === 'failed' || Boolean(browser) || Boolean(tool.stdout || tool.stderr) || tool.output.length > 0 || tool.exitCode !== undefined
  const row = <ToolActivitySummary tool={tool} active={active} summary={summary} />
  if (!hasDetail) return <div className={`prompt-turn-tool tool-row ${tool.status}`} aria-busy={active}>{row}</div>
  return <details className={`prompt-turn-tool ${tool.status}`} open={active || tool.status === 'failed' || Boolean(browser)} aria-busy={active}>
    <summary>{row}</summary>
    <div className="tool-row-detail">
      {active && <span className="tool-running-hint">{tool.status === 'pending' ? 'Preparing tool arguments…' : 'Executing tool…'}</span>}
      {browser ? <BrowserToolPreviewCard preview={browser} /> : <>
        {(tool.stdout || tool.stderr) && <div className="tool-live-output"><pre className="tool-stream-output">{tool.stdout}{tool.stderr && <span className="tool-stderr">{tool.stderr}</span>}</pre></div>}
        {tool.output.length > 0 && <div className="tool-live-output">{tool.output.map((block, index) => <ContentBlock key={index} block={block} />)}</div>}
      </>}
      {browser && tool.output.length > 0 && <details className="tool-raw-detail"><summary>Raw browser response</summary><div className="tool-live-output">{tool.output.map((block, index) => <ContentBlock key={index} block={block} />)}</div></details>}
      {tool.status === 'failed' && !tool.stdout && !tool.stderr && tool.output.length === 0 && <span className="tool-failure-hint">{tool.exitCode !== undefined ? `Command exited with code ${tool.exitCode} and produced no diagnostic output.` : 'Tool failed without diagnostic output.'}</span>}
      {tool.exitCode !== undefined && <small className="tool-exit-code">Exit code: {tool.exitCode}</small>}
    </div>
  </details>
}

function ToolActivitySummary({ tool, active, summary }: { tool: ToolActivity; active: boolean; summary: string }) {
  return <>
    <span className={`activity-status ${tool.status}`} aria-hidden="true" />
    <span className={`tool-kind compact ${tool.kind}`}>{tool.kind}</span>
    <span className="tool-row-copy"><strong>{displayToolTitle(tool.title)}</strong><small>{summary}</small></span>
    <span className={`pill ${tool.status}`}>{active && <span className="tool-spinner" aria-hidden="true" />}{tool.status === 'in_progress' ? 'Running' : tool.status === 'pending' ? 'Preparing' : tool.status}</span>
  </>
}

function BrowserToolPreviewCard({ preview }: { preview: BrowserToolPreview }) {
  const url = safeBrowserUrl(preview.url)
  const hostname = url ? new URL(url).hostname : undefined
  const snippet = preview.text ? compactToolText(preview.text, 420) : undefined
  return <div className="browser-tool-preview">
    <div className="browser-tool-preview-meta"><span>PAGE PREVIEW</span>{hostname && <span>{hostname}</span>}</div>
    <strong>{preview.title?.trim() || hostname || 'Browser result'}</strong>
    {url && <a href={url} target="_blank" rel="noreferrer">{url}</a>}
    {snippet && <p>{snippet}</p>}
  </div>
}

function toolSummary(tool: ToolActivity, browser?: BrowserToolPreview): string {
  if (browser) {
    const url = safeBrowserUrl(browser.url)
    const host = url ? new URL(url).hostname : ''
    return [host, browser.title?.trim()].filter(Boolean).join(' · ') || 'Browser result ready'
  }
  if (tool.locations.length) return compactToolText(tool.locations.join(' · '), 140)
  const stream = (tool.stderr || tool.stdout).trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (stream) return compactToolText(stream, 140)
  const output = tool.output.find((block) => block.type === 'text' && typeof block.text === 'string')
  if (output && typeof output.text === 'string') return compactToolText(output.text, 140)
  return tool.id
}

function displayToolTitle(title: string): string {
  const normalized = title.startsWith('mastra_workspace_') ? `Workspace ${title.slice('mastra_workspace_'.length)}`
    : title.startsWith('papyrus_') ? title.slice('papyrus_'.length)
    : title
  return normalized.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function compactToolText(text: string, limit: number): string {
  const compact = text.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 1))}…` : compact
}

function safeBrowserUrl(value?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch { return undefined }
}

export function projectActivity(events: SessionEvent[]): { plan: PlanItem[]; tools: ToolActivity[] } {
  let plan: PlanItem[] = []
  const tools = new Map<string, ToolActivity>()
  for (const event of events) {
    if (event.kind !== 'update' || !event.data || typeof event.data !== 'object') continue
    const update = event.data as { sessionUpdate?: string; entries?: PlanItem[]; toolCallId?: string; title?: string; kind?: string; status?: string; locations?: Array<{ path?: string }>; content?: Array<{ type?: string; terminalId?: string; content?: unknown }>; _meta?: { papyrus?: { outputDelta?: { stream?: string; text?: string }; exitCode?: number } } }
    if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) plan = update.entries
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && update.toolCallId) {
      const current = tools.get(update.toolCallId)
      const locations = update.locations?.flatMap((location) => typeof location.path === 'string' ? [location.path] : []) ?? []
      const terminals = update.content?.flatMap((content) => content.type === 'terminal' && content.terminalId ? [content.terminalId] : []) ?? []
      const output = update.content?.flatMap((content) => content.type === 'content' && content.content && typeof content.content === 'object' && !Array.isArray(content.content) ? [content.content as Record<string, unknown>] : []) ?? []
      const delta = update._meta?.papyrus?.outputDelta
      const appendOutput = (channel: string, currentText = '') => (currentText + (delta?.stream === channel && typeof delta.text === 'string' ? delta.text : '')).slice(-65536)
      const exitCode = update._meta?.papyrus?.exitCode ?? current?.exitCode
      tools.set(update.toolCallId, {
        id: update.toolCallId, title: update.title ?? current?.title ?? 'Tool activity', kind: update.kind ?? current?.kind ?? 'other',
        status: update.status ?? current?.status ?? 'pending', sequence: current?.sequence ?? event.sequence,
        locations: [...new Set([...(current?.locations ?? []), ...locations])],
        terminals: [...new Set([...(current?.terminals ?? []), ...terminals])],
        output: mergeToolOutput(current?.output ?? [], output),
        stdout: appendOutput('stdout', current?.stdout), stderr: appendOutput('stderr', current?.stderr),
        ...(exitCode !== undefined ? { exitCode } : {}),
      })
    }
  }
  return { plan, tools: [...tools.values()].sort((left, right) => left.sequence - right.sequence) }
}

function mergeToolOutput(current: Array<Record<string, unknown>>, incoming: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const merged = new Map(current.map((block) => [JSON.stringify(block), block]))
  for (const block of incoming) merged.set(JSON.stringify(block), block)
  return [...merged.values()]
}

function ApprovalCard({ approval, onDecision }: { approval: Approval; onDecision: (id: string, decision: 'approved' | 'denied', reason?: string) => Promise<void> }) {
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const decide = async (decision: 'approved' | 'denied') => { setSaving(true); try { await onDecision(approval.id, decision, reason) } finally { setSaving(false) } }
  return <Card className="approval-card"><div><span className="approval-kicker">TOOL PERMISSION</span><strong>{approval.toolTitle}</strong><span>Requested {new Date(approval.requestedAt).toLocaleString()}</span></div><label>Decision rationale (optional)<Textarea value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="Why is this action appropriate or denied?" /></label><div className="approval-actions"><Button className="danger" disabled={saving} onClick={() => void decide('denied')}>Deny</Button><Button className="primary" disabled={saving} onClick={() => void decide('approved')}>{saving ? 'Saving…' : 'Approve'}</Button></div></Card>
}
