import { useCallback, useEffect, useState } from 'react'
import type { PortalData, PublicConfig } from './api.js'
import { AuthenticationRequired, createSession, deleteSession, loadAgentStatus, loadPortal, logout, publicConfig, type AgentSession, type AgentStatus } from './api.js'
import { AgentView } from './Agent.js'
import { LibraryView } from './Library.js'
import { LinksView } from './Links.js'
import { ModelsView } from './Models.js'
import { ObservabilityPanel } from './Observability.js'
import { Alert, Avatar, Badge, Button, Card, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, Skeleton } from './components/ui/index.js'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger } from './components/ui/sidebar.js'

export type PortalView = 'agent' | 'models' | 'links' | 'library' | 'governance'
type AppState = { phase: 'loading' } | { phase: 'signed-out'; config: PublicConfig } | { phase: 'ready'; data: PortalData } | { phase: 'error'; message: string }

const ROUTES: Record<PortalView, string> = {
  agent: '/portal', models: '/portal/models', links: '/portal/links', library: '/portal/library', governance: '/portal/governance',
}

function viewFromPath(): PortalView {
  return (Object.entries(ROUTES).find(([, route]) => window.location.pathname === route)?.[0] as PortalView | undefined) ?? 'agent'
}

function Logo() { return <div className="brand"><span className="brand-mark" aria-hidden="true">P</span><span>PAPYRUS</span></div> }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') }
function profileLabel(profile: string) { return ({ gcc: 'GCC', gcch: 'GCC HIGH', dod: 'DOD', restricted: 'RESTRICTED', disconnected: 'DISCONNECTED' } as Record<string, string>)[profile] ?? profile.toUpperCase() }

export function App() {
  const [state, setState] = useState<AppState>({ phase: 'loading' })
  const [view, setView] = useState<PortalView>(viewFromPath)
  const [selectedSessionId, setSelectedSessionId] = useState(() => new URLSearchParams(window.location.search).get('session') ?? undefined)
  const [initialPrompt, setInitialPrompt] = useState(() => new URLSearchParams(window.location.search).get('prompt') ?? undefined)

  const refresh = useCallback(async () => {
    try { setState({ phase: 'ready', data: await loadPortal() }) }
    catch (cause) {
      if (cause instanceof AuthenticationRequired) {
        try { setState({ phase: 'signed-out', config: await publicConfig() }) }
        catch { setState({ phase: 'error', message: 'Unable to load deployment configuration' }) }
      } else setState({ phase: 'error', message: cause instanceof Error ? cause.message : 'Unable to open Papyrus' })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const onPopState = () => { setView(viewFromPath()); setSelectedSessionId(new URLSearchParams(window.location.search).get('session') ?? undefined) }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = (next: PortalView, options?: { prompt?: string | undefined; session?: string | undefined }) => {
    const query = new URLSearchParams()
    if (options?.prompt) query.set('prompt', options.prompt)
    if (options?.session) query.set('session', options.session)
    window.history.pushState({}, '', `${ROUTES[next]}${query.size ? `?${query}` : ''}`)
    setView(next); setInitialPrompt(options?.prompt); setSelectedSessionId(options?.session)
  }

  if (state.phase === 'loading') return <PortalSkeleton />
  if (state.phase === 'error') return <main className="center login"><Logo /><p className="eyebrow">DAEMON UNAVAILABLE</p><h1>Unable to open<br />Papyrus.</h1><Alert className="error">{state.message}</Alert><Button className="primary" onClick={() => { setState({ phase: 'loading' }); void refresh() }}>Try again →</Button></main>
  if (state.phase === 'signed-out') return <SignedOut config={state.config} />

  const data = state.data
  const selectedSession = data.sessions.find((session) => session.id === selectedSessionId) ?? data.sessions[0]
  const newSession = async () => {
    const created = await createSession()
    await refresh(); navigate('agent', { session: created.id })
  }
  // Confirmation lives here rather than in the row, so the destructive call has one
  // guard no matter which surface invokes it. The title is quoted back because the
  // sidebar lists conversations by name and "Delete session?" identifies nothing.
  const removeSession = async (session: AgentSession) => {
    if (!window.confirm(`Delete \u201C${session.title}\u201D? Its transcript is removed with it.`)) return
    await deleteSession(session.id); if (selectedSessionId === session.id) setSelectedSessionId(undefined); await refresh()
  }
  const signOut = async () => { await logout(); window.location.replace('/portal') }

  return <>
    <div className="handling-banner government"><strong>{profileLabel(data.config.profile)}</strong><span>AUTHORIZED USE ONLY · CUSTOMER-HOSTED AGENT RUNTIME</span></div>
    <SidebarProvider className="portal-shell with-handling-banner">
      <Sidebar collapsible="icon" className="portal-sidebar">
        <SidebarHeader>
          <div className="sidebar-brand-row"><Logo /></div>
          <div className="classification">{profileLabel(data.config.profile)} · {data.config.cloud}</div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton className="new-session" tooltip="New session" onClick={() => void newSession()}><span className="sidebar-icon">＋</span><span className="sidebar-copy">New session</span></SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup className="sidebar-history-group">
            <SidebarGroupLabel>History</SidebarGroupLabel>
            <SidebarGroupContent>
              <SessionHistory sessions={data.sessions} selectedId={selectedSession?.id} onSelect={(id) => navigate('agent', { session: id })} onDelete={(session) => void removeSession(session)} />
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Platform</SidebarGroupLabel>
            <SidebarGroupContent>
              <PrimaryNavigation view={view} onNavigate={navigate} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <RuntimeStatusStrip status={data.agent} sessionId={selectedSession?.id} />
          <DropdownMenu className="account-menu" trigger={<div className="account-trigger-content"><Avatar className="avatar">{initials(data.me.displayName)}</Avatar><span className="account-copy sidebar-copy"><strong>{data.me.displayName}</strong><small>ENTRA · {data.me.roles.length} ROLES</small></span><span className="sidebar-copy">•••</span></div>}>
            <DropdownMenuLabel><strong>{data.me.displayName}</strong><span>{data.me.preferredUsername ?? data.me.oid}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem disabled>Roles managed in Microsoft Entra</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="danger-item" onClick={() => void signOut()}>Sign out</DropdownMenuItem>
          </DropdownMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
      <SidebarInset className={`portal-main ${view === 'agent' ? 'agent-main' : ''}`}><PortalHeader view={view} data={data} />
        {view === 'agent' && (selectedSession
          ? <AgentView key={selectedSession.id} session={selectedSession} status={data.agent} initialPrompt={initialPrompt} canApprove={data.me.roles.includes('Papyrus.System.Owner') || data.me.roles.includes('Papyrus.Action.Approve')} canManageSkills={data.me.roles.includes('Papyrus.System.Owner')} onChanged={refresh} />
          : <EmptyAgent onCreate={() => void newSession()} />)}
        {view === 'models' && <ModelsView profiles={data.models} onAskAgent={(prompt) => navigate('agent', { prompt, session: selectedSession?.id })} onChanged={refresh} canManage={data.me.roles.includes('Papyrus.System.Owner') || data.me.roles.includes('Papyrus.Integration.Manage')} />}
        {view === 'links' && <LinksView {...(data.agent.links?.validation ? { validation: data.agent.links.validation } : {})} />}
        {view === 'library' && <LibraryView />}
        {view === 'governance' && <GovernanceView data={data} />}
      </SidebarInset>
    </SidebarProvider>
  </>

}

function SessionHistory({ sessions, selectedId, onSelect, onDelete }: { sessions: PortalData['sessions']; selectedId?: string | undefined; onSelect: (id: string) => void; onDelete: (session: AgentSession) => void }) {
  if (!sessions.length) return <small className="sidebar-empty">No sessions yet</small>
  return <SidebarMenu className="session-history">{sessions.map((session, index) => <SidebarMenuItem className="session-row" data-history-depth={Math.min(index, 6)} key={session.id}><SidebarMenuButton isActive={selectedId === session.id} tooltip={session.title} onClick={() => onSelect(session.id)}>{session.attention ? <span className="attention-icon" title="Requires attention">!</span> : <span className="sidebar-session-mark">•</span>}<span className="sidebar-copy session-title">{session.title}</span></SidebarMenuButton><Button variant="ghost" className="session-delete sidebar-copy" aria-label={`Delete ${session.title}`} onClick={() => onDelete(session)}>×</Button></SidebarMenuItem>)}</SidebarMenu>
}

function EmptyAgent({ onCreate }: { onCreate: () => void }) { return <Card className="empty-agent"><span>✦</span><h2>Start a durable session</h2><p>Your conversation, tool activity, and signal history stay in this customer-hosted daemon.</p><Button className="primary" onClick={onCreate}>New session →</Button></Card> }

function PortalSkeleton() {
  return <div className="portal-skeleton">
    <aside>
      <div className="portal-skeleton-brand"><Skeleton className="skeleton-square" /><Skeleton className="skeleton-brand-line" /></div>
      <Skeleton className="skeleton-sidebar-wide" />
      <Skeleton className="skeleton-sidebar-wide" />
      <div className="portal-skeleton-nav">{Array.from({ length: 5 }, (_, index) => <Skeleton className="skeleton-nav-line" key={index} />)}</div>
    </aside>
    <main>
      <div className="portal-skeleton-header"><div><Skeleton className="skeleton-eyebrow" /><Skeleton className="skeleton-title" /></div><Skeleton className="skeleton-status" /></div>
      <div className="portal-skeleton-body"><Skeleton className="skeleton-content-wide" /><Skeleton className="skeleton-content-line" /><Skeleton className="skeleton-content-line short" /><Skeleton className="skeleton-card" /></div>
    </main>
  </div>
}

function SignedOut({ config }: { config: PublicConfig }) {
  return <><div className="handling-banner government"><strong>{profileLabel(config.profile)}</strong><span>MICROSOFT ENTRA AUTHORITY</span></div><main className="center login agent-login"><Logo /><p className="eyebrow">CUSTOMER-HOSTED AGENT RUNTIME</p><h1>Your tools.<br />Your authority.</h1><p>Papyrus accepts identity and application roles from your Microsoft Entra tenant. It does not maintain a parallel user directory.</p>{config.entraConfigured
    ? <a className="primary" href={`/api/auth/entra/login?returnTo=${encodeURIComponent(window.location.pathname.startsWith('/portal') ? window.location.pathname : '/portal')}`}>Continue with Microsoft Entra →</a>
    : <Alert className="error">This deployment does not have Microsoft Entra configured.</Alert>}<div className="login-facts"><span>{config.organizationName}</span><span>{profileLabel(config.profile)}</span><span>{config.cloud}</span></div></main></>
}

export function scheduleSummary(jobs: NonNullable<AgentStatus['jobs']>): string {
  const { active, paused, nextFireAt } = jobs.schedules
  const parts = [`${active} active ${active === 1 ? 'schedule' : 'schedules'}`]
  if (paused > 0) parts.push(`${paused} paused`)
  if (typeof nextFireAt === 'number' && Number.isFinite(nextFireAt)) {
    parts.push(`next ${new Date(nextFireAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`)
  }
  return parts.join(' · ')
}

export function backgroundSummary(jobs: NonNullable<AgentStatus['jobs']>): string {
  if (!jobs.background.observed) return 'job queue unavailable'
  const { running, queued } = jobs.background
  if (running === 0 && queued === 0) return 'no jobs running'
  return [running > 0 ? `${running} running` : null, queued > 0 ? `${queued} queued` : null].filter(Boolean).join(' · ')
}

/**
 * Footer runtime status. Recurring work and running jobs are session-scoped: the strip
 * only reports what the daemon can observe for the selected session, and says so when it
 * cannot observe the background queue rather than reporting zero.
 */
/**
 * How often the footer re-reads session job state. A status strip that only loads once
 * is wrong the moment a job starts or a schedule fires, and there is no push channel for
 * either, so it polls. Five seconds is well inside the daemon's own schedule tick and
 * cheap: the endpoint returns counts, not transcripts.
 */
const JOBS_POLL_MS = 5_000

export function RuntimeStatusStrip({ status, sessionId }: { status: AgentStatus; sessionId?: string | undefined }) {
  const [jobs, setJobs] = useState<AgentStatus['jobs']>()

  useEffect(() => {
    if (!sessionId) { setJobs(undefined); return }
    let cancelled = false
    const load = () => {
      void loadAgentStatus(sessionId)
        .then((next) => { if (!cancelled) setJobs(next.jobs) })
        .catch(() => { if (!cancelled) setJobs(undefined) })
    }
    load()
    const timer = setInterval(load, JOBS_POLL_MS)
    return () => { cancelled = true; clearInterval(timer) }
  }, [sessionId])

  return <div className="runtime-panel">
    <span className="runtime-label">RUNTIME</span>
    <strong><span className={`dot ${status.agentReady ? 'good' : 'warning'}`} /><span className="sidebar-copy">{status.agentReady ? 'Mastra online' : 'Mastra storage online'}</span></strong>
    <small className="sidebar-copy">{status.model ?? 'Model configuration required'}</small>
    {jobs && <div className="runtime-jobs" data-session={jobs.sessionId}>
      <span><i className={`dot ${jobs.schedules.active > 0 ? 'good' : ''}`} />{scheduleSummary(jobs)}</span>
      <span><i className={`dot ${jobs.background.running > 0 ? 'good' : ''}`} />{backgroundSummary(jobs)}</span>
    </div>}
  </div>
}

export function PrimaryNavigation({ view, onNavigate }: { view: PortalView; onNavigate: (view: PortalView) => void }) {
  const items: Array<{ view: PortalView; icon: string; label: string }> = [
    { view: 'agent', icon: '✦', label: 'Agent' }, { view: 'models', icon: '◎', label: 'Models' },
    { view: 'links', icon: '◎', label: 'Links' }, { view: 'library', icon: '▤', label: 'Library' },
    { view: 'governance', icon: '◇', label: 'Governance' },
  ]
  return <SidebarMenu aria-label="Primary navigation">{items.map((item) => <SidebarMenuItem key={item.view}><SidebarMenuButton isActive={view === item.view} tooltip={item.label} onClick={() => onNavigate(item.view)}><span className="sidebar-icon" aria-hidden="true">{item.icon}</span><span className="sidebar-copy">{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
}

function PortalHeader({ view, data }: { view: PortalView; data: PortalData }) {
  const copy: Record<PortalView, [string, string]> = {
    agent: ['MASTRA RUNTIME', 'Agent'], models: ['MODEL GATEWAYS', 'Models'],
    links: ['AGENT-CREATED PUBLIC BOUNDARIES', 'Links'], library: ['AGENTFS FILE AUTHORITY', 'Library'], governance: ['IDENTITY, LICENSING AND AUDIT', 'Governance'],
  }
  return <header className="portal-header"><div className="portal-header-title"><SidebarTrigger /><div><p className="eyebrow">{copy[view][0]}</p><h1>{copy[view][1]}</h1></div></div><div className="header-status"><span><i className="dot good" />DAEMON HEALTHY</span><small>{data.config.organizationName}</small></div></header>
}

function GovernanceView({ data }: { data: PortalData }) {
  return <div className="governance-surface">
    <div className="governance-grid">
      <Card><p className="eyebrow">IDENTITY AUTHORITY</p><h2>Microsoft Entra ID</h2><p>Users, groups, and application roles are assigned in the customer tenant. Papyrus maintains no invitation or local role database.</p><div className="role-list">{data.me.roles.map((role) => <Badge key={role}>{role.replace('Papyrus.', '')}</Badge>)}</div></Card>
      <Card><p className="eyebrow">OFFLINE ENTITLEMENT</p><h2>{data.overview.deployment.license.valid ? 'License active' : 'Activation required'}</h2><p>Licensing remains deployment-bound and locally verified. No vendor cloud callback is required.</p><code>{data.overview.deployment.license.deploymentId.slice(0, 24)}…</code></Card>
      <Card><p className="eyebrow">ACTION BOUNDARY</p><h2>Suggestions are not authority</h2><p>Agent suggestions appear with a <strong>!</strong>. Only deterministic policy and an Entra-authorized approver can release an action to the leased executor worker.</p></Card>
    </div>
    <ObservabilityPanel roles={data.me.roles} />
  </div>
}
