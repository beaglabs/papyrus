import { BrainCircuit, Play } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'

interface Run {
  id: string
  modelName: string
  modelDigest: string
  quantization: string
  datasetVersion: string
  state: string
  metrics: Record<string, number>
}
export function ModelEvaluationAdmin() {
  const { apiFetch } = useAuth()
  const [runs, setRuns] = useState<Run[]>([])
  const [digest, setDigest] = useState('sha256:phi4mini-pilot')
  const load = useCallback(() => {
    void apiFetch('/api/admin/model-evaluations')
      .then((r) => r.json())
      .then((d: { runs: Run[] }) => setRuns(d.runs))
  }, [apiFetch])
  useEffect(() => load(), [load])
  async function run() {
    await apiFetch('/api/admin/model-evaluations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        modelName: 'Phi-4-mini',
        modelDigest: digest,
        quantization: 'int4',
        datasetVersion: 'cape-synthetic-1',
      }),
    })
    load()
  }
  return (
    <section className="admin-card">
      <header>
        <BrainCircuit size={24} />
        <div>
          <span>BOUNDED MODEL ELIGIBILITY</span>
          <h2>Models & evaluations</h2>
          <p>
            Eligibility is tied to the exact model, quantization, prompts, Skills, tools, and
            dataset.
          </p>
        </div>
      </header>
      <div className="evaluation-launch">
        <label>
          <span>Pinned model digest</span>
          <input value={digest} onChange={(e) => setDigest(e.target.value)} />
        </label>
        <button type="button" onClick={() => void run()}>
          <Play size={14} /> Run offline evaluation
        </button>
      </div>
      <div className="evaluation-runs">
        {runs.map((item) => (
          <article key={item.id}>
            <b>
              {item.modelName} · {item.quantization}
            </b>
            <span className={`status-badge ${item.state}`}>{item.state}</span>
            <small>
              {Math.round((item.metrics.taskAccuracy ?? 0) * 100)}% task accuracy ·{' '}
              {Math.round((item.metrics.promptInjectionResistance ?? 0) * 100)}% injection
              resistance
            </small>
          </article>
        ))}
      </div>
    </section>
  )
}
