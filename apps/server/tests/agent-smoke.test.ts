import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CyberConfig } from '../src/cyber/config.js'
import { CyberDatabase } from '../src/cyber/database.js'
import { ActionExecutorRegistry, ActionWorker, type ActionExecutor, type ActionExecutorContext, type ActionResult } from '../src/cyber/action-worker.js'
import { ActionStore } from '../src/cyber/action-store.js'
import { CyberService } from '../src/cyber/service.js'
import { ConnectorRegistry, SyncWorker, type ConnectorDriver } from '../src/cyber/sync-worker.js'
import { TerrainStore } from '../src/cyber/terrain-store.js'

describe('end-to-end smoke test: email → investigation → action → receipt', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  interface SmokeTestSetup {
    db: CyberDatabase
    terrain: TerrainStore
    actionStore: ActionStore
    service: CyberService
    actionWorker: ActionWorker
    executorRegistry: ActionExecutorRegistry
    syncWorker: SyncWorker
    config: CyberConfig
    owner: { oid: string; tenantId: string; displayName: string; roles: string[]; groups: string[]; source: string }
    emailIntegrationId: string
    firewallIntegrationId: string
    observationSourceId: string
    executeCalls: string[]
  }

  async function setupSmokeTest(options: {
    executor?: ActionExecutor
    syncDriver?: ConnectorDriver
  } = {}): Promise<SmokeTestSetup> {
    const dataDir = mkdtempSync(join(tmpdir(), 'papyrus-smoke-'))
    const db = new CyberDatabase(':memory:')
    const terrain = new TerrainStore(db)
    const actionStore = new ActionStore(db)
    const connectors = new ConnectorRegistry()
    const executorRegistry = new ActionExecutorRegistry()
    const syncWorker = new SyncWorker(db, terrain, connectors)
    const actionWorkerOptions = { pollMs: 10, leaseMs: 5_000, maxAttempts: 3, retryBaseMs: 50 }
    const config: CyberConfig = {
      mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 3210, publicOrigin: 'http://127.0.0.1:3210',
      dataDir, databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
      organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
    }
    const actionWorker = new ActionWorker(db, actionStore, executorRegistry, config, actionWorkerOptions)
    const service = new CyberService(db, config, terrain, syncWorker, actionStore, executorRegistry, actionWorker)
    const owner = {
      oid: 'owner', tenantId: 'tenant', displayName: 'Cyber Ops Owner',
      roles: ['Papyrus.System.Owner', 'Papyrus.Action.Approve'] as string[],
      groups: [] as string[], source: 'development',
    }

    // Register the exchange email driver (always, with a stub if none provided)
    const defaultDriver: ConnectorDriver = options.syncDriver ?? {
      async test() { return { reachable: true, authenticated: true, message: 'Connected' } },
      async sync() { return { observations: [], hasMore: false } },
    }
    connectors.register('exchange-email', defaultDriver)

    // Executors are bound to the connector catalog that performs them, so the
    // executor for the firewall integration is registered under its catalog id.
    const executeCalls: string[] = []
    const firewallExecutor: ActionExecutor = options.executor ?? {
      async test() { return { reachable: true, authenticated: true, message: 'ready' } },
      async execute(ctx: ActionExecutorContext): Promise<ActionResult> {
        executeCalls.push(ctx.job.idempotencyKey)
        return { result: 'success', message: `Executed: ${ctx.job.action} on ${ctx.job.target}` }
      },
    }
    executorRegistry.register('firewall-executor', firewallExecutor)

    // Create and activate the exchange-email integration
    const emailIntegration = service.createIntegration(owner as never, 'exchange-email', { name: 'Ops Mailbox', scope: 'operations', settings: {} })
    await service.testIntegration(owner as never, emailIntegration.id)
    service.submitIntegration(owner as never, emailIntegration.id)
    service.activateIntegration(owner as never, emailIntegration.id)

    // Create and activate the firewall-executor integration.
    // The catalog entry is critical / controlled_actions: its auth schemes are
    // certificate, mTLS, and vault_reference, and the manifest requires an
    // HTTPS endpoint, so a bare settings object would be rejected by the
    // configuration test.
    const firewallIntegration = service.createIntegration(owner as never, 'firewall-executor', {
      name: 'Firewall',
      scope: 'network',
      settings: {},
      endpoint: 'https://firewall.example.internal/executor',
      credentialRef: 'vault://corp-vault/papyrus/firewall-executor',
    })
    await service.testIntegration(owner as never, firewallIntegration.id)
    service.submitIntegration(owner as never, firewallIntegration.id)
    service.activateIntegration(owner as never, firewallIntegration.id)

    // The exchange-email adapter is a pull adapter, not an Observation API
    // source, so observation ingestion needs a dedicated push source.
    // Observation API sources are daemon-owned source profiles: registration
    // places them straight into 'active', so they skip the draft → tested →
    // awaiting_approval → active lifecycle entirely.
    const observationSource = service.createIntegration(owner as never, 'observation-api', { name: 'Custom Source', scope: 'daemon', settings: {} })
    expect(observationSource.state).toBe('active')

    disposers.push(() => { db.close(); rmSync(dataDir, { recursive: true, force: true }) })
    return {
      db, terrain, actionStore, service, actionWorker, executorRegistry, owner,
      syncWorker, config,
      emailIntegrationId: emailIntegration.id, firewallIntegrationId: firewallIntegration.id,
      observationSourceId: observationSource.id,
      executeCalls,
    }
  }

  it('creates an investigation from an email and lists it', async () => {
    const { service, owner, emailIntegrationId } = await setupSmokeTest()
    const investigation = service.createInvestigation(
      owner as never, 'Unusual workstation activity on workstation-17', 'email',
      emailIntegrationId, 'internetMessageId-001',
    )
    expect(investigation.status).toBe('open')
    expect(investigation.trigger).toBe('email')
    expect(investigation.triggerIntegrationId).toBe(emailIntegrationId)
    const listed = service.listInvestigations(owner as never)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ title: 'Unusual workstation activity on workstation-17' })
  })

  it('proposes an action, requires approval, and executes exactly once despite retries', async () => {
    const { service, actionStore, actionWorker, owner, firewallIntegrationId, executeCalls } = await setupSmokeTest()

    // 1. Create investigation
    const investigation = service.createInvestigation(owner as never, 'Isolate workstation-17', 'email')

    // 2. Propose an action
    const proposal = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId,
      'isolate', 'workstation-17', ['claim-1', 'claim-2'],
    )
    expect(proposal.status).toBe('proposed')
    expect(proposal.idempotencyKey).toHaveLength(64)
    // The investigation advances once a proposal exists; re-read it rather
    // than asserting against the snapshot taken before the proposal.
    expect(actionStore.getInvestigation(investigation.id)!.status).toBe('action_proposed')

    // 3. Duplicate proposal returns the same proposal (idempotency)
    const duplicate = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId,
      'isolate', 'workstation-17', ['claim-1', 'claim-2'],
    )
    expect(duplicate.id).toBe(proposal.id)

    // 4. Denial terminates the proposal
    const denied = service.denyProposal(owner as never, proposal.id, 'not enough evidence')
    expect(denied.status).toBe('denied')
    expect(denied.denialReason).toBe('not enough evidence')

    // 5. Create a new proposal for the positive path
    const proposal2 = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId,
      'notify', 'workstation-17', ['claim-1', 'claim-2', 'claim-3'],
    )
    expect(proposal2.id).not.toBe(proposal.id)

    // 6. Approval creates exactly one action job
    const approved = service.approveProposal(owner as never, proposal2.id)
    expect(approved.status).toBe('approved')
    const job = actionStore.getJobByProposal(proposal2.id)
    expect(job).toBeDefined()
    expect(job!.status).toBe('queued')

    // 7. Worker executes the job
    const executed = await actionWorker.runOnce(new Date('2100-09-02T08:00:00.000Z'))
    expect(executed).toBe(true)
    expect(executeCalls).toHaveLength(1)
    expect(executeCalls[0]).toBe(proposal2.idempotencyKey)

    // 8. The proposal is now executed
    const finalProposal = actionStore.getProposal(proposal2.id)
    expect(finalProposal!.status).toBe('executed')

    // 9. A receipt exists
    const receipt = actionStore.getReceiptByJob(job!.id)
    expect(receipt).toBeDefined()
    expect(receipt!.result).toBe('success')
    expect(receipt!.message).toContain('Executed: notify on workstation-17')

    // 10. The investigation is resolved
    const finalInvestigation = actionStore.getInvestigation(investigation.id)
    expect(finalInvestigation!.status).toBe('resolved')
  })

  it('prevents execution without the required Entra role', async () => {
    const { service, actionStore, owner, firewallIntegrationId } = await setupSmokeTest()
    const investigation = service.createInvestigation(owner as never, 'Test investigation', 'manual')
    const proposal = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId,
      'block', 'route-42', ['claim-1'],
    )

    // An approver without the role cannot approve
    const approver = { ...owner, oid: 'approver-no-role', roles: ['Papyrus.Integration.View'] }
    expect(() => service.approveProposal(approver as never, proposal.id)).toThrow(/Papyrus.Action.Approve is required/)

    // The proposal remains in 'proposed' state
    expect(actionStore.getProposal(proposal.id)!.status).toBe('proposed')
  })

  it('handles a daemon restart: job completes after re-claiming an expired lease', async () => {
    const { service, actionStore, actionWorker, owner, firewallIntegrationId, executeCalls } = await setupSmokeTest()
    const investigation = service.createInvestigation(owner as never, 'Restart test', 'manual')
    const proposal = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId,
      'notify', 'host-99', ['claim-1'],
    )
    service.approveProposal(owner as never, proposal.id)
    const job = actionStore.getJobByProposal(proposal.id)

    // Simulate a crash: a worker had claimed the job (consuming attempt 1) and
    // began executing, then died without releasing it, leaving a running job
    // with a stale lease.
    const now = new Date('2100-09-02T09:00:00.000Z')
    actionStore.db.sqlite.prepare("UPDATE cyber_action_jobs SET status='running',attempt=1,locked_by=?,locked_at=?,started_at=?,lease_expires_at=? WHERE id=?")
      .run('papyrus-action-dead-worker', now.toISOString(), now.toISOString(), new Date(now.getTime() - 1000).toISOString(), job!.id)

    // The worker reclaims the expired job on next poll. A lease expiry is a
    // daemon fault rather than an executor fault, so it is retried at once
    // instead of being held for a backoff it never earned.
    const reclaimed = await actionWorker.runOnce(now)
    expect(reclaimed).toBe(true)
    expect(executeCalls).toHaveLength(1)

    // The job completed successfully
    const finalJob = actionStore.getJob(job!.id)
    expect(finalJob!.status).toBe('completed')
    expect(finalJob!.attempt).toBe(2) // second attempt
  })

  it('expires stale proposals past their expiry time', async () => {
    const { actionStore, service, owner, firewallIntegrationId } = await setupSmokeTest()
    const investigation = service.createInvestigation(owner as never, 'Expiry test', 'manual')
    const past = new Date(Date.now() - 60_000).toISOString()
    const proposal = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId,
      'block', 'route-99', ['claim-1'], undefined, past,
    )
    expect(proposal.expiresAt).toBeDefined()

    const expired = actionStore.expireStaleProposals()
    expect(expired).toBeGreaterThanOrEqual(1)
    expect(actionStore.getProposal(proposal.id)!.status).toBe('expired')

    // Expired proposals cannot be approved
    expect(() => service.approveProposal(owner as never, proposal.id)).toThrow(/expired/i)
  })

  it('accepts duplicate observations idempotently (same sourceRecordId, same content)', async () => {
    const { service, terrain, observationSourceId } = await setupSmokeTest()
    const observation = {
      sourceRecordId: 'mail-dup-1', observedAt: '2026-09-02T07:00:00.000Z',
      evidenceType: 'HumanContext', subject: 'message:1', payload: { subject: 'Alert' },
    }
    const result1 = service.ingestObservationWithScopedCredential(observationSourceId, observation)
    expect(result1.created).toBe(true)
    const result2 = service.ingestObservationWithScopedCredential(observationSourceId, observation)
    expect(result2.created).toBe(false)
    expect(terrain.snapshot().observationCount).toBe(1)
  })

  it('retries a failed executor and eventually terminates after max attempts', async () => {
    const { actionStore, actionWorker, service, owner, firewallIntegrationId } = await setupSmokeTest({
      executor: {
        async test() { return { reachable: true, authenticated: true, message: 'ready' } },
        async execute(): Promise<ActionResult> { throw new Error('executor unavailable') },
      },
    })
    const investigation = service.createInvestigation(owner as never, 'Failure test', 'manual')
    const proposal = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId,
      'notify', 'host-fail', ['claim-1'],
    )
    service.approveProposal(owner as never, proposal.id)

    // The setup runs the worker with retryBaseMs = 50, so the backoff after
    // attempt N is 50 × 2^(N-1) milliseconds.
    const t0 = new Date('2100-09-02T10:00:00.000Z')

    // First attempt fails and is requeued behind a backoff
    await actionWorker.runOnce(t0)
    const job1 = actionStore.getJobByProposal(proposal.id)
    expect(job1!.status).toBe('queued')
    expect(job1!.attempt).toBe(1)
    expect(job1!.runAfter).toBe(new Date(t0.getTime() + 50).toISOString())

    // The job is not claimable until the backoff elapses. Without this hold
    // the worker's drain loop would re-claim the job immediately and spin.
    expect(await actionWorker.runOnce(new Date(t0.getTime() + 10))).toBe(false)
    expect(actionStore.getJobByProposal(proposal.id)!.attempt).toBe(1)

    // Second attempt fails: 50 × 2 = 100ms backoff
    await actionWorker.runOnce(new Date(t0.getTime() + 50))
    const job2 = actionStore.getJobByProposal(proposal.id)
    expect(job2!.attempt).toBe(2)
    expect(job2!.runAfter).toBe(new Date(t0.getTime() + 150).toISOString())

    // Third attempt is terminal (maxAttempts is 3), so it is failed outright
    // with no further backoff.
    await actionWorker.runOnce(new Date(t0.getTime() + 150))
    const job3 = actionStore.getJob(job1!.id)
    expect(job3!.status).toBe('failed')
    expect(job3!.attempt).toBe(3)
    expect(job3!.runAfter).toBeUndefined()

    // Proposal is marked failed
    expect(actionStore.getProposal(proposal.id)!.status).toBe('failed')
  })

  it('requires the integration management role to propose an action', async () => {
    const { service, actionStore, owner, firewallIntegrationId } = await setupSmokeTest()
    const investigation = service.createInvestigation(owner as never, 'Role test', 'manual')
    const viewer = { ...owner, oid: 'viewer', roles: ['Papyrus.Integration.View'] }

    expect(() => service.createProposal(
      viewer as never, investigation.id, firewallIntegrationId, 'isolate', 'host-role', ['claim-1'],
    )).toThrow(/Papyrus.Integration.Manage is required/)

    expect(actionStore.listProposals(investigation.id)).toHaveLength(0)
  })

  it('refuses to propose or approve an action when no executor is installed', async () => {
    const { db, config, terrain, syncWorker, actionStore, service, owner, firewallIntegrationId } = await setupSmokeTest()
    // Same ledger, but nothing in the process can carry the action out.
    const unequipped = new CyberService(db, config, terrain, syncWorker, actionStore, new ActionExecutorRegistry())
    const investigation = service.createInvestigation(owner as never, 'No executor', 'manual')

    expect(() => unequipped.createProposal(
      owner as never, investigation.id, firewallIntegrationId, 'isolate', 'host-none', ['claim-1'],
    )).toThrow(/No action executor is installed/)

    // An existing proposal is still not approvable while nothing can run it.
    const proposal = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId, 'isolate', 'host-none', ['claim-1'],
    )
    expect(() => unequipped.approveProposal(owner as never, proposal.id)).toThrow(/No action executor is installed/)
    expect(actionStore.getProposal(proposal.id)!.status).toBe('proposed')
  })

  it('refuses to approve an action when no worker can execute it', async () => {
    const { db, config, terrain, syncWorker, actionStore, service, executorRegistry, owner, firewallIntegrationId } = await setupSmokeTest()
    // The executor is installed, but no worker is running to pick the job up.
    const unstaffed = new CyberService(db, config, terrain, syncWorker, actionStore, executorRegistry)
    const investigation = service.createInvestigation(owner as never, 'No worker', 'manual')
    const proposal = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId, 'isolate', 'host-idle', ['claim-1'],
    )

    expect(() => unstaffed.approveProposal(owner as never, proposal.id)).toThrow(/Action worker is not running/)

    // The refusal happens before the decision is recorded, so nothing ran.
    expect(actionStore.getProposal(proposal.id)!.status).toBe('proposed')
    expect(actionStore.getJobByProposal(proposal.id)).toBeUndefined()
  })

  it('records the action decision history in the append-only audit chain', async () => {
    const { db, service, actionWorker, owner, firewallIntegrationId } = await setupSmokeTest()
    const investigation = service.createInvestigation(owner as never, 'Audit test', 'manual')

    const executed = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId, 'isolate', 'host-audit', ['claim-1'],
    )
    service.approveProposal(owner as never, executed.id)
    await actionWorker.runOnce(new Date('2100-09-02T11:00:00.000Z'))

    const denied = service.createProposal(
      owner as never, investigation.id, firewallIntegrationId, 'block', 'route-audit', ['claim-1'],
    )
    service.denyProposal(owner as never, denied.id, 'insufficient evidence')

    const actions = db.listEvents(firewallIntegrationId).map((event) => event.action)
    expect(actions).toContain('ActionProposed')
    expect(actions).toContain('ActionApproved')
    expect(actions).toContain('ActionExecuted')
    expect(actions).toContain('ActionDenied')

    // Decisions share the integration lifecycle chain, which must stay intact.
    expect(db.verifyEventChain().valid).toBe(true)

    const receipt = db.listEvents(firewallIntegrationId).find((event) => event.action === 'ActionExecuted')
    expect(receipt!.actorOid).toBe(owner.oid)
    expect(receipt!.data).toMatchObject({ proposalId: executed.id, result: 'success' })

    const denial = db.listEvents(firewallIntegrationId).find((event) => event.action === 'ActionDenied')
    expect(denial!.data).toMatchObject({ proposalId: denied.id, reason: 'insufficient evidence' })
  })
})
