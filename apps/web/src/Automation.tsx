import { useState, type FormEvent } from 'react'
import type { AgentSchedule, AgentSession } from './api.js'
import { createSchedule, deleteSchedule } from './api.js'
import { Alert, Badge, Button, Card, Combobox, Input, Label, NativeSelect, Textarea } from './components/ui/index.js'

const SCHEDULE_OPTIONS = [
  { value: '0 * * * *', label: 'Every hour', detail: 'At minute 0' },
  { value: '0 */4 * * *', label: 'Every 4 hours', detail: '00:00 · 04:00 · 08:00 · …' },
  { value: '0 8 * * *', label: 'Every day at 8:00 AM', detail: 'Daily' },
  { value: '0 9 * * *', label: 'Every day at 9:00 AM', detail: 'Daily' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 9:00 AM', detail: 'Monday–Friday' },
  { value: '0 15 * * 1-5', label: 'Weekdays at 3:00 PM', detail: 'Monday–Friday' },
  { value: '0 9 * * 1', label: 'Monday at 9:00 AM', detail: 'Weekly' },
  { value: '0 9 1 * *', label: 'First day of month at 9:00 AM', detail: 'Monthly' },
]

const TIMEZONE_OPTIONS = [
  { value: 'UTC', label: 'UTC', detail: 'Coordinated Universal Time' },
  { value: 'America/New_York', label: 'Eastern Time', detail: 'America/New_York' },
  { value: 'America/Chicago', label: 'Central Time', detail: 'America/Chicago' },
  { value: 'America/Denver', label: 'Mountain Time', detail: 'America/Denver' },
  { value: 'America/Los_Angeles', label: 'Pacific Time', detail: 'America/Los_Angeles' },
  { value: 'America/Anchorage', label: 'Alaska Time', detail: 'America/Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time', detail: 'Pacific/Honolulu' },
]

function scheduleLabel(cron: string): string {
  return SCHEDULE_OPTIONS.find((option) => option.value === cron)?.label ?? cron
}

export function ScheduledView({ schedules, sessions, onChanged }: { schedules: AgentSchedule[]; sessions: AgentSession[]; onChanged: () => Promise<void> }) {
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [timezone, setTimezone] = useState('UTC')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError(undefined)
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const threadId = String(form.get('threadId') ?? '').trim()
      await createSchedule({ name: String(form.get('name')), cron, prompt: String(form.get('prompt')), timezone, threadId })
      formElement.reset()
      setCron('0 9 * * 1-5')
      setTimezone('UTC')
      await onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create schedule') }
    finally { setBusy(false) }
  }
  return <div className="automation-grid"><Card className="automation-form"><p className="eyebrow">MASTRA SCHEDULE</p><h2>Schedule agent work</h2><p>Choose a human-readable cadence. Papyrus stores the equivalent durable schedule internally.</p><form onSubmit={(event) => void submit(event)}><Label>Name<Input name="name" required placeholder="Morning operations brief" /></Label><div className="form-grid"><Label>When<Combobox value={cron} options={SCHEDULE_OPTIONS} placeholder="Choose a schedule…" onValueChange={setCron} /></Label><Label>Timezone<Combobox value={timezone} options={TIMEZONE_OPTIONS} placeholder="Choose a timezone…" onValueChange={setTimezone} /></Label></div><Label>Session<NativeSelect name="threadId" required defaultValue=""><option value="" disabled>{sessions.length ? 'Choose a session…' : 'Create a session first'}</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}</NativeSelect><small>Scheduled work stays bound to this session so Mastra can preserve thread context and Papyrus resource ownership.</small></Label><Label>Prompt<Textarea name="prompt" required placeholder="Review new signals and summarize changes requiring attention." /></Label>{error && <Alert className="error">{error}</Alert>}<Button className="primary" disabled={busy || sessions.length === 0}>{sessions.length === 0 ? 'Create a session first' : busy ? 'Creating…' : 'Create schedule'}</Button></form></Card><section><div className="section-heading"><div><p className="eyebrow">DURABLE TRIGGERS</p><h2>Scheduled</h2></div><Badge>{schedules.length}</Badge></div><div className="schedule-list">{schedules.length ? schedules.map((schedule) => <Card key={schedule.id}><div><strong>{schedule.name ?? 'Agent schedule'}</strong><code>{scheduleLabel(schedule.cron)} · {schedule.timezone ?? 'UTC'}</code><p>{schedule.prompt}</p><small>Next run {new Date(schedule.nextFireAt).toLocaleString()}</small></div><div><Badge>{schedule.status}</Badge><Button variant="ghost" onClick={() => void deleteSchedule(schedule.id).then(onChanged)}>Delete</Button></div></Card>) : <Card className="empty-integration"><span>◷</span><div><h3>No schedules yet</h3><p>Create recurring work without operating a separate scheduler.</p></div></Card>}</div></section></div>
}
