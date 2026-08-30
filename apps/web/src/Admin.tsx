import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { type ApprovedSourceKind, ROLES, type AdminOverview, type McpServer, type Principal, type Role } from '@papyrus/contracts'
import { addMcpServer, addUserRole, adminOverview, assignApprovedSource, cancelInvitation, createApprovedSource, createInvitation, deleteMcpOauthClient, deleteMcpServer, ingestApprovedSource, retryMcpServer, revokeUserSessions, saveMcpOauthClient, setMcpServerEnabled } from './api.js'
import { SelectField } from './SelectField.js'
import { Alert, Button, Card, Checkbox, Combobox, Dialog, DialogContent, DialogFooter, DialogHeader, Input, TabsList, TabsTrigger } from './components/ui/index.js'

type AdminTab = 'deployment' | 'identity' | 'sources' | 'integrations'

export function AdminView({ me }: { me: Principal }) {
  const [data, setData] = useState<AdminOverview>()
  const [tab, setTab] = useState<AdminTab>('deployment')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [oauthRequest,setOauthRequest]=useState<{authorizationUrl:string;name:string;endpoint:string;issuer?:string;registrationMethod?:McpServer['oauthRegistrationMethod'];scope?:string}>()
  const [oauthClientRequest,setOauthClientRequest]=useState<McpServer>()
  const [oauthNotice,setOauthNotice]=useState<string>()
  const [deleteRequest,setDeleteRequest]=useState<McpServer>()
  const load = useCallback(async () => { setData(await adminOverview()) }, [])
  useEffect(() => { void load().catch(show) }, [load])
  useEffect(() => {
    const oauthMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.data?.type === 'papyrus:mcp-connected') {
        setOauthNotice(typeof event.data.message === 'string' ? event.data.message : 'MCP authorization complete')
        setError(undefined)
        void load()
      }
      if (event.data?.type === 'papyrus:mcp-oauth-error') {
        setError(typeof event.data.message === 'string' ? event.data.message : 'MCP authorization failed')
        void load()
      }
    }
    window.addEventListener('message', oauthMessage)
    return () => window.removeEventListener('message', oauthMessage)
  }, [load])
  function show(cause: unknown) { setError(cause instanceof Error ? cause.message : 'Administrative request failed') }
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await operation(); await load() } catch (cause) { show(cause) } finally { setBusy(false) } }
  const showOauth = (result: {server:McpServer;authorizationUrl?:string}) => {
    if (result.authorizationUrl) {
      setOauthClientRequest(undefined)
      setOauthRequest({
        authorizationUrl: result.authorizationUrl,
        name: result.server.name,
        endpoint: result.server.endpoint,
        ...(result.server.oauthIssuer ? { issuer: result.server.oauthIssuer } : {}),
        ...(result.server.oauthRegistrationMethod ? { registrationMethod: result.server.oauthRegistrationMethod } : {}),
        ...(result.server.oauthScope ? { scope: result.server.oauthScope } : {}),
      })
    } else if (result.server.oauthStatus === 'configuration_required') {
      setOauthClientRequest(result.server)
    }
  }
  const retryConnection = async (server:McpServer) => {
    setBusy(true); setError(undefined)
    try { const result=await retryMcpServer(server.id); showOauth(result); await load() } catch(cause) { show(cause) } finally { setBusy(false) }
  }
  if (!data) return <div className="empty">Loading deployment administration…</div>
  const allowedRoles = me.roles.includes('Owner') ? ROLES : ROLES.filter((role) => role !== 'Owner' && role !== 'Admin')
  return <div className="admin-view">
    {error && <Alert className="error">{error}<Button variant="ghost" onClick={() => setError(undefined)}>×</Button></Alert>}
    {oauthNotice && <Alert className="connection-notice">{oauthNotice}<Button variant="ghost" onClick={() => setOauthNotice(undefined)}>×</Button></Alert>}
    <TabsList className="admin-tabs">{(['deployment', 'identity', 'sources', 'integrations'] as AdminTab[]).map((item) => <TabsTrigger key={item} active={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item}</TabsTrigger>)}</TabsList>
    {tab === 'deployment' && <section className="admin-summary"><AdminPanel title="Deployment"><dl className="facts"><Fact label="Profile" value={data.deployment.profile} /><Fact label="Topology" value="ON-PREMISES" /><Fact label="Origin" value={data.deployment.publicOrigin} /><Fact label="Authentication" value={authenticationLabel(data.deployment.authentication)} /><Fact label="Gateway" value={yes(data.deployment.gatewayConfigured)} /></dl></AdminPanel><AdminPanel title="License"><dl className="facts"><Fact label="Required" value={yes(data.deployment.licenseRequired)} /><Fact label="Status" value={data.license.valid ? 'VALID' : 'NOT ACTIVE'} /><Fact label="Deployment" value={data.license.deploymentId.slice(0, 16)} /></dl></AdminPanel></section>}
    {tab === 'identity' && <section className="admin-summary identity-admin">
      <AdminPanel title={data.deployment.profile === 'commercial' ? 'Invite with organizational OIDC' : 'Create pending CAC/PIV identity'}>
        <form className={`admin-form identity-create ${data.deployment.profile === 'commercial' ? 'commercial' : 'dow'}`} onSubmit={(event) => {
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
        return <Card key={user.id} className="identity-card"><div><strong>{user.displayName}{isSelf ? ' · This is you' : ''}</strong><span>{user.email ?? authenticationLabel(user.authMethod)}</span><span>{user.roles.join(' · ') || 'No role'} · {authenticationLabel(user.authMethod)}</span></div>{isSelf || protectedTarget
          ? <span className="status-good">{isSelf ? 'CURRENT IDENTITY' : 'PROTECTED IDENTITY'}</span>
          : <form className="identity-role-actions" onSubmit={(event) => { event.preventDefault(); const role = new FormData(event.currentTarget).get('role'); if (typeof role === 'string' && role) void act(() => addUserRole(user.id, role as Role)) }}><SelectField name="role" label="Eligible role" placeholder="Choose a role" options={eligibleRoles.map((role) => ({ value: role, label: role }))} /><Button className="secondary" disabled={busy || eligibleRoles.length === 0}>Add role</Button><Button type="button" className="danger" disabled={busy} onClick={() => void act(() => revokeUserSessions(user.id))}>Revoke sessions</Button></form>}</Card>
      })}</div></AdminPanel>
    </section>}
    {tab === 'sources' && <SourceAdministration data={data} busy={busy} act={act} />}
    {tab === 'integrations' && <section className="admin-single"><AdminPanel title="MCP servers">
      <form className="admin-form mcp-register" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); setBusy(true); setError(undefined); setOauthNotice(undefined); void addMcpServer(String(values.get('name')), String(values.get('endpoint'))).then((result) => { form.reset(); showOauth(result); return load() }).catch(show).finally(() => setBusy(false)) }}>
        <Input name="name" required maxLength={256} placeholder="Server name" />
        <Input name="endpoint" type="url" required maxLength={2048} placeholder="https://mcp.internal/rpc" />
        <Button className="primary" disabled={busy}>{busy ? 'Discovering…' : 'Connect server'}</Button>
      </form>
      <div className="admin-list compact">{data.mcpServers.map((server) => <Card key={server.id}>
        <div><strong>{server.name}</strong><span>{server.endpoint}</span><span>{mcpStatus(server)}</span></div>
        <div className="mcp-server-actions">
          {server.oauthStatus === 'configuration_required'
            ? <Button variant="neutral" disabled={busy} onClick={() => setOauthClientRequest(server)}>Configure OAuth</Button>
            : (server.oauthStatus === 'authorization_required' || server.oauthStatus === 'error')
              ? <Button variant="neutral" disabled={busy} onClick={() => void retryConnection(server)}>Retry connection</Button>
              : <Button className={server.enabled ? 'danger' : 'secondary'} disabled={busy} onClick={() => void act(() => setMcpServerEnabled(server.id, !server.enabled))}>{server.enabled ? 'Disable' : 'Enable'}</Button>}
          <Button className="danger" disabled={busy} onClick={() => setDeleteRequest(server)}>Delete</Button>
        </div>
      </Card>)}</div>
      <p className="admin-note">Papyrus discovers OAuth from MCP protected-resource metadata, prefers a configured OAuth client, then Client ID Metadata Documents (CIMD), and uses Dynamic Client Registration only when the authorization server advertises it. Authorization uses PKCE and stored refresh tokens are rotated automatically.</p>
      {data.mcpOauthClients.length > 0 && <div className="mcp-oauth-clients">
        <p className="eyebrow">REGISTERED OAUTH CLIENTS</p>
        <div className="admin-list compact">{data.mcpOauthClients.map((client) => <Card key={client.issuer}>
          <div><strong>{new URL(client.issuer).hostname}</strong><span>{client.issuer}</span><span>{client.registrationMethod} · {client.hasClientSecret ? 'client secret stored' : 'public client'}{client.scopes ? ` · scopes: ${client.scopes}` : ''}</span></div>
          <Button className="danger" disabled={busy} onClick={() => void act(() => deleteMcpOauthClient(client.issuer))}>Remove</Button>
        </Card>)}</div>
      </div>}
    </AdminPanel></section>}
    <Dialog open={Boolean(deleteRequest)} onOpenChange={open=>{if(!open)setDeleteRequest(undefined)}}>
      {deleteRequest&&<DialogContent>
        <DialogHeader><div><p className="eyebrow">DELETE CONNECTION</p><h2>Delete {deleteRequest.name}?</h2></div></DialogHeader>
        <p>This removes the connection, pending OAuth state, stored credentials, and every associated tool grant. This cannot be undone.</p>
        <DialogFooter><Button variant="neutral" onClick={()=>setDeleteRequest(undefined)}>Cancel</Button><Button className="danger" disabled={busy} onClick={()=>void act(async()=>{await deleteMcpServer(deleteRequest.id);setDeleteRequest(undefined)})}>Delete connection</Button></DialogFooter>
      </DialogContent>}
    </Dialog>
    <Dialog open={Boolean(oauthClientRequest)} onOpenChange={open=>{if(!open)setOauthClientRequest(undefined)}}>
      {oauthClientRequest&&<DialogContent className="oauth-client-dialog">
        <form onSubmit={(event)=>{
          event.preventDefault()
          const form=event.currentTarget
          const values=new FormData(form)
          const issuer=oauthClientRequest.oauthIssuer
          if(!issuer)return
          setBusy(true);setError(undefined);setOauthNotice(undefined)
          void saveMcpOauthClient({
            issuer,
            clientId:String(values.get('clientId')),
            ...(String(values.get('clientSecret')??'').trim()?{clientSecret:String(values.get('clientSecret')).trim()}:{}),
            ...(String(values.get('scopes')??'').trim()?{scopes:String(values.get('scopes')).trim()}:{}),
          }).then(()=>retryMcpServer(oauthClientRequest.id)).then((result)=>{showOauth(result);return load()}).catch(show).finally(()=>setBusy(false))
        }}>
          <DialogHeader><img src={connectionLogo(oauthClientRequest.endpoint)} alt="Connection logo" referrerPolicy="no-referrer"/><div><p className="eyebrow">OAUTH CLIENT REGISTRATION</p><h2>Configure {oauthClientRequest.name}</h2></div></DialogHeader>
          <p>This authorization server requires Papyrus to use a pre-registered OAuth client. Create an OAuth app with the callback shown below, then enter its credentials here.</p>
          <dl className="facts"><Fact label="Authorization server" value={oauthClientRequest.oauthIssuer??'Unknown'}/><Fact label="Callback" value={`${data.deployment.publicOrigin}/api/mcp/oauth/callback`}/></dl>
          <div className="oauth-client-fields">
            <label><span>Client ID</span><Input name="clientId" required maxLength={2048} defaultValue={data.mcpOauthClients.find(client=>client.issuer===oauthClientRequest.oauthIssuer)?.clientId??''} placeholder="OAuth client ID" /></label>
            <label><span>Client secret</span><Input name="clientSecret" type="password" maxLength={4096} placeholder={data.mcpOauthClients.find(client=>client.issuer===oauthClientRequest.oauthIssuer)?.hasClientSecret?'Leave blank to keep stored secret':'OAuth client secret (if required)'} /></label>
            <label><span>Scopes</span><Input name="scopes" maxLength={4096} defaultValue={data.mcpOauthClients.find(client=>client.issuer===oauthClientRequest.oauthIssuer)?.scopes??''} placeholder="Optional space-separated scopes" /></label>
          </div>
          <DialogFooter><Button type="button" variant="neutral" onClick={()=>setOauthClientRequest(undefined)}>Cancel</Button><Button disabled={busy}>{busy?'Preparing authorization…':'Save & authorize →'}</Button></DialogFooter>
        </form>
      </DialogContent>}
    </Dialog>
    <Dialog open={Boolean(oauthRequest)} onOpenChange={open=>{if(!open)setOauthRequest(undefined)}}>
      {oauthRequest&&<DialogContent className="oauth-registration-dialog">
        <DialogHeader><img src={connectionLogo(oauthRequest.endpoint)} alt="Connection logo" referrerPolicy="no-referrer"/><div><p className="eyebrow">MCP OAUTH</p><h2>Authorize {oauthRequest.name}</h2></div></DialogHeader>
        <dl className="facts"><Fact label="Resource" value={oauthRequest.endpoint}/><Fact label="Authorization server" value={oauthRequest.issuer??new URL(oauthRequest.authorizationUrl).origin}/><Fact label="Client registration" value={registrationMethodLabel(oauthRequest.registrationMethod)}/>{oauthRequest.scope&&<Fact label="Requested scope" value={oauthRequest.scope}/>}<Fact label="Flow" value="Authorization code + PKCE"/><Fact label="Redirect" value="Papyrus MCP OAuth callback"/></dl>
        <p>Papyrus validated the MCP protected-resource and authorization-server metadata. Continue to the provider to approve this connection.</p>
        <DialogFooter><Button variant="neutral" onClick={()=>setOauthRequest(undefined)}>Cancel</Button><Button onClick={()=>{const popup=window.open(oauthRequest.authorizationUrl,'papyrus-mcp-oauth','popup,width=720,height=820');if(!popup)setError('The OAuth popup was blocked by the browser. Allow popups for Papyrus and try again.');setOauthRequest(undefined)}}>Continue to authorization →</Button></DialogFooter>
      </DialogContent>}
    </Dialog>
  </div>
}

function mcpStatus(server:McpServer){
  if(server.oauthStatus==='connected')return `OAuth connected · ${server.oauthIssuer} · ${registrationMethodLabel(server.oauthRegistrationMethod)}`
  if(server.oauthStatus==='configuration_required')return server.oauthError??'OAuth client registration required'
  if(server.oauthStatus==='authorization_required')return server.oauthError??'Waiting for OAuth authorization'
  if(server.oauthStatus==='error')return server.oauthError??'OAuth connection failed'
  return 'Connected · validated with MCP SDK'
}
function registrationMethodLabel(method:McpServer['oauthRegistrationMethod']|undefined){return method==='preregistered'?'Pre-registered client':method==='cimd'?'Client ID Metadata Document':method==='dcr'?'Dynamic Client Registration':'Provider client'}
function connectionLogo(endpoint:string){const hostname=new URL(endpoint).hostname;return `https://img.logo.dev/${hostname}?token=pk_PJhuwvcfSPKKCJJxJcElsQ`}

function SourceAdministration({data,busy,act}:{data:AdminOverview;busy:boolean;act:(operation:()=>Promise<unknown>)=>Promise<void>}){
  const [kind,setKind]=useState<ApprovedSourceKind>('upload')
  const kinds=[{value:'upload',label:'Upload'},{value:'domain',label:'Domain'},{value:'mcp',label:'MCP'},{value:'api',label:'API'}]
  const modes=[{value:'snapshot',label:'Snapshot'},{value:'live',label:'Live'}]
  return <section className="admin-single approved-source-admin"><AdminPanel title="Approved sources">
    <form className="admin-form source-register" onSubmit={(event)=>{event.preventDefault();const form=event.currentTarget;const values=new FormData(form);void act(async()=>{
      const locator=kind==='upload'?String((values.get('file') as File)?.name??'upload'):String(values.get('locator')??'')
      if(kind==='domain')validateApprovedDomain(locator)
      const source=await createApprovedSource({name:String(values.get('name')),kind,locator,mode:String(values.get('mode')||'snapshot') as 'snapshot'|'live'})
      if(kind==='upload'){const file=values.get('file');if(!(file instanceof File)||!file.size)throw new Error('Choose a file to upload');await ingestApprovedSource(source.id,{uri:'upload:///'+file.name,title:file.name,mediaType:file.type||'text/plain',content:await file.text()})}
      form.reset();setKind('upload')
    })}}>
      <Input name="name" required maxLength={256} placeholder="Source name" />
      <Combobox value={kind} onValueChange={value=>setKind(value as ApprovedSourceKind)} options={kinds} placeholder="Choose source type" />
      {kind==='upload'&&<Input name="file" type="file" required accept=".txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.log,text/*,application/json,application/xml" />}
      {kind==='domain'&&<Input name="locator" type="url" required pattern="https://[^\\s]+" placeholder="https://docs.example.mil" />}
      {kind==='api'&&<Input name="locator" type="url" required placeholder="https://api.example.mil/v1" />}
      {kind==='mcp'&&<Combobox name="locator" options={data.mcpServers.filter(server=>server.enabled).map(server=>({value:server.id,label:server.name,detail:new URL(server.endpoint).hostname}))} placeholder="Choose MCP connection" />}
      <Combobox name="mode" defaultValue="snapshot" options={modes} placeholder="Choose retrieval mode" />
      <Button className="primary" disabled={busy}>Add source</Button>
    </form>
    <p className="admin-note">Sources are assigned to identities and rechecked on every search and read. Uploads are indexed immediately; domains and APIs retain their approved locator; MCP sources bind to an existing validated connection.</p>
    <div className="admin-list source-admin-list">{data.sources.map(source=><Card key={source.id}><div><strong>{source.name}</strong><span>{source.kind.replace(/^./,character=>character.toUpperCase())} · {source.mode.replace(/^./,character=>character.toUpperCase())} · {source.documentCount} documents</span><code>{source.locator}</code></div><div className="source-assignees">{data.users.map(user=><label key={user.id}><Checkbox checked={source.assignedUserIds.includes(user.id)} disabled={busy} onChange={(event)=>void act(()=>assignApprovedSource(source.id,user.id,event.target.checked))}/>{user.displayName}</label>)}</div></Card>)}</div>
  </AdminPanel></section>
}

function validateApprovedDomain(value:string){
  let url:URL
  try{url=new URL(value)}catch{throw new Error('Enter a valid HTTPS domain')}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.port)throw new Error('Domain sources must use a credential-free HTTPS origin')
  if(url.pathname!=='/'||url.search||url.hash)throw new Error('Enter a domain origin without a path, query, or fragment')
}

function AdminPanel({ title, children }: { title: string; children: ReactNode }) { return <Card className="panel admin-panel"><div className="panel-head"><h2>{title}</h2></div>{children}</Card> }
function Fact({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div> }
function yes(value: boolean) { return value ? 'CONFIGURED' : 'NOT CONFIGURED' }
function commercialAction(profile: AdminOverview['deployment']['profile']) { return profile === 'commercial' ? 'Send invite' : 'Create identity' }
function identityKindLabel(value: string) {
  return ({ email: 'Organizational email', edipi: 'EDIPI / DoD ID', upn: 'UPN', piv_uuid: 'PIV UUID', fasc_n: 'FASC-N', issuer_subject: 'Issuer + certificate subject' } as Record<string, string>)[value] ?? value
}
function authenticationLabel(value: Principal['authMethod'] | AdminOverview['deployment']['authentication']) { return ({ oidc: 'ORGANIZATIONAL OIDC', mtls: 'CAC/PIV MTLS', 'trusted-proxy': 'TRUSTED IDENTITY PROXY', none: 'NONE CONFIGURED' } as Record<string, string>)[value] ?? String(value).toUpperCase() }
