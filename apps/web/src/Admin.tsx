import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ROLES, type AdminOverview, type FileMountAccess, type Principal, type Role } from '@papyrus/contracts'
import { assignFileMount, createFileMount, revokeFileMountAssignment, addMcpServer, addUserRole, adminOverview, cancelInvitation, createInvitation, revokeUserSessions, setMcpServerEnabled } from './api.js'
import { SelectField } from './SelectField.js'

type AdminTab = 'deployment' | 'identity' | 'files' | 'integrations'

export function AdminView({ me }: { me: Principal }) {
  const [data, setData] = useState<AdminOverview>()
  const [tab, setTab] = useState<AdminTab>('deployment')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { setData(await adminOverview()) }, [])
  useEffect(() => { void load().catch(show) }, [load])
  useEffect(() => { const connected = (event: MessageEvent) => { if (event.origin === window.location.origin && event.data?.type === 'papyrus:mcp-connected') void load() }; window.addEventListener('message', connected); return () => window.removeEventListener('message', connected) }, [load])
  function show(cause: unknown) { setError(cause instanceof Error ? cause.message : 'Administrative request failed') }
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await operation(); await load() } catch (cause) { show(cause) } finally { setBusy(false) } }
  if (!data) return <div className="empty">Loading deployment administration…</div>
  const allowedRoles = me.roles.includes('Owner') ? ROLES : ROLES.filter((role) => role !== 'Owner' && role !== 'Admin')
  return <div className="admin-view">
    {error && <div className="error">{error}<button onClick={() => setError(undefined)}>×</button></div>}
    <div className="admin-tabs" role="tablist">{(['deployment', 'identity', 'files', 'integrations'] as AdminTab[]).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</button>)}</div>
    {tab === 'deployment' && <section className="admin-summary"><AdminPanel title="Deployment"><dl className="facts"><Fact label="Profile" value={data.deployment.profile} /><Fact label="Topology" value="ON-PREMISES" /><Fact label="Origin" value={data.deployment.publicOrigin} /><Fact label="Authentication" value={authenticationLabel(data.deployment.authentication)} /><Fact label="Gateway" value={yes(data.deployment.gatewayConfigured)} /></dl></AdminPanel><AdminPanel title="License"><dl className="facts"><Fact label="Required" value={yes(data.deployment.licenseRequired)} /><Fact label="Status" value={data.license.valid ? 'VALID' : 'NOT ACTIVE'} /><Fact label="Deployment" value={data.license.deploymentId.slice(0, 16)} /></dl></AdminPanel></section>}
    {tab === 'identity' && <section className="admin-summary identity-admin">
      <AdminPanel title={data.deployment.profile === 'commercial' ? 'Invite with organizational OIDC' : 'Create pending CAC/PIV identity'}>
        <form className={`admin-form identity-create ${data.deployment.profile === 'commercial' ? 'commercial' : 'government'}`} onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const values = new FormData(form)
          const commercial = data.deployment.profile === 'commercial'
          const identityValue = String(values.get(commercial ? 'commercialEmail' : 'identityValue'))
          void act(async () => {
            await createInvitation({
              identityValue,
              displayName: String(values.get('displayName')),
              ...(!commercial && values.get('contactEmail') ? { email: String(values.get('contactEmail')) } : {}),
              role: String(values.get('role')) as Role,
            })
            form.reset()
          })
        }}>
          <input name="displayName" required maxLength={256} placeholder="Display name" />
          {data.deployment.profile === 'commercial'
            ? <input name="commercialEmail" type="email" required maxLength={256} placeholder="Organizational email" />
            : <>
              <input name="identityValue" required maxLength={1024} placeholder="EDIPI, UPN, PIV UUID, FASC-N, or issuer:subject" aria-label="Stable CAC/PIV identifier" />
              <input name="contactEmail" type="email" maxLength={256} placeholder="Contact email (optional)" />
            </>}
          <SelectField name="role" label="Initial role" placeholder="Choose a role" options={allowedRoles.map((role) => ({ value: role, label: role }))} />
          <button className="primary" disabled={busy}>{commercialAction(data.deployment.profile)}</button>
        </form>
        <p className="admin-note">{data.deployment.profile === 'commercial'
          ? 'The first validated OIDC login must match this email. Papyrus then binds the user to the provider issuer and subject.'
          : 'Papyrus detects the identifier format and matches it against the validated CAC/PIV certificate. Email is optional and is never the government identity selector.'}</p>
      </AdminPanel>
      <AdminPanel title="Pending identities">
        <div className="admin-list compact">{data.invitations.filter((invitation) => invitation.status === 'pending').length
          ? data.invitations.filter((invitation) => invitation.status === 'pending').map((invitation) => <article key={invitation.id}><div><strong>{invitation.displayName}</strong><span>{identityKindLabel(invitation.identityKind)} · {invitation.identityValue}</span><span>{invitation.email ? `${invitation.email} · ` : ''}{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleString()}</span></div><button className="danger" disabled={busy} onClick={() => void act(() => cancelInvitation(invitation.id))}>Cancel</button></article>)
          : <div className="empty">No pending identities.</div>}</div>
      </AdminPanel>
      <AdminPanel title="Identity and roles"><div className="admin-list">{data.users.map((user) => {
        const eligibleRoles = allowedRoles.filter((role) => !user.roles.includes(role))
        const isSelf = user.id === me.id
        const protectedTarget = user.roles.includes('Owner') || (me.roles.includes('Admin') && user.roles.includes('Admin'))
        return <article key={user.id}><div><strong>{user.displayName}{isSelf ? ' · This is you' : ''}</strong><span>{user.email ?? authenticationLabel(user.authMethod)}</span><span>{user.roles.join(' · ') || 'No role'} · {authenticationLabel(user.authMethod)}</span></div>{isSelf || protectedTarget
          ? <span className="status-good">{isSelf ? 'CURRENT IDENTITY' : 'PROTECTED IDENTITY'}</span>
          : <form onSubmit={(event) => { event.preventDefault(); const role = new FormData(event.currentTarget).get('role'); if (typeof role === 'string' && role) void act(() => addUserRole(user.id, role as Role)) }}><SelectField name="role" label="Eligible role" placeholder="Choose a role" options={eligibleRoles.map((role) => ({ value: role, label: role }))} /><button className="secondary" disabled={busy || eligibleRoles.length === 0}>Add role</button><button type="button" className="danger" disabled={busy} onClick={() => void act(() => revokeUserSessions(user.id))}>Revoke sessions</button></form>}</article>
      })}</div></AdminPanel>
    </section>}
    {tab === 'files' && <section className="admin-single">
      <AdminPanel title="NAS-backed file mounts">
        <form className="admin-form file-mount-create" onSubmit={(event) => {
          event.preventDefault(); const form = event.currentTarget; const values = new FormData(form)
          void act(async () => { await createFileMount(String(values.get('name')), String(values.get('rootPath'))); form.reset() })
        }}>
          <input name="name" required maxLength={256} placeholder="Mount name" />
          <input name="rootPath" required maxLength={4096} placeholder="/mnt/approved-data" />
          <button className="primary compact-button" disabled={busy}>Connect mount</button>
        </form>
        <p className="admin-note">Papyrus uses an existing operating-system NAS mount. Credentials remain outside Papyrus. Agents work from isolated proposals and cannot write directly to this path.</p>
        <div className="admin-list">{data.fileMounts.map((mount) => <article key={mount.id} className="file-mount-admin"><div><strong>{mount.name}</strong><span>{mount.rootPath}</span><span>{mount.assignments.length} assigned identities</span></div>
          <form onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void act(() => assignFileMount(mount.id, String(values.get('userId')), String(values.get('access')) as FileMountAccess)) }}>
            <SelectField name="userId" label="Identity" placeholder="Choose identity" options={data.users.map((user) => ({ value: user.id, label: user.displayName }))} />
            <SelectField name="access" label="Access" placeholder="Choose access" options={[{ value: 'read', label: 'Read only' }, { value: 'publish', label: 'Read + publish' }]} />
            <button className="secondary compact-button" disabled={busy}>Assign</button>
          </form>
          {mount.assignments.length > 0 && <div className="mount-assignments">{mount.assignments.map((assignment) => {
            const user = data.users.find((item) => item.id === assignment.userId)
            return <span key={assignment.userId}><b>{user?.displayName ?? assignment.userId}</b> · {assignment.access}<button className="text-button" disabled={busy} onClick={() => void act(() => revokeFileMountAssignment(mount.id, assignment.userId))}>Remove</button></span>
          })}</div>}
        </article>)}</div>
      </AdminPanel>
    </section>}
    {tab === 'integrations' && <section className="admin-single"><AdminPanel title="MCP servers"><form className="admin-form mcp-register" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); setBusy(true); setError(undefined); void addMcpServer(String(values.get('name')), String(values.get('endpoint'))).then((result) => { form.reset(); if (result.authorizationUrl) window.open(result.authorizationUrl, 'papyrus-mcp-oauth', 'popup,width=720,height=820'); return load() }).catch(show).finally(() => setBusy(false)) }}><input name="name" required maxLength={256} placeholder="Server name" /><input name="endpoint" type="url" required maxLength={2048} placeholder="https://mcp.internal/rpc" /><button className="primary" disabled={busy}>{busy ? 'Discovering…' : 'Connect server'}</button></form><div className="admin-list compact">{data.mcpServers.map((server) => <article key={server.id}><div><strong>{server.name}</strong><span>{server.endpoint}</span><span>{server.oauthStatus === 'connected' ? `OAuth connected · ${server.oauthIssuer}` : server.oauthStatus === 'authorization_required' ? 'Waiting for OAuth authorization' : server.oauthStatus === 'error' ? server.oauthError : 'No OAuth challenge · direct connection'} </span></div><button className={server.enabled ? 'danger' : 'secondary'} disabled={busy || server.oauthStatus === 'authorization_required'} onClick={() => void act(() => setMcpServerEnabled(server.id, !server.enabled))}>{server.enabled ? 'Disable' : 'Enable'}</button></article>)}</div><p className="admin-note">Papyrus discovers protected-resource metadata, dynamically registers an OAuth client, and completes authorization-code + PKCE before a protected remote server becomes available.</p></AdminPanel></section>}
  </div>
}

function AdminPanel({ title, children }: { title: string; children: ReactNode }) { return <article className="panel admin-panel"><div className="panel-head"><h2>{title}</h2></div>{children}</article> }
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div> }
function yes(value: boolean) { return value ? 'CONFIGURED' : 'NOT CONFIGURED' }
function commercialAction(profile: AdminOverview['deployment']['profile']) { return profile === 'commercial' ? 'Send invite' : 'Create identity' }
function identityKindLabel(value: string) {
  return ({ email: 'Organizational email', edipi: 'EDIPI / DoD ID', upn: 'UPN', piv_uuid: 'PIV UUID', fasc_n: 'FASC-N', issuer_subject: 'Issuer + certificate subject' } as Record<string, string>)[value] ?? value
}
function authenticationLabel(value: Principal['authMethod'] | AdminOverview['deployment']['authentication']) { return ({ oidc: 'ORGANIZATIONAL OIDC', mtls: 'CAC/PIV MTLS', 'trusted-proxy': 'TRUSTED IDENTITY PROXY', none: 'NONE CONFIGURED' } as Record<string, string>)[value] ?? String(value).toUpperCase() }
