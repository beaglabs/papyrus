import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { APPROVED_SOURCE_KINDS, type ApprovedSourceKind, ROLES, type AdminOverview, type Principal, type Role } from '@papyrus/contracts'
import { addMcpServer, addUserRole, adminOverview, assignApprovedSource, cancelInvitation, createApprovedSource, createInvitation, ingestApprovedSource, revokeUserSessions, setMcpServerEnabled } from './api.js'
import { SelectField } from './SelectField.js'
import { Button, Card, Checkbox, Input, NativeSelect, TabsList, TabsTrigger } from './components/ui/index.js'

type AdminTab = 'deployment' | 'identity' | 'sources' | 'integrations'

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
    {error && <div className="error">{error}<Button onClick={() => setError(undefined)}>×</Button></div>}
    <TabsList className="admin-tabs">{(['deployment', 'identity', 'sources', 'integrations'] as AdminTab[]).map((item) => <TabsTrigger key={item} active={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</TabsTrigger>)}</TabsList>
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
          <Input name="displayName" required maxLength={256} placeholder="Display name" />
          {data.deployment.profile === 'commercial'
            ? <Input name="commercialEmail" type="email" required maxLength={256} placeholder="Organizational email" />
            : <>
              <Input name="identityValue" required maxLength={1024} placeholder="EDIPI, UPN, PIV UUID, FASC-N, or issuer:subject" aria-label="Stable CAC/PIV identifier" />
              <Input name="contactEmail" type="email" maxLength={256} placeholder="Contact email (optional)" />
            </>}
          <SelectField name="role" label="Initial role" placeholder="Choose a role" options={allowedRoles.map((role) => ({ value: role, label: role }))} />
          <Button className="primary" disabled={busy}>{commercialAction(data.deployment.profile)}</Button>
        </form>
        <p className="admin-note">{data.deployment.profile === 'commercial'
          ? 'The first validated OIDC login must match this email. Papyrus then binds the user to the provider issuer and subject.'
          : 'Papyrus detects the identifier format and matches it against the validated CAC/PIV certificate. Email is optional and is never the government identity selector.'}</p>
      </AdminPanel>
      <AdminPanel title="Pending identities">
        <div className="admin-list compact">{data.invitations.filter((invitation) => invitation.status === 'pending').length
          ? data.invitations.filter((invitation) => invitation.status === 'pending').map((invitation) => <Card key={invitation.id}><div><strong>{invitation.displayName}</strong><span>{identityKindLabel(invitation.identityKind)} · {invitation.identityValue}</span><span>{invitation.email ? `${invitation.email} · ` : ''}{invitation.role} · expires {new Date(invitation.expiresAt).toLocaleString()}</span></div><Button className="danger" disabled={busy} onClick={() => void act(() => cancelInvitation(invitation.id))}>Cancel</Button></Card>)
          : <div className="empty">No pending identities.</div>}</div>
      </AdminPanel>
      <AdminPanel title="Identity and roles"><div className="admin-list">{data.users.map((user) => {
        const eligibleRoles = allowedRoles.filter((role) => !user.roles.includes(role))
        const isSelf = user.id === me.id
        const protectedTarget = user.roles.includes('Owner') || (me.roles.includes('Admin') && user.roles.includes('Admin'))
        return <Card key={user.id}><div><strong>{user.displayName}{isSelf ? ' · This is you' : ''}</strong><span>{user.email ?? authenticationLabel(user.authMethod)}</span><span>{user.roles.join(' · ') || 'No role'} · {authenticationLabel(user.authMethod)}</span></div>{isSelf || protectedTarget
          ? <span className="status-good">{isSelf ? 'CURRENT IDENTITY' : 'PROTECTED IDENTITY'}</span>
          : <form onSubmit={(event) => { event.preventDefault(); const role = new FormData(event.currentTarget).get('role'); if (typeof role === 'string' && role) void act(() => addUserRole(user.id, role as Role)) }}><SelectField name="role" label="Eligible role" placeholder="Choose a role" options={eligibleRoles.map((role) => ({ value: role, label: role }))} /><Button className="secondary" disabled={busy || eligibleRoles.length === 0}>Add role</Button><Button type="button" className="danger" disabled={busy} onClick={() => void act(() => revokeUserSessions(user.id))}>Revoke sessions</Button></form>}</Card>
      })}</div></AdminPanel>
    </section>}
    {tab === 'sources' && <SourceAdministration data={data} busy={busy} act={act} />}
    {tab === 'integrations' && <section className="admin-single"><AdminPanel title="MCP servers"><form className="admin-form mcp-register" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); setBusy(true); setError(undefined); void addMcpServer(String(values.get('name')), String(values.get('endpoint'))).then((result) => { form.reset(); if (result.authorizationUrl) window.open(result.authorizationUrl, 'papyrus-mcp-oauth', 'popup,width=720,height=820'); return load() }).catch(show).finally(() => setBusy(false)) }}><Input name="name" required maxLength={256} placeholder="Server name" /><Input name="endpoint" type="url" required maxLength={2048} placeholder="https://mcp.internal/rpc" /><Button className="primary" disabled={busy}>{busy ? 'Discovering…' : 'Connect server'}</Button></form><div className="admin-list compact">{data.mcpServers.map((server) => <Card key={server.id}><div><strong>{server.name}</strong><span>{server.endpoint}</span><span>{server.oauthStatus === 'connected' ? `OAuth connected · ${server.oauthIssuer}` : server.oauthStatus === 'authorization_required' ? 'Waiting for OAuth authorization' : server.oauthStatus === 'error' ? server.oauthError : 'No OAuth challenge · direct connection'} </span></div><Button className={server.enabled ? 'danger' : 'secondary'} disabled={busy || server.oauthStatus === 'authorization_required'} onClick={() => void act(() => setMcpServerEnabled(server.id, !server.enabled))}>{server.enabled ? 'Disable' : 'Enable'}</Button></Card>)}</div><p className="admin-note">Papyrus discovers protected-resource metadata, dynamically registers an OAuth client, and completes authorization-code + PKCE before a protected remote server becomes available.</p></AdminPanel></section>}
  </div>
}

function SourceAdministration({data,busy,act}:{data:AdminOverview;busy:boolean;act:(operation:()=>Promise<unknown>)=>Promise<void>}){
  return <section className="admin-single approved-source-admin"><AdminPanel title="Approved sources">
    <form className="admin-form source-register" onSubmit={(event)=>{event.preventDefault();const form=event.currentTarget;const values=new FormData(form);void act(async()=>{await createApprovedSource({name:String(values.get('name')),kind:String(values.get('kind')) as ApprovedSourceKind,locator:String(values.get('locator')),mode:String(values.get('mode')) as 'snapshot'|'live'});form.reset()})}}>
      <Input name="name" required maxLength={256} placeholder="Source name" />
      <NativeSelect name="kind" aria-label="Source type">{APPROVED_SOURCE_KINDS.map(kind=><option key={kind} value={kind}>{kind}</option>)}</NativeSelect>
      <Input name="locator" required maxLength={4096} placeholder="Existing path, domain, endpoint, or package URI" />
      <NativeSelect name="mode" aria-label="Retrieval mode"><option value="snapshot">snapshot</option><option value="live">live</option></NativeSelect>
      <Button className="primary" disabled={busy}>Add source</Button>
    </form>
    <p className="admin-note">Papyrus does not mount network storage. Point directory sources at paths already mounted by the host, container, or Kubernetes deployment.</p>
    <div className="admin-list source-admin-list">{data.sources.map(source=><Card key={source.id}><div><strong>{source.name}</strong><span>{source.kind} · {source.mode} · {source.documentCount} documents</span><code>{source.locator}</code></div><div className="source-assignees">{data.users.map(user=><label key={user.id}><Checkbox checked={source.assignedUserIds.includes(user.id)} disabled={busy} onChange={(event)=>void act(()=>assignApprovedSource(source.id,user.id,event.target.checked))}/>{user.displayName}</label>)}</div></Card>)}</div>
    {data.sources.length>0&&<form className="admin-form source-ingest" onSubmit={(event)=>{event.preventDefault();const form=event.currentTarget;const values=new FormData(form);const file=values.get('file');if(!(file instanceof File)||!file.size)return;void file.text().then(content=>act(async()=>{await ingestApprovedSource(String(values.get('sourceId')),{uri:'upload:///'+file.name,title:file.name,mediaType:file.type||'text/plain',content});form.reset()}))}}>
      <NativeSelect name="sourceId" aria-label="Source to index">{data.sources.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</NativeSelect>
      <Input name="file" type="file" required accept=".txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.log,text/*,application/json,application/xml" />
      <Button className="secondary" disabled={busy}>Index document</Button>
    </form>}
  </AdminPanel></section>
}

function AdminPanel({ title, children }: { title: string; children: ReactNode }) { return <Card className="panel admin-panel"><div className="panel-head"><h2>{title}</h2></div>{children}</Card> }
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div> }
function yes(value: boolean) { return value ? 'CONFIGURED' : 'NOT CONFIGURED' }
function commercialAction(profile: AdminOverview['deployment']['profile']) { return profile === 'commercial' ? 'Send invite' : 'Create identity' }
function identityKindLabel(value: string) {
  return ({ email: 'Organizational email', edipi: 'EDIPI / DoD ID', upn: 'UPN', piv_uuid: 'PIV UUID', fasc_n: 'FASC-N', issuer_subject: 'Issuer + certificate subject' } as Record<string, string>)[value] ?? value
}
function authenticationLabel(value: Principal['authMethod'] | AdminOverview['deployment']['authentication']) { return ({ oidc: 'ORGANIZATIONAL OIDC', mtls: 'CAC/PIV MTLS', 'trusted-proxy': 'TRUSTED IDENTITY PROXY', none: 'NONE CONFIGURED' } as Record<string, string>)[value] ?? String(value).toUpperCase() }
