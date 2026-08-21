import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { AdminOverview, Principal, Workspace } from '@papyrus/contracts'
import { adminOverview, assignWorkspace, createWorkspaceAdmin, grantTool, revokeToolGrant } from './api.js'

export function WorkspacesView({ me, items }: { me: Principal; items: Workspace[] }) {
  const privileged = me.roles.some((role) => role === 'Owner' || role === 'Admin')
  const [data, setData] = useState<AdminOverview>()
  const [selectedId, setSelectedId] = useState(items[0]?.id)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { if (privileged) setData(await adminOverview()) }, [privileged])
  useEffect(() => { void load().catch(show) }, [load])
  const workspaces = data?.workspaces ?? items.map((item) => ({ ...item, assignedUserIds: [] }))
  const selected = workspaces.find((item) => item.id === selectedId) ?? workspaces[0]
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(undefined); try { await operation(); await load() } catch (cause) { show(cause) } finally { setBusy(false) } }
  function show(cause: unknown) { setError(cause instanceof Error ? cause.message : 'Workspace request failed') }

  return <div className="workspace-console">
    {error && <div className="error">{error}<button onClick={() => setError(undefined)}>×</button></div>}
    <aside className="workspace-directory">
      <div className="panel-head"><h2>Workspaces</h2><span>{workspaces.length}</span></div>
      {workspaces.map((workspace) => <button key={workspace.id} className={workspace.id === selected?.id ? 'selected' : ''} onClick={() => setSelectedId(workspace.id)}><strong>{workspace.name}</strong><span>{workspace.description || 'No description'}</span></button>)}
      {!workspaces.length && <div className="empty">No workspace assignments are available.</div>}
      {privileged && <form className="workspace-create" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); void act(() => createWorkspaceAdmin(String(values.get('name')), String(values.get('description') ?? ''))).then(() => form.reset()) }}><input name="name" required maxLength={256} placeholder="New workspace" /><input name="description" maxLength={2000} placeholder="Description" /><button className="primary" disabled={busy}>Create</button></form>}
    </aside>
    <section className="workspace-detail">
      {!selected ? <div className="conversation-empty"><h2>No workspace selected.</h2></div> : <>
        <article className="panel workspace-hero"><p className="eyebrow">GOVERNANCE BOUNDARY</p><h2>{selected.name}</h2><p>{selected.description || 'No description has been provided.'}</p></article>
        <div className="workspace-controls">
          <article className="panel admin-panel"><div className="panel-head"><h2>Members</h2><span>{selected.assignedUserIds.length}</span></div>
            {privileged && data ? <><form className="admin-form compact-form" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void act(() => assignWorkspace(String(values.get('principalId')), selected.id)) }}><select name="principalId">{data.users.filter((user) => !selected.assignedUserIds.includes(user.id)).map((user) => <option value={user.id} key={user.id}>{user.displayName}</option>)}</select><button className="primary" disabled={busy}>Assign member</button></form><div className="admin-list compact">{selected.assignedUserIds.map((id) => { const user = data.users.find((item) => item.id === id); return <article key={id}><div><strong>{user?.displayName ?? id.slice(0, 8)}</strong><span>{user?.email ?? user?.externalId ?? 'Assigned identity'}</span></div></article> })}</div></> : <p>Membership is managed by deployment administrators.</p>}
          </article>
          <article className="panel admin-panel"><div className="panel-head"><h2>Tool grants</h2><span>{data?.toolGrants.filter((grant) => grant.workspaceId === selected.id).length ?? 0}</span></div>
            {privileged && data ? <><form className="admin-form compact-form" onSubmit={(event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const values = new FormData(event.currentTarget); void act(() => grantTool(selected.id, String(values.get('mcpServerId')), String(values.get('toolName')))) }}><select name="mcpServerId">{data.mcpServers.filter((server) => server.enabled).map((server) => <option value={server.id} key={server.id}>{server.name}</option>)}</select><input name="toolName" required maxLength={256} placeholder="Tool name" /><button className="primary" disabled={busy || !data.mcpServers.some((server) => server.enabled)}>Grant</button></form><div className="grant-list">{data.toolGrants.filter((grant) => grant.workspaceId === selected.id).map((grant) => <div key={grant.id}><span>{data.mcpServers.find((server) => server.id === grant.mcpServerId)?.name ?? 'Server'} / <strong>{grant.toolName}</strong></span><button className="danger" disabled={busy} onClick={() => void act(() => revokeToolGrant(grant.id))}>Revoke</button></div>)}</div></> : <p>Effective tool access is read-only for this identity.</p>}
          </article>
        </div>
      </>}
    </section>
  </div>
}
