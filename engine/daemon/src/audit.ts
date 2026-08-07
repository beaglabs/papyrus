/**
 * Audit logging — tracks all mutations with who/when/what for compliance.
 *
 * Stored in SQLite alongside project data. Every node/edge/project mutation
 * generates an audit entry. Logs are append-only and tamper-evident (each
 * entry includes a hash of the previous entry).
 */
import { createHash } from 'node:crypto'
import { getDb } from './database.js'

function ensureAuditSchema(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      details TEXT DEFAULT '{}',
      prev_hash TEXT,
      entry_hash TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
  `)
}

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'export'
  | 'import'
  | 'connect'
  | 'disconnect'

export interface AuditEntry {
  id: number
  timestamp: string
  actor: string
  action: AuditAction
  entityType: string
  entityId: string
  projectId: string
  details: Record<string, unknown>
  prevHash: string | null
  entryHash: string
}

/** Compute SHA-256 hash of audit entry data, chained with previous hash. */
function computeHash(data: string, prevHash: string | null): string {
  const seed = prevHash ?? '0'
  return createHash('sha256').update(seed).update(data).digest('hex')
}

/**
 * Record an audit event.
 */
export function auditLog(params: {
  actor: string
  action: AuditAction
  entityType: string
  entityId: string
  projectId: string
  details?: Record<string, unknown>
}): AuditEntry {
  ensureAuditSchema()
  const db = getDb()

  // Get the last hash for this project's chain
  const lastEntry = db
    .prepare('SELECT entry_hash FROM audit_log WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .get(params.projectId) as { entry_hash: string } | undefined

  const prevHash = lastEntry?.entry_hash ?? null
  const timestamp = new Date().toISOString()
  const data = `${params.actor}:${params.action}:${params.entityType}:${params.entityId}:${params.projectId}:${timestamp}`
  const entryHash = computeHash(data, prevHash)

  const result = db
    .prepare(
      'INSERT INTO audit_log (timestamp, actor, action, entity_type, entity_id, project_id, details, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      timestamp,
      params.actor,
      params.action,
      params.entityType,
      params.entityId,
      params.projectId,
      JSON.stringify(params.details ?? {}),
      prevHash,
      entryHash,
    )

  return {
    id: Number(result.lastInsertRowid),
    timestamp,
    actor: params.actor,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    projectId: params.projectId,
    details: params.details ?? {},
    prevHash,
    entryHash,
  }
}

/**
 * Query audit log for a project.
 */
export function getAuditLog(params: {
  projectId: string
  limit?: number
  offset?: number
  actor?: string
  action?: AuditAction
  entityType?: string
}): AuditEntry[] {
  ensureAuditSchema()
  const db = getDb()
  let query = 'SELECT * FROM audit_log WHERE project_id = ?'
  const args: unknown[] = [params.projectId]

  if (params.actor) {
    query += ' AND actor = ?'
    args.push(params.actor)
  }
  if (params.action) {
    query += ' AND action = ?'
    args.push(params.action)
  }
  if (params.entityType) {
    query += ' AND entity_type = ?'
    args.push(params.entityType)
  }

  query += ' ORDER BY id DESC'

  if (params.limit) {
    query += ' LIMIT ?'
    args.push(params.limit)
  }
  if (params.offset) {
    query += ' OFFSET ?'
    args.push(params.offset)
  }

  const rows = db.prepare(query).all(...args) as Array<{
    id: number
    timestamp: string
    actor: string
    action: string
    entity_type: string
    entity_id: string
    project_id: string
    details: string
    prev_hash: string | null
    entry_hash: string
  }>

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action as AuditAction,
    entityType: row.entity_type,
    entityId: row.entity_id,
    projectId: row.project_id,
    details: JSON.parse(row.details) as Record<string, unknown>,
    prevHash: row.prev_hash,
    entryHash: row.entry_hash,
  }))
}

/**
 * Verify audit log integrity (chain of hashes).
 */
export function verifyAuditChain(projectId: string): { valid: boolean; brokenAt?: number } {
  ensureAuditSchema()
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM audit_log WHERE project_id = ? ORDER BY id ASC')
    .all(projectId) as Array<{
    id: number
    timestamp: string
    actor: string
    action: string
    entity_type: string
    entity_id: string
    project_id: string
    details: string
    prev_hash: string | null
    entry_hash: string
  }>

  let prevHash: string | null = null
  for (const row of rows) {
    if (row.prev_hash !== prevHash) {
      return { valid: false, brokenAt: row.id }
    }
    const data = `${row.actor}:${row.action}:${row.entity_type}:${row.entity_id}:${row.project_id}:${row.timestamp}`
    const expectedHash = computeHash(data, row.prev_hash)
    if (row.entry_hash !== expectedHash) {
      return { valid: false, brokenAt: row.id }
    }
    prevHash = row.entry_hash
  }

  return { valid: true }
}
