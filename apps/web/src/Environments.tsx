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
  const [creating, setCreating] = useState(false)
  const load = useCallback(async () => { if (privileged) setData(await adminOverview()) }, [privileged])
  useEffect(() => { void load().catch(show) }, [load])
  const environments = data?.environments ?? items.map((item) => ({ ...item, assignedUserIds: [] }))
  const selected = environments.find((item) => item.id === selectedId) ?? environments[0]
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await operation(); await load(); return true } catch (cause) { show(cause); return false } finally { setBusy(false) } }
  function show(cause: unknown) { setError(cause instanceof Error ? cause.message : 'Environment request failed') }

  const eligibleUsers = data?.users.filter((user) => !selected?.assignedUserIds.includes(user.id)) ?? []
  const grantedServerIds = new Set(data?.toolGrants.filter((grant) => grant.environmentId === selected?.id).map((grant) => grant.mcpServerId) ?? [])
  const eligibleServers = data?.mcpServers.filter((server) => server.enabled && !grantedServerIds.has(server.id)) ?? []

  return <div className="environment-console">
    {error && <div className="error">{error}<button onClick={() => setError(undefined)}>×</button></div>}
    <aside className="environment-directory">
      <div className="session-sidebar-head"><strong>Environments</strong>{privileged && <button className="icon-button" onClick={() => setCreating(true)} aria-label="Create environment">＋</button>}</div>
      {environments.map((environment) => <button key={environment.id} className={environment.id === selected?.id ? 'selected' : ''} onClick={() => setSelectedId(environment.id)}><strong>{environment.name}</strong><span>{environment.description || 'No description'}</span></button>)}
      {!environments.length && <div className="empty">No environments are assigned to this identity.</div>}
    </aside>
    <section className="environment-detail">
      {creating ? <form className="create-session environment-create-panel" onSubmit={(event) => {
        event.preventDefault()
        const form = event.currentTarget
        const values = new FormData(form)
        void act(() => createEnvironmentAdmin(String(values.get('name')), String(values.get('description') ?? ''))).then((created) => {
          if (created) {
            form.reset()
            setCreating(false)
          }
        })
      }}>
        <div><strong>New environment</strong><button type="button" className="icon-button" onClick={() => setCreating(false)} aria-label="Close environment form">×</button></div>
        <label>Environment name<input name="name" required maxLength={256} autoFocus placeholder="Development" /></label>
        <label>Purpose and handling boundary<input name="description" maxLength={2000} placeholder="Describe the authorized work and data boundary" /></label>
        <button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create environment →'}</button>
      </form> : !selected ? <div className="conversation-empty"><h2>No environment selected.</h2><p>Create or request access to an environment before starting sessions.</p></div> : <>
        <article className="panel environment-hero"><p className="eyebrow">CEDAR AUTHORIZATION BOUNDARY</p><h2>{selected.name}</h2><p>{selected.description || 'No purpose or handling description has been provided.'}</p></article>
        <div className="environment-controls">
          <article className="panel admin-panel"><div className="panel-head"><h2>Members</h2><span>{selected.assignedUserIds.length}</span></div>
            {privileged && data ? <div className="resource-list">
              {selected.assignedUserIds.length ? selected.assignedUserIds.flatMap((id) => {
                const user = data.users.find((item) => item.id === id)
                return user ? [<article className="resource-list-card" key={id}><div><strong>{user.displayName}</strong><span>{authenticationLabel(user.authMethod)} · {user.roles.join(' · ') || 'No role'}</span></div><span className="pill completed">member</span></article>] : []
              }) : <div className="resource-list-empty">No identities are assigned.</div>}
              {eligibleUsers.length ? <form className="resource-list-card resource-list-action" onSubmit={(event) => {
                event.preventDefault()
                const principalId = new FormData(event.currentTarget).get('principalId')
                if (typeof principalId === 'string' && principalId) void act(() => assignEnvironment(principalId, selected.id))
              }}><SelectField name="principalId" label="Add member" placeholder="Choose an eligible identity" options={eligibleUsers.map((user) => ({ value: user.id, label: user.displayName, detail: authenticationLabel(user.authMethod) }))} /><button className="primary" disabled={busy}>Assign</button></form> : <div className="resource-list-empty">Every eligible identity is already assigned.</div>}
            </div> : <p>Membership is managed by deployment administrators.</p>}
          </article>
          <article className="panel admin-panel"><div className="panel-head"><h2>MCP access</h2><span>{grantedServerIds.size}</span></div>
            {privileged && data ? <><p className="admin-note">Enabled sources expose tools to this environment. Cedar policy and approval still govern every call.</p><div className="resource-list">
              {data.toolGrants.filter((grant) => grant.environmentId === selected.id).length ? data.toolGrants.filter((grant) => grant.environmentId === selected.id).map((grant) => {
                const server = data.mcpServers.find((item) => item.id === grant.mcpServerId)
                return <article className="resource-list-card" key={grant.id}><div><strong>{server?.name ?? 'Registered server'}</strong><span>{server?.endpoint ?? 'Governed MCP tool source'}</span></div><button className="danger" disabled={busy} onClick={() => void act(() => revokeToolGrant(grant.id))}>Disable</button></article>
              }) : <div className="resource-list-empty">No MCP sources are enabled.</div>}
              {eligibleServers.length ? <form className="resource-list-card resource-list-action" onSubmit={(event) => {
                event.preventDefault()
                const serverId = new FormData(event.currentTarget).get('mcpServerId')
                if (typeof serverId === 'string' && serverId) void act(() => grantMcpServer(selected.id, serverId))
              }}><SelectField name="mcpServerId" label="Enable source" placeholder="Choose a registered MCP server" options={eligibleServers.map((server) => ({ value: server.id, label: server.name, detail: server.endpoint }))} /><button className="primary" disabled={busy}>Enable</button></form> : <div className="resource-list-empty">No additional registered MCP sources are available.</div>}
            </div></> : <p>Effective MCP access is read-only for this identity.</p>}
          </article>
        </div>
      </>}
    </section>
  </div>
}

function authenticationLabel(method: Principal['authMethod']) {
  return method === 'oidc' ? 'Organizational OIDC identity' : 'CAC/PIV certificate identity'
}
