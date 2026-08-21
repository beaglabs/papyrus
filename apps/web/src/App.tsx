import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Workspace } from '@papyrus/contracts'
import { api, AuthenticationRequired, loadShell, logout, type AuthenticationChallenge, type Health, type ShellData } from './api.js'

type View = 'home' | 'sessions' | 'workspaces' | 'sources' | 'administration'
type AppState =
  | { phase: 'loading' }
  | { phase: 'signed-out'; health: Health; challenge: AuthenticationChallenge }
  | { phase: 'ready'; data: ShellData }
  | { phase: 'error'; message: string }

function Logo() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true">P</span><span>PAPYRUS</span></div>
}

function HandlingBanner({ profile }: { profile: string }) {
  const government = profile.startsWith('government')
  return <div className={`handling-banner ${government ? 'government' : 'commercial'}`} role="status">
    <strong>{profileLabel(profile)}</strong>
    <span>{government ? 'AUTHORIZED USE ONLY · FOLLOW ORGANIZATION HANDLING REQUIREMENTS' : 'COMMERCIAL DEPLOYMENT'}</span>
  </div>
}

export function App() {
  const [state, setState] = useState<AppState>({ phase: 'loading' })
  const [view, setView] = useState<View>('home')

  const refresh = useCallback(async () => {
    setState({ phase: 'loading' })
    try {
      setState({ phase: 'ready', data: await loadShell() })
    } catch (cause) {
      if (cause instanceof AuthenticationRequired) setState({ phase: 'signed-out', health: cause.health, challenge: cause.challenge })
      else setState({ phase: 'error', message: cause instanceof Error ? cause.message : 'Unable to open Papyrus' })
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const unauthenticated = () => { void refresh() }
    window.addEventListener('papyrus:unauthenticated', unauthenticated)
    return () => window.removeEventListener('papyrus:unauthenticated', unauthenticated)
  }, [refresh])

  if (state.phase === 'loading') return <main className="center"><Logo /><p className="eyebrow">OPENING GOVERNED WORKSPACE…</p></main>
  if (state.phase === 'error') return <main className="center login"><Logo /><p className="eyebrow">PAPYRUS IS UNAVAILABLE</p><h1>Unable to open<br />the control plane.</h1><div className="error">{state.message}</div><button className="primary" onClick={() => void refresh()}>Try again →</button></main>
  if (state.phase === 'signed-out') return <SignedOut health={state.health} challenge={state.challenge} />
  if (state.data.me.roles.length === 0) return <><HandlingBanner profile={state.data.health.profile} />{state.data.health.bootstrapRequired
    ? <Bootstrap me={state.data.me.displayName} onDone={refresh} />
    : <AccessPending me={state.data.me.displayName} />}</>

  const signOut = async () => { try { await logout() } finally { await refresh() } }

  return <>
    <HandlingBanner profile={state.data.health.profile} />
    <div className="shell with-handling-banner">
      <aside>
        <Logo />
        <div className="classification">{profileLabel(state.data.health.profile)}</div>
        <nav aria-label="Primary navigation">
          <NavButton active={view === 'home'} onClick={() => setView('home')}>Overview</NavButton>
          <NavButton active={view === 'sessions'} onClick={() => setView('sessions')}>Sessions</NavButton>
          <NavButton active={view === 'workspaces'} onClick={() => setView('workspaces')}>Workspaces</NavButton>
          <NavButton active={view === 'sources'} onClick={() => setView('sources')}>Sources</NavButton>
          {state.data.me.roles.some((role) => role === 'Owner' || role === 'Admin') && <NavButton active={view === 'administration'} onClick={() => setView('administration')}>Administration</NavButton>}
        </nav>
        <div className="runtime-status"><span className="dot good" />Policy enforcement active</div>
      </aside>
      <main>
        <header>
          <div><p className="eyebrow">GOVERNED AGENT WORKSPACE</p><h1>{viewTitle(view)}</h1></div>
          <div className="identity"><div><strong>{state.data.me.displayName}</strong><span>{state.data.me.roles.join(' · ')} · {state.data.me.authMethod}</span></div><div className="avatar" aria-hidden="true">{initials(state.data.me.displayName)}</div><button className="text-button" onClick={() => void signOut()}>Sign out</button></div>
        </header>
        <ShellView view={view} data={state.data} />
      </main>
    </div>
  </>
}

function SignedOut({ health, challenge }: { health: Health; challenge: AuthenticationChallenge }) {
  const government = health.profile.startsWith('government')
  const oidc = challenge.methods.includes('oidc') && challenge.login_url
  return <><HandlingBanner profile={health.profile} /><main className="center login auth-entry"><Logo /><p className="eyebrow">GOVERNED AGENT WORKSPACE</p><h1>Identity before<br />authority.</h1><p>Papyrus binds every session, tool request, and policy decision to an authenticated organizational identity.</p><div className="auth-grid">
    {oidc && <a className="primary" href={challenge.login_url}>Continue with organizational login →</a>}
    {government && <article className="profile-card"><strong>CAC/PIV authentication</strong><p>Insert your card, select its authentication certificate when prompted, then reload this page.</p><button className="secondary" onClick={() => window.location.reload()}>Retry certificate authentication</button></article>}
    {challenge.methods.includes('mtls-proxy') && <article className="profile-card"><strong>Trusted identity gateway</strong><p>Open Papyrus through your organization’s authorized access gateway.</p></article>}
    {challenge.methods.length === 0 && <div className="error">This deployment has no configured authentication method.</div>}
  </div></main></>
}

function Bootstrap({ me, onDone }: { me: string; onDone: () => Promise<void> }) {
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    try { await api('/api/bootstrap', { method: 'POST', body: JSON.stringify({ secret: form.get('secret') }) }); await onDone() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Bootstrap failed') }
  }
  return <main className="center login"><Logo /><p className="eyebrow">ONE-TIME DEPLOYMENT BOOTSTRAP</p><h1>Establish the Owner.</h1><p>Signed in as {me}. Enter the installation bootstrap secret. Bootstrap closes permanently after success.</p><form className="stack" onSubmit={submit}><input name="secret" type="password" required autoComplete="off" placeholder="Bootstrap secret" /><button className="primary">Become deployment Owner →</button></form>{error && <div className="error">{error}</div>}</main>
}

function AccessPending({ me }: { me: string }) {
  return <main className="center login"><Logo /><p className="eyebrow">ACCESS PENDING</p><h1>Identity verified.<br />Authority required.</h1><p>{me}, an Owner or Admin must assign your fixed role and workspace access before you can enter Papyrus.</p></main>
}

function ShellView({ view, data }: { view: View; data: ShellData }) {
  if (view === 'home') return <section className="grid-two wide-left"><article className="panel hero-panel"><p className="eyebrow">CONTROL PLANE READY</p><h2>Begin governed work from one durable session.</h2><p>The session workspace arrives in the next stack layer. Identity, handling context, and workspace authority are already active.</p><button className="primary" disabled>New session</button></article><DeploymentFacts data={data} /></section>
  if (view === 'workspaces') return <WorkspaceCards items={data.workspaces} />
  return <article className="panel placeholder"><span>STACK PREVIEW</span><h2>{viewTitle(view)}</h2><p>{placeholder(view)}</p></article>
}

function DeploymentFacts({ data }: { data: ShellData }) {
  return <article className="panel"><div className="panel-head"><h2>Deployment</h2><span className="status-good">ENFORCED</span></div><dl className="facts"><div><dt>Policy</dt><dd>Cedar {data.health.cedar}</dd></div><div><dt>Mode</dt><dd>{data.health.mode}</dd></div><div><dt>Identity</dt><dd>{data.me.authMethod}</dd></div><div><dt>Workspaces</dt><dd>{data.workspaces.length}</dd></div></dl></article>
}

function WorkspaceCards({ items }: { items: Workspace[] }) {
  return <article className="panel"><div className="panel-head"><h2>Authorized workspaces</h2><span>{items.length}</span></div>{items.length ? <div className="cards">{items.map((item) => <div className="workspace" key={item.id}><span className="workspace-icon">↗</span><div><strong>{item.name}</strong><p>{item.description || 'No description'}</p></div></div>)}</div> : <div className="empty">No workspace assignments are available.</div>}</article>
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) { return <button className={active ? 'active' : ''} onClick={onClick}>{children}</button> }
function profileLabel(profile: string) { return ({ commercial: 'COMMERCIAL', 'government-il4': 'GOVERNMENT IL4', 'government-il6': 'GOVERNMENT IL6' } as Record<string, string>)[profile] ?? profile.toUpperCase() }
function viewTitle(view: View) { return ({ home: 'Operational overview', sessions: 'Sessions', workspaces: 'Workspaces', sources: 'Sources', administration: 'Administration' })[view] }
function placeholder(view: View) { return ({ sessions: 'Durable conversations, streaming runs, and cancellation are implemented in layer 03.', sources: 'Governed browser sources and captured evidence are implemented in layer 06.', administration: 'Runtime, tool, browser, and deployment administration are implemented in layer 07.', home: '', workspaces: '' })[view] }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') }
