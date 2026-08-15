import { createHash, randomUUID } from 'node:crypto'
import { getDb } from './database.js'
import {
  type DocumentProcessingJob,
  enqueueDocumentProcessing,
  getDocumentJob,
  processDocumentJob,
} from './document-processing.js'
import { type IntakeSecurityResult, getSecurityResult, scanIntakeItem } from './intake-security.js'

export type IntakeState = 'quarantine' | 'staging' | 'released' | 'rejected'
export interface IntakeItem {
  id: string
  filename: string
  mediaType: string
  sizeBytes: number
  sha256: string
  state: IntakeState
  suggestedClassification: string
  approvedClassification?: string
  tags: string[]
  findings: string[]
  submittedBy: string
  submittedAt: string
  reviewedBy?: string
  reviewedAt?: string
  processing?: DocumentProcessingJob
  security?: IntakeSecurityResult
  recordsScheduleId?: string
}

function map(row: Record<string, unknown>): IntakeItem {
  const id = String(row.id)
  return {
    id,
    filename: String(row.filename),
    mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    state: row.state as IntakeState,
    suggestedClassification: String(row.suggested_classification),
    approvedClassification: row.approved_classification
      ? String(row.approved_classification)
      : undefined,
    tags: JSON.parse(String(row.tags)),
    findings: JSON.parse(String(row.findings)),
    submittedBy: String(row.submitted_by),
    submittedAt: String(row.submitted_at),
    reviewedBy: row.reviewed_by ? String(row.reviewed_by) : undefined,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : undefined,
    processing: getDocumentJob(id) ?? undefined,
    security: getSecurityResult(id) ?? undefined,
    recordsScheduleId: row.records_schedule_id ? String(row.records_schedule_id) : undefined,
  }
}

export function stageIntake(input: {
  organizationId: string
  projectId?: string
  filename: string
  mediaType: string
  contentBase64: string
  submittedBy: string
}): IntakeItem {
  const bytes = Buffer.from(input.contentBase64, 'base64')
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024)
    throw new Error('Intake item must be between 1 byte and 25 MB')
  const text = bytes.toString('utf8').slice(0, 200_000)
  const findings = [
    /(CUI|CONTROLLED UNCLASSIFIED)/i.test(text) && 'CUI marking detected',
    /(SSN|social security|date of birth)/i.test(text) && 'Potential PII detected',
    /(FOUO)/i.test(text) && 'Legacy FOUO marking detected',
  ].filter(Boolean) as string[]
  const suggested = findings.some((f) => /CUI|PII/.test(f)) ? 'CUI' : 'UNCLASSIFIED'
  const id = `intake-${randomUUID()}`
  const now = new Date().toISOString()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  getDb()
    .prepare(
      `INSERT INTO intake_items (id, organization_id, project_id, filename, media_type, size_bytes, sha256, content_base64, state, suggested_classification, tags, findings, submitted_by, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.organizationId,
      input.projectId ?? null,
      input.filename,
      input.mediaType,
      bytes.length,
      sha256,
      input.contentBase64,
      suggested,
      JSON.stringify([]),
      JSON.stringify(findings),
      input.submittedBy,
      now,
    )
  enqueueDocumentProcessing(input.organizationId, id)
  scanIntakeItem(input.organizationId, id)
  processDocumentJob(id)
  return map(
    getDb().prepare('SELECT * FROM intake_items WHERE id = ?').get(id) as Record<string, unknown>,
  )
}

export function listIntake(organizationId: string): IntakeItem[] {
  return (
    getDb()
      .prepare('SELECT * FROM intake_items WHERE organization_id = ? ORDER BY submitted_at DESC')
      .all(organizationId) as Record<string, unknown>[]
  ).map(map)
}

export function getIntakePreview(organizationId: string, id: string) {
  const item = getDb()
    .prepare(
      'SELECT id,filename,media_type,content_base64 FROM intake_items WHERE id=? AND organization_id=?',
    )
    .get(id, organizationId) as Record<string, unknown> | undefined
  if (!item) throw new Error('Intake item not found')
  const derivative = getDb()
    .prepare(
      "SELECT media_type,content_base64 FROM document_derivatives WHERE intake_item_id=? AND organization_id=? AND kind='text' ORDER BY created_at DESC LIMIT 1",
    )
    .get(id, organizationId) as Record<string, unknown> | undefined
  return {
    id,
    filename: String(item.filename),
    mediaType: String(item.media_type),
    contentBase64: String(item.content_base64),
    extractedText: derivative
      ? Buffer.from(String(derivative.content_base64), 'base64').toString('utf8')
      : undefined,
  }
}

export function updateIntakeMetadata(
  organizationId: string,
  id: string,
  input: { classification: string; tags: string[] },
) {
  const classification = input.classification.trim().toUpperCase()
  if (!['UNCLASSIFIED', 'CUI', 'CUI//SP-PRVCY', 'CUI//SP-PROPIN'].includes(classification))
    throw new Error('Unsupported classification marking')
  const tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 30)
  const changed = getDb()
    .prepare(
      "UPDATE intake_items SET approved_classification=?,tags=? WHERE id=? AND organization_id=? AND state='staging'",
    )
    .run(classification, JSON.stringify(tags), id, organizationId)
  if (!changed.changes) throw new Error('Staged intake item not found')
  return map(
    getDb().prepare('SELECT * FROM intake_items WHERE id=?').get(id) as Record<string, unknown>,
  )
}

export function listReleasedContext(organizationId: string, projectId: string) {
  const rows = getDb()
    .prepare(`
    SELECT i.id, i.filename, i.media_type, i.approved_classification, d.content_base64
    FROM intake_items i
    LEFT JOIN document_derivatives d ON d.id = (
      SELECT latest.id FROM document_derivatives latest
      WHERE latest.intake_item_id=i.id AND latest.organization_id=i.organization_id AND latest.kind='text'
      ORDER BY latest.created_at DESC LIMIT 1
    )
    WHERE i.organization_id=? AND i.project_id=? AND i.state='released'
    ORDER BY i.reviewed_at DESC
  `)
    .all(organizationId, projectId) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: String(row.id),
    title: String(row.filename),
    kind: 'document',
    classification: String(row.approved_classification ?? 'UNCLASSIFIED'),
    mediaType: String(row.media_type),
    text: row.content_base64
      ? Buffer.from(String(row.content_base64), 'base64').toString('utf8').slice(0, 100_000)
      : '',
  }))
}

export function decideIntake(
  id: string,
  organizationId: string,
  input: {
    decision: 'release' | 'reject'
    classification: string
    tags: string[]
    rationale?: string
    reviewedBy: string
  },
): IntakeItem {
  const classification = input.classification.trim().toUpperCase()
  if (!['UNCLASSIFIED', 'CUI', 'CUI//SP-PRVCY', 'CUI//SP-PROPIN'].includes(classification))
    throw new Error('Unsupported classification marking')
  const tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 30)
  const existing = getDb()
    .prepare('SELECT id,state FROM intake_items WHERE id = ? AND organization_id = ?')
    .get(id, organizationId) as { id: string; state: IntakeState } | undefined
  if (!existing) throw new Error('Intake item not found')
  if (existing.state !== 'staging') throw new Error('Only staged intake items can be reviewed')
  const processing = getDocumentJob(id)
  if (input.decision === 'release' && processing?.state !== 'complete')
    throw new Error('Document processing must complete before release')
  const security = getSecurityResult(id)
  if (input.decision === 'release' && security?.verdict !== 'passed')
    throw new Error('Intake security checks must pass before release')
  const record = getDb()
    .prepare('SELECT records_schedule_id FROM intake_items WHERE id=? AND organization_id=?')
    .get(id, organizationId) as Record<string, unknown>
  if (input.decision === 'release' && !record.records_schedule_id)
    throw new Error('A records schedule must be assigned before release')
  const now = new Date().toISOString()
  const state = input.decision === 'release' ? 'released' : 'rejected'
  const changed = getDb()
    .prepare(
      "UPDATE intake_items SET state = ?, approved_classification = ?, tags = ?, reviewed_by = ?, reviewed_at = ?, decision_rationale = ? WHERE id = ? AND organization_id = ? AND state = 'staging'",
    )
    .run(
      state,
      classification,
      JSON.stringify(tags),
      input.reviewedBy,
      now,
      input.rationale ?? null,
      id,
      organizationId,
    )
  if (!changed.changes) throw new Error('The intake item changed before the decision was applied')
  const row = getDb()
    .prepare('SELECT * FROM intake_items WHERE id = ? AND organization_id = ?')
    .get(id, organizationId) as Record<string, unknown> | undefined
  if (!row) throw new Error('Intake item not found')
  if (input.decision === 'release' && row.project_id) {
    getDb()
      .prepare(`INSERT INTO artifact_provenance
      (id,intake_item_id,project_id,artifact_id,sha256,classification,released_by,released_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        `provenance-${randomUUID()}`,
        id,
        String(row.project_id),
        `released-document-${id}`,
        String(row.sha256),
        classification,
        input.reviewedBy,
        now,
      )
  }
  return map(row)
}
