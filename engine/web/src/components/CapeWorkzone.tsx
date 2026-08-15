import {
  Activity,
  ArrowUp,
  Bot,
  Check,
  Circle,
  Clock3,
  FileText,
  Globe2,
  LockKeyhole,
  Play,
  ShieldCheck,
  SquareTerminal,
  UserRound,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { ToolWorkbench, type WorkbenchSession } from './ToolWorkbench'

interface RunEvent {
  id: string
  sequence: number
  kind: string
  actor: string
  occurredAt: string
  payload: Record<string, unknown>
}
interface RunMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  sources: Array<{ id: string; title: string; kind: string }>
  createdAt: string
}
interface PlanStep {
  id: string
  title: string
  status: 'queued' | 'active' | 'complete' | 'failed'
  detail?: string
}
interface Approval {
  id: string
  action: string
  reason: string
  risk: string
  status: string
  requestedAt: string
}
interface RunBundle {
  run: {
    id: string
    title: string
    status: string
    classification: string
    createdAt: string
    updatedAt: string
  }
  request: string
  messages: RunMessage[]
  plan: PlanStep[]
  events: RunEvent[]
  approvals: Approval[]
  sessions: WorkbenchSession[]
}

function elapsed(createdAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function CapeWorkzone({
  projectId,
  projectName,
}: { projectId: string; projectName: string }) {
  const { apiFetch } = useAuth()
  const [prompt, setPrompt] = useState('')
  const [bundle, setBundle] = useState<RunBundle | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [browserFrame, setBrowserFrame] = useState('')

  const refresh = useCallback(
    async (runId: string) => {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(runId)}`)
      if (!response.ok) throw new Error('Unable to load run')
      setBundle((await response.json()) as RunBundle)
    },
    [apiFetch],
  )

  useEffect(() => {
    void apiFetch(`/api/runs?projectId=${encodeURIComponent(projectId)}`).then(async (response) => {
      if (!response.ok) return
      const data = (await response.json()) as { runs: Array<{ id: string }> }
      if (data.runs[0]) await refresh(data.runs[0].id)
    })
  }, [apiFetch, projectId, refresh])

  const activeRunId = bundle?.run.id
  const initialEventSequence = bundle?.events.at(-1)?.sequence ?? 0

  useEffect(() => {
    if (!activeRunId) return
    const controller = new AbortController()
    const runId = activeRunId
    const after = initialEventSequence
    void (async () => {
      try {
        const response = await apiFetch(
          `/api/runs/${encodeURIComponent(runId)}/events?after=${after}`,
          { signal: controller.signal },
        )
        const reader = response.body?.getReader()
        if (!reader) return
        const decoder = new TextDecoder()
        let pending = ''
        while (!controller.signal.aborted) {
          const chunk = await reader.read()
          if (chunk.done) break
          pending += decoder.decode(chunk.value, { stream: true })
          const frames = pending.split('\n\n')
          pending = frames.pop() ?? ''
          if (frames.some((frame) => frame.includes('event: run-event'))) await refresh(runId)
        }
      } catch (streamError) {
        if (!controller.signal.aborted)
          setError(streamError instanceof Error ? streamError.message : 'Run stream disconnected')
      }
    })()
    return () => controller.abort()
  }, [apiFetch, activeRunId, initialEventSequence, refresh])

  async function createRun() {
    const request = prompt.trim()
    if (!request || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, request, classification: 'CUI' }),
      })
      const data = (await response.json()) as RunBundle & { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Run creation failed')
      setBundle(data)
      setPrompt('')
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Run creation failed')
    } finally {
      setBusy(false)
    }
  }

  async function decide(approvalId: string, decision: 'approved' | 'rejected') {
    if (!bundle) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(
        `/api/runs/${encodeURIComponent(bundle.run.id)}/approvals/${encodeURIComponent(approvalId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      )
      const data = (await response.json()) as RunBundle & { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Approval failed')
      setBundle(data)
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Approval failed')
    } finally {
      setBusy(false)
    }
  }

  async function startBrowser(url: string) {
    if (!bundle) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(bundle.run.id)}/browser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Browser launch failed')
      await refresh(bundle.run.id)
    } catch (browserError) {
      setError(browserError instanceof Error ? browserError.message : 'Browser launch failed')
    } finally {
      setBusy(false)
    }
  }

  async function takeover(sessionId: string, takeoverState: boolean) {
    if (!bundle) return
    const response = await apiFetch(
      `/api/runs/${encodeURIComponent(bundle.run.id)}/browser/${encodeURIComponent(sessionId)}/takeover`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ takeover: takeoverState }),
      },
    )
    if (!response.ok) {
      const data = (await response.json()) as { error?: string }
      setError(data.error ?? 'Takeover failed')
      return
    }
    await refresh(bundle.run.id)
  }

  async function browserAction(sessionId: string, instruction: string) {
    if (!bundle) return
    setBusy(true)
    setError('')
    try {
      const response = await apiFetch(
        `/api/runs/${encodeURIComponent(bundle.run.id)}/browser/${encodeURIComponent(sessionId)}/act`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruction }),
        },
      )
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Browser action failed')
      await refresh(bundle.run.id)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Browser action failed')
    } finally {
      setBusy(false)
    }
  }

  const browserSession = bundle?.sessions.find((session) => session.kind === 'browser')
  const browserSessionId = browserSession?.id
  useEffect(() => {
    if (!activeRunId || !browserSessionId) {
      setBrowserFrame('')
      return
    }
    let stopped = false
    const loadFrame = async () => {
      const response = await apiFetch(
        `/api/runs/${encodeURIComponent(activeRunId)}/browser/${encodeURIComponent(browserSessionId)}/frame`,
      )
      if (!response.ok || stopped) return
      const frame = (await response.json()) as { mediaType: string; contentBase64: string }
      if (!stopped) setBrowserFrame(`data:${frame.mediaType};base64,${frame.contentBase64}`)
    }
    void loadFrame()
    const timer = window.setInterval(() => void loadFrame(), 2000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [activeRunId, apiFetch, browserSessionId])

  const pendingApprovals =
    bundle?.approvals.filter((approval) => approval.status === 'pending') ?? []
  const activity = useMemo(
    () =>
      bundle?.events
        .filter((event) => /^(model\.|tool\.|approval\.|run\.status)/.test(event.kind))
        .slice(-8)
        .reverse() ?? [],
    [bundle],
  )

  return (
    <div className="cape-workzone">
      <section className="agent-thread">
        <header className="pane-header">
          <div>
            <span className="eyebrow">
              {bundle ? bundle.run.status.replaceAll('_', ' ').toUpperCase() : 'NEW RUN'}
            </span>
            <h1>{projectName}</h1>
          </div>
          <div className="pane-actions">
            <span className="agent-label">
              <Bot size={15} /> Orchestrator
            </span>
            <button
              className="outline-button"
              type="button"
              disabled={!bundle}
              aria-expanded={inspectorOpen}
              onClick={() => setInspectorOpen((open) => !open)}
            >
              <Activity size={15} /> Run
            </button>
          </div>
        </header>
        <div className="thread-scroll">
          {!bundle && (
            <div className="workzone-empty">
              <Bot size={38} />
              <h2>What should Papyrus work on?</h2>
              <p>
                Start a governed run. Plans, messages, approvals, evidence, and tool sessions will
                appear here as they are persisted.
              </p>
            </div>
          )}
          {bundle?.messages.map((message) => (
            <article
              className={`message ${message.role === 'user' ? 'human-message' : 'agent-message'}`}
              key={message.id}
            >
              <div className={`message-avatar ${message.role === 'assistant' ? 'orange' : ''}`}>
                {message.role === 'user' ? (
                  <UserRound size={15} />
                ) : message.role === 'assistant' ? (
                  <Bot size={15} />
                ) : (
                  <SquareTerminal size={15} />
                )}
              </div>
              <div>
                <b>
                  {message.role === 'user'
                    ? 'You'
                    : message.role === 'assistant'
                      ? 'Papyrus'
                      : 'Runtime'}
                </b>
                <p>{message.content}</p>
                {message.sources.length > 0 && (
                  <div className="source-row">
                    {message.sources.map((source) => (
                      <span key={source.id}>
                        {source.kind === 'browser' ? <Globe2 size={13} /> : <FileText size={13} />}{' '}
                        {source.title}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
          {pendingApprovals.map((approval) => (
            <article className="approval-card pending" key={approval.id}>
              <header>
                <div className="approval-icon">
                  <ShieldCheck size={18} />
                </div>
                <div>
                  <span>HUMAN APPROVAL REQUIRED · {approval.risk.toUpperCase()} RISK</span>
                  <h2>{approval.action}</h2>
                </div>
                <b>{bundle?.run.classification}</b>
              </header>
              <p>{approval.reason}</p>
              <footer>
                <button
                  type="button"
                  className="reject-button"
                  disabled={busy}
                  onClick={() => void decide(approval.id, 'rejected')}
                >
                  <X size={15} /> Reject
                </button>
                <button
                  type="button"
                  className="approve-button"
                  disabled={busy}
                  onClick={() => void decide(approval.id, 'approved')}
                >
                  <Check size={15} /> Approve action
                </button>
              </footer>
            </article>
          ))}
          {error && <div className="workzone-error">{error}</div>}
        </div>
        <form
          className="agent-composer"
          onSubmit={(event) => {
            event.preventDefault()
            void createRun()
          }}
        >
          <textarea
            value={prompt}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Ask Papyrus to research, analyze, draft, or operate a connected system…"
          />
          <footer>
            <div>
              <span>
                <ShieldCheck size={13} /> Released staging context only
              </span>
            </div>
            <button
              className="send-button"
              type="submit"
              disabled={!prompt.trim() || busy}
              aria-label="Start run"
            >
              <ArrowUp size={17} />
            </button>
          </footer>
        </form>
      </section>
      <aside className={`run-inspector ${inspectorOpen ? 'open' : ''}`}>
        <header className="pane-header">
          <div>
            <span className="eyebrow">{bundle?.run.id ?? 'NO ACTIVE RUN'}</span>
            <h2>Execution</h2>
          </div>
          <div className="pane-actions">
            <button
              type="button"
              className="icon-button"
              aria-label="Close execution panel"
              onClick={() => setInspectorOpen(false)}
            >
              <X size={15} />
            </button>
          </div>
        </header>
        {bundle ? (
          <>
            <section className="run-status">
              <span className="live-dot" />
              <b>{bundle.run.status.replaceAll('_', ' ')}</b>
              <small>{elapsed(bundle.run.createdAt)} elapsed</small>
            </section>
            <section className="plan-section">
              <header>
                <b>Plan</b>
                <span>
                  {bundle.plan.filter((step) => step.status === 'complete').length} of{' '}
                  {bundle.plan.length}
                </span>
              </header>
              <ol>
                {bundle.plan.map((step) => (
                  <li key={step.id} className={step.status}>
                    <span>
                      {step.status === 'complete' ? (
                        <Check size={13} />
                      ) : step.status === 'active' ? (
                        <Play size={11} />
                      ) : (
                        <Circle size={10} />
                      )}
                    </span>
                    <div>
                      <b>{step.title}</b>
                      <small>{step.detail ?? step.status}</small>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section className="activity-section">
              <header>
                <b>Activity</b>
                <span>{bundle.events.length} events</span>
              </header>
              {activity.map((event) => (
                <div key={event.id}>
                  {event.kind.startsWith('tool') ? (
                    <Globe2 size={14} />
                  ) : event.kind.startsWith('approval') ? (
                    <ShieldCheck size={14} />
                  ) : (
                    <Clock3 size={14} />
                  )}
                  <p>
                    <b>{event.kind}</b>
                    <span>{event.actor}</span>
                  </p>
                  <time>
                    {new Date(event.occurredAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
              ))}
            </section>
            <footer className="run-policy">
              <LockKeyhole size={14} />
              <span>
                <b>Role-bounded run</b>
                <small>{bundle.run.classification} · full audit trail</small>
              </span>
            </footer>
          </>
        ) : (
          <div className="inspector-empty">No run selected</div>
        )}
      </aside>
      <section className="workbench-pane">
        <ToolWorkbench
          generation={null}
          loading={false}
          onApprove={() => {}}
          onReject={() => {}}
          onFilesUpdate={() => {}}
          onBuildValidation={() => {}}
          runMode
          sessions={bundle?.sessions ?? []}
          activity={bundle?.events ?? []}
          busy={busy}
          browserFrame={browserFrame}
          onStartBrowser={startBrowser}
          onTakeover={takeover}
          onBrowserAction={browserAction}
        />
      </section>
    </div>
  )
}
