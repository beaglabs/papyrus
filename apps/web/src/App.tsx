import { useEffect, useState, type FormEvent } from 'react'
import type { AuditEvent, Session, Workspace } from '@papyrus/contracts'
import { api, auditEvents, dashboard, type DashboardData } from './api.js'

type View = 'overview' | 'workspaces' | 'admin' | 'audit'

function Logo() {
  return <div className="brand"><span className="brand-mark">P</span><span>PAPYRUS</span></div>
}

function Stat({ value, label, tone }: { value: number | string; label: string; tone: string }) {
  return <article className={`stat ${tone}`}><strong>{value}</strong><span>{label}</span></article>
}

function Empty({ children }: { children: string }) { return <div className="empty">{children}</div> }

export function App() {
  const [data, setData] = useState<DashboardData>()
  const [view, setView] = useState<View>('overview')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [audit, setAudit] = useState<{ integrity: { valid: boolean; brokenAt?: number }; events: AuditEvent[] }>()

  const refresh = async () => {
    setLoading(true); setError(undefined)
    try { setData(await dashboard()) } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load Papyrus') }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (view === 'audit' && data?.me.roles.some((role) => ['Owner', 'Admin', 'Auditor'].includes(role))) {
      void auditEvents().then(setAudit).catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load audit'))
    }
  }, [view, data?.me.roles])

  if (loading && !data) return <main className="center"><Logo /><p className="eyebrow">Opening secure workspace…</p></main>
  if (!data) return <Login error={error} />
  if (data.me.roles.length === 0) return data.health.bootstrapRequired
    ? <Bootstrap me={data.me.displayName} onDone={refresh} />
    : <AccessPending me={data.me.displayName} />
  const privileged = data.me.roles.some((role) => ['Owner', 'Admin', 'Auditor'].includes(role))
  const canAdmin = data.me.roles.some((role) => ['Owner', 'Admin'].includes(role))

  return <div className="shell">
    <aside>
      <Logo />
      <div className="classification">{data.health.profile.toUpperCase()}</div>
      <nav>
        {(['overview', 'workspaces'] as View[]).map((item) => <button key={item} className={view === item ? 'active' : ''} onClick={() => setView(item)}>{item}</button>)}
        {canAdmin && <button className={view === 'admin' ? 'active' : ''} onClick={() => setView('admin')}>administration</button>}
        {privileged && <button className={view === 'audit' ? 'active' : ''} onClick={() => setView('audit')}>audit</button>}
      </nav>
      <div className="runtime-status"><span className="dot good" />ACP Gateway active</div>
    </aside>
    <main>
      <header>
        <div><p className="eyebrow">SECURE AGENT GATEWAY</p><h1>{title(view)}</h1></div>
        <div className="identity"><div><strong>{data.me.displayName}</strong><span>{data.me.roles.join(' · ')}</span></div><div className="avatar">{initials(data.me.displayName)}</div></div>
      </header>
      {error && <div className="error">{error}<button onClick={() => setError(undefined)}>×</button></div>}
      {view === 'overview' && <Overview data={data} />}
      {view === 'workspaces' && <Workspaces items={data.workspaces} canManage={privileged} onChanged={refresh} />}
      {view === 'admin' && <Admin data={data} onChanged={refresh} />}
      {view === 'audit' && <Audit data={audit} />}
    </main>
  </div>
}

function Login({ error }: { error: string | undefined }) {
  return <main className="center login"><Logo /><p className="eyebrow">SECURE AGENT GATEWAY</p><h1>Controlled agents.<br />Clear authority.</h1><p>Authenticate through your organization to enter Papyrus.</p>{error && <div className="error">{error}</div>}<a className="primary" href="/api/auth/oidc/start">Continue with OIDC →</a></main>
}

function Bootstrap({ me, onDone }: { me: string; onDone: () => Promise<void> }) {
  const [error, setError] = useState<string>()
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget)
    try { await api('/api/bootstrap', { method: 'POST', body: JSON.stringify({ secret: form.get('secret') }) }); await onDone() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Bootstrap failed') }
  }
  return <main className="center login"><Logo /><p className="eyebrow">ONE-TIME DEPLOYMENT BOOTSTRAP</p><h1>Establish the Owner.</h1><p>Signed in as {me}. Enter the installation bootstrap secret. This operation closes permanently after success.</p><form className="stack" onSubmit={submit}><input name="secret" type="password" required placeholder="Bootstrap secret" /><button className="primary">Become deployment Owner →</button></form>{error && <div className="error">{error}</div>}</main>
}

function AccessPending({ me }: { me: string }) {
  return <main className="center login"><Logo /><p className="eyebrow">ACCESS PENDING</p><h1>Identity verified.<br />Authority required.</h1><p>{me}, an Owner or Admin must assign your fixed role and resources before you can enter Papyrus.</p></main>
}

function Overview({ data }: { data: DashboardData }) {
  return <>
    <section className="stats"><Stat value={data.activity.sessions} label="Sessions" tone="yellow" /><Stat value={data.activity.prompts} label="Prompts" tone="blue" /><Stat value={data.activity.toolCalls} label="Tool calls" tone="pink" /><Stat value={data.activity.deniedActions} label="Denied" tone="white" /></section>
    <section className="grid-two">
      <article className="panel"><div className="panel-head"><h2>Recent sessions</h2><span>{data.sessions.length}</span></div><SessionRows sessions={data.sessions.slice(0, 6)} /></article>
      <article className="panel"><div className="panel-head"><h2>Control plane</h2><span className="status-good">ENFORCED</span></div><dl className="facts"><div><dt>Policy engine</dt><dd>Cedar {data.health.cedar}</dd></div><div><dt>ACP Gateway</dt><dd>Provider configured by client</dd></div><div><dt>Server mode</dt><dd>{data.health.mode}</dd></div><div><dt>Identity</dt><dd>{data.me.authMethod}</dd></div></dl></article>
    </section>
  </>
}

function Workspaces({ items, canManage, onChanged }: { items: Workspace[]; canManage: boolean; onChanged: () => Promise<void> }) {
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: form.get('name'), description: form.get('description') }) }); event.currentTarget.reset(); await onChanged() }
  return <section className="grid-two"><article className="panel"><div className="panel-head"><h2>Assigned workspaces</h2><span>{items.length}</span></div>{items.length ? <div className="cards">{items.map((item) => <div className="workspace" key={item.id}><span className="workspace-icon">↗</span><div><strong>{item.name}</strong><p>{item.description || 'No description'}</p></div></div>)}</div> : <Empty>You have no workspace assignments.</Empty>}</article>{canManage && <article className="panel accent"><h2>Create workspace</h2><form className="stack" onSubmit={submit}><label>Name<input required name="name" placeholder="Mission workspace" /></label><label>Description<textarea name="description" placeholder="Purpose and handling context" /></label><button className="primary">Create workspace →</button></form></article>}</section>
}

function SessionRows({ sessions }: { sessions: Session[] }) { return sessions.length ? <div className="rows">{sessions.map((session) => <div className="row" key={session.id}><div><strong>{session.title}</strong><small>{new Date(session.updatedAt).toLocaleString()}</small></div><span className={`pill ${session.status}`}>{session.status}</span></div>)}</div> : <Empty>No sessions yet.</Empty> }

function Admin({ data, onChanged }: { data: DashboardData; onChanged: () => Promise<void> }) {
  const [message, setMessage] = useState<string>()
  const run = async (operation: () => Promise<unknown>, form: HTMLFormElement) => {
    setMessage(undefined)
    try { await operation(); form.reset(); await onChanged() }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Administration request failed') }
  }
  const submitRole = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); void run(() => api(`/api/users/${encodeURIComponent(String(values.get('user')))}/roles`, { method: 'POST', body: JSON.stringify({ role: values.get('role') }) }), form) }
  const submitAssignment = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); const [resourceType, resourceId] = String(values.get('resource')).split(':'); void run(() => api('/api/assignments', { method: 'POST', body: JSON.stringify({ principalId: values.get('user'), resourceType, resourceId }) }), form) }
  const submitMcp = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); void run(() => api('/api/mcp/servers', { method: 'POST', body: JSON.stringify({ name: values.get('name'), endpoint: values.get('endpoint') }) }), form) }
  const submitGrant = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); void run(() => api('/api/mcp/grants', { method: 'POST', body: JSON.stringify({ workspaceId: values.get('workspace'), mcpServerId: values.get('server'), toolName: values.get('tool') }) }), form) }
  const canAssignPrivileged = data.me.roles.includes('Owner')
  return <>
    {message && <div className="error">{message}<button onClick={() => setMessage(undefined)}>×</button></div>}
    <section className="admin-grid">
      <article className="panel"><div className="panel-head"><h2>People and fixed roles</h2><span>{data.users.length}</span></div><div className="rows">{data.users.map((user) => <div className="row" key={user.id}><div><strong>{user.displayName}</strong><small>{user.externalId}</small></div><span className="pill">{user.roles.join(' · ') || 'PENDING'}</span></div>)}</div><form className="stack mini-form" onSubmit={submitRole}><label>User<select name="user">{data.users.map((user) => <option value={user.id} key={user.id}>{user.displayName}</option>)}</select></label><label>Role<select name="role"><option>User</option><option>Auditor</option>{canAssignPrivileged && <option>Admin</option>}{canAssignPrivileged && <option>Owner</option>}</select></label><button className="primary">Assign fixed role →</button></form></article>
      <article className="panel accent"><h2>Resource assignment</h2><form className="stack" onSubmit={submitAssignment}><label>User<select name="user">{data.users.map((user) => <option value={user.id} key={user.id}>{user.displayName}</option>)}</select></label><label>Workspace<select name="resource">{data.workspaces.map((item) => <option value={`workspace:${item.id}`} key={item.id}>{item.name}</option>)}</select></label><button className="primary">Assign resource →</button></form></article>
      <article className="panel accent"><div className="panel-head"><h2>MCP control</h2><span>{data.mcpServers.length}</span></div><form className="stack" onSubmit={submitMcp}><label>Server name<input name="name" required placeholder="Approved records service" /></label><label>HTTP endpoint<input name="endpoint" required placeholder="https://mcp.internal/rpc" /></label><button className="primary">Register MCP server →</button></form><form className="stack mini-form" onSubmit={submitGrant}><label>Workspace<select name="workspace">{data.workspaces.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>MCP server<select name="server">{data.mcpServers.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label><label>Exact tool name<input name="tool" required placeholder="records.search" /></label><button className="primary">Grant tool →</button></form></article>
    </section>
  </>
}

function Audit({ data }: { data: { integrity: { valid: boolean; brokenAt?: number }; events: AuditEvent[] } | undefined }) {
  if (!data) return <Empty>Loading audit ledger…</Empty>
  return <article className="panel"><div className="panel-head"><h2>Append-only event ledger</h2><span className={data.integrity.valid ? 'status-good' : 'status-bad'}>{data.integrity.valid ? 'CHAIN VERIFIED' : `BROKEN AT ${data.integrity.brokenAt}`}</span></div><div className="audit-table"><div className="audit-row heading"><span>Sequence</span><span>Action</span><span>Resource</span><span>Decision</span><span>Time</span></div>{data.events.map((event) => <div className="audit-row" key={event.id}><span>#{event.sequence}</span><strong>{event.action}</strong><span>{event.resourceType}:{short(event.resourceId)}</span><span className={`decision ${event.decision}`}>{event.decision}</span><span>{new Date(event.occurredAt).toLocaleString()}</span></div>)}</div></article>
}

function title(view: View) { return ({ overview: 'Operational overview', workspaces: 'Workspaces', admin: 'Administration', audit: 'Audit ledger' })[view] }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') }
function short(id: string) { return id.length > 16 ? `${id.slice(0, 8)}…` : id }
