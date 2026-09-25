import { useCallback, useEffect, useState } from 'react'
import { CLASSIFICATION_BANNER_FEATURE, CLASSIFICATION_BANNERS, CLASSIFICATION_LEVELS, type ClassificationLevel, type LicenseStatus } from '@papyrus/contracts'
import type { PortalData, PublicConfig } from './api.js'
import { AuthenticationRequired, createSession, deleteSession, loadPortal, logout, publicConfig, type AgentSession, type AgentStatus } from './api.js'
import { AgentView } from './Agent.js'
import { AccessView } from './Access.js'
import { LibraryView } from './Library.js'
import { LinksView } from './Links.js'
import { ModelsView } from './Models.js'
import { ObservabilityPanel } from './Observability.js'
import { Onboarding } from './Onboarding.js'
import { Alert, Avatar, Badge, Button, Card, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, Skeleton } from './components/ui/index.js'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger } from './components/ui/sidebar.js'
import papyrusLogo from '../../../deploy/marketplace/logos/papyrus-small-48x48.png'

export type PortalView = 'agent' | 'models' | 'links' | 'library' | 'governance' | 'access'
type AppState = { phase: 'loading' } | { phase: 'bootstrap' } | { phase: 'signed-out'; config: PublicConfig } | { phase: 'ready'; data: PortalData } | { phase: 'error'; message: string }

const ROUTES: Record<PortalView, string> = {
  agent: '/portal', models: '/portal/models', links: '/portal/links', library: '/portal/library', governance: '/portal/governance', access: '/portal/access',
}

function viewFromPath(): PortalView {
  return (Object.entries(ROUTES).find(([, route]) => window.location.pathname === route)?.[0] as PortalView | undefined) ?? 'agent'
}

function Logo() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true"><img src={papyrusLogo} alt="" width="39" height="39" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} /></span><span>PAPYRUS</span></div>
}
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') }
function profileLabel(profile: string) { return profile.toUpperCase() }

async function licensedClassification(): Promise<ClassificationLevel | undefined> {
  try {
    const response = await fetch('/api/license/status', { credentials: 'same-origin', headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    const status = await response.json() as LicenseStatus
    const features = status.valid ? status.license?.features ?? [] : []
    if (!features.includes(CLASSIFICATION_BANNER_FEATURE)) return undefined
    const value = features.find((feature) => feature.startsWith('classification:'))?.slice('classification:'.length)
    return value && CLASSIFICATION_LEVELS.includes(value as ClassificationLevel) ? value as ClassificationLevel : undefined
  } catch {
    return undefined
  }
}

function ClassificationBanner({ level }: { level: ClassificationLevel }) {
  const banner = CLASSIFICATION_BANNERS[level]
  return <div className="classification-banner" role="note" aria-label={`System classification: ${banner.label}`} style={{ background: banner.background, color: banner.foreground }}><strong>{banner.label}</strong></div>
}

/**
 * Keep the identity mark stable even when an upstream identity response temporarily omits
 * its picture URL. The initials are always rendered underneath the image, so a failed image
 * can never turn into an empty/generic avatar; when an identity provider does supply a
 * picture URL, the last good URL is retained locally for this exact tenant + object id.
 */
function UserAvatar({ principal }: { principal: PortalData['me'] }) {
  const identity = principal as PortalData['me'] & { pictureUrl?: string }
  const cacheKey = `papyrus:user-avatar:${principal.tenantId}:${principal.oid}`
  const [pictureUrl, setPictureUrl] = useState<string | undefined>(() => {
    if (identity.pictureUrl) return identity.pictureUrl
    try { return window.localStorage.getItem(cacheKey) ?? undefined } catch { return undefined }
  })

  useEffect(() => {
    if (!identity.pictureUrl) return
    setPictureUrl(identity.pictureUrl)
    try { window.localStorage.setItem(cacheKey, identity.pictureUrl) } catch { /* storage can be disabled by policy */ }
  }, [cacheKey, identity.pictureUrl])

  const fallback = initials(principal.displayName) || initials(principal.preferredUsername ?? '') || 'U'
  return <Avatar className="avatar" style={{ position: 'relative', overflow: 'hidden' }}>
    <span aria-hidden="true">{fallback}</span>
    {pictureUrl && <img src={pictureUrl} alt="" referrerPolicy="no-referrer" onError={() => setPictureUrl(undefined)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />}
  </Avatar>
}

export function App() {
  const [state, setState] = useState<AppState>({ phase: 'loading' })
  const [classification, setClassification] = useState<ClassificationLevel | undefined>()
  const [view, setView] = useState<PortalView>(viewFromPath)
  const [selectedSessionId, setSelectedSessionId] = useState(() => new URLSearchParams(window.location.search).get('session') ?? undefined)
  const [initialPrompt, setInitialPrompt] = useState(() => new URLSearchParams(window.location.search).get('prompt') ?? undefined)

  const refresh = useCallback(async () => {
    try {
      const config = await publicConfig()
      setClassification(await licensedClassification())
      if (config.bootstrap) { setState({ phase: 'bootstrap' }); return }
      setState({ phase: 'ready', data: await loadPortal() })
    }
    catch (cause) {
      if (cause instanceof AuthenticationRequired) {
        try {
          setClassification(await licensedClassification())
          setState({ phase: 'signed-out', config: await publicConfig() })
        }
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
  if (state.phase === 'bootstrap') return <Onboarding />
  if (state.phase === 'error') return <main className="center login"><Logo /><p className="eyebrow">DAEMON UNAVAILABLE</p><h1>Unable to open<br />Papyrus.</h1><Alert className="error">{state.message}</Alert><Button className="primary" onClick={() => { setState({ phase: 'loading' }); void refresh() }}>Try again →</Button></main>
  if (state.phase === 'signed-out') return <SignedOut config={state.config} classification={classification} />

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
    {classification && <ClassificationBanner level={classification} />}
    <SidebarProvider className={`portal-shell ${classification ? 'with-handling-banner' : ''}`}>
      <Sidebar collapsible="icon" className="portal-sidebar">
        <SidebarHeader>
          <div className="sidebar-brand-row"><Logo /></div>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton className="new-session" tooltip="New session" onClick={() => void newSession()}><span className="sidebar-icon">＋</span><span className="sidebar-copy">New session</span></SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Platform</SidebarGroupLabel>
            <SidebarGroupContent>
              <PrimaryNavigation view={view} onNavigate={navigate} />
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup className="sidebar-history-group">
            <SidebarGroupLabel>History</SidebarGroupLabel>
            <SidebarGroupContent>
              <SessionHistory sessions={data.sessions} selectedId={selectedSession?.id} onSelect={(id) => navigate('agent', { session: id })} onDelete={(session) => void removeSession(session)} />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <RuntimeStatusStrip status={data.agent} sessionId={selectedSession?.id} />
          <DropdownMenu className="account-menu" trigger={<div className="account-trigger-content"><UserAvatar principal={data.me} /><span className="account-copy sidebar-copy"><strong>{data.me.displayName}</strong><small>ENTRA · {data.me.roles.length} ROLES</small></span><span className="sidebar-copy">•••</span></div>}>
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
        {view === 'links' && <LinksView {...(data.agent.links?.validation ? { validation: data.agent.links.validation } : {})} canManageSchedules={data.me.roles.includes('Papyrus.System.Owner') || data.me.roles.includes('Papyrus.Integration.Manage')} />}
        {view === 'library' && <LibraryView />}
        {view === 'governance' && <GovernanceView data={data} />}
        {view === 'access' && <AccessView me={data.me} />}
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

function SignedOut({ config, classification }: { config: PublicConfig; classification?: ClassificationLevel | undefined }) {
  return <>{classification && <ClassificationBanner level={classification} />}<main className={`center login agent-login ${classification ? 'login-with-classification' : ''}`}><Logo /><p className="eyebrow">CUSTOMER-HOSTED AGENT RUNTIME</p><h1>Your tools.<br />Your authority.</h1><p>Papyrus accepts identity and application roles from your Microsoft Entra tenant. It does not maintain a parallel user directory.</p>{config.entraConfigured
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
 * The durable objective, if this session has one. Undefined rather than a placeholder, so a
 * session with no goal renders exactly the strip it rendered before goals existed and an
 * operator never sees a goal line that means nothing.
 */
export function goalSummary(jobs: NonNullable<AgentStatus['jobs']>): string | undefined {
  const goal = jobs.goal
  if (!goal) return undefined
  const budget = typeof goal.maxRuns === 'number' && goal.maxRuns > 0 ? ` · ${goal.runsUsed}/${goal.maxRuns} judged` : ''
  return `goal ${goal.status}${budget}`
}

/**
 * Footer runtime status is deliberately limited to runtime/model health. Session goals,
 * schedules, and background job counters belong on their own surfaces rather than becoming
 * a second task dashboard in the sidebar footer.
 */
export function RuntimeStatusStrip({ status }: { status: AgentStatus; sessionId?: string | undefined }) {
  return <div className="runtime-panel">
    <span className="runtime-label">RUNTIME</span>
    <strong><span className={`dot ${status.agentReady ? 'good' : 'warning'}`} /><span className="sidebar-copy">{status.agentReady ? 'Mastra online' : 'Mastra storage online'}</span></strong>
    <small className="sidebar-copy">{status.model ?? 'Model configuration required'}</small>
  </div>
}

export function PrimaryNavigation({ view, onNavigate }: { view: PortalView; onNavigate: (view: PortalView) => void }) {
  const items: Array<{ view: PortalView; icon: string; label: string }> = [
    { view: 'agent', icon: '✦', label: 'Agent' }, { view: 'models', icon: '◎', label: 'Models' },
    { view: 'links', icon: '◎', label: 'Links' }, { view: 'library', icon: '▤', label: 'Library' },
    { view: 'governance', icon: '◇', label: 'Governance' }, { view: 'access', icon: '◈', label: 'Access' },
  ]
  return <SidebarMenu aria-label="Primary navigation">{items.map((item) => <SidebarMenuItem key={item.view}><SidebarMenuButton isActive={view === item.view} tooltip={item.label} onClick={() => onNavigate(item.view)}><span className="sidebar-icon" aria-hidden="true">{item.icon}</span><span className="sidebar-copy">{item.label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
}

function PortalHeader({ view, data }: { view: PortalView; data: PortalData }) {
  const copy: Record<PortalView, [string, string]> = {
    agent: ['MASTRA RUNTIME', 'Agent'], models: ['MODEL GATEWAYS', 'Models'],
    links: ['AGENT-CREATED PUBLIC BOUNDARIES', 'Links'], library: ['AGENTFS FILE AUTHORITY', 'Library'], governance: ['IDENTITY, LICENSING AND AUDIT', 'Governance'],
    access: ['IDENTITY AND ENTITLEMENTS', 'Access'],
  }
  // The health claim was literal text with a hardcoded green dot, so it read "DAEMON HEALTHY"
  // even with no model configured and agent chat disabled. A status that cannot be false is
  // worse than none, so it now follows the daemon's own reported state. The wording in the
  // healthy case is unchanged.
  return <header className="portal-header"><div className="portal-header-title"><SidebarTrigger /><div><p className="eyebrow">{copy[view][0]}</p><h1>{copy[view][1]}</h1></div></div><div className="header-status"><span><i className={`dot ${data.agent.ready ? 'good' : 'warning'}`} />{data.agent.ready ? 'DAEMON HEALTHY' : 'DAEMON UNREACHABLE'}</span><small>{data.config.organizationName}</small></div></header>
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
