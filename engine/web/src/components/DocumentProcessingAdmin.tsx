import { CheckCircle2, FileScan, Save } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Settings {
  maxFileSizeBytes: number
  ocrEnabled: boolean
  ocrLanguages: string[]
  nativeTextMinimum: number
  jobTimeoutSeconds: number
  retainIntermediates: boolean
  updatedBy: string
  updatedAt: string
}

export function DocumentProcessingAdmin() {
  const { apiFetch } = useAuth()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [canManage, setCanManage] = useState(false)
  const [status, setStatus] = useState('')
  const load = useCallback(async () => {
    const response = await apiFetch('/api/admin/document-processing')
    if (!response.ok) return setStatus('Unable to load document-processing settings.')
    const data = (await response.json()) as { settings: Settings; canManage: boolean }
    setSettings(data.settings)
    setCanManage(data.canManage)
  }, [apiFetch])
  useEffect(() => {
    void load()
  }, [load])
  async function save() {
    if (!settings) return
    setStatus('Saving…')
    const response = await apiFetch('/api/admin/document-processing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    })
    if (!response.ok) {
      const body = (await response.json()) as { error?: string }
      setStatus(body.error ?? 'Save failed')
      return
    }
    const body = (await response.json()) as { settings: Settings }
    setSettings(body.settings)
    setStatus('Saved and active')
  }
  if (!settings)
    return (
      <div className="processing-admin">
        <p>{status || 'Loading document processing…'}</p>
      </div>
    )
  return (
    <div className="processing-admin">
      <header>
        <FileScan size={28} />
        <div>
          <span>ADMINISTRATION</span>
          <h1>Document processing</h1>
          <p>
            Control native extraction and OCR behavior for staged documents. Settings are stored by
            Papyrus—no configuration files required.
          </p>
        </div>
      </header>
      <section className="processing-settings">
        <div className="processing-status">
          <CheckCircle2 size={20} />
          <div>
            <strong>Native extraction ready</strong>
            <span>OCR adapters can be installed without changing the intake contract.</span>
          </div>
        </div>
        <label>
          Maximum file size <span>{Math.round(settings.maxFileSizeBytes / 1024 / 1024)} MB</span>
          <input
            type="range"
            min="1"
            max="250"
            value={Math.round(settings.maxFileSizeBytes / 1024 / 1024)}
            disabled={!canManage}
            onChange={(event) =>
              setSettings({
                ...settings,
                maxFileSizeBytes: Number(event.target.value) * 1024 * 1024,
              })
            }
          />
        </label>
        <label>
          Native text threshold{' '}
          <input
            type="number"
            min="1"
            max="10000"
            value={settings.nativeTextMinimum}
            disabled={!canManage}
            onChange={(event) =>
              setSettings({ ...settings, nativeTextMinimum: Number(event.target.value) })
            }
          />
        </label>
        <label>
          Job timeout (seconds){' '}
          <input
            type="number"
            min="10"
            max="1800"
            value={settings.jobTimeoutSeconds}
            disabled={!canManage}
            onChange={(event) =>
              setSettings({ ...settings, jobTimeoutSeconds: Number(event.target.value) })
            }
          />
        </label>
        <label>
          OCR languages{' '}
          <input
            value={settings.ocrLanguages.join(', ')}
            disabled={!canManage}
            onChange={(event) =>
              setSettings({
                ...settings,
                ocrLanguages: event.target.value.split(',').map((value) => value.trim()),
              })
            }
          />
        </label>
        <label className="processing-check">
          <input
            type="checkbox"
            checked={settings.ocrEnabled}
            disabled={!canManage}
            onChange={(event) => setSettings({ ...settings, ocrEnabled: event.target.checked })}
          />
          Enable OCR adapters
        </label>
        <label className="processing-check">
          <input
            type="checkbox"
            checked={settings.retainIntermediates}
            disabled={!canManage}
            onChange={(event) =>
              setSettings({ ...settings, retainIntermediates: event.target.checked })
            }
          />
          Retain authorized processing derivatives
        </label>
        <footer>
          <p>
            {canManage
              ? status || 'Changes are validated and audited when activated.'
              : 'Administrator access is required to change these settings.'}
          </p>
          {canManage && (
            <button type="button" onClick={() => void save()}>
              <Save size={16} />
              Save settings
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
