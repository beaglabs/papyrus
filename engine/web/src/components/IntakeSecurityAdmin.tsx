import { ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Settings {
  clamavRequired: boolean
  yaraxRequired: boolean
  maxDefinitionAgeHours: number
  archiveMaxDepth: number
  archiveMaxMembers: number
  scanTimeoutSeconds: number
  activeRulePackVersion: string
}

export function IntakeSecurityAdmin() {
  const { apiFetch } = useAuth()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [canManage, setCanManage] = useState(false)
  const load = useCallback(() => {
    void apiFetch('/api/admin/intake-security')
      .then((response) => response.json())
      .then((data: { settings: Settings; canManage: boolean }) => {
        setSettings(data.settings)
        setCanManage(data.canManage)
      })
  }, [apiFetch])
  useEffect(() => load(), [load])
  if (!settings)
    return <div className="workspace-section-placeholder">Loading intake security…</div>
  async function save() {
    await apiFetch('/api/admin/intake-security', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    load()
  }
  return (
    <section className="admin-card">
      <header>
        <ShieldCheck size={24} />
        <div>
          <span>FAIL-CLOSED GATE</span>
          <h2>Intake security</h2>
          <p>ClamAV and YARA-X policy is enforced before staged material can be released.</p>
        </div>
      </header>
      <div className="admin-form-grid">
        <label>
          <span>ClamAV required</span>
          <input
            type="checkbox"
            checked={settings.clamavRequired}
            disabled={!canManage}
            onChange={(e) => setSettings({ ...settings, clamavRequired: e.target.checked })}
          />
        </label>
        <label>
          <span>YARA-X required</span>
          <input
            type="checkbox"
            checked={settings.yaraxRequired}
            disabled={!canManage}
            onChange={(e) => setSettings({ ...settings, yaraxRequired: e.target.checked })}
          />
        </label>
        <label>
          <span>Definition age (hours)</span>
          <input
            type="number"
            value={settings.maxDefinitionAgeHours}
            disabled={!canManage}
            onChange={(e) =>
              setSettings({ ...settings, maxDefinitionAgeHours: Number(e.target.value) })
            }
          />
        </label>
        <label>
          <span>Archive depth</span>
          <input
            type="number"
            value={settings.archiveMaxDepth}
            disabled={!canManage}
            onChange={(e) => setSettings({ ...settings, archiveMaxDepth: Number(e.target.value) })}
          />
        </label>
        <label>
          <span>Archive members</span>
          <input
            type="number"
            value={settings.archiveMaxMembers}
            disabled={!canManage}
            onChange={(e) =>
              setSettings({ ...settings, archiveMaxMembers: Number(e.target.value) })
            }
          />
        </label>
        <label>
          <span>Timeout (seconds)</span>
          <input
            type="number"
            value={settings.scanTimeoutSeconds}
            disabled={!canManage}
            onChange={(e) =>
              setSettings({ ...settings, scanTimeoutSeconds: Number(e.target.value) })
            }
          />
        </label>
      </div>
      <footer>
        <span>Rule pack: {settings.activeRulePackVersion}</span>
        <button type="button" disabled={!canManage} onClick={save}>
          Save security policy
        </button>
      </footer>
    </section>
  )
}
