import { useState, type FormEvent } from 'react'
import type { AgentSchedule, AgentSession, WorkflowSummary } from './api.js'
import { createSchedule, deleteSchedule, runWorkflow } from './api.js'
import { Alert, Badge, Button, Card, Input, Label, NativeSelect, Textarea } from './components/ui/index.js'

export function ScheduledView({ schedules, sessions, onChanged }: { schedules: AgentSchedule[]; sessions: AgentSession[]; onChanged: () => Promise<void> }) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(undefined)
    const form = new FormData(event.currentTarget)
    try {
      await createSchedule({ name: String(form.get('name')), cron: String(form.get('cron')), prompt: String(form.get('prompt')), timezone: String(form.get('timezone') || 'UTC'), ...(form.get('threadId') ? { threadId: String(form.get('threadId')) } : {}) })
      event.currentTarget.reset(); await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create schedule') }
    finally { setBusy(false) }
  }
  return <div className="automation-grid"><Card className="automation-form"><p className="eyebrow">MASTRA SCHEDULE</p><h2>Schedule agent work</h2><p>Schedules persist in the daemon and fire into a durable session after restarts.</p><form onSubmit={(event) => void submit(event)}><Label>Name<Input name="name" required placeholder="Morning operations brief" /></Label><div className="form-grid"><Label>Cron<Input name="cron" required placeholder="0 9 * * 1-5" /></Label><Label>Timezone<Input name="timezone" defaultValue="UTC" /></Label></div><Label>Session<NativeSelect name="threadId"><option value="">Create an unbound run</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</NativeSelect></Label><Label>Prompt<Textarea name="prompt" required placeholder="Review new signals and summarize changes requiring attention." /></Label>{error && <Alert className="error">{error}</Alert>}<Button className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create schedule'}</Button></form></Card><section><div className="section-heading"><div><p className="eyebrow">DURABLE TRIGGERS</p><h2>Scheduled</h2></div><Badge>{schedules.length}</Badge></div><div className="schedule-list">{schedules.length ? schedules.map((schedule) => <Card key={schedule.id}><div><strong>{schedule.name ?? 'Agent schedule'}</strong><code>{schedule.cron} · {schedule.timezone ?? 'UTC'}</code><p>{schedule.prompt}</p><small>Next run {new Date(schedule.nextFireAt).toLocaleString()}</small></div><div><Badge>{schedule.status}</Badge><Button variant="ghost" onClick={() => void deleteSchedule(schedule.id).then(onChanged)}>Delete</Button></div></Card>) : <Card className="empty-integration"><span>◷</span><div><h3>No schedules yet</h3><p>Create recurring work without operating a separate scheduler.</p></div></Card>}</div></section></div>
}

export function WorkflowsView({ workflows }: { workflows: WorkflowSummary[] }) {
  const [result, setResult] = useState<string>()
  const [error, setError] = useState<string>()
  const run = async (event: FormEvent<HTMLFormElement>, id: string) => {
    event.preventDefault(); setError(undefined); setResult(undefined)
    const form = new FormData(event.currentTarget)
    try {
      const value = await runWorkflow(id, { source: String(form.get('source')), kind: String(form.get('kind')), summary: String(form.get('summary')), payload: {} })
      setResult(JSON.stringify(value, null, 2))
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Workflow failed') }
  }
  return <div className="workflows-view"><section className="surface-intro"><div><p className="eyebrow">MASTRA DURABLE EXECUTION</p><h2>Workflows</h2><p>Inspectable deterministic stages around the agent. Workflows persist state and can be invoked by plugins, schedules, or an operator.</p></div></section><div className="workflow-grid">{workflows.map((workflow) => <Card key={workflow.id}><div className="workflow-icon">⌬</div><Badge>{workflow.trigger}</Badge><h3>{workflow.name}</h3><p>{workflow.description}</p>{workflow.id === 'signal-intake' && <form onSubmit={(event) => void run(event, workflow.id)}><div className="form-grid"><Label>Source<Input name="source" required defaultValue="manual" /></Label><Label>Kind<Input name="kind" required defaultValue="test" /></Label></div><Label>Summary<Input name="summary" required placeholder="A test event arrived" /></Label><Button className="primary">Run workflow</Button></form>}</Card>)}</div>{error && <Alert className="error">{error}</Alert>}{result && <Card className="workflow-result"><p className="eyebrow">RUN RESULT</p><pre>{result}</pre></Card>}</div>
}
