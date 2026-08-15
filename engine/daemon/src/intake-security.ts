import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getDb } from './database.js'

export type SecurityVerdict =
  | 'checking'
  | 'passed'
  | 'review-required'
  | 'blocked'
  | 'engine-unavailable'
  | 'definitions-stale'

export interface IntakeSecurityResult {
  id: string
  intakeItemId: string
  verdict: SecurityVerdict
  matches: string[]
  evidence: string[]
  clamavVersion?: string
  yaraxVersion?: string
  rulePackVersion?: string
  completedAt?: string
}

export interface IntakeSecuritySettings {
  clamavRequired: boolean
  yaraxRequired: boolean
  maxDefinitionAgeHours: number
  archiveMaxDepth: number
  archiveMaxMembers: number
  archiveMaxExpandedBytes: number
  scanTimeoutSeconds: number
  activeRulePackVersion: string
}

const defaults: IntakeSecuritySettings = {
  clamavRequired: true,
  yaraxRequired: true,
  maxDefinitionAgeHours: 72,
  archiveMaxDepth: 3,
  archiveMaxMembers: 250,
  archiveMaxExpandedBytes: 100 * 1024 * 1024,
  scanTimeoutSeconds: 60,
  activeRulePackVersion: 'builtin-1',
}

function map(row: Record<string, unknown>): IntakeSecurityResult {
  return {
    id: String(row.id),
    intakeItemId: String(row.intake_item_id),
    verdict: row.verdict as SecurityVerdict,
    matches: JSON.parse(String(row.matches_json)),
    evidence: JSON.parse(String(row.evidence_json)),
    clamavVersion: row.clamav_version ? String(row.clamav_version) : undefined,
    yaraxVersion: row.yarax_version ? String(row.yarax_version) : undefined,
    rulePackVersion: row.rule_pack_version ? String(row.rule_pack_version) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
  }
}

export function getIntakeSecuritySettings(organizationId: string): IntakeSecuritySettings {
  const row = getDb()
    .prepare('SELECT * FROM intake_security_settings WHERE organization_id = ?')
    .get(organizationId) as Record<string, unknown> | undefined
  if (!row) return defaults
  return {
    clamavRequired: Boolean(row.clamav_required),
    yaraxRequired: Boolean(row.yarax_required),
    maxDefinitionAgeHours: Number(row.max_definition_age_hours),
    archiveMaxDepth: Number(row.archive_max_depth),
    archiveMaxMembers: Number(row.archive_max_members),
    archiveMaxExpandedBytes: Number(row.archive_max_expanded_bytes),
    scanTimeoutSeconds: Number(row.scan_timeout_seconds),
    activeRulePackVersion: String(row.active_rule_pack_version),
  }
}

export function updateIntakeSecuritySettings(
  organizationId: string,
  input: Partial<IntakeSecuritySettings>,
  updatedBy: string,
): IntakeSecuritySettings {
  const next = { ...getIntakeSecuritySettings(organizationId), ...input }
  const now = new Date().toISOString()
  getDb()
    .prepare(`INSERT INTO intake_security_settings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id) DO UPDATE SET clamav_required=excluded.clamav_required,
      yarax_required=excluded.yarax_required,max_definition_age_hours=excluded.max_definition_age_hours,
      archive_max_depth=excluded.archive_max_depth,archive_max_members=excluded.archive_max_members,
      archive_max_expanded_bytes=excluded.archive_max_expanded_bytes,scan_timeout_seconds=excluded.scan_timeout_seconds,
      active_rule_pack_version=excluded.active_rule_pack_version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .run(
      organizationId,
      Number(next.clamavRequired),
      Number(next.yaraxRequired),
      next.maxDefinitionAgeHours,
      next.archiveMaxDepth,
      next.archiveMaxMembers,
      next.archiveMaxExpandedBytes,
      next.scanTimeoutSeconds,
      next.activeRulePackVersion,
      updatedBy,
      now,
    )
  return next
}

export function getSecurityResult(intakeItemId: string): IntakeSecurityResult | null {
  const row = getDb()
    .prepare('SELECT * FROM intake_security_scans WHERE intake_item_id = ?')
    .get(intakeItemId) as Record<string, unknown> | undefined
  return row ? map(row) : null
}

function commandVersion(command: string): string | undefined {
  try {
    return execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 })
      .trim()
      .split('\n')[0]
  } catch {
    return undefined
  }
}

export function scanIntakeItem(organizationId: string, intakeItemId: string): IntakeSecurityResult {
  const db = getDb()
  const item = db
    .prepare(
      'SELECT content_base64, filename FROM intake_items WHERE id = ? AND organization_id = ?',
    )
    .get(intakeItemId, organizationId) as Record<string, unknown> | undefined
  if (!item) throw new Error('Intake item not found')
  const bytes = Buffer.from(String(item.content_base64), 'base64')
  const matches: string[] = []
  const now = new Date().toISOString()
  const settings = getIntakeSecuritySettings(organizationId)
  const clamavVersion = commandVersion('clamscan')
  const yaraxVersion = commandVersion('yr')
  const rulesPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'security-rules',
    'default.yar',
  )
  const evidence: string[] = []
  let unavailable = false
  const directory = mkdtempSync(join(tmpdir(), 'papyrus-scan-'))
  const target = join(directory, 'intake.bin')
  writeFileSync(target, bytes, { mode: 0o600 })
  try {
    if (clamavVersion) {
      try {
        execFileSync('clamscan', ['--no-summary', '--stdout', target], {
          encoding: 'utf8',
          timeout: settings.scanTimeoutSeconds * 1000,
        })
      } catch (error) {
        const result = error as {
          status?: number
          stdout?: string | Buffer
          stderr?: string | Buffer
        }
        if (result.status === 1) {
          const output = String(result.stdout ?? '').trim()
          matches.push(
            ...output
              .split('\n')
              .filter(Boolean)
              .map((line) => `ClamAV:${line}`),
          )
        } else {
          unavailable = true
          evidence.push(
            `ClamAV error: ${String(result.stderr ?? result.stdout ?? 'scan failed').trim()}`,
          )
        }
      }
    } else if (settings.clamavRequired) {
      unavailable = true
      evidence.push('ClamAV executable is unavailable')
    }
    if (yaraxVersion && rulesPath) {
      try {
        const output = execFileSync('yr', ['scan', rulesPath, target], {
          encoding: 'utf8',
          timeout: settings.scanTimeoutSeconds * 1000,
        }).trim()
        if (output)
          matches.push(
            ...output
              .split('\n')
              .filter(Boolean)
              .map((line) => `YARA-X:${line}`),
          )
      } catch (error) {
        const result = error as { stdout?: string | Buffer; stderr?: string | Buffer }
        unavailable = true
        evidence.push(
          `YARA-X error: ${String(result.stderr ?? result.stdout ?? 'scan failed').trim()}`,
        )
      }
    } else if (settings.yaraxRequired) {
      unavailable = true
      evidence.push('YARA-X executable is unavailable')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  evidence.push(...matches.map((match) => `${String(item.filename)}: ${match}`))
  const verdict: SecurityVerdict = matches.length
    ? 'blocked'
    : unavailable
      ? 'engine-unavailable'
      : 'passed'
  db.prepare(`INSERT INTO intake_security_scans
    (id,organization_id,intake_item_id,verdict,clamav_version,clamav_definitions_at,yarax_version,rule_pack_version,matches_json,evidence_json,started_at,completed_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(intake_item_id) DO UPDATE SET verdict=excluded.verdict,
    matches_json=excluded.matches_json,evidence_json=excluded.evidence_json,completed_at=excluded.completed_at,updated_at=excluded.updated_at`).run(
    `scan-${randomUUID()}`,
    organizationId,
    intakeItemId,
    verdict,
    clamavVersion ?? null,
    now,
    yaraxVersion ?? null,
    settings.activeRulePackVersion,
    JSON.stringify(matches),
    JSON.stringify(evidence),
    now,
    now,
    now,
  )
  return getSecurityResult(intakeItemId) as IntakeSecurityResult
}

export function overrideSecurityResult(
  organizationId: string,
  intakeItemId: string,
  actor: string,
  rationale: string,
): IntakeSecurityResult {
  if (rationale.trim().length < 12) throw new Error('A meaningful override rationale is required')
  getDb()
    .prepare(`UPDATE intake_security_scans SET verdict='review-required',override_by=?,override_rationale=?,updated_at=?
      WHERE intake_item_id=? AND organization_id=? AND verdict='blocked'`)
    .run(actor, rationale, new Date().toISOString(), intakeItemId, organizationId)
  const result = getSecurityResult(intakeItemId)
  if (!result) throw new Error('Security result not found')
  return result
}
