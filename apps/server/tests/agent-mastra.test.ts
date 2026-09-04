import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadAgentConfig, type AgentConfig } from '../src/agent/config.js'
import { ActionStore, ThreadConflictError } from '../src/agent/action-store.js'
import { AgentDatabase } from '../src/agent/database.js'
import { MastraRuntime } from '../src/agent/mastra/runtime.js'
import {
  assertUsableSandbox,
  localSandboxOptions,
  probeIsolation,
  resolveSandboxPolicy,
  SandboxUnavailableError,
} from '../src/agent/mastra/sandbox-policy.js'
import { SignalOutbox } from '../src/agent/mastra/signal-outbox.js'
import {
  AgentToolAuthorizationError,
  assertAgentSafeTool,
  INVESTIGATION_TOOLS,
  isInvestigationTool,
  listProposals,
  runInvestigationTool,
  terrainQuery,
} from '../src/agent/mastra/tools.js'
import { AgentService } from '../src/agent/service.js'
import { ConnectorRegistry, SyncWorker } from '../src/agent/sync-worker.js'
import { TerrainStore } from '../src/agent/terrain-store.js'

const CAN_RUN_ALL = () => true
const CAN_RUN_NONE = () => false

function config(): AgentConfig {
  return {
    mode: 'local', profile: 'gcc', host: '127.0.0.1', port: 3210, publicOrigin: 'http://127.0.0.1:3210',
    dataDir: mkdtempSync(join(tmpdir(), 'papyrus-mastra-')),
    databasePath: ':memory:', portalSecret: 'portal-secret-at-least-thirty-two-characters',
    organizationName: 'Example Agency', cloud: 'Public', licenseRequired: false, licenseAuthorities: {},
  }
}

describe('signal outbox', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  function outbox(maxAttempts = 5) {
    const db = new AgentDatabase(':memory:')
    disposers.push(() => db.close())
    return new SignalOutbox(db, maxAttempts)
  }

  it('persists signals as pending before any delivery attempt', () => {
    const store = outbox()
    const record = store.enqueue({ type: 'investigation_created', investigationId: 'inv-1', payload: { title: 'Phish report' } })

    expect(record.status).toBe('pending')
    expect(record.investigationId).toBe('inv-1')
    expect(record.payload.title).toBe('Phish report')
    expect(store.counts().pending).toBe(1)
  })

  it('leases signals on claim and marks them delivered on ack', () => {
    const store = outbox()
    store.enqueue({ type: 'new_claim', investigationId: 'inv-1' })

    const claimed = store.claim('worker-a', 5_000)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.status).toBe('delivering')
    expect(claimed[0]?.lockedBy).toBe('worker-a')
    expect(claimed[0]?.attempts).toBe(1)

    // A second claim cannot take the same row while the lease is held.
    expect(store.claim('worker-b', 5_000)).toHaveLength(0)

    store.ack(claimed[0]!.id)
    expect(store.get(claimed[0]!.id)?.status).toBe('delivered')
    expect(store.counts()).toMatchObject({ delivered: 1, pending: 0 })
  })

  it('returns a failed signal to pending so it is retried', () => {
    const store = outbox()
    const record = store.enqueue({ type: 'evidence_threshold' })

    store.claim('worker-a', 5_000)
    store.fail(record.id, 'thread not bound')

    expect(store.get(record.id)?.status).toBe('pending')
    expect(store.get(record.id)?.error).toBe('thread not bound')
  })

  it('fails a signal permanently once attempts are exhausted', () => {
    const store = outbox(2)
    const record = store.enqueue({ type: 'contradiction' })

    store.claim('worker-a', 5_000)
    store.fail(record.id, 'boom')
    store.claim('worker-a', 5_000)
    store.fail(record.id, 'boom')

    expect(store.get(record.id)?.status).toBe('failed')
    expect(store.counts().failed).toBe(1)
    // Exhausted signals are never claimed again.
    expect(store.claim('worker-a', 5_000)).toHaveLength(0)
  })

  it('reclaims a lease whose holder died', () => {
    const store = outbox()
    store.enqueue({ type: 'posture_review' })

    const first = new Date('2026-01-01T00:00:00.000Z')
    const later = new Date('2026-01-01T00:10:00.000Z')
    expect(store.claim('dead-worker', 1_000, 25, first)).toHaveLength(1)

    const reclaimed = store.claim('live-worker', 1_000, 25, later)
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.lockedBy).toBe('live-worker')
  })

  it('lists signals by investigation', () => {
    const store = outbox()
    store.enqueue({ type: 'new_claim', investigationId: 'inv-1' })
    store.enqueue({ type: 'new_claim', investigationId: 'inv-2' })
    store.enqueue({ type: 'contradiction', investigationId: 'inv-1' })

    expect(store.byInvestigation('inv-1')).toHaveLength(2)
    expect(store.byInvestigation('inv-2')).toHaveLength(1)
  })
})

describe('sandbox policy', () => {
  it('keeps Bubblewrap as the default Linux backend', () => {
    expect(probeIsolation({ platform: 'linux', canRun: CAN_RUN_ALL })).toBe('bwrap')
    expect(probeIsolation({ platform: 'linux', canRun: CAN_RUN_NONE })).toBe('none')
    expect(probeIsolation({ platform: 'darwin', canRun: CAN_RUN_ALL })).toBe('none')
    expect(probeIsolation({ platform: 'win32', canRun: CAN_RUN_ALL })).toBe('none')
  })

  it('allows an explicit Seatbelt backend on macOS', () => {
    const binaries: string[] = []
    expect(probeIsolation({
      platform: 'darwin',
      isolation: 'seatbelt',
      canRun: (binary) => { binaries.push(binary); return true },
    })).toBe('seatbelt')
    expect(binaries).toEqual(['sandbox-exec'])

    const policy = resolveSandboxPolicy({
      dataDir: '/srv/papyrus',
      platform: 'darwin',
      isolation: 'seatbelt',
      canRun: CAN_RUN_ALL,
    })
    expect(policy).toMatchObject({
      enabled: true,
      isolation: 'seatbelt',
      allowNetwork: false,
      workingDirectory: '/srv/papyrus/sandbox',
    })
    expect(policy.reason).toMatch(/Seatbelt isolation/)
  })

  it('does not silently select Seatbelt on macOS', () => {
    const policy = resolveSandboxPolicy({
      dataDir: '/srv/papyrus', platform: 'darwin', canRun: CAN_RUN_ALL,
    })

    expect(policy.enabled).toBe(false)
    expect(policy.isolation).toBe('none')
    expect(policy.reason).toMatch(/PAPYRUS_SANDBOX_RUNTIME=seatbelt/)
  })

  it('rejects a backend on the wrong operating system before probing the binary', () => {
    const shouldNotProbe = () => { throw new Error('binary probe should not run') }
    expect(probeIsolation({
      platform: 'darwin', isolation: 'bwrap', canRun: shouldNotProbe,
    })).toBe('none')
    expect(probeIsolation({
      platform: 'linux', isolation: 'seatbelt', canRun: shouldNotProbe,
    })).toBe('none')

    expect(resolveSandboxPolicy({
      dataDir: '/srv/p', platform: 'darwin', isolation: 'bwrap', canRun: CAN_RUN_ALL,
    }).reason).toMatch(/bwrap requires Linux/)
    expect(resolveSandboxPolicy({
      dataDir: '/srv/p', platform: 'linux', isolation: 'seatbelt', canRun: CAN_RUN_ALL,
    }).reason).toMatch(/seatbelt requires macOS/)
  })

  it('enables an isolated Bubblewrap sandbox with network denied', () => {
    const policy = resolveSandboxPolicy({
      dataDir: '/srv/papyrus', platform: 'linux', canRun: CAN_RUN_ALL,
    })

    expect(policy.enabled).toBe(true)
    expect(policy.isolation).toBe('bwrap')
    expect(policy.allowNetwork).toBe(false)
    expect(policy.workingDirectory).toBe('/srv/papyrus/sandbox')
  })

  it('refuses to enable a selected sandbox when its binary is unavailable', () => {
    const defaultBwrap = resolveSandboxPolicy({
      dataDir: '/srv/papyrus', platform: 'linux', canRun: CAN_RUN_NONE,
    })
    expect(defaultBwrap.enabled).toBe(false)
    expect(defaultBwrap.reason).toMatch(/Bubblewrap \(bwrap\).*refusing to run code unisolated/)

    const bwrap = resolveSandboxPolicy({
      dataDir: '/srv/papyrus', platform: 'linux', isolation: 'bwrap', canRun: CAN_RUN_NONE,
    })
    expect(bwrap.enabled).toBe(false)
    expect(bwrap.reason).toMatch(/Bubblewrap \(bwrap\).*refusing to run code unisolated/)

    const seatbelt = resolveSandboxPolicy({
      dataDir: '/srv/papyrus', platform: 'darwin', isolation: 'seatbelt', canRun: CAN_RUN_NONE,
    })
    expect(seatbelt.enabled).toBe(false)
    expect(seatbelt.reason).toMatch(/Seatbelt \(sandbox-exec\).*refusing to run code unisolated/)
  })

  it('honours an explicit execution opt-out even on a capable host', () => {
    const policy = resolveSandboxPolicy({
      dataDir: '/srv/papyrus', platform: 'linux', canRun: CAN_RUN_ALL, allowExecution: false,
    })

    expect(policy.enabled).toBe(false)
    expect(policy.isolation).toBe('bwrap')
    expect(policy.reason).toMatch(/disabled by configuration/)
  })

  it('returns Mastra constructor options for both supported native backends', () => {
    const disabled = resolveSandboxPolicy({ dataDir: '/srv/p', platform: 'darwin', canRun: CAN_RUN_ALL })
    expect(localSandboxOptions(disabled)).toBeUndefined()

    const bwrap = resolveSandboxPolicy({
      dataDir: '/srv/p', platform: 'linux', isolation: 'bwrap', canRun: CAN_RUN_ALL, readOnlyPaths: ['/srv/p/reference'],
    })
    expect(localSandboxOptions(bwrap)).toEqual({
      workingDirectory: '/srv/p/sandbox',
      isolation: 'bwrap',
      nativeSandbox: { allowNetwork: false, readOnlyPaths: ['/srv/p/reference'] },
    })

    const seatbelt = resolveSandboxPolicy({
      dataDir: '/srv/p', platform: 'darwin', isolation: 'seatbelt', canRun: CAN_RUN_ALL, readOnlyPaths: ['/srv/p/reference'],
    })
    expect(localSandboxOptions(seatbelt)).toEqual({
      workingDirectory: '/srv/p/sandbox',
      isolation: 'seatbelt',
      nativeSandbox: { allowNetwork: false, readOnlyPaths: ['/srv/p/reference'] },
    })
  })

  it('loads the sandbox backend from PAPYRUS_SANDBOX_RUNTIME and rejects unknown values', () => {
    const env = {
      PAPYRUS_MODE: 'local',
      PAPYRUS_PORTAL_SECRET: 'development-portal-secret',
      PAPYRUS_DEV_ENTRA_PRINCIPAL: JSON.stringify({
        oid: 'dev', tenantId: 'tenant', displayName: 'Developer', roles: [],
      }),
    }

    expect(loadAgentConfig({ ...env, PAPYRUS_SANDBOX_RUNTIME: 'bwrap' }).sandboxRuntime).toBe('bwrap')
    expect(loadAgentConfig({ ...env, PAPYRUS_SANDBOX_RUNTIME: 'seatbelt' }).sandboxRuntime).toBe('seatbelt')
    expect(() => loadAgentConfig({ ...env, PAPYRUS_SANDBOX_RUNTIME: 'docker' })).toThrow(
      /PAPYRUS_SANDBOX_RUNTIME must be bwrap or seatbelt/,
    )
  })

  it('fails closed when asserted', () => {
    const disabled = resolveSandboxPolicy({ dataDir: '/srv/p', platform: 'darwin', canRun: CAN_RUN_ALL })
    expect(() => assertUsableSandbox(disabled)).toThrow(SandboxUnavailableError)

    const enabled = resolveSandboxPolicy({ dataDir: '/srv/p', platform: 'darwin', isolation: 'seatbelt', canRun: CAN_RUN_ALL })
    expect(() => assertUsableSandbox(enabled)).not.toThrow()
  })
})

describe('investigation tools', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  function context() {
    const db = new AgentDatabase(':memory:')
    disposers.push(() => db.close())
    const actionStore = new ActionStore(db)
    const terrain = new TerrainStore(db)
    return { actionStore, terrain }
  }

  it('exposes only read-only tools', () => {
    for (const descriptor of Object.values(INVESTIGATION_TOOLS)) {
      expect(descriptor.authority).toBe('read_only')
    }
  })

  it('returns the current terrain snapshot', () => {
    const snapshot = terrainQuery(context())
    expect(snapshot).toMatchObject({ entities: [], relationships: [], observationCount: 0 })
  })

  it('returns an empty proposal list when nothing has been proposed', () => {
    expect(listProposals(context())).toEqual([])
    expect(listProposals(context(), { investigationId: 'missing' })).toEqual([])
  })

  it('refuses to let the agent hold an authorizing tool', () => {
    expect(() => assertAgentSafeTool('approveProposal')).toThrow(AgentToolAuthorizationError)
    expect(() => assertAgentSafeTool('denyProposal')).toThrow(AgentToolAuthorizationError)
    expect(() => assertAgentSafeTool('terrainQuery')).not.toThrow()

    expect(isInvestigationTool('terrainQuery')).toBe(true)
    expect(isInvestigationTool('approveProposal')).toBe(false)
  })

  it('dispatches by tool name', () => {
    const ctx = context()
    expect(runInvestigationTool('terrainQuery', ctx)).toMatchObject({ entities: [] })
    expect(runInvestigationTool('listInvestigations', ctx)).toEqual([])
    expect(runInvestigationTool('listProposals', ctx, { investigationId: 'missing' })).toEqual([])
  })
})

describe('mastra runtime without the harness installed', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  async function runtime() {
    const cfg = config()
    const db = new AgentDatabase(':memory:')
    const terrain = new TerrainStore(db)
    const actionStore = new ActionStore(db)
    const connectors = new ConnectorRegistry()
    const syncWorker = new SyncWorker(db, terrain, connectors)
    const service = new AgentService(db, cfg, terrain, syncWorker, actionStore)
    disposers.push(() => db.close(), () => rmSync(cfg.dataDir, { recursive: true, force: true }))
    const subject = new MastraRuntime(cfg, actionStore, terrain, service)
    await subject.start()
    return subject
  }

  it('records signals durably even when no harness is available', async () => {
    const subject = await runtime()
    expect(subject.harnessReady).toBe(false)

    subject.emitSignal({ type: 'investigation_created', investigationId: 'inv-1', payload: { title: 'Phish' } })

    expect(subject.signals.counts().pending).toBe(1)
    expect(subject.signals.pending()[0]?.investigationId).toBe('inv-1')
  })

  it('leaves signals pending rather than failing them when the harness is absent', async () => {
    const subject = await runtime()
    subject.emitSignal({ type: 'new_claim', investigationId: 'inv-1' })

    expect(await subject.drainSignals()).toBe(0)
    expect(subject.signals.counts()).toMatchObject({ pending: 1, failed: 0 })
  })

  it('creates an investigation from email and records the creation signal', async () => {
    const subject = await runtime()
    const investigation = subject.createInvestigationFromEmail({
      title: 'Suspicious mailbox rule', triggerIntegrationId: 'int-1', triggerMessageId: 'msg-1',
    })

    expect(investigation.title).toBe('Suspicious mailbox rule')
    // No harness means no thread binding yet; it happens once Mastra is present.
    expect(investigation.mastraThreadId).toBeUndefined()
    expect(subject.signals.byInvestigation(investigation.id)).toHaveLength(1)
    expect(subject.signals.byInvestigation(investigation.id)[0]?.type).toBe('investigation_created')
  })

  it('resolves a sandbox policy at startup', async () => {
    const subject = await runtime()
    expect(subject.sandboxPolicy).toBeDefined()
    expect(subject.sandboxPolicy?.allowNetwork).toBe(false)
  })
})

/**
 * These tests pin the delivery contract verified against @mastra/core 1.63.2.
 * `sendSignal` takes two positional arguments and returns an `accepted` promise
 * telling you what actually happened to the signal — so the fake agent stands in
 * for the real one and lets us assert both without installing Mastra.
 */
describe('signal delivery contract', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  interface SentSignal { type?: string; tagName?: string; contents?: string; attributes?: Record<string, unknown> }
  interface SentTarget { resourceId?: string; threadId?: string }
  interface FakeAgent {
    sendSignal: (signal: SentSignal, target: SentTarget) => { accepted: Promise<{ action: string }> }
  }

  /**
   * The harness handle is private by design. Tests reach in deliberately so the
   * delivery contract is verifiable without the package installed.
   */
  function injectAgent(subject: MastraRuntime, agent: FakeAgent): void {
    const handle = subject as unknown as { mastra: { instance: unknown; agent: Record<string, unknown> } }
    handle.mastra = { instance: {}, agent: agent as unknown as Record<string, unknown> }
  }

  /**
   * Bind the thread and emit before the harness exists, so the row is
   * guaranteed pending rather than racing an immediate delivery. Returns the
   * refreshed record — the one createInvestigation returned is stale by the
   * time the thread id is set.
   */
  function pendingSignal(subject: MastraRuntime, title: string) {
    const created = subject.actionStore.createInvestigation({
      title, trigger: 'email', triggerIntegrationId: 'int-1', triggerMessageId: 'msg-1',
    })
    const threadId = `papyrus-investigation-${created.id}`
    subject.actionStore.setMastraThreadId(created.id, threadId)
    subject.emitSignal({
      type: 'investigation_created',
      investigationId: created.id,
      payload: { title },
    })
    const investigation = subject.actionStore.getInvestigation(created.id)
    if (!investigation) throw new Error('the investigation was not persisted')
    return investigation
  }

  async function runtime() {
    const cfg = config()
    const db = new AgentDatabase(':memory:')
    const terrain = new TerrainStore(db)
    const actionStore = new ActionStore(db)
    const connectors = new ConnectorRegistry()
    const syncWorker = new SyncWorker(db, terrain, connectors)
    const service = new AgentService(db, cfg, terrain, syncWorker, actionStore)
    disposers.push(() => db.close(), () => rmSync(cfg.dataDir, { recursive: true, force: true }))
    const subject = new MastraRuntime(cfg, actionStore, terrain, service)
    await subject.start()
    return subject
  }

  it('passes the signal and target as two positional arguments', async () => {
    const subject = await runtime()
    const investigation = pendingSignal(subject, 'Phish report')
    const sent: Array<{ signal: SentSignal; target: SentTarget }> = []

    injectAgent(subject, {
      sendSignal: (signal, target) => {
        sent.push({ signal, target })
        return { accepted: Promise.resolve({ action: 'wake' }) }
      },
    })

    expect(await subject.drainSignals()).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.target.threadId).toBe(investigation.mastraThreadId)
    expect(sent[0]?.target.resourceId).toBeTruthy()
  })

  it('maps a Papyrus domain event onto the notification category, keeping its type in tagName', async () => {
    const subject = await runtime()
    pendingSignal(subject, 'Phish report')
    const sent: Array<{ signal: SentSignal; target: SentTarget }> = []

    injectAgent(subject, {
      sendSignal: (signal, target) => {
        sent.push({ signal, target })
        return { accepted: Promise.resolve({ action: 'deliver' }) }
      },
    })
    await subject.drainSignals()

    const signal = sent[0]?.signal
    expect(signal?.type).toBe('notification')
    expect(signal?.tagName).toBe('investigation_created')
    expect(signal?.attributes?.papyrusSignalType).toBe('investigation_created')
    expect(signal?.attributes?.investigationId).toBeTruthy()
    expect(signal?.contents).toContain('Phish report')
    expect(signal?.contents).toContain('Papyrus signal: investigation_created')
  })

  it('refuses to build an agent with no model configured', async () => {
    const subject = await runtime()
    expect(subject.harnessReady).toBe(false)
    // The agent needs a model, and choosing one is the customer's decision.
    expect(process.env.PAPYRUS_INVESTIGATION_MODEL).toBeUndefined()
  })

  // The important one: acking a discarded signal would silently drop evidence,
  // which is the exact failure the outbox exists to prevent.
  it.each(['discard', 'blocked'] as const)(
    'does not acknowledge a signal the runtime reported as %s',
    async (action) => {
      const subject = await runtime()
      pendingSignal(subject, 'Phish report')

      injectAgent(subject, {
        sendSignal: () => ({ accepted: Promise.resolve({ action }) }),
      })

      expect(await subject.drainSignals()).toBe(0)
      expect(subject.signals.counts()).toMatchObject({ pending: 1, delivered: 0, failed: 0 })

      // Returned to pending for retry rather than acked away: the row survives
      // and records why it was not delivered.
      const row = subject.signals.pending()[0]
      expect(row?.attempts).toBe(1)
      expect(row?.error).toBeTruthy()
    },
  )

  it.each(['wake', 'deliver', 'persist'] as const)(
    'acknowledges a signal the runtime reported as %s',
    async (action) => {
      const subject = await runtime()
      pendingSignal(subject, 'Phish report')

      injectAgent(subject, {
        sendSignal: () => ({ accepted: Promise.resolve({ action }) }),
      })

      expect(await subject.drainSignals()).toBe(1)
      expect(subject.signals.counts()).toMatchObject({ delivered: 1, failed: 0 })
    },
  )

  it('refuses to deliver to an investigation with no bound thread', async () => {
    const subject = await runtime()
    const investigation = subject.actionStore.createInvestigation({ title: 'Unbound', trigger: 'email' })
    subject.emitSignal({ type: 'new_claim', investigationId: investigation.id })

    let called = false
    injectAgent(subject, {
      sendSignal: () => {
        called = true
        return { accepted: Promise.resolve({ action: 'wake' }) }
      },
    })

    expect(await subject.drainSignals()).toBe(0)
    expect(called).toBe(false)
    expect(subject.signals.counts().delivered).toBe(0)
  })
})

describe('investigation thread binding', () => {
  const disposers: Array<() => void> = []
  afterEach(() => { while (disposers.length) disposers.pop()?.() })

  it('binds idempotently and refuses to rebind to a different thread', () => {
    const db = new AgentDatabase(':memory:')
    disposers.push(() => db.close())
    const store = new ActionStore(db)
    const investigation = store.createInvestigation({ title: 'Phish', trigger: 'email' })

    store.setMastraThreadId(investigation.id, 'thread-a')
    store.setMastraThreadId(investigation.id, 'thread-a')
    expect(store.getInvestigation(investigation.id)?.mastraThreadId).toBe('thread-a')

    expect(() => store.setMastraThreadId(investigation.id, 'thread-b')).toThrow(ThreadConflictError)
    expect(store.getInvestigation(investigation.id)?.mastraThreadId).toBe('thread-a')
  })
})
