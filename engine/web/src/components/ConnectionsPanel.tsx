import { Cable, CheckCircle2, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Connection {
  id: string
  name: string
  systemKey: string
  adapterKind: string
  lifecycleState: string
  mode: string
  credentialRef?: string
  lastTestStatus?: string
}
export function ConnectionsPanel() {
  const { apiFetch } = useAuth()
  const [connections, setConnections] = useState<Connection[]>([])
  const [canManage, setCanManage] = useState(false)
  const load = useCallback(() => {
    void apiFetch('/api/cape/connections')
      .then((r) => r.json())
      .then((d: { connections: Connection[]; canManage: boolean }) => {
        setConnections(d.connections)
        setCanManage(d.canManage)
      })
  }, [apiFetch])
  useEffect(() => load(), [load])
  async function create(systemKey: string) {
    await apiFetch('/api/cape/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: systemKey.toUpperCase(),
        systemKey,
        adapterKind: systemKey === 'generic-file' ? 'managed-file' : 'api',
        mode: 'simulated',
        credentialRef: `secret://cape/${systemKey}`,
      }),
    })
    load()
  }
  async function test(id: string) {
    await apiFetch('/api/cape/connections/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    load()
  }
  return (
    <div className="catalog-page">
      <header>
        <Cable size={28} />
        <div>
          <span>AUTHORIZED ADAPTER BOUNDARIES</span>
          <h1>CAPE connections</h1>
          <p>
            Configure scopes, opaque credential references, mappings, approvals, and health without
            exposing secrets.
          </p>
        </div>
      </header>
      {canManage && (
        <div className="connection-actions">
          {['dai', 'dcpds', 'icompass', 'diss', 'generic-file'].map((key) => (
            <button type="button" key={key} onClick={() => void create(key)}>
              <Plus size={14} /> {key}
            </button>
          ))}
        </div>
      )}
      <div className="catalog-list">
        {connections.length === 0 ? (
          <article>
            <div>
              <h2>No connections configured</h2>
              <p>Add a simulated adapter to validate mappings and approvals safely.</p>
            </div>
            <b>EMPTY</b>
          </article>
        ) : (
          connections.map((c) => (
            <article key={c.id}>
              <div>
                <h2>{c.name}</h2>
                <p>{c.adapterKind} · credential reference protected</p>
              </div>
              <span>
                <CheckCircle2 size={14} /> {c.mode} · {c.lifecycleState}
              </span>
              <button type="button" onClick={() => void test(c.id)} disabled={!canManage}>
                <RefreshCw size={14} /> Test
              </button>
            </article>
          ))
        )}
      </div>
    </div>
  )
}
