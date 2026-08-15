import { Check, Clock3, FileSearch, RefreshCw, ShieldAlert, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Item {
  id: string
  filename: string
  mediaType: string
  sizeBytes: number
  state: string
  suggestedClassification: string
  approvedClassification?: string
  findings: string[]
  tags: string[]
  processing?: { state: string; extractionMethod?: string; errorMessage?: string }
  security?: {
    verdict: string
    matches: string[]
    evidence: string[]
    clamavVersion?: string
    yaraxVersion?: string
    rulePackVersion?: string
  }
  recordsScheduleId?: string
}
interface Schedule {
  id: string
  code: string
  title: string
}
interface Preview {
  filename: string
  mediaType: string
  contentBase64: string
  extractedText?: string
}

export function IntakePanel({ projectId }: { projectId?: string }) {
  const { apiFetch } = useAuth()
  const [items, setItems] = useState<Item[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [classification, setClassification] = useState('UNCLASSIFIED')
  const [tags, setTags] = useState('')
  const [scheduleId, setScheduleId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const selected = items.find((item) => item.id === selectedId)

  const load = useCallback(async () => {
    const [intakeResponse, recordsResponse] = await Promise.all([
      apiFetch('/api/intake'),
      apiFetch('/api/records'),
    ])
    const intake = (await intakeResponse.json()) as { items: Item[] }
    const records = (await recordsResponse.json()) as { schedules: Schedule[] }
    setItems(intake.items)
    setSchedules(records.schedules)
    setSelectedId((current) =>
      current && intake.items.some((item) => item.id === current)
        ? current
        : (intake.items[0]?.id ?? ''),
    )
  }, [apiFetch])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!selected) {
      setPreview(null)
      return
    }
    setClassification(selected.approvedClassification ?? selected.suggestedClassification)
    setTags(selected.tags.join(', '))
    setScheduleId(selected.recordsScheduleId ?? '')
    void apiFetch(`/api/intake/${encodeURIComponent(selected.id)}/preview`).then(
      async (response) => {
        if (response.ok) setPreview((await response.json()) as Preview)
      },
    )
  }, [apiFetch, selected])

  async function upload(file: File) {
    setBusy(true)
    setError('')
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onerror = () => reject(reader.error)
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.readAsDataURL(file)
      })
      const response = await apiFetch('/api/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          filename: file.name,
          mediaType: file.type,
          contentBase64,
        }),
      })
      const data = (await response.json()) as Item & { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Upload failed')
      await load()
      setSelectedId(data.id)
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }
  async function saveReview(): Promise<boolean> {
    if (!selected) return false
    setBusy(true)
    setError('')
    try {
      const metadata = await apiFetch(`/api/intake/${encodeURIComponent(selected.id)}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classification,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
      })
      if (!metadata.ok) {
        const data = (await metadata.json()) as { error?: string }
        throw new Error(data.error ?? 'Metadata update failed')
      }
      if (scheduleId && scheduleId !== selected.recordsScheduleId) {
        const records = await apiFetch('/api/records/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intakeItemId: selected.id, scheduleId }),
        })
        if (!records.ok) {
          const data = (await records.json()) as { error?: string }
          throw new Error(data.error ?? 'Schedule assignment failed')
        }
      }
      await load()
      return true
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Review update failed')
    } finally {
      setBusy(false)
    }
    return false
  }
  async function decide(decision: 'release' | 'reject') {
    if (!selected) return
    if (!(await saveReview())) return
    setBusy(true)
    try {
      const response = await apiFetch('/api/intake/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selected.id,
          decision,
          classification,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        }),
      })
      const data = (await response.json()) as { error?: string }
      if (!response.ok) throw new Error(data.error ?? 'Decision failed')
      await load()
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Decision failed')
    } finally {
      setBusy(false)
    }
  }
  async function retry() {
    if (!selected) return
    setBusy(true)
    await apiFetch('/api/intake/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id }),
    })
    await apiFetch('/api/intake/security/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selected.id }),
    })
    await load()
    setBusy(false)
  }
  const releasable =
    selected?.processing?.state === 'complete' &&
    selected.security?.verdict === 'passed' &&
    Boolean(scheduleId) &&
    Boolean(classification)

  return (
    <div className="intake-panel staging-workspace">
      <header>
        <div>
          <span>CONTROLLED INTAKE</span>
          <h1>Review before release</h1>
          <p>Files remain outside every agent workzone until all release gates pass.</p>
        </div>
        <button type="button" onClick={() => input.current?.click()} disabled={busy}>
          <Upload size={16} />
          {busy ? 'Working…' : 'Add files'}
        </button>
        <input
          ref={input}
          hidden
          type="file"
          multiple
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? [])) void upload(file)
          }}
        />
      </header>
      <section className="staging-flow" aria-label="Staging release workflow">
        <div className="active">
          <span>1</span>
          <b>Received</b>
          <small>Files and connectors</small>
        </div>
        <div>
          <span>2</span>
          <b>Security checks</b>
          <small>ClamAV + YARA-X</small>
        </div>
        <div>
          <span>3</span>
          <b>Label & tag</b>
          <small>Suggested + human</small>
        </div>
        <div>
          <span>4</span>
          <b>Human review</b>
          <small>Role authorized</small>
        </div>
        <div>
          <span>5</span>
          <b>Release</b>
          <small>Enter workzone</small>
        </div>
      </section>
      {items.length === 0 ? (
        <div className="intake-empty">
          <FileSearch size={44} />
          <h2>Staging is clear</h2>
          <p>Add a PDF, office file, image, or exported connector record to begin.</p>
        </div>
      ) : (
        <div className="staging-review">
          <aside className="staging-queue">
            <header>
              <b>Queue</b>
              <span>{items.filter((item) => item.state === 'staging').length} pending</span>
            </header>
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                className={item.id === selectedId ? 'active' : ''}
                onClick={() => setSelectedId(item.id)}
              >
                <FileSearch size={17} />
                <span>
                  <b>{item.filename}</b>
                  <small>
                    {Math.ceil(item.sizeBytes / 1024)} KB · {item.state}
                  </small>
                </span>
                <i className={`queue-verdict ${item.security?.verdict ?? 'checking'}`} />
              </button>
            ))}
          </aside>
          <section className="staging-preview">
            <header>
              <b>{selected?.filename}</b>
              <span>
                {selected?.processing?.extractionMethod ?? selected?.processing?.state ?? 'queued'}
              </span>
            </header>
            <div>
              {preview?.mediaType === 'application/pdf' ? (
                <iframe
                  title={preview.filename}
                  src={`data:${preview.mediaType};base64,${preview.contentBase64}`}
                />
              ) : preview?.mediaType.startsWith('image/') ? (
                <img
                  alt={preview.filename}
                  src={`data:${preview.mediaType};base64,${preview.contentBase64}`}
                />
              ) : preview?.extractedText ? (
                <pre>{preview.extractedText}</pre>
              ) : (
                <div className="preview-unavailable">
                  <FileSearch size={36} />
                  <p>Preview will appear after document processing completes.</p>
                </div>
              )}
            </div>
          </section>
          <aside className="staging-review-form">
            <header>
              <b>Release review</b>
              <span>{selected?.state}</span>
            </header>
            <label>
              Classification
              <select
                value={classification}
                onChange={(event) => setClassification(event.target.value)}
              >
                <option>UNCLASSIFIED</option>
                <option>CUI</option>
                <option value="CUI//SP-PRVCY">{'CUI//SP-PRVCY'}</option>
                <option value="CUI//SP-PROPIN">{'CUI//SP-PROPIN'}</option>
              </select>
            </label>
            <label>
              Tags
              <input
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="budget, acquisition, FY27"
              />
            </label>
            <label>
              Records schedule
              <select value={scheduleId} onChange={(event) => setScheduleId(event.target.value)}>
                <option value="">Select a schedule</option>
                {schedules.map((schedule) => (
                  <option value={schedule.id} key={schedule.id}>
                    {schedule.code} · {schedule.title}
                  </option>
                ))}
              </select>
            </label>
            <section className="gate-list">
              <div className={selected?.processing?.state === 'complete' ? 'pass' : 'hold'}>
                <Clock3 size={14} />
                <span>
                  <b>Document processing</b>
                  <small>
                    {selected?.processing?.state ?? 'queued'}
                    {selected?.processing?.errorMessage
                      ? ` · ${selected.processing.errorMessage}`
                      : ''}
                  </small>
                </span>
              </div>
              <div className={selected?.security?.verdict === 'passed' ? 'pass' : 'hold'}>
                <ShieldAlert size={14} />
                <span>
                  <b>Security</b>
                  <small>
                    {selected?.security?.verdict ?? 'checking'} · ClamAV{' '}
                    {selected?.security?.clamavVersion ?? 'pending'} · YARA-X{' '}
                    {selected?.security?.yaraxVersion ?? 'pending'}
                  </small>
                </span>
              </div>
              <div className={scheduleId ? 'pass' : 'hold'}>
                <FileSearch size={14} />
                <span>
                  <b>Records</b>
                  <small>{scheduleId ? 'Schedule selected' : 'Schedule required'}</small>
                </span>
              </div>
            </section>
            {selected?.findings.length || selected?.security?.evidence.length ? (
              <details>
                <summary>Findings and scan evidence</summary>
                {selected.findings.map((finding) => (
                  <p key={finding}>{finding}</p>
                ))}
                {selected.security?.evidence.map((evidence) => (
                  <p key={evidence}>{evidence}</p>
                ))}
              </details>
            ) : null}
            {error && <div className="workzone-error">{error}</div>}
            <footer>
              <button type="button" onClick={() => void retry()} disabled={busy}>
                <RefreshCw size={14} /> Reprocess
              </button>
              <button type="button" onClick={() => void saveReview()} disabled={busy}>
                Save review
              </button>
              <button
                type="button"
                className="reject"
                onClick={() => void decide('reject')}
                disabled={busy}
              >
                <X size={14} /> Reject
              </button>
              <button
                type="button"
                className="release"
                onClick={() => void decide('release')}
                disabled={!releasable || busy}
              >
                <Check size={14} /> Release
              </button>
            </footer>
          </aside>
        </div>
      )}
    </div>
  )
}
