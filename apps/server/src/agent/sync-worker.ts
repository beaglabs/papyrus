import { randomUUID } from 'node:crypto'
import type { IntegrationConfiguration, ObservationInput, SyncJob } from '@papyrus/contracts'
import { CyberDatabase } from './database.js'
import { TerrainStore } from './terrain-store.js'

export interface ConnectorContext {
  integration: IntegrationConfiguration
  cursor?: string
  signal: AbortSignal
}

export interface ConnectorTestResult {
  reachable: boolean
  authenticated: boolean
  message: string
  details?: Record<string, unknown>
}

export interface SyncBatch {
  observations: ObservationInput[]
  nextCursor?: string
  hasMore: boolean
}

export interface ConnectorDriver {
  test(context: ConnectorContext): Promise<ConnectorTestResult>
  sync(context: ConnectorContext): Promise<SyncBatch>
}

export class ConnectorRegistry {
  private readonly drivers = new Map<string, ConnectorDriver>()

  register(catalogId: string, driver: ConnectorDriver): this {
    if (this.drivers.has(catalogId)) throw new Error(`Connector driver already registered for ${catalogId}`)
    this.drivers.set(catalogId, driver)
    return this
  }

  get(catalogId: string): ConnectorDriver | undefined { return this.drivers.get(catalogId) }
  has(catalogId: string): boolean { return this.drivers.has(catalogId) }
}

export interface IntegrationSyncRuntime {
  supports(integration: IntegrationConfiguration): boolean
  test(integration: IntegrationConfiguration): Promise<ConnectorTestResult | undefined>
  enqueue(integration: IntegrationConfiguration, runAfter?: string): SyncJob | undefined
  cancel(integrationId: string): void
}

export interface SyncWorkerOptions {
  pollMs?: number
  leaseMs?: number
  syncIntervalMs?: number
  retryBaseMs?: number
  maxAttempts?: number
  maxBatchesPerRun?: number
}

export class SyncWorker implements IntegrationSyncRuntime {
  readonly workerId = `papyrus-${process.pid}-${randomUUID()}`
  private readonly pollMs: number
  private readonly leaseMs: number
  private readonly syncIntervalMs: number
  private readonly retryBaseMs: number
  private readonly maxAttempts: number
  private readonly maxBatchesPerRun: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private draining: Promise<void> | undefined
  private running = false

  constructor(
    readonly db: CyberDatabase,
    readonly terrain: TerrainStore,
    readonly registry: ConnectorRegistry,
    options: SyncWorkerOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 2_000
    this.leaseMs = options.leaseMs ?? 60_000
    this.syncIntervalMs = options.syncIntervalMs ?? 60_000
    this.retryBaseMs = options.retryBaseMs ?? 1_000
    this.maxAttempts = options.maxAttempts ?? 5
    this.maxBatchesPerRun = options.maxBatchesPerRun ?? 100
  }

  supports(integration: IntegrationConfiguration): boolean { return this.registry.has(integration.catalogId) }

  async test(integration: IntegrationConfiguration): Promise<ConnectorTestResult | undefined> {
    const driver = this.registry.get(integration.catalogId)
    if (!driver) return undefined
    const controller = new AbortController()
    const cursor = this.terrain.checkpoint(integration.id)?.cursor
    return driver.test({ integration, ...(cursor ? { cursor } : {}), signal: controller.signal })
  }

  enqueue(integration: IntegrationConfiguration, runAfter?: string): SyncJob | undefined {
    if (!this.supports(integration)) return undefined
    return this.terrain.enqueueSync(integration.id, runAfter)
  }

  cancel(integrationId: string): void { this.terrain.cancelSync(integrationId) }

  start(): void {
    if (this.running) return
    this.running = true
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.controller?.abort()
    await this.draining?.catch(() => undefined)
  }

  async runOnce(now = new Date()): Promise<boolean> {
    const job = this.terrain.claimSync(this.workerId, this.leaseMs, now)
    if (!job) return false
    const integration = this.db.getIntegration(job.integrationId)
    if (!integration || integration.state !== 'active') {
      this.terrain.cancelSync(job.integrationId)
      return true
    }
    const driver = this.registry.get(integration.catalogId)
    if (!driver) {
      const message = `Connector driver is not installed for ${integration.catalogId}`
      this.terrain.retrySync(job.id, message, now.toISOString(), true)
      this.db.recordSyncFailure(integration.id, message)
      return true
    }

    this.controller = new AbortController()
    try {
      let cursor = this.terrain.checkpoint(integration.id)?.cursor
      let latestEvidence: string | undefined
      for (let batchNumber = 0; batchNumber < this.maxBatchesPerRun; batchNumber += 1) {
        const batch = await driver.sync({ integration, ...(cursor ? { cursor } : {}), signal: this.controller.signal })
        for (const observation of batch.observations) {
          this.terrain.ingest(integration, observation)
          if (!latestEvidence || observation.observedAt > latestEvidence) latestEvidence = observation.observedAt
        }
        cursor = batch.nextCursor
        this.terrain.saveCheckpoint(integration.id, cursor)
        if (!batch.hasMore) break
        if (batchNumber === this.maxBatchesPerRun - 1) throw new Error(`Connector exceeded ${this.maxBatchesPerRun} batches in one sync run`)
      }
      this.terrain.completeSync(job.id)
      if (this.db.getIntegration(integration.id)?.state === 'active') {
        this.db.recordSyncSuccess(integration.id, latestEvidence)
        const next = new Date(now.getTime() + this.syncIntervalMs).toISOString()
        this.terrain.enqueueSync(integration.id, next)
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Connector synchronization failed'
      if (this.db.getIntegration(integration.id)?.state !== 'active') {
        this.terrain.cancelSync(integration.id)
        return true
      }
      const terminal = job.attempt >= this.maxAttempts
      const exponent = Math.max(0, job.attempt - 1)
      const delay = Math.min(this.retryBaseMs * (2 ** exponent), 15 * 60_000)
      this.terrain.retrySync(job.id, message, new Date(now.getTime() + delay).toISOString(), terminal)
      this.db.recordSyncFailure(integration.id, message)
    } finally {
      this.controller = undefined
    }
    return true
  }

  private schedule(delay: number): void {
    if (!this.running) return
    this.timer = setTimeout(() => {
      this.draining = this.drain()
      void this.draining.catch((cause) => console.error('[sync-worker] drain failed', cause)).finally(() => {
        this.draining = undefined
        this.schedule(this.pollMs)
      })
    }, delay)
    this.timer.unref?.()
  }

  private async drain(): Promise<void> {
    while (this.running && await this.runOnce()) {
      // Drain every ready job before returning to the polling interval.
    }
  }
}
