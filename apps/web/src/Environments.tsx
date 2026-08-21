import { useCallback, useEffect, useState } from 'react'
import type { AdminOverview, Environment, Principal } from '@papyrus/contracts'
import { adminOverview, assignEnvironment, createEnvironmentAdmin, grantMcpServer, revokeToolGrant } from './api.js'
import { SelectField } from './SelectField.js'

export function EnvironmentsView({ me, items }: { me: Principal; items: Environment[] }) {
  const privileged = me.roles.some((role) => role === 'Owner' || role === 'Admin')
  const [data, setData] = useState<AdminOverview>()
  const [selectedId, setSelectedId] = useState(items[0]?.id)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { if (privileged) setData(await adminOverview()) }, [privileged])
  useEffect(() => { void load().catch(show) }, [load])
  const environments = data?.environments ?? items.map((item) => ({ ...item, assignedUserIds: [] }))
  const selected = environments.find((item) => item.id === selectedId) ?? environments[0]
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await operation(); await load() } catch (cause) { show(cause) } finally { setBusy(false) } }
  function show(cause: unknown) { setError(cause instanceof Error ? cause.message : 'Environment request failed') }

  const eligibleUsers = data?.users.filter((user) => !selected?.assignedUserIds.includes(user.id)) ?? []
  const grantedServerIds = new Set(data?.toolGrants.filter((grant) => grant.environmentId === selected?.id).map((grant) => grant.mcpServerId) ?? [])
  const eligibleServers = data?.mcpServers.filter((server) => server.enabled && !grantedServerIds.has(server.id)) ?? []

  return <div className="environment-console">
    {error && <div className="error">{error}<button onClick={() => setError(undefined)}>×</button></div>}
    <aside className="environment-directory">
      <div className="panel-head"><h2>Environments</h2><span>{environments.length}</span></div>
      {environments.map((environment) => <button key={environment.id} className={environment.id === selected?.id ? 'selected' : ''} onClick={() => setSelectedId(environment.id)}><strong>{environment.name}</strong><span>{environment.description || 'No description'}</span></button>)}
      {!environments.length && <div className="empty">No environments are assigned to this identity.</div>}
      {privileged && <form className="environment-create" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); void act(() => createEnvironmentAdmin(String(values.get('name')), String(values.get('description') ?? ''))).then(() => form.reset()) }}><input name="name" required maxLength={256} placeholder="New environment" /><input name="description" maxLength={2000} placeholder="Purpose and handling boundary" /><button className="primary" disabled={busy}>Create environment</button></form>}
    </aside>
    <section className="environment-detail">
      {!selected ? <div className="conversation-empty"><h2>No environment selected.</h2><p>Create or request access to an environment before starting sessions.</p></div> : <>
        <article className="panel environment-hero"><p className="eyebrow">CEDAR AUTHORIZATION BOUNDARY</p><h2>{selected.name}</h2><p>{selected.description || 'No purpose or handling description has been provided.'}</p></article>
        <div className="environment-controls">
          <article className="panel admin-panel"><div className="panel-head"><h2>Members</h2><span>{selected.assignedUserIds.length}</span></div>
            {privileged && data ? <><form className="admin-form compact-form" onSubmit={(event) => { event.preventDefault(); const principalId = new FormData(event.currentTarget).get('principalId'); if (typeof principalId === 'string' && principalId) void act(() => assignEnvironment(principalId, selected.id)) }}><SelectField name="principalId" label="Eligible identity" placeholder="Choose an identity" options={eligibleUsers.map((user) => ({ value: user.id, label: user.displayName, detail: authenticationLabel(user.authMethod) }))} /><button className="primary" disabled={busy || eligibleUsers.length === 0}>Assign member</button></form><div className="admin-list compact">{selected.assignedUserIds.length ? selected.assignedUserIds.flatMap((id) => { const user = data.users.find((item) => item.id === id); return user ? [<article key={id}><div><strong>{user.displayName}</strong><span>{authenticationLabel(user.authMethod)} · {user.roles.join(' · ') || 'No role'}</span></div></article>] : [] }) : <div className="empty">No identities are assigned.</div>}</div></> : <p>Membership is managed by deployment administrators.</p>}
          </article>
          <article className="panel admin-panel"><div className="panel-head"><h2>MCP access</h2><span>{grantedServerIds.size}</span></div>
            {privileged && data ? <><p className="admin-note">Enabling a registered MCP server makes its tools available to sessions in this environment. Individual tool calls remain subject to Cedar policy and approval.</p><form className="admin-form compact-form" onSubmit={(event) => { event.preventDefault(); const serverId = new FormData(event.currentTarget).get('mcpServerId'); if (typeof serverId === 'string' && serverId) void act(() => grantMcpServer(selected.id, serverId)) }}><SelectField name="mcpServerId" label="Registered MCP server" placeholder="Choose a tool source" options={eligibleServers.map((server) => ({ value: server.id, label: server.name, detail: server.endpoint }))} /><button className="primary" disabled={busy || eligibleServers.length === 0}>Enable server</button></form><div className="grant-list">{data.toolGrants.filter((grant) => grant.environmentId === selected.id).map((grant) => <div key={grant.id}><span><strong>{data.mcpServers.find((server) => server.id === grant.mcpServerId)?.name ?? 'Registered server'}</strong><small>Source of governed MCP tools</small></span><button className="danger" disabled={busy} onClick={() => void act(() => revokeToolGrant(grant.id))}>Disable</button></div>)}</div></> : <p>Effective MCP access is read-only for this identity.</p>}
          </article>
        </div>
      </>}
    </section>
  </div>
}

function authenticationLabel(method: Principal['authMethod']) {
  return method === 'development' ? 'Loopback development identity' : method === 'oidc' ? 'Organizational OIDC identity' : 'CAC/PIV certificate identity'
}
