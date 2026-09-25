import { randomUUID } from 'node:crypto'
import type { AgentActionJob, AgentActionReceipt, AgentActionProposal } from '@papyrus/contracts'
import type { AgentConfig } from './config.js'
import type { AgentDatabase } from './database.js'
import { ActionStore } from './action-store.js'
import { requireSessionConnectorBinding, SessionConnectorAccessError } from './session-connector-access.js'

export interface ActionExecutorContext {
  job: AgentActionJob
  proposal: AgentActionProposal
  config: AgentConfig
  signal: AbortSignal
}

export interface ActionResult {
  result: 'success' | 'partial' | 'failure'
  message: string
  evidenceObservationId?: string
}

export interface ActionExecutor {
  test(context: ActionExecutorContext): Promise<{ reachable: boolean; authenticated: boolean; message: string }>
  execute(context: ActionExecutorContext): Promise<ActionResult>
}

export class ActionExecutorRegistry {
  private readonly executors = new Map<string, ActionExecutor>()

  register(catalogId: string, executor: ActionExecutor): this {
    if (this.executors.has(catalogId)) throw new Error(`Action executor already registered for ${catalogId}`)
    this.executors.set(catalogId, executor)
    return this
  }

  get(catalogId: string): ActionExecutor | undefined { return this.executors.get(catalogId) }
  has(catalogId: string): boolean { return this.executors.has(catalogId) }
}

export interface ActionWorkerOptions {
  pollMs?: number
  leaseMs?: number
  maxAttempts?: number
  retryBaseMs?: number
  retryCapMs?: number
  expiryCheckIntervalMs?: number
}

export class ActionWorker {
  readonly workerId = `papyrus-action-${process.pid}-${randomUUID()}`
  private readonly pollMs: number
  private readonly leaseMs: number
  readonly defaultMaxAttempts: number
  private readonly retryBaseMs: number
  readonly retryCapMs: number
  private readonly expiryCheckIntervalMs: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private expiryTimer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private draining: Promise<void> | undefined
  private running = false

  constructor(
    readonly db: AgentDatabase,
    readonly store: ActionStore,
    readonly registry: ActionExecutorRegistry,
    readonly config: AgentConfig,
    options: ActionWorkerOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 2_000
    this.leaseMs = options.leaseMs ?? 60_000
    this.defaultMaxAttempts = options.maxAttempts ?? 3
    this.retryBaseMs = options.retryBaseMs ?? 2_000
    this.retryCapMs = options.retryCapMs ?? 15 * 60_000
    this.expiryCheckIntervalMs = options.expiryCheckIntervalMs ?? 30_000
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
    this.scheduleExpiryCheck()
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    this.controller?.abort()
    await this.draining?.catch(() => undefined)
  }

  /**
   * Exponential backoff for a failed attempt, capped so a wedged executor
   * cannot park an approved action for longer than an operator would wait.
   * Attempt 1 → base, attempt 2 → 2×base, attempt 3 → 4×base, …
   */
  nextRetryDelayMs(job: Pick<AgentActionJob, 'attempt'>): number {
    const exponent = Math.max(0, job.attempt - 1)
    return Math.min(this.retryBaseMs * (2 ** exponent), this.retryCapMs)
  }

  async runOnce(now = new Date()): Promise<boolean> {
    const job = this.store.claimJob(this.workerId, this.leaseMs, now)
    if (!job) return false
    const proposal = this.store.getProposal(job.proposalId)
    if (!proposal) {
      this.store.failJob(job.id, 'Proposal not found', true)
      return true
    }
    // Executors are registered per connector catalog id, mirroring the sync
    // worker's driver registry, so resolve the integration before looking one
    // up. An integration that is gone or no longer active can never execute.
    const integration = this.db.getIntegration(proposal.executorIntegrationId)
    if (!integration || integration.state !== 'active') {
      this.store.failJob(job.id, `Executor integration ${proposal.executorIntegrationId} is not active`, true)
      return true
    }

    // Session connector authority is re-checked at the last possible point,
    // immediately before the external executor is selected. This makes a
    // disconnect a revocation: an action approved while the connector was
    // attached cannot execute later if that session binding has disappeared.
    // Manual/non-session investigations keep their existing governed path.
    const investigation = this.store.getInvestigation(proposal.investigationId)
    if (investigation?.mastraThreadId) {
      try {
        requireSessionConnectorBinding(this.db, integration.id, {
          sessionId: investigation.mastraThreadId,
          actorOid: proposal.proposedByOperatorId,
        })
      } catch (cause) {
        const message = cause instanceof SessionConnectorAccessError
          ? `${cause.code}: ${cause.message}`
          : cause instanceof Error ? cause.message : 'Session connector authorization failed'
        this.store.failJob(job.id, message, true)
        return true
      }
    }

    const executor = this.registry.get(integration.catalogId)
    // A missing executor is permanent for this process: retrying would be a
    // no-op that re-claims the job on every drain pass and spins the loop.
    if (!executor) {
      this.store.failJob(job.id, `No action executor installed for ${integration.catalogId}`, true)
      return true
    }

    this.controller = new AbortController()
    try {
      const result = await executor.execute({ job, proposal, config: this.config, signal: this.controller.signal })
      this.store.completeJob(job.id, result, now)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Action execution failed'
      const terminal = job.attempt >= job.maxAttempts
      this.store.failJob(job.id, message, terminal, terminal ? 0 : this.nextRetryDelayMs(job), now)
    } finally {
      this.controller = undefined
    }
    return true
  }

  private schedule(delay: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.draining = this.drain()
      void this.draining.catch((cause) => console.error('[action-worker] drain failed', cause)).finally(() => {
        this.draining = undefined
        this.schedule(this.pollMs)
      })
    }, delay)
    this.timer.unref?.()
  }

  private scheduleExpiryCheck(): void {
    if (!this.running) return
    this.expiryTimer = setTimeout(() => {
      const expired = this.store.expireStaleProposals()
      if (expired > 0) console.log(`[action-worker] expired ${expired} stale proposals`)
      this.scheduleExpiryCheck()
    }, this.expiryCheckIntervalMs)
    this.expiryTimer.unref?.()
  }

  private async drain(): Promise<void> {
    while (this.running && await this.runOnce()) {
      // Drain every ready job before returning to the polling interval.
    }
  }
}