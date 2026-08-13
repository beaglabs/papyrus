import { createHash, randomUUID } from 'node:crypto'
import { getDb } from './database.js'

export type IntakeState = 'quarantine' | 'staging' | 'released' | 'rejected'
export interface IntakeItem { id: string; filename: string; mediaType: string; sizeBytes: number; sha256: string; state: IntakeState; suggestedClassification: string; approvedClassification?: string; tags: string[]; findings: string[]; submittedBy: string; submittedAt: string; reviewedBy?: string; reviewedAt?: string }

function map(row: Record<string, unknown>): IntakeItem {
  return { id: String(row.id), filename: String(row.filename), mediaType: String(row.media_type), sizeBytes: Number(row.size_bytes), sha256: String(row.sha256), state: row.state as IntakeState, suggestedClassification: String(row.suggested_classification), approvedClassification: row.approved_classification ? String(row.approved_classification) : undefined, tags: JSON.parse(String(row.tags)), findings: JSON.parse(String(row.findings)), submittedBy: String(row.submitted_by), submittedAt: String(row.submitted_at), reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined, reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined }
}

export function stageIntake(input: { organizationId: string; projectId?: string; filename: string; mediaType: string; contentBase64: string; submittedBy: string }): IntakeItem {
  const bytes = Buffer.from(input.contentBase64, 'base64')
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) throw new Error('Intake item must be between 1 byte and 25 MB')
  const text = bytes.toString('utf8').slice(0, 200_000)
  const findings = [/(CUI|CONTROLLED UNCLASSIFIED)/i.test(text) && 'CUI marking detected', /(SSN|social security|date of birth)/i.test(text) && 'Potential PII detected', /(FOUO)/i.test(text) && 'Legacy FOUO marking detected'].filter(Boolean) as string[]
  const suggested = findings.some((f) => /CUI|PII/.test(f)) ? 'CUI' : 'UNCLASSIFIED'
  const id = `intake-${randomUUID()}`; const now = new Date().toISOString(); const sha256 = createHash('sha256').update(bytes).digest('hex')
  getDb().prepare(`INSERT INTO intake_items (id, organization_id, project_id, filename, media_type, size_bytes, sha256, content_base64, state, suggested_classification, tags, findings, submitted_by, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?)`).run(id, input.organizationId, input.projectId ?? null, input.filename, input.mediaType, bytes.length, sha256, input.contentBase64, suggested, JSON.stringify([]), JSON.stringify(findings), input.submittedBy, now)
  return { id, filename: input.filename, mediaType: input.mediaType, sizeBytes: bytes.length, sha256, state: 'staging', suggestedClassification: suggested, tags: [], findings, submittedBy: input.submittedBy, submittedAt: now }
}

export function listIntake(organizationId: string): IntakeItem[] { return (getDb().prepare('SELECT * FROM intake_items WHERE organization_id = ? ORDER BY submitted_at DESC').all(organizationId) as Record<string, unknown>[]).map(map) }

export function decideIntake(id: string, input: { decision: 'release' | 'reject'; classification: string; tags: string[]; rationale?: string; reviewedBy: string }): IntakeItem {
  const now = new Date().toISOString(); const state = input.decision === 'release' ? 'released' : 'rejected'
  getDb().prepare('UPDATE intake_items SET state = ?, approved_classification = ?, tags = ?, reviewed_by = ?, reviewed_at = ?, decision_rationale = ? WHERE id = ? AND state = \'staging\'').run(state, input.classification, JSON.stringify(input.tags), input.reviewedBy, now, input.rationale ?? null, id)
  const row = getDb().prepare('SELECT * FROM intake_items WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) throw new Error('Intake item not found')
  return map(row)
}
