import { Archive, LockKeyhole, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
interface Schedule {
  id: string
  code: string
  title: string
  retentionMonths?: number
  dispositionAction: string
  permanent: boolean
}
interface Hold {
  id: string
  name: string
  state: string
  rationale: string
}
export function RecordsPanel() {
  const { apiFetch } = useAuth()
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [holds, setHolds] = useState<Hold[]>([])
  const [canManage, setCanManage] = useState(false)
  const load = useCallback(() => {
    void apiFetch('/api/records')
      .then((r) => r.json())
      .then((d: { schedules: Schedule[]; holds: Hold[]; canManage: boolean }) => {
        setSchedules(d.schedules)
        setHolds(d.holds)
        setCanManage(d.canManage)
      })
  }, [apiFetch])
  useEffect(() => load(), [load])
  async function hold() {
    await apiFetch('/api/records/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'CAPE pilot preservation hold',
        rationale: 'Preserve pilot evidence pending program review',
      }),
    })
    load()
  }
  return (
    <div className="catalog-page">
      <header>
        <Archive size={28} />
        <div>
          <span>INFORMATION GOVERNANCE</span>
          <h1>Records</h1>
          <p>
            Versioned schedules, disposition authority, legal holds, and immutable action history.
          </p>
        </div>
      </header>
      {canManage && (
        <div className="connection-actions">
          <button type="button" onClick={() => void hold()}>
            <Plus size={14} /> Create preservation hold
          </button>
        </div>
      )}
      <div className="records-layout">
        <section>
          <h2>Active schedules</h2>
          {schedules.map((s) => (
            <article key={s.id}>
              <b>{s.code}</b>
              <strong>{s.title}</strong>
              <span>
                {s.permanent
                  ? 'Permanent transfer'
                  : `${s.retentionMonths} months · ${s.dispositionAction}`}
              </span>
            </article>
          ))}
        </section>
        <section>
          <h2>Legal holds</h2>
          {holds.length === 0 ? (
            <p>No active holds.</p>
          ) : (
            holds.map((h) => (
              <article key={h.id}>
                <LockKeyhole size={17} />
                <strong>{h.name}</strong>
                <span>
                  {h.state} · {h.rationale}
                </span>
              </article>
            ))
          )}
        </section>
      </div>
    </div>
  )
}
