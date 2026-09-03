import { useCallback, useEffect, useState } from 'react'
import type { PortalData, PublicConfig } from './api.js'
import { AuthenticationRequired, createSession, deleteSession, loadPortal, logout, publicConfig } from './api.js'
import { AgentView } from './Agent.js'
import { PluginsView } from './Plugins.js'
import { ScheduledView, WorkflowsView } from './Automation.js'
import { Alert, Avatar, Badge, Button, Card, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/ui/index.js'

export type PortalView = 'agent' | 'plugins' | 'scheduled' | 'workflows' | 'governance'
type AppState = { phase: 'loading' } | { phase: 'signed-out'; config: PublicConfig } | { phase: 'ready'; data: PortalData } | { phase: 'error'; message: string }

const ROUTES: Record<PortalView, string> = {
  agent: '/portal', plugins: '/portal/plugins', scheduled: '/portal/scheduled', workflows: '/portal/workflows', governance: '/portal/governance',
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

  if (state.phase === 'loading') return <main className="center portal-loading"><Logo /><div className="signal-loader"><span /><span /><span /></div><p className="eyebrow">OPENING RUNTIME…</p></main>
  if (state.phase === 'error') return <main className="center login"><Logo /><p className="eyebrow">DAEMON UNAVAILABLE</p><h1>Unable to open<br />Papyrus.</h1><Alert className="error">{state.message}</Alert><Button className="primary" onClick={() => { setState({ phase: 'loading' }); void refresh() }}>Try again →</Button></main>
  if (state.phase === 'signed-out') return <SignedOut config={state.config} />

  const data = state.data
  const selectedSession = data.sessions.find((session) => session.id === selectedSessionId) ?? data.sessions[0]
  const newSession = async () => {
    const created = await createSession()
    await refresh(); navigate('agent', { session: created.id })
  }
  const removeSession = async (id: string) => {
    await deleteSession(id); if (selectedSessionId === id) setSelectedSessionId(undefined); await refresh()
  }
  const signOut = async () => { await logout(); window.location.replace('/portal') }

  return <>
    <div className="handling-banner government"><strong>{profileLabel(data.config.profile)}</strong><span>AUTHORIZED USE ONLY · CUSTOMER-HOSTED AGENT RUNTIME</span></div>
    <div className="portal-shell with-handling-banner agent-layout">
      <aside className="portal-sidebar"><Logo /><div className="classification">{profileLabel(data.config.profile)} · {data.config.cloud}</div>
        <Button className="new-session" onClick={() => void newSession()}><span>＋</span> New session</Button>
        <SessionHistory sessions={data.sessions} selectedId={selectedSession?.id} onSelect={(id) => navigate('agent', { session: id })} onDelete={(id) => void removeSession(id)} />
        <PrimaryNavigation view={view} onNavigate={navigate} />
        <div className="runtime-panel"><span className="runtime-label">COLLECTIVE RUNTIME</span><strong><span className={`dot ${data.agent.agentReady ? 'good' : 'warning'}`} />{data.agent.agentReady ? 'Starlings + Mastra online' : 'Mastra storage online'}</strong><small>{data.agent.model ?? 'Model configuration required'}</small></div>
        <DropdownMenu className="account-menu" trigger={<div className="account-trigger-content"><Avatar className="avatar">{initials(data.me.displayName)}</Avatar><span className="account-copy"><strong>{data.me.displayName}</strong><small>ENTRA · {data.me.roles.length} ROLES</small></span><span>•••</span></div>}>
          <DropdownMenuLabel><strong>{data.me.displayName}</strong><span>{data.me.preferredUsername ?? data.me.oid}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem disabled>Roles managed in Microsoft Entra</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="danger-item" onClick={() => void signOut()}>Sign out</DropdownMenuItem>
        </DropdownMenu>
      </aside>
      <main className={`portal-main ${view === 'agent' ? 'agent-main' : ''}`}><PortalHeader view={view} data={data} />
        {view === 'agent' && (selectedSession
          ? <AgentView key={selectedSession.id} session={selectedSession} status={data.agent} initialPrompt={initialPrompt} canApprove={data.me.roles.includes('Papyrus.System.Owner') || data.me.roles.includes('Papyrus.Action.Approve')} onChanged={refresh} />
          : <EmptyAgent onCreate={() => void newSession()} />)}
        {view === 'plugins' && <PluginsView catalog={data.catalog} configured={data.integrations} onAskAgent={(prompt) => navigate('agent', { prompt, session: selectedSession?.id })} onChanged={refresh} canManage={data.me.roles.includes('Papyrus.System.Owner') || data.me.roles.includes('Papyrus.Integration.Manage')} />}
        {view === 'scheduled' && <ScheduledView schedules={data.schedules} sessions={data.sessions} onChanged={refresh} />}
        {view === 'workflows' && <WorkflowsView workflows={data.workflows} />}
        {view === 'governance' && <GovernanceView data={data} />}
      </main>
    </div>
  </>
}

function SessionHistory({ sessions, selectedId, onSelect, onDelete }: { sessions: PortalData['sessions']; selectedId?: string | undefined; onSelect: (id: string) => void; onDelete: (id: string) => void }) {
  return <section className="session-history"><p className="sidebar-label">HISTORY</p><div>{sessions.map((session) => <div className={`session-row ${selectedId === session.id ? 'active' : ''}`} key={session.id}><Button variant="ghost" onClick={() => onSelect(session.id)}>{session.attention && <span className="attention-icon" title="Requires attention">!</span>}<span>{session.title}</span></Button><Button variant="ghost" className="session-delete" aria-label={`Delete ${session.title}`} onClick={() => onDelete(session.id)}>×</Button></div>)}</div>{sessions.length === 0 && <small>No sessions yet</small>}</section>
}

function EmptyAgent({ onCreate }: { onCreate: () => void }) { return <Card className="empty-agent"><span>✦</span><h2>Start a durable session</h2><p>Your conversation, tool activity, and signal history stay in this customer-hosted daemon.</p><Button className="primary" onClick={onCreate}>New session →</Button></Card> }

function SignedOut({ config }: { config: PublicConfig }) {
  return <><div className="handling-banner government"><strong>{profileLabel(config.profile)}</strong><span>MICROSOFT ENTRA AUTHORITY</span></div><main className="center login cyber-login"><Logo /><p className="eyebrow">CUSTOMER-HOSTED AGENT RUNTIME</p><h1>Your tools.<br />Your authority.</h1><p>Papyrus accepts identity and application roles from your Microsoft Entra tenant. It does not maintain a parallel user directory.</p>{config.entraConfigured
    ? <a className="primary" href={`/api/auth/entra/login?returnTo=${encodeURIComponent(window.location.pathname.startsWith('/portal') ? window.location.pathname : '/portal')}`}>Continue with Microsoft Entra →</a>
    : <Alert className="error">This deployment does not have Microsoft Entra configured.</Alert>}<div className="login-facts"><span>{config.organizationName}</span><span>{profileLabel(config.profile)}</span><span>{config.cloud}</span></div></main></>
}

export function PrimaryNavigation({ view, onNavigate }: { view: PortalView; onNavigate: (view: PortalView) => void }) {
  const items: Array<{ view: PortalView; icon: string; label: string }> = [
    { view: 'agent', icon: '✦', label: 'Agent' }, { view: 'plugins', icon: '⌘', label: 'Plugins' },
    { view: 'scheduled', icon: '◷', label: 'Scheduled' }, { view: 'workflows', icon: '⌬', label: 'Workflows' },
    { view: 'governance', icon: '◇', label: 'Governance' },
  ]
  return <nav aria-label="Primary navigation">{items.map((item) => <Button variant="ghost" key={item.view} className={view === item.view ? 'active' : ''} onClick={() => onNavigate(item.view)}><span aria-hidden="true">{item.icon}</span>{item.label}</Button>)}</nav>
}

function PortalHeader({ view, data }: { view: PortalView; data: PortalData }) {
  const copy: Record<PortalView, [string, string]> = {
    agent: ['MASTRA + STARLINGS', 'Agent'], plugins: ['TOOLS AND SIGNALS', 'Plugins'], scheduled: ['PERSISTENT TRIGGERS', 'Scheduled'],
    workflows: ['DURABLE EXECUTION', 'Workflows'], governance: ['IDENTITY, LICENSING AND AUDIT', 'Governance'],
  }
  return <header className="portal-header"><div><p className="eyebrow">{copy[view][0]}</p><h1>{copy[view][1]}</h1></div><div className="header-status"><span><i className="dot good" />DAEMON HEALTHY</span><small>{data.config.organizationName}</small></div></header>
}

function GovernanceView({ data }: { data: PortalData }) {
  return <div className="governance-grid"><Card><p className="eyebrow">IDENTITY AUTHORITY</p><h2>Microsoft Entra ID</h2><p>Users, groups, and application roles are assigned in the customer tenant. Papyrus maintains no invitation or local role database.</p><div className="role-list">{data.me.roles.map((role) => <Badge key={role}>{role.replace('Papyrus.', '')}</Badge>)}</div></Card><Card><p className="eyebrow">OFFLINE ENTITLEMENT</p><h2>{data.overview.deployment.license.valid ? 'License active' : 'Activation required'}</h2><p>Licensing remains deployment-bound and locally verified. No vendor cloud callback is required.</p><code>{data.overview.deployment.license.deploymentId.slice(0, 24)}…</code></Card><Card><p className="eyebrow">ACTION BOUNDARY</p><h2>Suggestions are not authority</h2><p>Agent suggestions appear with a <strong>!</strong>. Only deterministic policy and an Entra-authorized approver can release an action to the leased executor worker.</p></Card></div>
}
