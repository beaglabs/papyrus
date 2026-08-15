import { Check, Clock3, FileSearch, RefreshCw, ShieldAlert, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Item {
  id: string
  filename: string
  sizeBytes: number
  state: string
  suggestedClassification: string
  approvedClassification?: string
  findings: string[]
  tags: string[]
  processing?: { state: string; extractionMethod?: string; errorMessage?: string }
  security?: { verdict: string; matches: string[]; evidence: string[] }
  recordsScheduleId?: string
}
interface Schedule {
  id: string
  code: string
  title: string
}

export function IntakePanel({ projectId }: { projectId?: string }) {
  const { apiFetch } = useAuth()
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const input = useRef<HTMLInputElement>(null)
  const load = useCallback(() => {
    void apiFetch('/api/intake')
      .then((r) => r.json())
      .then((data: { items: Item[] }) => setItems(data.items))
  }, [apiFetch])
  useEffect(() => {
    void apiFetch('/api/intake')
      .then((r) => r.json())
      .then((data: { items: Item[] }) => setItems(data.items))
    void apiFetch('/api/records')
      .then((r) => r.json())
      .then((data: { schedules: Schedule[] }) => setSchedules(data.schedules))
  }, [apiFetch])
  async function upload(file: File) {
    setBusy(true)
    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
      reader.readAsDataURL(file)
    })
    await apiFetch('/api/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, filename: file.name, mediaType: file.type, contentBase64 }),
    })
    setBusy(false)
    load()
  }
  async function decide(item: Item, decision: 'release' | 'reject') {
    if (decision === 'release' && !item.recordsScheduleId && schedules[0]) {
      await apiFetch('/api/records/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intakeItemId: item.id, scheduleId: schedules[0].id }),
      })
    }
    await apiFetch('/api/intake/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: item.id,
        decision,
        classification: item.suggestedClassification,
        tags: item.tags,
      }),
    })
    load()
  }
  async function retry(item: Item) {
    await apiFetch('/api/intake/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id }),
    })
    load()
  }
  function uploadSelected(files: FileList | null) {
    for (const file of Array.from(files ?? [])) void upload(file)
  }
  return (
    <div className="intake-panel">
      <header>
        <div>
          <span>CONTROLLED INTAKE</span>
          <h1>Review before release</h1>
          <p>
            Files remain outside the agent workzone until processing and authorized human review are
            complete.
          </p>
        </div>
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>
          <Upload size={16} />
          {busy ? 'Staging…' : 'Add files'}
        </button>
        <input
          ref={input}
          hidden
          type="file"
          multiple
          accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.csv,.json,.png,.jpg,.jpeg,.tif,.tiff"
          onChange={(e) => uploadSelected(e.target.files)}
        />
      </header>
      <section className="intake-list">
        {items.length === 0 ? (
          <div className="intake-empty">
            <FileSearch size={44} />
            <h2>No staged material</h2>
            <p>
              PDFs and connector content will appear here for processing, labeling, and release.
            </p>
          </div>
        ) : (
          items.map((item) => (
            <article key={item.id}>
              <div className="intake-file">
                <FileSearch size={22} />
                <div>
                  <strong>{item.filename}</strong>
                  <span>
                    {Math.ceil(item.sizeBytes / 1024)} KB · {item.state}
                  </span>
                  <span className={`security-chip ${item.security?.verdict ?? 'checking'}`}>
                    <ShieldAlert size={12} /> Security: {item.security?.verdict ?? 'checking'}
                  </span>
                  <span className="records-chip">
                    Records: {item.recordsScheduleId ? 'assigned' : 'assign on release'}
                  </span>
                  <span className={`processing-chip ${item.processing?.state ?? 'queued'}`}>
                    <Clock3 size={12} />
                    {item.processing?.state ?? 'queued'}
                    {item.processing?.extractionMethod
                      ? ` · ${item.processing.extractionMethod}`
                      : ''}
                  </span>
                  {item.processing?.errorMessage && <span>{item.processing.errorMessage}</span>}
                </div>
              </div>
              <div className="intake-findings">
                <b>{item.approvedClassification ?? item.suggestedClassification}</b>
                {item.findings.length ? (
                  item.findings.map((f) => (
                    <span key={f}>
                      <ShieldAlert size={13} />
                      {f}
                    </span>
                  ))
                ) : (
                  <span>No sensitive marking detected</span>
                )}
              </div>
              {item.state === 'staging' && (
                <div className="intake-actions">
                  {item.processing?.state === 'complete' && item.security?.verdict === 'passed' ? (
                    <button type="button" onClick={() => void decide(item, 'release')}>
                      <Check size={14} />
                      Release
                    </button>
                  ) : (
                    <button type="button" onClick={() => void retry(item)}>
                      <RefreshCw size={14} />
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    className="reject"
                    onClick={() => void decide(item, 'reject')}
                  >
                    <X size={14} />
                    Reject
                  </button>
                </div>
              )}
            </article>
          ))
        )}
      </section>
    </div>
  )
}
