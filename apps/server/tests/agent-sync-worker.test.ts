import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '../src/agent/config.js'
import { AgentDatabase } from '../src/agent/database.js'
import { AgentService } from '../src/agent/service.js'
import { ConnectorRegistry, SyncWorker, type ConnectorDriver } from '../src/agent/sync-worker.js'
import { TerrainStore } from '../src/agent/terrain-store.js'

describe('connector synchronization worker', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  async function setup(driver: ConnectorDriver, options: ConstructorParameters<typeof SyncWorker>[3] = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-sync-test-'))
    const db = new AgentDatabase(':memory:')
    const terrain = new TerrainStore(db)
    const registry = new ConnectorRegistry().register('exchange-email', driver)
    const worker = new SyncWorker(db, terrain, registry, options)
    const config: AgentConfig = {
      mode: 'local', profile: 'gcc', host: 'localhost', port: 3210, publicOrigin: 'http://localhost:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
    const service = new AgentService(db, config, terrain, worker)
    const owner = { oid: 'owner', tenantId: 'tenant', displayName: 'Owner', roles: ['Papyrus.System.Owner' as const], groups: [], source: 'development' as const }
    const created = service.createIntegration(owner, 'exchange-email', { name: 'Mailbox', scope: 'operations', settings: {} })
    await service.testIntegration(owner, created.id)
    service.submitIntegration(owner, created.id)
    const integration = service.activateIntegration(owner, created.id)
    disposers.push(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }) })
    return { db, terrain, worker, service, owner, integration }
  }

  it('runs an incremental driver, commits evidence, advances its cursor, and schedules the next run', async () => {
    const sync = vi.fn(async () => ({
      observations: [{
        sourceRecordId: 'mail-1', observedAt: '2026-09-02T07:00:00.000Z', evidenceType: 'HumanContext', subject: 'message:1', payload: { subject: 'Status' },
        terrain: { entities: [{ externalId: 'account:analyst', kind: 'UserAccount', label: 'Analyst' }] },
      }], nextCursor: 'cursor-1', hasMore: false,
    }))
    const { worker, terrain, service, owner, integration } = await setup({
      test: async () => ({ reachable: true, authenticated: true, message: 'Connected' }), sync,
    }, { syncIntervalMs: 60_000 })
    expect(await worker.runOnce(new Date('2100-09-02T07:00:00.000Z'))).toBe(true)
    expect(sync).toHaveBeenCalledOnce()
    expect(terrain.checkpoint(integration.id)?.cursor).toBe('cursor-1')
    expect(service.terrainSnapshot(owner)).toMatchObject({ observationCount: 1, entities: [{ label: 'Analyst' }] })
    expect(service.integrations(owner)[0]).toMatchObject({ health: 'healthy', lastSyncAt: expect.any(String), lastEvidenceAt: '2026-09-02T07:00:00.000Z' })
    expect(terrain.listJobs(integration.id).map((job) => job.status).sort()).toEqual(['completed', 'queued'])
  })

  it('retries with backoff and stops after the bounded attempt count', async () => {
    const driver: ConnectorDriver = {
      test: async () => ({ reachable: true, authenticated: true, message: 'Connected' }),
      sync: async () => { throw new Error('upstream unavailable') },
    }
    const { worker, terrain, service, owner, integration } = await setup(driver, { retryBaseMs: 100, maxAttempts: 2 })
    expect(await worker.runOnce(new Date('2100-09-02T07:00:00.000Z'))).toBe(true)
    expect(terrain.listJobs(integration.id)[0]).toMatchObject({ status: 'queued', attempt: 1, error: 'upstream unavailable' })
    expect(service.integrations(owner)[0]).toMatchObject({ health: 'degraded', lastSyncError: 'upstream unavailable' })
    expect(await worker.runOnce(new Date('2100-09-02T07:00:00.101Z'))).toBe(true)
    expect(terrain.listJobs(integration.id)[0]).toMatchObject({ status: 'failed', attempt: 2 })
  })

  it('recovers an expired job lease for another worker', async () => {
    const driver: ConnectorDriver = {
      test: async () => ({ reachable: true, authenticated: true, message: 'Connected' }),
      sync: async () => ({ observations: [], hasMore: false }),
    }
    const { terrain, integration } = await setup(driver)
    const first = terrain.claimSync('worker-a', 100, new Date('2100-09-02T07:00:00.000Z'))
    expect(first).toMatchObject({ status: 'running', lockedBy: 'worker-a', attempt: 1 })
    const recovered = terrain.claimSync('worker-b', 100, new Date('2100-09-02T07:00:00.101Z'))
    expect(recovered).toMatchObject({ id: first?.id, status: 'running', lockedBy: 'worker-b', attempt: 2, integrationId: integration.id })
  })
})
