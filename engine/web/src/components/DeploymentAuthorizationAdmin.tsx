import { Download, ServerCog, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
interface Posture {
  profile: string
  identityStatus: string
  auditForwardingStatus: string
  backupStatus: string
  secretStoreStatus: string
  timeSyncStatus: string
  authorizationStatus: string
  updatedAt: string
}
export function DeploymentAuthorizationAdmin() {
  const { apiFetch } = useAuth()
  const [posture, setPosture] = useState<Posture | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [evidence, setEvidence] = useState('')
  const load = useCallback(() => {
    void apiFetch('/api/admin/deployment-posture')
      .then((r) => r.json())
      .then((d: { posture: Posture; canManage: boolean }) => {
        setPosture(d.posture)
        setCanManage(d.canManage)
      })
  }, [apiFetch])
  useEffect(() => load(), [load])
  if (!posture) return null
  async function save() {
    await apiFetch('/api/admin/deployment-posture', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(posture),
    })
    load()
  }
  async function generate() {
    const r = await apiFetch('/api/admin/authorization-evidence', { method: 'POST' })
    const d = (await r.json()) as { sha256: string }
    setEvidence(d.sha256)
  }
  return (
    <section className="admin-card">
      <header>
        <ServerCog size={24} />
        <div>
          <span>DEPLOYMENT & AUTHORIZATION</span>
          <h2>Operational posture</h2>
          <p>
            Collect customer-tailorable evidence without representing Papyrus as self-authorized.
          </p>
        </div>
      </header>
      <div className="authorization-warning">
        <ShieldAlert size={18} />
        <b>NOT AUTHORIZED</b>
        <span>Only the responsible Government Authorizing Official can grant authorization.</span>
      </div>
      <div className="admin-form-grid">
        <label>
          <span>Deployment profile</span>
          <select
            value={posture.profile}
            disabled={!canManage}
            onChange={(e) => setPosture({ ...posture, profile: e.target.value })}
          >
            <option value="local-development">Local development</option>
            <option value="nipr-il5-pilot">NIPRNet / IL5 pilot</option>
            <option value="future-classified">Future classified profile</option>
          </select>
        </label>
        {(
          [
            'identityStatus',
            'auditForwardingStatus',
            'backupStatus',
            'secretStoreStatus',
            'timeSyncStatus',
          ] as const
        ).map((key) => (
          <label key={key}>
            <span>
              {key
                .replace(/Status$/, '')
                .replace(/[A-Z]/g, (m) => ` ${m}`)
                .trim()}
            </span>
            <select
              value={posture[key]}
              disabled={!canManage}
              onChange={(e) => setPosture({ ...posture, [key]: e.target.value })}
            >
              <option value="unverified">Unverified</option>
              <option value="configured">Configured</option>
              <option value="inherited">Inherited</option>
              <option value="customer-owned">Customer-owned</option>
            </select>
          </label>
        ))}
      </div>
      <footer>
        <button type="button" disabled={!canManage} onClick={() => void save()}>
          Save posture
        </button>
        <button type="button" disabled={!canManage} onClick={() => void generate()}>
          <Download size={14} /> Generate evidence
        </button>
      </footer>
      {evidence && <small>Evidence SHA-256: {evidence}</small>}
    </section>
  )
}
