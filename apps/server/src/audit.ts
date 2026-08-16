import { createHash } from 'node:crypto'
import type { AuditEvent } from '@papyrus/contracts'
import type { PapyrusDatabase } from './db.js'

export const POLICY_VERSION = 'papyrus-fixed-v1'
const GENESIS_HASH = '0'.repeat(64)

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export class AuditLog {
  constructor(private readonly db: PapyrusDatabase) {}

  append(input: Omit<AuditEvent, 'sequence' | 'id' | 'occurredAt' | 'previousHash' | 'hash' | 'policyVersion'>): AuditEvent {
    return this.db.transaction(() => {
      const previous = this.db.sqlite.prepare('SELECT sequence,hash FROM audit_events ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; hash: string } | undefined
      const base = {
        sequence: (previous?.sequence ?? 0) + 1,
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        ...input,
        policyVersion: POLICY_VERSION,
        previousHash: previous?.hash ?? GENESIS_HASH,
      }
      const hash = createHash('sha256').update(canonical(base)).digest('hex')
      const event: AuditEvent = { ...base, hash }
      this.db.sqlite.prepare(`INSERT INTO audit_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        event.sequence, event.id, event.occurredAt, event.actorId, event.action, event.resourceType,
        event.resourceId, event.decision, event.policyVersion, JSON.stringify(event.metadata), event.previousHash, event.hash,
      )
      return event
    })
  }

  list(limit = 200): AuditEvent[] {
    const rows = this.db.sqlite.prepare('SELECT * FROM audit_events ORDER BY sequence DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 1000)) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      sequence: Number(row.sequence), id: String(row.id), occurredAt: String(row.occurred_at), actorId: row.actor_id ? String(row.actor_id) : null,
      action: String(row.action), resourceType: String(row.resource_type), resourceId: String(row.resource_id),
      decision: row.decision as AuditEvent['decision'], policyVersion: String(row.policy_version), metadata: JSON.parse(String(row.metadata_json)),
      previousHash: String(row.previous_hash), hash: String(row.hash),
    }))
  }

  verify(): { valid: boolean; brokenAt?: number } {
    const rows = this.db.sqlite.prepare('SELECT * FROM audit_events ORDER BY sequence ASC').all() as Array<Record<string, unknown>>
    const events: AuditEvent[] = rows.map((row) => ({
      sequence: Number(row.sequence), id: String(row.id), occurredAt: String(row.occurred_at), actorId: row.actor_id ? String(row.actor_id) : null,
      action: String(row.action), resourceType: String(row.resource_type), resourceId: String(row.resource_id),
      decision: row.decision as AuditEvent['decision'], policyVersion: String(row.policy_version), metadata: JSON.parse(String(row.metadata_json)),
      previousHash: String(row.previous_hash), hash: String(row.hash),
    }))
    let previousHash = GENESIS_HASH
    for (const event of events) {
      const { hash, ...base } = event
      if (base.previousHash !== previousHash || createHash('sha256').update(canonical(base)).digest('hex') !== hash) {
        return { valid: false, brokenAt: event.sequence }
      }
      previousHash = hash
    }
    return { valid: true }
  }
}
