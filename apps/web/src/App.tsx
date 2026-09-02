import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { PortalData, PublicConfig } from './api.js'
import { AuthenticationRequired, loadPortal, logout, publicConfig } from './api.js'
import { IntegrationsView } from './Integrations.js'
import { TerrainView } from './Terrain.js'
import { Alert, Avatar, Badge, Button, Card, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from './components/ui/index.js'

export type PortalView = 'posture' | 'terrain' | 'investigations' | 'integrations' | 'governance'
type AppState = { phase: 'loading' } | { phase: 'signed-out'; config: PublicConfig } | { phase: 'ready'; data: PortalData } | { phase: 'error'; message: string }

const ROUTES: Record<PortalView, string> = {
  posture: '/portal', terrain: '/portal/terrain', investigations: '/portal/investigations',
  integrations: '/portal/integrations', governance: '/portal/governance',
}

function viewFromPath(): PortalView {
  return (Object.entries(ROUTES).find(([, route]) => window.location.pathname === route)?.[0] as PortalView | undefined) ?? 'posture'
}

function Logo() { return <div className="brand"><span className="brand-mark" aria-hidden="true">P</span><span>PAPYRUS</span></div> }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') }
function profileLabel(profile: string) { return ({ gcc: 'GCC', gcch: 'GCC HIGH', dod: 'DOD', restricted: 'RESTRICTED', disconnected: 'DISCONNECTED' } as Record<string, string>)[profile] ?? profile.toUpperCase() }

export function App() {
  const [state, setState] = useState<AppState>({ phase: 'loading' })
  const [view, setView] = useState<PortalView>(viewFromPath)

  const refresh = useCallback(async () => {
    try { setState({ phase: 'ready', data: await loadPortal() }) }
    catch (cause) {
      if (cause instanceof AuthenticationRequired) {
        try { setState({ phase: 'signed-out', config: await publicConfig() }) }
        catch { setState({ phase: 'error', message: 'Unable to load deployment configuration' }) }
      } else setState({ phase: 'error', message: cause instanceof Error ? cause.message : 'Unable to open Papyrus Cyber Twin' })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const navigate = () => setView(viewFromPath())
    window.addEventListener('popstate', navigate)
    return () => window.removeEventListener('popstate', navigate)
  }, [])

  const navigate = (next: PortalView) => {
    window.history.pushState({}, '', ROUTES[next]); setView(next)
  }

  if (state.phase === 'loading') return <main className="center portal-loading"><Logo /><div className="signal-loader"><span /><span /><span /></div><p className="eyebrow">OPENING CYBER TERRAIN…</p></main>
  if (state.phase === 'error') return <main className="center login"><Logo /><p className="eyebrow">DAEMON UNAVAILABLE</p><h1>Unable to open<br />the cyber twin.</h1><Alert className="error">{state.message}</Alert><Button className="primary" onClick={() => { setState({ phase: 'loading' }); void refresh() }}>Try again →</Button></main>
  if (state.phase === 'signed-out') return <SignedOut config={state.config} />

  const data = state.data
  const signOut = async () => { await logout(); window.location.replace('/portal') }
  return <>
    <div className="handling-banner government"><strong>{profileLabel(data.config.profile)}</strong><span>AUTHORIZED USE ONLY · CUSTOMER-HOSTED CYBER RESILIENCE TWIN</span></div>
    <div className="portal-shell with-handling-banner">
      <aside className="portal-sidebar"><Logo /><div className="classification">{profileLabel(data.config.profile)} · {data.config.cloud}</div>
        <PrimaryNavigation view={view} onNavigate={navigate} />
        <div className="runtime-panel"><span className="runtime-label">COLLECTIVE RUNTIME</span><strong><span className="dot good" />Starlings online</strong><small>Entra authority active</small></div>
        <DropdownMenu className="account-menu" trigger={<div className="account-trigger-content"><Avatar className="avatar">{initials(data.me.displayName)}</Avatar><span className="account-copy"><strong>{data.me.displayName}</strong><small>ENTRA · {data.me.roles.length} ROLES</small></span><span>•••</span></div>}>
          <DropdownMenuLabel><strong>{data.me.displayName}</strong><span>{data.me.preferredUsername ?? data.me.oid}</span></DropdownMenuLabel><DropdownMenuSeparator />
          <DropdownMenuItem disabled>Roles managed in Microsoft Entra</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem className="danger-item" onClick={() => void signOut()}>Sign out</DropdownMenuItem>
        </DropdownMenu>
      </aside>
      <main className="portal-main"><PortalHeader view={view} data={data} />
        {view === 'posture' && <PostureView data={data} onOpenIntegrations={() => navigate('integrations')} />}
        {view === 'integrations' && <IntegrationsView me={data.me} catalog={data.catalog} integrations={data.integrations} onChanged={refresh} />}
        {view === 'terrain' && <TerrainView data={data} onOpenIntegrations={() => navigate('integrations')} onRefresh={refresh} />}
        {view === 'investigations' && <EmptyProductView eyebrow="COLLECTIVE ANALYSIS" title="Investigations" copy="Starlings investigations will assemble claims, contradictions, evidence, and attack hypotheses here—without creating chat sessions." />}
        {view === 'governance' && <GovernanceView data={data} />}
      </main>
    </div>
  </>
}

function SignedOut({ config }: { config: PublicConfig }) {
  return <><div className="handling-banner government"><strong>{profileLabel(config.profile)}</strong><span>MICROSOFT ENTRA AUTHORITY</span></div><main className="center login cyber-login"><Logo /><p className="eyebrow">CUSTOMER-HOSTED CYBER RESILIENCE</p><h1>Your terrain.<br />Your authority.</h1><p>Papyrus accepts identity and application roles from your Microsoft Entra tenant. It does not maintain a parallel user directory.</p>{config.entraConfigured
    ? <a className="primary" href={`/api/auth/entra/login?returnTo=${encodeURIComponent(window.location.pathname.startsWith('/portal') ? window.location.pathname : '/portal')}`}>Continue with Microsoft Entra →</a>
    : <Alert className="error">This deployment does not have Microsoft Entra configured.</Alert>}<div className="login-facts"><span>{config.organizationName}</span><span>{profileLabel(config.profile)}</span><span>{config.cloud}</span></div></main></>
}

export function PrimaryNavigation({ view, onNavigate }: { view: PortalView; onNavigate: (view: PortalView) => void }) {
  const items: Array<{ view: PortalView; icon: string; label: string }> = [
    { view: 'posture', icon: '◫', label: 'Posture' }, { view: 'terrain', icon: '⌘', label: 'Cyber terrain' },
    { view: 'investigations', icon: '◎', label: 'Investigations' }, { view: 'integrations', icon: '↗', label: 'Integrations' },
    { view: 'governance', icon: '◇', label: 'Governance' },
  ]
  return <nav aria-label="Primary navigation">{items.map((item) => <Button variant="ghost" key={item.view} className={view === item.view ? 'active' : ''} onClick={() => onNavigate(item.view)}><span aria-hidden="true">{item.icon}</span>{item.label}</Button>)}</nav>
}

function PortalHeader({ view, data }: { view: PortalView; data: PortalData }) {
  const copy: Record<PortalView, [string, string]> = {
    posture: ['CYBER RESILIENCE TWIN', 'Operational posture'], terrain: ['EVIDENCE-BACKED TOPOLOGY', 'Cyber terrain'],
    investigations: ['DISTRIBUTED REASONING', 'Investigations'], integrations: ['CONNECTION AND EVIDENCE PLANE', 'Integrations'],
    governance: ['IDENTITY, LICENSING AND AUDIT', 'Governance'],
  }
  return <header className="portal-header"><div><p className="eyebrow">{copy[view][0]}</p><h1>{copy[view][1]}</h1></div><div className="header-status"><span><i className="dot good" />DAEMON HEALTHY</span><small>{data.config.organizationName}</small></div></header>
}

function PostureView({ data, onOpenIntegrations }: { data: PortalData; onOpenIntegrations: () => void }) {
  const posture = data.overview.posture
  return <div className="posture-grid">
    <Card className="posture-hero"><div><p className="eyebrow">CURRENT ASSESSMENT</p><Badge className="status-good">OBSERVING</Badge></div><h2>Cyber terrain is waiting for evidence.</h2><p>Connect operator interfaces and security sources. Starlings will treat every record as evidence—not authoritative truth—and make disagreement visible.</p><Button className="primary" onClick={onOpenIntegrations}>Configure integrations →</Button><div className="terrain-lines" aria-hidden="true"><span /><span /><span /><span /></div></Card>
    <Card className="metric-card"><span className="metric-label">INTEGRATIONS</span><strong>{posture.integrations}</strong><small>{posture.healthy} healthy</small></Card>
    <Card className="metric-card warning"><span className="metric-label">AWAITING APPROVAL</span><strong>{posture.awaitingApproval}</strong><small>Entra-governed activation</small></Card>
    <Card className="metric-card"><span className="metric-label">EVIDENCE SOURCES</span><strong>{posture.evidenceSources}</strong><small>local observations</small></Card>
    <Card className="metric-card critical"><span className="metric-label">ACTION EXECUTORS</span><strong>{posture.actionExecutors}</strong><small>controlled authority</small></Card>
    <Card className="runtime-card"><div className="panel-head"><h2>Runtime boundary</h2><Badge>ENFORCED</Badge></div><dl className="facts"><div><dt>Identity</dt><dd>MICROSOFT ENTRA</dd></div><div><dt>Computation</dt><dd>STARLINGS</dd></div><div><dt>Topology</dt><dd>CUSTOMER-HOSTED</dd></div><div><dt>License</dt><dd>{data.overview.deployment.license.valid ? 'VALID' : 'ACTION REQUIRED'}</dd></div></dl></Card>
  </div>
}

function GovernanceView({ data }: { data: PortalData }) {
  return <div className="governance-grid"><Card><p className="eyebrow">IDENTITY AUTHORITY</p><h2>Microsoft Entra ID</h2><p>Users, groups, and application roles are assigned in the customer tenant. Papyrus maintains no invitation or local role database.</p><div className="role-list">{data.me.roles.map((role) => <Badge key={role}>{role.replace('Papyrus.', '')}</Badge>)}</div></Card><Card><p className="eyebrow">OFFLINE ENTITLEMENT</p><h2>{data.overview.deployment.license.valid ? 'License active' : 'Activation required'}</h2><p>Licensing remains deployment-bound and locally verified. No Beag cloud callback is required.</p><code>{data.overview.deployment.license.deploymentId.slice(0, 24)}…</code></Card><Card><p className="eyebrow">OPERATIONAL GUARANTEE</p><h2>Claims before actions</h2><p>Starlings may propose an operational action. Only deterministic policy and an Entra-authorized approver can release it to an executor.</p></Card></div>
}

function EmptyProductView({ eyebrow, title, copy, children }: { eyebrow: string; title: string; copy: string; children?: ReactNode }) {
  return <Card className="empty-product"><p className="eyebrow">{eyebrow}</p><span className="empty-product-mark">◎</span><h2>{title}</h2><p>{copy}</p>{children}</Card>
}
