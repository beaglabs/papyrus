import { createHash, randomUUID } from 'node:crypto'
import type {
  CyberActionAttempt,
  CyberActionJob,
  CyberActionProposal,
  CyberActionReceipt,
  CyberInvestigation,
} from '@papyrus/contracts'
import { canonical, CyberDatabase } from './database.js'

type Row = Record<string, unknown>

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export interface CreateInvestigationInput {
  title: string
  trigger: CyberInvestigation['trigger']
  triggerIntegrationId?: string
  triggerMessageId?: string
  mastraThreadId?: string
}

export class ThreadConflictError extends Error {
  constructor() {
    super('The investigation is already bound to a different agent thread')
    this.name = 'ThreadConflictError'
  }
}

export interface CreateProposalInput {
  investigationId: string
  proposedByOperatorId: string
  executorIntegrationId: string
  action: string
  target: string
  parameters?: Record<string, unknown>
  rationaleClaimIds: string[]
  simulationId?: string
  expiresAt?: string
}

export class ActionStore {
  constructor(readonly db: CyberDatabase) { this.migrate() }

  createInvestigation(input: CreateInvestigationInput): CyberInvestigation {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.sqlite.prepare(`INSERT INTO cyber_investigations(
      id,title,trigger,trigger_integration_id,trigger_message_id,mastra_thread_id,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      id, input.title, input.trigger,
      input.triggerIntegrationId ?? null,
      input.triggerMessageId ?? null,
      input.mastraThreadId ?? null,
      'open', now, now,
    )
    return this.getInvestigation(id) as CyberInvestigation
  }

  getInvestigation(id: string): CyberInvestigation | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM cyber_investigations WHERE id=?').get(id) as Row | undefined
    return row ? this.investigation(row) : undefined
  }

  listInvestigations(): CyberInvestigation[] {
    return (this.db.sqlite.prepare('SELECT * FROM cyber_investigations ORDER BY updated_at DESC').all() as Row[])
      .map((row) => this.investigation(row))
  }

  updateInvestigationStatus(id: string, status: CyberInvestigation['status'], summary?: string): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare('UPDATE cyber_investigations SET status=?,summary=COALESCE(?,summary),updated_at=? WHERE id=?')
      .run(status, summary ?? null, now, id)
  }

  /**
   * Bind an investigation to its durable agent thread. Idempotent: rebinding
   * the same thread is a no-op, and rebinding a different thread is refused so
   * a restarted daemon cannot silently split one investigation across threads.
   */
  setMastraThreadId(id: string, threadId: string): void {
    const now = new Date().toISOString()
    const result = this.db.sqlite.prepare(
      'UPDATE cyber_investigations SET mastra_thread_id=?,updated_at=? WHERE id=? AND (mastra_thread_id IS NULL OR mastra_thread_id=?)',
    ).run(threadId, now, id, threadId)
    if (result.changes === 0 && this.getInvestigation(id)?.mastraThreadId !== threadId) {
      throw new ThreadConflictError()
    }
  }

  addClaimToInvestigation(investigationId: string, claimId: string): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare('INSERT OR IGNORE INTO cyber_investigation_claims(investigation_id,claim_id,added_at) VALUES(?,?,?)')
      .run(investigationId, claimId, now)
    this.db.sqlite.prepare('UPDATE cyber_investigations SET updated_at=? WHERE id=?').run(now, investigationId)
  }

  /**
   * Advance an investigation once an action has been proposed against it.
   * Proposal linkage is derived from cyber_action_proposals.investigation_id,
   * so this only drives the status transition.
   */
  markActionProposed(investigationId: string): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE cyber_investigations SET status=CASE WHEN status IN ('open','analyzing') THEN 'action_proposed' ELSE status END,updated_at=? WHERE id=?")
      .run(now, investigationId)
  }

  createProposal(input: CreateProposalInput): CyberActionProposal {
    const now = new Date().toISOString()
    const id = randomUUID()
    const idempotencyKey = digest({
      investigationId: input.investigationId,
      executorIntegrationId: input.executorIntegrationId,
      action: input.action,
      target: input.target,
      parameters: input.parameters ?? {},
    })
    const existing = this.db.sqlite.prepare('SELECT * FROM cyber_action_proposals WHERE idempotency_key=?').get(idempotencyKey) as Row | undefined
    if (existing) return this.proposal(existing)
    this.db.sqlite.prepare(`INSERT INTO cyber_action_proposals(
      id,investigation_id,proposed_by_operator_id,executor_integration_id,action,target,parameters_json,
      rationale_claim_ids_json,simulation_id,status,required_role,idempotency_key,expires_at,proposed_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.investigationId, input.proposedByOperatorId, input.executorIntegrationId,
      input.action, input.target, JSON.stringify(input.parameters ?? {}),
      JSON.stringify(input.rationaleClaimIds),
      input.simulationId ?? null,
      'proposed', 'Papyrus.Action.Approve', idempotencyKey,
      input.expiresAt ?? null, now,
    )
    this.markActionProposed(input.investigationId)
    return this.getProposal(id) as CyberActionProposal
  }

  getProposal(id: string): CyberActionProposal | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM cyber_action_proposals WHERE id=?').get(id) as Row | undefined
    return row ? this.proposal(row) : undefined
  }

  listProposals(investigationId?: string): CyberActionProposal[] {
    const query = investigationId
      ? 'SELECT * FROM cyber_action_proposals WHERE investigation_id=? ORDER BY proposed_at DESC'
      : 'SELECT * FROM cyber_action_proposals ORDER BY proposed_at DESC'
    const params = investigationId ? [investigationId] : []
    return (this.db.sqlite.prepare(query).all(...params) as Row[]).map((row) => this.proposal(row))
  }

  approveProposal(id: string, approverOid: string): CyberActionProposal {
    const proposal = this.getProposal(id)
    if (!proposal) throw new Error('Proposal not found')
    if (proposal.status !== 'proposed') throw new Error(`Proposal is ${proposal.status}, cannot approve`)
    if (proposal.expiresAt && new Date(proposal.expiresAt) < new Date()) throw new Error('Proposal has expired')
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE cyber_action_proposals SET status='approved',approved_by_oid=?,approved_at=?,decided_at=? WHERE id=?")
      .run(approverOid, now, now, id)
    // The investigation advances to 'executing' when the job is enqueued, not
    // here: an approved action that is not yet queued is not awaiting anything.
    return this.getProposal(id) as CyberActionProposal
  }

  denyProposal(id: string, denyerOid: string, reason?: string): CyberActionProposal {
    const proposal = this.getProposal(id)
    if (!proposal) throw new Error('Proposal not found')
    if (proposal.status !== 'proposed') throw new Error(`Proposal is ${proposal.status}, cannot deny`)
    const now = new Date().toISOString()
    this.db.sqlite.prepare("UPDATE cyber_action_proposals SET status='denied',denied_by_oid=?,denied_at=?,denial_reason=?,decided_at=? WHERE id=?")
      .run(denyerOid, now, reason ?? null, now, id)
    return this.getProposal(id) as CyberActionProposal
  }

  expireProposal(id: string): void {
    this.db.sqlite.prepare("UPDATE cyber_action_proposals SET status='expired',decided_at=? WHERE id=? AND status='proposed'")
      .run(new Date().toISOString(), id)
  }

  expireStaleProposals(now = new Date()): number {
    const result = this.db.sqlite.prepare("UPDATE cyber_action_proposals SET status='expired',decided_at=? WHERE status='proposed' AND expires_at IS NOT NULL AND expires_at<=?")
      .run(now.toISOString(), now.toISOString())
    return result.changes
  }

  enqueueJob(proposal: CyberActionProposal, maxAttempts = 3): CyberActionJob {
    const existing = this.db.sqlite.prepare('SELECT * FROM cyber_action_jobs WHERE proposal_id=?').get(proposal.id) as Row | undefined
    if (existing && ['queued', 'running'].includes(String(existing.status))) return this.job(existing)
    const now = new Date().toISOString()
    const id = randomUUID()
    this.db.sqlite.prepare(`INSERT INTO cyber_action_jobs(
      id,proposal_id,investigation_id,executor_integration_id,action,target,parameters_json,
      idempotency_key,status,attempt,max_attempts,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?)`).run(
      id, proposal.id, proposal.investigationId, proposal.executorIntegrationId,
      proposal.action, proposal.target, JSON.stringify(proposal.parameters ?? {}),
      proposal.idempotencyKey, 'queued', maxAttempts, now, now, null,
    )
    this.db.sqlite.prepare('UPDATE cyber_investigations SET status=?,updated_at=? WHERE id=?')
      .run('executing', now, proposal.investigationId)
    return this.getJob(id) as CyberActionJob
  }

  getJob(id: string): CyberActionJob | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM cyber_action_jobs WHERE id=?').get(id) as Row | undefined
    return row ? this.job(row) : undefined
  }

  getJobByProposal(proposalId: string): CyberActionJob | undefined {
    const row = this.db.sqlite.prepare("SELECT * FROM cyber_action_jobs WHERE proposal_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1").get(proposalId) as Row | undefined
    return row ? this.job(row) : undefined
  }

  claimJob(workerId: string, leaseMs: number, now = new Date()): CyberActionJob | undefined {
    const stamp = now.toISOString()
    return this.db.sqlite.transaction(() => {
      // A lease that expired means the owning worker died mid-execution. Those
      // jobs are retried at once rather than waiting out a backoff they never
      // earned, so the delay is cleared along with the lease.
      this.db.sqlite.prepare(`UPDATE cyber_action_jobs SET status='queued',locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,run_after=NULL,updated_at=?
        WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`)
        .run(stamp, stamp)
      const candidate = this.db.sqlite.prepare("SELECT id FROM cyber_action_jobs WHERE status='queued' AND (run_after IS NULL OR run_after<=?) ORDER BY created_at LIMIT 1")
        .get(stamp) as Row | undefined
      if (!candidate) return undefined
      const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString()
      const result = this.db.sqlite.prepare(`UPDATE cyber_action_jobs SET status='running',attempt=attempt+1,locked_by=?,locked_at=?,
        lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND status='queued'`)
        .run(workerId, now.toISOString(), leaseExpiresAt, now.toISOString(), now.toISOString(), String(candidate.id))
      if (result.changes !== 1) return undefined
      const job = this.getJob(String(candidate.id)) as CyberActionJob
      this.recordAttempt(job)
      return job
    })()
  }

  completeJob(jobId: string, receipt: { result: 'success' | 'partial' | 'failure'; message: string; evidenceObservationId?: string }, at = new Date()): CyberActionReceipt {
    const now = at.toISOString()
    const job = this.getJob(jobId)
    if (!job) throw new Error('Job not found')
    return this.db.sqlite.transaction(() => {
      this.db.sqlite.prepare("UPDATE cyber_action_jobs SET status='completed',completed_at=?,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,run_after=NULL,updated_at=? WHERE id=?")
        .run(now, now, jobId)
      this.db.sqlite.prepare("UPDATE cyber_action_proposals SET status='executed',decided_at=? WHERE id=?")
        .run(now, job.proposalId)
      this.db.sqlite.prepare('UPDATE cyber_investigations SET status=?,updated_at=? WHERE id=?')
        .run('resolved', now, job.investigationId)
      this.db.sqlite.prepare("UPDATE cyber_action_attempts SET completed_at=?,success=1 WHERE job_id=? AND attempt=?")
        .run(now, jobId, job.attempt)
      const receiptId = randomUUID()
      this.db.sqlite.prepare(`INSERT INTO cyber_action_receipts(
        id,job_id,proposal_id,investigation_id,executor_integration_id,action,target,result,message,evidence_observation_id,executed_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        receiptId, jobId, job.proposalId, job.investigationId, job.executorIntegrationId,
        job.action, job.target, receipt.result, receipt.message, receipt.evidenceObservationId ?? null, now,
      )
      // Execution is attributed to the approver whose authorization released
      // the action; the worker that carried it out is recorded as data.
      this.db.recordActionEvent(job.executorIntegrationId, this.getProposal(job.proposalId)?.approvedByOid ?? 'daemon', 'ActionExecuted', {
        jobId, proposalId: job.proposalId, investigationId: job.investigationId,
        receiptId, attempt: job.attempt, result: receipt.result, message: receipt.message,
        workerId: job.lockedBy ?? 'daemon',
        ...(receipt.evidenceObservationId ? { evidenceObservationId: receipt.evidenceObservationId } : {}),
      })
      return this.getReceipt(receiptId) as CyberActionReceipt
    })()
  }

  failJob(jobId: string, error: string, terminal: boolean, retryDelayMs = 0, at = new Date()): void {
    const now = at
    const stamp = now.toISOString()
    const job = this.getJob(jobId)
    if (!job) return
    this.db.sqlite.transaction(() => {
      const status = terminal ? 'failed' : 'queued'
      // A retryable failure is held until its backoff elapses; without this the
      // worker's drain loop would re-claim the job on the same tick and spin.
      const runAfter = terminal || retryDelayMs <= 0 ? null : new Date(now.getTime() + retryDelayMs).toISOString()
      this.db.sqlite.prepare(`UPDATE cyber_action_jobs SET status=?,error=?,locked_by=NULL,locked_at=NULL,lease_expires_at=NULL,run_after=?,updated_at=? WHERE id=?`)
        .run(status, error.slice(0, 2048), runAfter, stamp, jobId)
      this.db.sqlite.prepare("UPDATE cyber_action_attempts SET completed_at=?,success=0,error=? WHERE job_id=? AND attempt=?")
        .run(stamp, error.slice(0, 2048), jobId, job.attempt)
      if (terminal) {
        this.db.sqlite.prepare("UPDATE cyber_action_proposals SET status='failed',decided_at=? WHERE id=?")
          .run(stamp, job.proposalId)
        this.db.recordActionEvent(job.executorIntegrationId, this.getProposal(job.proposalId)?.approvedByOid ?? 'daemon', 'ActionFailed', {
          jobId, proposalId: job.proposalId, investigationId: job.investigationId,
          attempt: job.attempt, error: error.slice(0, 2048), workerId: job.lockedBy ?? 'daemon',
        })
      }
    })()
  }

  getReceipt(id: string): CyberActionReceipt | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM cyber_action_receipts WHERE id=?').get(id) as Row | undefined
    return row ? this.receipt(row) : undefined
  }

  getReceiptByJob(jobId: string): CyberActionReceipt | undefined {
    const row = this.db.sqlite.prepare('SELECT * FROM cyber_action_receipts WHERE job_id=?').get(jobId) as Row | undefined
    return row ? this.receipt(row) : undefined
  }

  listReceipts(investigationId?: string): CyberActionReceipt[] {
    const query = investigationId
      ? 'SELECT * FROM cyber_action_receipts WHERE investigation_id=? ORDER BY executed_at DESC'
      : 'SELECT * FROM cyber_action_receipts ORDER BY executed_at DESC'
    const params = investigationId ? [investigationId] : []
    return (this.db.sqlite.prepare(query).all(...params) as Row[]).map((row) => this.receipt(row))
  }

  private recordAttempt(job: CyberActionJob): void {
    const now = new Date().toISOString()
    this.db.sqlite.prepare('INSERT OR IGNORE INTO cyber_action_attempts(id,job_id,attempt,worker_id,started_at) VALUES(?,?,?,?,?)')
      .run(randomUUID(), job.id, job.attempt, job.lockedBy ?? 'unknown', now)
  }

  private investigation(row: Row): CyberInvestigation {
    const claimIds = (this.db.sqlite.prepare('SELECT claim_id FROM cyber_investigation_claims WHERE investigation_id=? ORDER BY added_at')
      .all(String(row.id)) as Row[]).map((r) => String(r.claim_id))
    const proposalIds = (this.db.sqlite.prepare('SELECT id FROM cyber_action_proposals WHERE investigation_id=? ORDER BY proposed_at')
      .all(String(row.id)) as Row[]).map((r) => String(r.id))
    return {
      id: String(row.id), title: String(row.title), trigger: row.trigger as CyberInvestigation['trigger'],
      ...(row.trigger_integration_id ? { triggerIntegrationId: String(row.trigger_integration_id) } : {}),
      ...(row.trigger_message_id ? { triggerMessageId: String(row.trigger_message_id) } : {}),
      ...(row.mastra_thread_id ? { mastraThreadId: String(row.mastra_thread_id) } : {}),
      status: row.status as CyberInvestigation['status'],
      ...(row.summary ? { summary: String(row.summary) } : {}),
      claimIds, proposalIds,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  private proposal(row: Row): CyberActionProposal {
    return {
      id: String(row.id), investigationId: String(row.investigation_id),
      proposedByOperatorId: String(row.proposed_by_operator_id),
      executorIntegrationId: String(row.executor_integration_id),
      action: String(row.action), target: String(row.target),
      ...(row.parameters_json && row.parameters_json !== '{}' ? { parameters: JSON.parse(String(row.parameters_json)) } : {}),
      rationaleClaimIds: JSON.parse(String(row.rationale_claim_ids_json ?? '[]')) as string[],
      ...(row.simulation_id ? { simulationId: String(row.simulation_id) } : {}),
      status: row.status as CyberActionProposal['status'],
      requiredRole: 'Papyrus.Action.Approve',
      ...(row.approved_by_oid ? { approvedByOid: String(row.approved_by_oid) } : {}),
      ...(row.approved_at ? { approvedAt: String(row.approved_at) } : {}),
      ...(row.denied_by_oid ? { deniedByOid: String(row.denied_by_oid) } : {}),
      ...(row.denied_at ? { deniedAt: String(row.denied_at) } : {}),
      ...(row.denial_reason ? { denialReason: String(row.denial_reason) } : {}),
      ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
      idempotencyKey: String(row.idempotency_key),
      proposedAt: String(row.proposed_at),
      ...(row.decided_at ? { decidedAt: String(row.decided_at) } : {}),
    }
  }

  private job(row: Row): CyberActionJob {
    return {
      id: String(row.id), proposalId: String(row.proposal_id), investigationId: String(row.investigation_id),
      executorIntegrationId: String(row.executor_integration_id),
      action: String(row.action), target: String(row.target),
      ...(row.parameters_json && row.parameters_json !== '{}' ? { parameters: JSON.parse(String(row.parameters_json)) } : {}),
      idempotencyKey: String(row.idempotency_key),
      status: row.status as CyberActionJob['status'],
      attempt: Number(row.attempt), maxAttempts: Number(row.max_attempts),
      ...(row.locked_by ? { lockedBy: String(row.locked_by) } : {}),
      ...(row.locked_at ? { lockedAt: String(row.locked_at) } : {}),
      ...(row.lease_expires_at ? { leaseExpiresAt: String(row.lease_expires_at) } : {}),
      ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
      ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
      ...(row.error ? { error: String(row.error) } : {}),
      ...(row.run_after ? { runAfter: String(row.run_after) } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  private receipt(row: Row): CyberActionReceipt {
    return {
      id: String(row.id), jobId: String(row.job_id), proposalId: String(row.proposal_id),
      investigationId: String(row.investigation_id), executorIntegrationId: String(row.executor_integration_id),
      action: String(row.action), target: String(row.target),
      result: row.result as CyberActionReceipt['result'], message: String(row.message),
      ...(row.evidence_observation_id ? { evidenceObservationId: String(row.evidence_observation_id) } : {}),
      executedAt: String(row.executed_at),
    }
  }

  private migrate(): void {
    this.db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS cyber_investigations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        trigger TEXT NOT NULL,
        trigger_integration_id TEXT,
        trigger_message_id TEXT,
        mastra_thread_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('open','analyzing','action_proposed','awaiting_approval','executing','resolved','abandoned')),
        summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cyber_investigations_status ON cyber_investigations(status,updated_at DESC);
      CREATE TABLE IF NOT EXISTS cyber_investigation_claims (
        investigation_id TEXT NOT NULL REFERENCES cyber_investigations(id),
        claim_id TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY(investigation_id,claim_id)
      );
      CREATE TABLE IF NOT EXISTS cyber_action_proposals (
        id TEXT PRIMARY KEY,
        investigation_id TEXT NOT NULL REFERENCES cyber_investigations(id),
        proposed_by_operator_id TEXT NOT NULL,
        executor_integration_id TEXT NOT NULL REFERENCES cyber_integrations(id),
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        rationale_claim_ids_json TEXT NOT NULL,
        simulation_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('proposed','approved','denied','expired','executing','executed','failed')),
        required_role TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        approved_by_oid TEXT,
        approved_at TEXT,
        denied_by_oid TEXT,
        denied_at TEXT,
        denial_reason TEXT,
        expires_at TEXT,
        proposed_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS cyber_action_proposals_investigation ON cyber_action_proposals(investigation_id,proposed_at DESC);
      CREATE INDEX IF NOT EXISTS cyber_action_proposals_status ON cyber_action_proposals(status,proposed_at DESC);
      CREATE TABLE IF NOT EXISTS cyber_action_jobs (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES cyber_action_proposals(id),
        investigation_id TEXT NOT NULL REFERENCES cyber_investigations(id),
        executor_integration_id TEXT NOT NULL REFERENCES cyber_integrations(id),
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        parameters_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
        attempt INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL,
        locked_by TEXT,
        locked_at TEXT,
        lease_expires_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        run_after TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cyber_action_jobs_ready ON cyber_action_jobs(status,run_after,created_at);
      CREATE INDEX IF NOT EXISTS cyber_action_jobs_proposal ON cyber_action_jobs(proposal_id);
      CREATE TABLE IF NOT EXISTS cyber_action_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES cyber_action_jobs(id),
        attempt INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        success INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        UNIQUE(job_id,attempt)
      );
      CREATE TABLE IF NOT EXISTS cyber_action_receipts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES cyber_action_jobs(id),
        proposal_id TEXT NOT NULL REFERENCES cyber_action_proposals(id),
        investigation_id TEXT NOT NULL REFERENCES cyber_investigations(id),
        executor_integration_id TEXT NOT NULL REFERENCES cyber_integrations(id),
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        result TEXT NOT NULL CHECK(result IN ('success','partial','failure')),
        message TEXT NOT NULL,
        evidence_observation_id TEXT,
        executed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cyber_action_receipts_investigation ON cyber_action_receipts(investigation_id,executed_at DESC);
    `)
  }
}
