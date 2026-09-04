import { randomUUID } from 'node:crypto'
import type { AgentSignal } from '@papyrus/contracts'
import type { AgentDatabase } from '../database.js'

/**
 * Durable signal outbox.
 *
 * Signals are significant investigation state changes, not raw observations.
 * They are persisted before delivery so that a daemon restart, a crashed
 * harness, or an unavailable agent thread cannot lose them. The Mastra bridge
 * leases pending rows, delivers them to the investigation thread, and
 * acknowledges each one; unacknowledged leases expire back to pending.
 */

type Row = Record<string, unknown>

export type SignalStatus = 'pending' | 'delivering' | 'delivered' | 'failed'

export interface SignalRecord {
  id: string
  type: AgentSignal['type']
  investigationId?: string
  proposalId?: string
  claimId?: string
  payload: Record<string, unknown>
  status: SignalStatus
  attempts: number
  maxAttempts: number
  lockedBy?: string
  leaseExpiresAt?: string
  createdAt: string
  updatedAt: string
  deliveredAt?: string
  error?: string
}

export interface EnqueueSignalInput {
  type: AgentSignal['type']
  investigationId?: string
  proposalId?: string
  claimId?: string
  payload?: Record<string, unknown>
}

export const DEFAULT_SIGNAL_MAX_ATTEMPTS = 5

export class SignalOutbox {
  constructor(
    readonly db: AgentDatabase,
    readonly maxAttempts: number = DEFAULT_SIGNAL_MAX_ATTEMPTS,
  ) {
    this.migrate()
  }

  enqueue(input: EnqueueSignalInput, now = new Date()): SignalRecord {
    const stamp = now.toISOString()
    const id = randomUUID()
    this.db.sqlite.prepare(`INSERT INTO agent_signal_outbox(
      id,type,investigation_id,proposal_id,claim_id,payload_json,status,attempts,max_attempts,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.type,
      input.investigationId ?? null,
      input.proposalId ?? null,
      input.claimId ?? null,
      JSON.stringify(input.payload ?? {}),
      'pending',
      0,
      this.maxAttempts,
      stamp,
      stamp,
    )
    return this.get(id) as SignalRecord
  }

  get(id: string): SignalRecord | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM agent_signal_outbox WHERE id=?').get(id) as Row | undefined
    return row ? this.record(row) : undefined
  }

  /** Lease pending signals for delivery. Expired leases return to pending first. */
  claim(workerId: string, leaseMs: number, limit = 25, now = new Date()): SignalRecord[] {
    const stamp = now.toISOString()
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString()
    return this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare(`UPDATE agent_signal_outbox
        SET status='pending',locked_by=NULL,lease_expires_at=NULL,updated_at=?
        WHERE status='delivering' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`).run(stamp, stamp)

      const rows = this.db.sqlite.prepare(
        "SELECT id FROM agent_signal_outbox WHERE status='pending' AND attempts<max_attempts ORDER BY created_at LIMIT ?",
      ).all(limit) as Row[]

      const claimed: SignalRecord[] = []
      for (const row of rows) {
        const id = String(row['id'])
        this.db.sqlite.prepare(
          "UPDATE agent_signal_outbox SET status='delivering',locked_by=?,lease_expires_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'",
        ).run(workerId, leaseExpiresAt, stamp, id)
        const record = this.get(id)
        if (record) claimed.push(record)
      }
      return claimed
    })()
  }

  ack(id: string, now = new Date()): void {
    const stamp = now.toISOString()
    this.db.sqlite.prepare(
      `UPDATE agent_signal_outbox
       SET status='delivered',delivered_at=?,locked_by=NULL,lease_expires_at=NULL,error=NULL,updated_at=?
       WHERE id=?`,
    ).run(stamp, stamp, id)
  }

  /** Return a leased signal to pending, or fail it once attempts are exhausted. */
  fail(id: string, error: string, now = new Date()): void {
    const stamp = now.toISOString()
    this.db.sqlite.prepare(`UPDATE agent_signal_outbox
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
          error=?,locked_by=NULL,lease_expires_at=NULL,updated_at=?
      WHERE id=?`).run(error, stamp, id)
  }

  pending(limit = 100): SignalRecord[] {
    const rows = this.db.sqlite.prepare(
      "SELECT * FROM agent_signal_outbox WHERE status='pending' ORDER BY created_at LIMIT ?",
    ).all(limit) as Row[]
    return rows.map((row) => this.record(row))
  }

  byInvestigation(investigationId: string): SignalRecord[] {
    const rows = this.db.sqlite.prepare(
      'SELECT * FROM agent_signal_outbox WHERE investigation_id=? ORDER BY created_at',
    ).all(investigationId) as Row[]
    return rows.map((row) => this.record(row))
  }

  counts(): Record<SignalStatus, number> {
    const rows = this.db.sqlite.prepare(
      'SELECT status, COUNT(*) AS n FROM agent_signal_outbox GROUP BY status',
    ).all() as Row[]
    const result: Record<SignalStatus, number> = { pending: 0, delivering: 0, delivered: 0, failed: 0 }
    for (const row of rows) result[String(row['status']) as SignalStatus] = Number(row['n'] ?? 0)
    return result
  }

  private record(row: Row): SignalRecord {
    const raw = row['payload_json']
    let payload: Record<string, unknown> = {}
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
      } catch {
        payload = {}
      }
    }
    return {
      id: String(row['id']),
      type: row['type'] as AgentSignal['type'],
      ...(row['investigation_id'] ? { investigationId: String(row['investigation_id']) } : {}),
      ...(row['proposal_id'] ? { proposalId: String(row['proposal_id']) } : {}),
      ...(row['claim_id'] ? { claimId: String(row['claim_id']) } : {}),
      payload,
      status: row['status'] as SignalStatus,
      attempts: Number(row['attempts'] ?? 0),
      maxAttempts: Number(row['max_attempts'] ?? this.maxAttempts),
      ...(row['locked_by'] ? { lockedBy: String(row['locked_by']) } : {}),
      ...(row['lease_expires_at'] ? { leaseExpiresAt: String(row['lease_expires_at']) } : {}),
      createdAt: String(row['created_at']),
      updatedAt: String(row['updated_at']),
      ...(row['delivered_at'] ? { deliveredAt: String(row['delivered_at']) } : {}),
      ...(row['error'] ? { error: String(row['error']) } : {}),
    }
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_signal_outbox (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        investigation_id TEXT,
        proposal_id TEXT,
        claim_id TEXT,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','delivering','delivered','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        locked_by TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_signal_outbox_status ON agent_signal_outbox(status,created_at);
      CREATE INDEX IF NOT EXISTS agent_signal_outbox_investigation ON agent_signal_outbox(investigation_id,created_at);
    `)
  }
}
