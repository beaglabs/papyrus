import { Bot } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Settings {
  configured: boolean
  baseUrl: string
  model: string
  updatedAt?: string
}

export function ModelRuntimeAdmin() {
  const { apiFetch } = useAuth()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [message, setMessage] = useState('')
  const load = useCallback(() => {
    void apiFetch('/api/admin/model-runtime')
      .then((response) => response.json())
      .then((data: { settings: Settings; canManage: boolean }) => {
        setSettings(data.settings)
        setCanManage(data.canManage)
      })
  }, [apiFetch])
  useEffect(() => load(), [load])
  if (!settings) return <div className="workspace-section-placeholder">Loading model runtime…</div>
  async function save() {
    if (!settings) return
    setMessage('')
    const response = await apiFetch('/api/admin/model-runtime', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: settings.baseUrl }),
    })
    const data = (await response.json()) as { settings?: Settings; error?: string }
    if (!response.ok || !data.settings) {
      setMessage(data.error ?? 'Unable to save the model runtime')
      return
    }
    setSettings(data.settings)
    setMessage('Local model runtime saved')
  }
  return (
    <section className="admin-card">
      <header>
        <Bot size={24} />
        <div>
          <span>LOCAL INFERENCE</span>
          <h2>LFM2.5-2.6B runtime</h2>
          <p>
            Papyrus runs LiquidAI/LFM2.5-2.6B locally through its dedicated inference endpoint.
            Configure the endpoint here without editing YAML or environment files.
          </p>
        </div>
      </header>
      <div className="admin-form-grid">
        <label>
          <span>API endpoint</span>
          <input
            type="url"
            placeholder="http://127.0.0.1:11434/v1"
            value={settings.baseUrl}
            disabled={!canManage}
            onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })}
          />
        </label>
        <label>
          <span>Model</span>
          <input value={settings.model} disabled aria-label="Fixed local model" />
        </label>
      </div>
      <footer>
        <span>
          {message ||
            (settings.configured
              ? `Configured${settings.updatedAt ? ` · ${new Date(settings.updatedAt).toLocaleString()}` : ''}`
              : 'Not configured')}
        </span>
        <button
          type="button"
          disabled={!canManage || !settings.baseUrl.trim()}
          onClick={() => void save()}
        >
          Save model runtime
        </button>
      </footer>
    </section>
  )
}
