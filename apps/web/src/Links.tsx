import { useEffect, useMemo, useState } from 'react'
import type { AgentActionProposal, AgentLink, IntegrationConfiguration, LinkInbound, LinkType } from '@papyrus/contracts'
import { api, createSessionProposal, linkContentUrl, linkInboundUrl, linkInbounds, listLinks, listProposals, publicLinkUrl, workspaceFileContentUrl } from './api.js'
import { Alert, Badge, Button, Input, Label, Skeleton, Textarea } from './components/ui/index.js'

type LinkFilter = 'all' | LinkType | 'schedule'
const LINK_SYSTEM_EXECUTOR_ID = 'papyrus-links-system'

type InvocationMode = 'agent_decides' | 'always' | 'conditional'
type ApprovalPolicy = 'inherit' | 'required'

interface WebhookAttachmentView {
  key: string
  executorIntegrationId: string
  executorName: string
  action: string
  target: string
  invocationMode: InvocationMode
  approvalPolicy: ApprovalPolicy
  condition?: Record<string, unknown>
  inputMapping: Record<string, string>
  timeoutMs?: number
  maxRetries?: number
  state: 'pending' | 'active' | 'removing' | 'failed'
  proposalId: string
}

interface ScheduleLink {
  id: string
  name: string
  cron: string
  prompt: string
  timezone?: string
  threadId: string
  status?: string
  nextFireAt?: number | null
  createdAt?: string
  updatedAt?: string
}

async function scheduleRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  })
  const text = await response.text()
  let value: unknown
  try { value = text ? JSON.parse(text) : {} } catch { value = { error: text || `Request failed (${response.status})` } }
  if (!response.ok) {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    throw new Error(typeof record['error'] === 'string' ? record['error'] : typeof record['message'] === 'string' ? record['message'] : `Request failed (${response.status})`)
  }
  return value as T
}

async function listScheduleLinks(): Promise<ScheduleLink[]> {
  return (await scheduleRequest<{ schedules: ScheduleLink[] }>('/api/links/schedules')).schedules
}

async function getScheduleLink(id: string): Promise<ScheduleLink> {
  return (await scheduleRequest<{ schedule: ScheduleLink }>(`/api/links/schedules/${encodeURIComponent(id)}`)).schedule
}

async function saveScheduleLink(id: string, value: Pick<ScheduleLink, 'name' | 'cron' | 'prompt'> & { timezone?: string }): Promise<{ schedule: ScheduleLink; replacedId: string }> {
  return scheduleRequest(`/api/links/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(value),
  })
}

function scheduleFromLocation(): string | undefined {
  return new URLSearchParams(window.location.search).get('schedule') ?? undefined
}

function sessionFromLocation(): string | undefined {
  return new URLSearchParams(window.location.search).get('session') ?? undefined
}

export function LinksView({ validation, canManageSchedules = false }: { validation?: 'local-static' | 'kitesurf'; canManageSchedules?: boolean }) {
  const [links, setLinks] = useState<AgentLink[]>([])
  const [schedules, setSchedules] = useState<ScheduleLink[]>([])
  const [proposals, setProposals] = useState<AgentActionProposal[]>([])
  const [integrations, setIntegrations] = useState<IntegrationConfiguration[]>([])
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | undefined>(scheduleFromLocation)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LinkFilter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refresh = async () => {
    try {
      setError(undefined)
      const [nextLinks, nextSchedules, nextProposals, integrationResult] = await Promise.all([
        listLinks(),
        listScheduleLinks(),
        listProposals(),
        api<{ integrations: IntegrationConfiguration[] }>('/api/integrations'),
      ])
      setLinks(nextLinks)
      setSchedules(nextSchedules)
      setProposals(nextProposals)
      setIntegrations(integrationResult.integrations)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to load Links')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 12_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onPopState = () => setSelectedScheduleId(scheduleFromLocation())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const visibleLinks = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return links.filter((link) =>
      (filter === 'all' || link.type === filter) &&
      (!needle || link.name.toLowerCase().includes(needle) || link.slug.includes(needle) || link.type.includes(needle)))
  }, [links, query, filter])

  const visibleSchedules = useMemo(() => {
    if (filter !== 'all' && filter !== 'schedule') return []
    const needle = query.trim().toLowerCase()
    return schedules.filter((schedule) => !needle || [schedule.name, schedule.cron, schedule.prompt, schedule.timezone ?? '', 'schedule'].some((value) => value.toLowerCase().includes(needle)))
  }, [schedules, query, filter])

  const pendingLinkApprovals = useMemo(() => proposals.filter((proposal) =>
    proposal.action === 'publish_link' && !['executed', 'denied', 'expired', 'failed'].includes(proposal.status) &&
    (filter === 'all' || filter === proposal.parameters?.['linkType']) &&
    (!query.trim() || proposal.target.toLowerCase().includes(query.trim().toLowerCase())),
  ), [proposals, filter, query])

  const actionExecutors = useMemo(() => integrations.filter((integration) =>
    integration.id !== LINK_SYSTEM_EXECUTOR_ID && integration.state === 'active' &&
    (integration.catalogId === 'exchange-email' || integration.integrationClass === 'action_executor' || integration.authority === 'controlled_actions'),
  ), [integrations])

  const openSchedule = (id: string) => {
    const query = new URLSearchParams(window.location.search)
    query.set('schedule', id)
    window.history.pushState({}, '', `/portal/links?${query}`)
    setSelectedScheduleId(id)
  }
  const closeSchedule = () => {
    const query = new URLSearchParams(window.location.search)
    query.delete('schedule')
    window.history.pushState({}, '', `/portal/links${query.size ? `?${query}` : ''}`)
    setSelectedScheduleId(undefined)
    void refresh()
  }

  if (selectedScheduleId) {
    return <ScheduleEditor id={selectedScheduleId} canManage={canManageSchedules} onBack={closeSchedule} onReplaced={(id) => {
      const query = new URLSearchParams(window.location.search)
      query.set('schedule', id)
      window.history.replaceState({}, '', `/portal/links?${query}`)
      setSelectedScheduleId(id)
      void refresh()
    }} />
  }

  const visibleCount = visibleLinks.length + visibleSchedules.length + pendingLinkApprovals.length
  const total = links.length + schedules.length + pendingLinkApprovals.length

  return <div className="links-view">
    <header className="links-head">
      <div className="links-title"><h2>Links</h2><span>{total}</span></div>
      <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search links…" aria-label="Search Links" />
    </header>

    <nav className="links-tabs" aria-label="Link types">
      <LinkTab active={filter === 'all'} onClick={() => setFilter('all')} icon="◎">All</LinkTab>
      <LinkTab active={filter === 'webpage'} onClick={() => setFilter('webpage')} icon="◉">Webpage</LinkTab>
      <LinkTab active={filter === 'api'} onClick={() => setFilter('api')} icon="〈〉">API</LinkTab>
      <LinkTab active={filter === 'webhook'} onClick={() => setFilter('webhook')} icon="ϟ">Webhook</LinkTab>
      <LinkTab active={filter === 'schedule'} onClick={() => setFilter('schedule')} icon="◷">Schedule</LinkTab>
      <span className="links-validation">PREVIEW · {(validation ?? 'local-static').toUpperCase()}</span>
    </nav>

    {error && <Alert className="error">{error}</Alert>}
    <main className="links-grid" aria-busy={loading}>
      {loading && total === 0
        ? Array.from({ length: 3 }, (_, index) => <Skeleton className="link-card-skeleton" key={index} />)
        : <>
          {pendingLinkApprovals.map((proposal) => <PendingLinkCard proposal={proposal} key={`pending:${proposal.id}`} />)}
          {visibleLinks.map((link) => <LinkCard
            link={link}
            proposals={proposals}
            executors={actionExecutors}
            sessionId={sessionFromLocation()}
            canManage={canManageSchedules}
            onChanged={refresh}
            key={`link:${link.id}`}
          />)}
          {visibleSchedules.map((schedule) => <ScheduleCard schedule={schedule} onOpen={() => openSchedule(schedule.id)} key={`schedule:${schedule.id}`} />)}
        </>}
      {!loading && visibleCount === 0 && <div className="links-empty"><span>◎</span><h3>{total ? 'No matching Links' : 'No Links yet'}</h3><p>{total ? 'Try another type or search.' : 'Ask Papyrus to create a Webpage, API, Webhook, or Schedule. Schedules stay customer-hosted and can be edited here.'}</p></div>}
    </main>
  </div>
}

function LinkTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: string; children: string }) {
  return <button type="button" className={active ? 'active' : ''} aria-pressed={active} onClick={onClick}><span>{icon}</span>{children}</button>
}

function PendingLinkCard({ proposal }: { proposal: AgentActionProposal }) {
  const type = String(proposal.parameters?.['linkType'] ?? 'link')
  return <article className="link-card">
    <div className="link-preview"><div className="webhook-preview"><div className="webhook-logo"><span>◇</span></div><strong>{proposal.target}</strong><small>Draft is not publicly reachable</small><code>Approval {shortId(proposal.id)}</code></div><Badge className="link-type-badge">{type.toUpperCase()}</Badge></div>
    <div className="link-card-body">
      <div className="link-card-title"><strong>{proposal.target}</strong><Badge>PENDING APPROVAL</Badge></div>
      <div className="link-meta"><span className="dot warning" />Awaiting workspace approval<span>·</span><span>{new Date(proposal.proposedAt).toLocaleString()}</span></div>
      <div className="link-card-foot"><span>Draft snapshot</span><span>Not live until approved</span><span className="link-card-foot-actions"><a className="nb-button" href={approvalUrl(proposal.id)}>View approval →</a></span></div>
    </div>
  </article>
}

function ScheduleCard({ schedule, onOpen }: { schedule: ScheduleLink; onOpen: () => void }) {
  const status = schedule.status ?? 'active'
  return <article className="link-card">
    <div className="link-preview">
      <div className="webhook-preview">
        <div className="webhook-logo" aria-hidden="true"><span>◷</span></div>
        <strong>{schedule.cron}</strong>
        <small>{schedule.timezone || 'Daemon timezone'}</small>
        <code>{schedule.prompt.length > 180 ? `${schedule.prompt.slice(0, 180)}…` : schedule.prompt}</code>
      </div>
      <Badge className="link-type-badge">SCHEDULE</Badge>
    </div>
    <div className="link-card-body">
      <div className="link-card-title"><button type="button" className="link-inbound-toggle" onClick={onOpen}>{schedule.name}</button><Badge>{status.toUpperCase()}</Badge></div>
      <div className="link-meta"><span className={`dot ${status === 'paused' ? 'warning' : 'good'}`} />{status === 'paused' ? 'Paused' : 'Active'}<span>·</span><span>{schedule.nextFireAt ? `Next ${new Date(schedule.nextFireAt).toLocaleString()}` : 'Waiting for next run'}</span></div>
      <div className="link-card-foot"><span>Session · {shortId(schedule.threadId)}</span><span>Mastra recurring agent work</span><span className="link-card-foot-actions"><Button variant="ghost" onClick={onOpen}>Edit schedule</Button></span></div>
    </div>
  </article>
}

function ScheduleEditor({ id, canManage, onBack, onReplaced }: { id: string; canManage: boolean; onBack: () => void; onReplaced: (id: string) => void }) {
  const [schedule, setSchedule] = useState<ScheduleLink>()
  const [name, setName] = useState('')
  const [cron, setCron] = useState('')
  const [timezone, setTimezone] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let active = true
    setSchedule(undefined); setError(undefined); setSaved(false)
    getScheduleLink(id).then((value) => {
      if (!active) return
      setSchedule(value); setName(value.name); setCron(value.cron); setTimezone(value.timezone ?? ''); setPrompt(value.prompt)
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load schedule') })
    return () => { active = false }
  }, [id])

  const save = async () => {
    if (!canManage || !name.trim() || !cron.trim() || !prompt.trim()) return
    setBusy(true); setError(undefined); setSaved(false)
    try {
      const result = await saveScheduleLink(id, { name: name.trim(), cron: cron.trim(), prompt: prompt.trim(), ...(timezone.trim() ? { timezone: timezone.trim() } : {}) })
      setSchedule(result.schedule); setSaved(true)
      if (result.schedule.id !== id) onReplaced(result.schedule.id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save schedule')
    } finally {
      setBusy(false)
    }
  }

  return <div className="links-view">
    <header className="links-head">
      <div className="links-title"><Button variant="ghost" onClick={onBack}>← Links</Button><h2>{schedule?.name ?? 'Schedule'}</h2></div>
      {schedule && <Badge>{(schedule.status ?? 'active').toUpperCase()}</Badge>}
    </header>
    {error && <Alert className="error">{error}</Alert>}
    {!canManage && <Alert>Schedule editing requires Integration Manage or System Owner.</Alert>}
    {!schedule && !error ? <Skeleton className="link-card-skeleton" /> : schedule && <article className="nb-card" style={{ display: 'grid', gap: 18 }}>
      <div>
        <p className="eyebrow">HOSTED SCHEDULE LINK</p>
        <h2>Edit recurring agent work</h2>
        <p>This page edits the Mastra schedule bound to session <code>{schedule.threadId}</code>. Saving updates the schedule in place, preserving its ID, session binding, and resource authority.</p>
      </div>
      <Label>Name<Input value={name} disabled={!canManage || busy} onChange={(event) => setName(event.target.value)} maxLength={120} /></Label>
      <Label>Timing (cron)<Input value={cron} disabled={!canManage || busy} onChange={(event) => setCron(event.target.value)} placeholder="0 8 * * 1-5" spellCheck={false} /><small>Five-field cron expression interpreted by the customer-hosted Mastra scheduler.</small></Label>
      <Label>Timezone<Input value={timezone} disabled={!canManage || busy} onChange={(event) => setTimezone(event.target.value)} placeholder="Optional timezone, for example UTC" spellCheck={false} /></Label>
      <Label>Prompt<Textarea value={prompt} disabled={!canManage || busy} onChange={(event) => setPrompt(event.target.value)} rows={10} /><small>This prompt is delivered to the same durable Agent session every time the schedule fires.</small></Label>
      <div className="link-card-foot">
        <span>{schedule.nextFireAt ? `Next run · ${new Date(schedule.nextFireAt).toLocaleString()}` : 'No next run reported'}</span>
        <span>ID · {shortId(schedule.id)}</span>
        <span className="link-card-foot-actions"><Button className="primary" disabled={!canManage || busy || !name.trim() || !cron.trim() || !prompt.trim()} onClick={() => void save()}>{busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save schedule'}</Button></span>
      </div>
    </article>}
  </div>
}

function LinkCard({ link, proposals, executors, sessionId, canManage, onChanged }: {
  link: AgentLink
  proposals: AgentActionProposal[]
  executors: IntegrationConfiguration[]
  sessionId: string | undefined
  canManage: boolean
  onChanged: () => Promise<void>
}) {
  const url = publicLinkUrl(link)
  const [copied, setCopied] = useState(false)
  const [showInbounds, setShowInbounds] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  return <article className="link-card">
    <div className="link-preview">
      {link.type === 'webpage' && <iframe src={link.publicPath} title={`${link.name} preview`} sandbox="" loading="lazy" />}
      {link.type === 'api' && <ApiPreview url={link.publicPath} />}
      {link.type === 'webhook' && <WebhookPreview link={link} />}
      <Badge className="link-type-badge">{link.type.toUpperCase()} ↗</Badge>
    </div>
    <div className="link-card-body">
      <div className="link-card-title"><a href={url} target="_blank" rel="noreferrer">{link.name}</a><Badge>{link.state.toUpperCase()}</Badge></div>
      <div className="link-meta">
        <span className="link-live-dot" />Live<span>·</span><span>{link.pingCount} pings</span><span>·</span>
        <button type="button" className="link-inbound-toggle" aria-expanded={showInbounds} onClick={() => setShowInbounds((open) => !open)}>
          {link.inboundCount} inbounds {showInbounds ? '▴' : '▾'}
        </button>
      </div>
      {link.type === 'webhook' && <WebhookExecutors link={link} proposals={proposals} executors={executors} sessionId={sessionId} canManage={canManage} onChanged={onChanged} />}
      {showInbounds && <LinkInbounds link={link} />}
      <div className="link-card-foot"><span>{link.type === 'webhook' && link.threadId ? `Session · ${shortId(link.threadId)}` : link.workflowId ? `Workflow · ${link.workflowId}` : link.scheduleId ? `Schedule · ${link.scheduleId}` : 'General'}</span><span>{link.type === 'webhook' ? 'Mastra Webhook Signal' : link.validationProvider ? `Validated · ${link.validationProvider}` : 'Approved snapshot'}</span><span className="link-card-foot-actions"><a className="link-snapshot" href={linkContentUrl(link.id, true)} title="Download the approved snapshot this Link serves">Snapshot ↓</a><Button variant="ghost" onClick={() => void copy()} aria-label={`Copy ${link.name} Link`}>{copied ? 'Copied ✓' : 'Copy link'}</Button></span></div>
    </div>
  </article>
}

function WebhookExecutors({ link, proposals, executors, sessionId, canManage, onChanged }: {
  link: AgentLink
  proposals: AgentActionProposal[]
  executors: IntegrationConfiguration[]
  sessionId: string | undefined
  canManage: boolean
  onChanged: () => Promise<void>
}) {
  const attachments = useMemo(() => attachmentViews(link.id, proposals, executors), [link.id, proposals, executors])
  const [executorId, setExecutorId] = useState(executors[0]?.id ?? '')
  const [action, setAction] = useState('')
  const [target, setTarget] = useState(link.slug)
  const [mode, setMode] = useState<InvocationMode>('agent_decides')
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>('inherit')
  const [conditionPath, setConditionPath] = useState('body.type')
  const [conditionEquals, setConditionEquals] = useState('')
  const [inputMapping, setInputMapping] = useState('{}')
  const [timeoutMs, setTimeoutMs] = useState('30000')
  const [maxRetries, setMaxRetries] = useState('2')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    if (!executorId && executors[0]) setExecutorId(executors[0].id)
  }, [executorId, executors])

  const attach = async () => {
    if (!sessionId || !executorId || !action.trim()) return
    setBusy(true); setError(undefined)
    try {
      const mapping = parseStringMap(inputMapping)
      const condition = mode === 'conditional'
        ? { path: conditionPath.trim(), equals: parseScalar(conditionEquals) }
        : undefined
      const proposal = await createSessionProposal(sessionId, {
        executorIntegrationId: LINK_SYSTEM_EXECUTOR_ID,
        action: 'attach_webhook_executor',
        target: link.id,
        parameters: {
          executorIntegrationId: executorId,
          executorAction: action.trim(),
          executorTarget: target.trim() || link.slug,
          invocationMode: mode,
          approvalPolicy,
          inputMapping: mapping,
          ...(condition ? { condition } : {}),
          timeoutMs: Number(timeoutMs),
          maxRetries: Number(maxRetries),
        },
      })
      await onChanged()
      window.location.hash = `approval-${proposal.id}`
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to submit executor attachment')
    } finally {
      setBusy(false)
    }
  }

  const detach = async (attachment: WebhookAttachmentView) => {
    if (!sessionId) return
    setBusy(true); setError(undefined)
    try {
      await createSessionProposal(sessionId, {
        executorIntegrationId: LINK_SYSTEM_EXECUTOR_ID,
        action: 'detach_webhook_executor',
        target: link.id,
        parameters: {
          executorIntegrationId: attachment.executorIntegrationId,
          executorAction: attachment.action,
          executorTarget: attachment.target,
        },
      })
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to submit executor detachment')
    } finally {
      setBusy(false)
    }
  }

  return <section className="webhook-executors" aria-label={`Action Executors attached to ${link.name}`}>
    <div className="webhook-executors-head"><span><p className="eyebrow">ACTION EXECUTORS</p><strong>{attachments.filter((item) => item.state === 'active').length} attached</strong></span><small>Webhook ingress never executes an action directly.</small></div>
    {attachments.length === 0 ? <p className="link-inbounds-empty">No Action Executors attached.</p> : <div className="webhook-executor-list">{attachments.map((attachment) => <div className="webhook-executor-row" key={attachment.key}>
      <span><strong>⚡ {attachment.executorName}</strong><small>{attachment.action} → {attachment.target} · {attachment.invocationMode.replace('_', ' ')}</small></span>
      <span className="webhook-executor-policy"><Badge>{attachment.state.toUpperCase()}</Badge><small>{attachment.approvalPolicy === 'required' ? 'Approval required' : 'Workspace policy · approval required'}</small></span>
      {(attachment.state === 'pending' || attachment.state === 'removing') && <a href={approvalUrl(attachment.proposalId)}>View approval →</a>}
      {attachment.state === 'active' && canManage && <Button variant="ghost" disabled={busy || !sessionId} onClick={() => void detach(attachment)}>Detach</Button>}
    </div>)}</div>}

    {error && <Alert className="error">{error}</Alert>}
    {canManage && <details className="webhook-executor-attach">
      <summary>+ Attach Action Executor</summary>
      {!sessionId && <Alert>Open Links from an Agent session before changing executor attachments. The configuration change itself is submitted to the durable approval queue.</Alert>}
      <div className="webhook-executor-form">
        <Label>Executor<select value={executorId} disabled={busy || !sessionId} onChange={(event) => setExecutorId(event.target.value)}><option value="">Select executor</option>{executors.map((executor) => <option value={executor.id} key={executor.id}>{executor.name}</option>)}</select></Label>
        <Label>Action<Input value={action} disabled={busy || !sessionId} onChange={(event) => setAction(event.target.value)} placeholder="Executor action name" /></Label>
        <Label>Target<Input value={target} disabled={busy || !sessionId} onChange={(event) => setTarget(event.target.value)} placeholder={link.slug} /><small>May interpolate values such as {'{body.repository}'}</small></Label>
        <Label>Invocation<select value={mode} disabled={busy || !sessionId} onChange={(event) => setMode(event.target.value as InvocationMode)}><option value="agent_decides">Agent decides</option><option value="always">Always propose</option><option value="conditional">Conditional proposal</option></select></Label>
        <Label>Approval<select value={approvalPolicy} disabled={busy || !sessionId} onChange={(event) => setApprovalPolicy(event.target.value as ApprovalPolicy)}><option value="inherit">Inherit workspace policy</option><option value="required">Always require approval</option></select></Label>
        {mode === 'conditional' && <><Label>Condition path<Input value={conditionPath} disabled={busy || !sessionId} onChange={(event) => setConditionPath(event.target.value)} placeholder="body.type" /></Label><Label>Equals<Input value={conditionEquals} disabled={busy || !sessionId} onChange={(event) => setConditionEquals(event.target.value)} placeholder="push" /></Label></>}
        <Label>Input mapping<Textarea value={inputMapping} disabled={busy || !sessionId} onChange={(event) => setInputMapping(event.target.value)} rows={4} spellCheck={false} /><small>JSON object mapping executor parameter names to paths, e.g. {'{"repository":"body.repository"}'}.</small></Label>
        <Label>Timeout (ms)<Input type="number" min={1000} max={120000} value={timeoutMs} disabled={busy || !sessionId} onChange={(event) => setTimeoutMs(event.target.value)} /></Label>
        <Label>Retries<Input type="number" min={0} max={2} value={maxRetries} disabled={busy || !sessionId} onChange={(event) => setMaxRetries(event.target.value)} /></Label>
        <Button className="primary" disabled={busy || !sessionId || !executorId || !action.trim()} onClick={() => void attach()}>{busy ? 'Submitting…' : 'Submit attachment for approval'}</Button>
      </div>
    </details>}
  </section>
}

function attachmentViews(linkId: string, proposals: AgentActionProposal[], integrations: IntegrationConfiguration[]): WebhookAttachmentView[] {
  const names = new Map(integrations.map((integration) => [integration.id, integration.name]))
  const active = new Map<string, WebhookAttachmentView>()
  const pending: WebhookAttachmentView[] = []
  const relevant = proposals.filter((proposal) => proposal.target === linkId && ['attach_webhook_executor', 'detach_webhook_executor'].includes(proposal.action))
    .sort((left, right) => left.proposedAt.localeCompare(right.proposedAt))

  for (const proposal of relevant) {
    const parameters = proposal.parameters ?? {}
    const executorIntegrationId = String(parameters['executorIntegrationId'] ?? '')
    const action = String(parameters['executorAction'] ?? '')
    const target = String(parameters['executorTarget'] ?? '')
    const key = `${executorIntegrationId}\u0000${action}\u0000${target}`
    if (!executorIntegrationId || !action || !target) continue
    const base: WebhookAttachmentView = {
      key,
      executorIntegrationId,
      executorName: names.get(executorIntegrationId) ?? executorIntegrationId,
      action,
      target,
      invocationMode: ['always', 'conditional'].includes(String(parameters['invocationMode'])) ? parameters['invocationMode'] as InvocationMode : 'agent_decides',
      approvalPolicy: parameters['approvalPolicy'] === 'required' ? 'required' : 'inherit',
      ...(parameters['condition'] && typeof parameters['condition'] === 'object' && !Array.isArray(parameters['condition']) ? { condition: parameters['condition'] as Record<string, unknown> } : {}),
      inputMapping: parameters['inputMapping'] && typeof parameters['inputMapping'] === 'object' && !Array.isArray(parameters['inputMapping']) ? parameters['inputMapping'] as Record<string, string> : {},
      ...(typeof parameters['timeoutMs'] === 'number' ? { timeoutMs: parameters['timeoutMs'] } : {}),
      ...(typeof parameters['maxRetries'] === 'number' ? { maxRetries: parameters['maxRetries'] } : {}),
      state: 'pending',
      proposalId: proposal.id,
    }

    if (proposal.action === 'attach_webhook_executor') {
      if (proposal.status === 'executed') active.set(key, { ...base, state: 'active' })
      else if (proposal.status === 'failed') pending.push({ ...base, state: 'failed' })
      else if (!['denied', 'expired'].includes(proposal.status)) pending.push(base)
    } else if (proposal.status === 'executed') {
      active.delete(key)
    } else if (!['denied', 'expired', 'failed'].includes(proposal.status)) {
      const attached = active.get(key)
      if (attached) active.set(key, { ...attached, state: 'removing', proposalId: proposal.id })
    }
  }
  return [...active.values(), ...pending]
}

function parseStringMap(value: string): Record<string, string> {
  const parsed = JSON.parse(value || '{}') as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Input mapping must be a JSON object')
  const result: Record<string, string> = {}
  for (const [key, path] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof path !== 'string') throw new Error(`Input mapping ${key} must be a string path`)
    result[key] = path
  }
  return result
}

function parseScalar(value: string): string | number | boolean | null {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed === null || ['string', 'number', 'boolean'].includes(typeof parsed)) return parsed as string | number | boolean | null
  } catch { /* plain strings are valid */ }
  return trimmed
}

function approvalUrl(id: string): string {
  const query = new URLSearchParams({ approval: id })
  const session = sessionFromLocation()
  if (session) query.set('session', session)
  return `/portal/governance?${query}`
}

function LinkInbounds({ link }: { link: AgentLink }) {
  const [inbounds, setInbounds] = useState<LinkInbound[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    linkInbounds(link.id).then((records) => { if (active) setInbounds(records) })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'Unable to load inbound records') })
    return () => { active = false }
  }, [link.id])

  if (error) return <p className="link-inbounds-empty">{error}</p>
  if (!inbounds) return <p className="link-inbounds-empty">Loading received records…</p>
  if (!inbounds.length) return <p className="link-inbounds-empty">Nothing has arrived on this Link yet.</p>

  return <ul className="link-inbounds">
    {inbounds.map((record) => <li key={record.id}>
      <span className="link-inbounds-method">{record.method}</span>
      <span className="link-inbounds-when">{new Date(record.receivedAt).toLocaleString()}</span>
      <span className="link-inbounds-size">{record.size} B</span>
      <span className="link-inbounds-actions">
        <a href={linkInboundUrl(link.id, record.id)} target="_blank" rel="noreferrer">View</a>
        <a href={linkInboundUrl(link.id, record.id, true)} download>Download</a>
      </span>
    </li>)}
  </ul>
}

function WebhookPreview({ link }: { link: AgentLink }) {
  const logoUrl = link.logoPath ? workspaceFileContentUrl(link.logoPath) : undefined
  return <div className="webhook-preview">
    <div className="webhook-logo">
      {logoUrl
        ? <img src={logoUrl} alt={`${link.name} logo`} loading="lazy" />
        : <span aria-hidden="true">{link.logoText || 'ϟ'}</span>}
    </div>
    <strong>{link.name}</strong>
    <small>{link.threadId ? `Session-scoped · ${shortId(link.threadId)}` : 'Webhook'}</small>
    <code>{link.publicPath}</code>
  </div>
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}

function ApiPreview({ url }: { url: string }) {
  const [text, setText] = useState('Loading API preview…')
  useEffect(() => {
    let active = true
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async (response) => {
        const value = await response.text()
        if (!response.ok) throw new Error(value)
        try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
      })
      .then((value) => { if (active) setText(value.slice(0, 1800)) })
      .catch(() => { if (active) setText('API preview unavailable') })
    return () => { active = false }
  }, [url])
  return <pre className="api-link-preview">{text}</pre>
}