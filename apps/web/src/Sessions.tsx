import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type { Session, SessionEvent, Workspace } from '@papyrus/contracts'
import { cancelSession, createSession, promptSession, resumeSession, sessionEvents, sessionPage } from './api.js'

interface ConversationMessage { id: string; role: 'user' | 'agent'; text: string; sequence: number }

export function SessionHarness({ workspaces }: { workspaces: Workspace[] }) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [selectedId, setSelectedId] = useState<string>()
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string>()
  const streamRef = useRef<EventSource | null>(null)
  const selected = sessions.find((session) => session.id === selectedId)
  const messages = useMemo(() => conversation(events), [events])

  const loadSessions = async (cursor?: string) => {
    const page = await sessionPage(cursor)
    setSessions((current) => cursor ? [...current, ...page.sessions.filter((item) => !current.some((existing) => existing.id === item.id))] : page.sessions)
    setNextCursor(page.nextCursor)
    if (!cursor && !selectedId) setSelectedId(page.sessions[0]?.id)
  }

  useEffect(() => { void loadSessions().catch(showError).finally(() => setLoading(false)) }, [])
  useEffect(() => {
    streamRef.current?.close()
    if (!selectedId) { setEvents([]); return }
    let active = true
    void sessionEvents(selectedId).then((history) => {
      if (!active) return
      setEvents(history)
      const after = history.at(-1)?.sequence ?? 0
      const stream = new EventSource(`/api/sessions/${encodeURIComponent(selectedId)}/events/stream?after=${after}`)
      stream.addEventListener('session_event', (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as SessionEvent
        setEvents((current) => current.some((item) => item.sequence === event.sequence) ? current : [...current, event])
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
    if (!prompt) return
    form.reset(); setRunning(true); setError(undefined)
    try {
      if (selected?.status === 'stopped' || selected?.status === 'failed' || selected?.status === 'interrupted') await resumeSession(selectedId)
      await promptSession(selectedId, prompt)
      await loadSessions()
    } catch (cause) { showError(cause) }
    finally { setRunning(false) }
  }

  const cancel = async () => {
    if (!selectedId) return
    try { await cancelSession(selectedId); setRunning(false); await loadSessions() } catch (cause) { showError(cause) }
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
        <div className="conversation-head"><div><strong>{selected.title}</strong><span>{selected.status} · {workspaceName(workspaces, selected.workspaceId)}</span></div>{running && <button className="danger" onClick={() => void cancel()}>Cancel run</button>}</div>
        <div className="messages" aria-live="polite">{messages.length ? messages.map((message) => <article className={`message ${message.role}`} key={message.id}><span>{message.role === 'user' ? 'YOU' : 'PAPYRUS'}</span><p>{message.text}</p></article>) : <div className="conversation-empty compact"><h2>What work should Papyrus begin?</h2><p>The runtime and tools are selected by deployment policy.</p></div>}{running && <div className="working"><span className="dot good" />Working under policy…</div>}</div>
        <form className="composer" onSubmit={send}><textarea name="prompt" required disabled={running} placeholder="Describe the work to perform…" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} /><div><span>Enter to submit · Shift+Enter for a new line</span><button className="primary" disabled={running}>{running ? 'Running…' : 'Send →'}</button></div></form>
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
