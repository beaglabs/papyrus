import { useEffect, useMemo, useState } from 'react'
import type { AgentLink, HostedApp, LinkInbound, LinkType } from '@papyrus/contracts'
import { linkContentUrl, linkInboundUrl, linkInbounds, listLinks, publicLinkUrl, workspaceFileContentUrl } from './api.js'
import { AppLinkWorkspace, appRequest } from './AppBuilder.js'
import { Alert, Badge, Button, Input, Label, Skeleton, Textarea } from './components/ui/index.js'

type LinkFilter = 'all' | LinkType | 'schedule'

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

function selectionFromLocation(): { app?: string; schedule?: string } {
  const query = new URLSearchParams(window.location.search)
  const app = query.get('app') ?? undefined
  const schedule = query.get('schedule') ?? undefined
  return {
    ...(app ? { app } : {}),
    ...(schedule ? { schedule } : {}),
  }
}

export function LinksView({ validation, canManageSchedules = false }: { validation?: 'local-static' | 'kitesurf'; canManageSchedules?: boolean }) {
  const initialSelection = selectionFromLocation()
  const [links, setLinks] = useState<AgentLink[]>([])
  const [apps, setApps] = useState<HostedApp[]>([])
  const [schedules, setSchedules] = useState<ScheduleLink[]>([])
  const [selectedAppId, setSelectedAppId] = useState<string | undefined>(initialSelection.app)
  const [selectedScheduleId, setSelectedScheduleId] = useState<string | undefined>(initialSelection.schedule)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LinkFilter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()

  const refresh = async () => {
    try {
      setError(undefined)
      const [nextLinks, nextApps, nextSchedules] = await Promise.all([
        listLinks(),
        appRequest<{ apps: HostedApp[] }>('/api/apps').then((value) => value.apps),
        listScheduleLinks(),
      ])
      setLinks(nextLinks)
      setApps(nextApps)
      setSchedules(nextSchedules)
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
    const onPopState = () => {
      const selection = selectionFromLocation()
      setSelectedAppId(selection.app)
      setSelectedScheduleId(selection.schedule)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  // Published apps are also materialized in agent_links for the serving plane.
  // AppStore is authoritative for authoring, so omit those duplicates here and
  // render both draft and live apps through the same first-class App Link card.
  const ordinaryLinks = useMemo(() => links.filter((link) => link.type !== 'app'), [links])
  const visibleLinks = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return ordinaryLinks.filter((link) =>
      (filter === 'all' || link.type === filter) &&
      (!needle || link.name.toLowerCase().includes(needle) || link.slug.includes(needle) || link.type.includes(needle)))
  }, [ordinaryLinks, query, filter])

  const visibleApps = useMemo(() => {
    if (filter !== 'all' && filter !== 'app') return []
    const needle = query.trim().toLowerCase()
    return apps.filter((app) => !needle || [app.name, app.id, app.sessionId, app.liveReleaseId ? 'live app' : 'draft app'].some((value) => value.toLowerCase().includes(needle)))
  }, [apps, query, filter])

  const visibleSchedules = useMemo(() => {
    if (filter !== 'all' && filter !== 'schedule') return []
    const needle = query.trim().toLowerCase()
    return schedules.filter((schedule) => !needle || [schedule.name, schedule.cron, schedule.prompt, schedule.timezone ?? '', 'schedule'].some((value) => value.toLowerCase().includes(needle)))
  }, [schedules, query, filter])

  const openApp = (id: string) => {
    window.history.pushState({}, '', `/portal/links?app=${encodeURIComponent(id)}`)
    setSelectedScheduleId(undefined)
    setSelectedAppId(id)
  }
  const closeApp = () => {
    window.history.pushState({}, '', '/portal/links')
    setSelectedAppId(undefined)
    void refresh()
  }
  const openSchedule = (id: string) => {
    window.history.pushState({}, '', `/portal/links?schedule=${encodeURIComponent(id)}`)
    setSelectedAppId(undefined)
    setSelectedScheduleId(id)
  }
  const closeSchedule = () => {
    window.history.pushState({}, '', '/portal/links')
    setSelectedScheduleId(undefined)
    void refresh()
  }

  if (selectedAppId) {
    const selected = apps.find((app) => app.id === selectedAppId)
    if (!selected && loading) return <div className="links-view"><Skeleton className="link-card-skeleton" /></div>
    if (!selected) return <div className="links-view"><Alert className="error">App Link not found or you no longer have author access.</Alert><Button onClick={closeApp}>← Links</Button></div>
    return <AppLinkWorkspace app={selected} onBack={closeApp} onChanged={() => { void refresh() }} />
  }

  if (selectedScheduleId) {
    return <ScheduleEditor id={selectedScheduleId} canManage={canManageSchedules} onBack={closeSchedule} onReplaced={(id) => {
      window.history.replaceState({}, '', `/portal/links?schedule=${encodeURIComponent(id)}`)
      setSelectedScheduleId(id)
      void refresh()
    }} />
  }

  const visibleCount = visibleLinks.length + visibleApps.length + visibleSchedules.length
  const total = ordinaryLinks.length + apps.length + schedules.length

  return <div className="links-view">
    <header className="links-head">
      <div className="links-title"><h2>Links</h2><span>{total}</span></div>
      <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search links…" aria-label="Search Links" />
    </header>

    <nav className="links-tabs" aria-label="Link types">
      <LinkTab active={filter === 'all'} onClick={() => setFilter('all')} icon="◎">All</LinkTab>
      <LinkTab active={filter === 'app'} onClick={() => setFilter('app')} icon="▣">App</LinkTab>
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
          {visibleApps.map((app) => <AppLinkCard app={app} onOpen={() => openApp(app.id)} key={`app:${app.id}`} />)}
          {visibleLinks.map((link) => <LinkCard link={link} key={`link:${link.id}`} />)}
          {visibleSchedules.map((schedule) => <ScheduleCard schedule={schedule} onOpen={() => openSchedule(schedule.id)} key={`schedule:${schedule.id}`} />)}
        </>}
      {!loading && visibleCount === 0 && <div className="links-empty"><span>◎</span><h3>{total ? 'No matching Links' : 'No Links yet'}</h3><p>{total ? 'Try another type or search.' : 'Ask Papyrus to create an App, Webpage, API, Webhook, or Schedule. App Links are built and continuously prompted from this page.'}</p></div>}
    </main>
  </div>
}

function LinkTab({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: string; children: string }) {
  return <button type="button" className={active ? 'active' : ''} aria-pressed={active} onClick={onClick}><span>{icon}</span>{children}</button>
}

function AppLinkCard({ app, onOpen }: { app: HostedApp; onOpen: () => void }) {
  const live = Boolean(app.liveReleaseId)
  return <article className="link-card app-link-card">
    <div className="link-preview app-link-preview">
      <div className="app-link-preview-mark"><span>✦</span><strong>AGENTIC APP</strong><small>{live ? 'Immutable production release' : 'Software factory draft'}</small></div>
      <Badge className="link-type-badge">APP</Badge>
    </div>
    <div className="link-card-body">
      <div className="link-card-title"><button type="button" className="link-inbound-toggle" onClick={onOpen}>{app.name}</button><Badge className={live ? 'status-good' : ''}>{live ? 'LIVE' : 'DRAFT'}</Badge></div>
      <div className="link-meta"><span className={`dot ${live ? 'good' : 'warning'}`} />{live ? 'Published' : 'Building'}<span>·</span><span>Entra authenticated</span><span>·</span><span>Agent-owned project</span></div>
      <div className="link-card-foot">
        <span>Session · {shortId(app.sessionId)}</span>
        <span>{live ? `Release · ${shortId(app.liveReleaseId!)}` : 'Prompt to continue building'}</span>
        <span className="link-card-foot-actions"><Button variant="ghost" onClick={onOpen}>Open factory</Button>{live && <a className="link-snapshot" href={`/a/${encodeURIComponent(app.id)}`} target="_blank" rel="noreferrer">Open live ↗</a>}</span>
      </div>
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

function LinkCard({ link }: { link: AgentLink }) {
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
      {showInbounds && <LinkInbounds link={link} />}
      <div className="link-card-foot"><span>{link.type === 'webhook' && link.threadId ? `Session · ${shortId(link.threadId)}` : link.workflowId ? `Workflow · ${link.workflowId}` : link.scheduleId ? `Schedule · ${link.scheduleId}` : 'General'}</span><span>{link.type === 'webhook' ? 'Mastra Webhook Signal' : link.validationProvider ? `Validated · ${link.validationProvider}` : 'Approved snapshot'}</span><span className="link-card-foot-actions"><a className="link-snapshot" href={linkContentUrl(link.id, true)} title="Download the approved snapshot this Link serves">Snapshot ↓</a><Button variant="ghost" onClick={() => void copy()} aria-label={`Copy ${link.name} Link`}>{copied ? 'Copied ✓' : 'Copy link'}</Button></span></div>
    </div>
  </article>
}

/**
 * What actually arrived on a Link, and the only place it can be read back.
 *
 * A workflow-bound API Link answers GET by running its workflow, so the pinned snapshot is not
 * retrievable through the Link itself, and inbound records were previously only reachable by
 * listing metadata, copying a blob path out of it, and reading that path as a workspace file.
 * Both are served from authenticated portal routes here; the Link URL is a public boundary and
 * inbound traffic is customer data, so none of this is exposed there.
 */
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
