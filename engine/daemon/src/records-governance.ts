import { randomUUID } from 'node:crypto'
import { getDb } from './database.js'
export interface RecordsSchedule {
  id: string
  code: string
  title: string
  retentionMonths?: number
  dispositionAction: string
  permanent: boolean
  effectiveAt: string
}
function map(row: Record<string, unknown>): RecordsSchedule {
  return {
    id: String(row.id),
    code: String(row.code),
    title: String(row.title),
    retentionMonths: row.retention_months == null ? undefined : Number(row.retention_months),
    dispositionAction: String(row.disposition_action),
    permanent: Boolean(row.permanent),
    effectiveAt: String(row.effective_at),
  }
}
export function listRecordsSchedules(organizationId: string): RecordsSchedule[] {
  return (
    getDb()
      .prepare('SELECT * FROM records_schedules WHERE organization_id=? AND active=1 ORDER BY code')
      .all(organizationId) as Record<string, unknown>[]
  ).map(map)
}
export function ensureDefaultSchedules(organizationId: string, actor: string): RecordsSchedule[] {
  const now = new Date().toISOString()
  const insert = getDb().prepare(
    'INSERT OR IGNORE INTO records_schedules (id,organization_id,code,title,retention_months,disposition_action,permanent,effective_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
  )
  insert.run(
    `schedule-${organizationId}-grs51`,
    organizationId,
    'GRS 5.1',
    'Common office records',
    36,
    'destroy',
    0,
    '2026-01-01',
    actor,
    now,
  )
  insert.run(
    `schedule-${organizationId}-permanent`,
    organizationId,
    'CAPE-PERM',
    'Permanent CAPE decision record',
    null,
    'transfer',
    1,
    '2026-01-01',
    actor,
    now,
  )
  return listRecordsSchedules(organizationId)
}
export function assignRecordsSchedule(
  organizationId: string,
  intakeItemId: string,
  scheduleId: string,
  actor: string,
) {
  const schedule = getDb()
    .prepare('SELECT id FROM records_schedules WHERE id=? AND organization_id=? AND active=1')
    .get(scheduleId, organizationId)
  if (!schedule) throw new Error('Active records schedule required')
  const changed = getDb()
    .prepare('UPDATE intake_items SET records_schedule_id=? WHERE id=? AND organization_id=?')
    .run(scheduleId, intakeItemId, organizationId)
  if (!changed.changes) throw new Error('Intake item not found')
  getDb()
    .prepare('INSERT INTO records_disposition_history VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(
      `record-event-${randomUUID()}`,
      organizationId,
      'intake',
      intakeItemId,
      scheduleId,
      'schedule-assigned',
      actor,
      null,
      null,
      new Date().toISOString(),
    )
  return { intakeItemId, scheduleId }
}
export function createLegalHold(
  organizationId: string,
  actor: string,
  name: string,
  rationale: string,
) {
  if (rationale.trim().length < 12) throw new Error('A meaningful hold rationale is required')
  const id = `hold-${randomUUID()}`
  const now = new Date().toISOString()
  getDb()
    .prepare(
      "INSERT INTO records_holds (id,organization_id,name,scope_json,state,rationale,created_by,created_at) VALUES (?,?,?,?,'active',?,?,?)",
    )
    .run(
      id,
      organizationId,
      name,
      JSON.stringify({ allReleasedRecords: true }),
      rationale,
      actor,
      now,
    )
  return { id, name, state: 'active', rationale }
}
export function listLegalHolds(organizationId: string) {
  return getDb()
    .prepare(
      'SELECT id,name,state,rationale,created_at AS createdAt FROM records_holds WHERE organization_id=? ORDER BY created_at DESC',
    )
    .all(organizationId)
}
