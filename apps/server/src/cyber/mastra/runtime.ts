import { join } from 'node:path'
import type { CyberSignal } from '@papyrus/contracts'
import type { ActionStore } from '../action-store.js'
import type { CyberConfig } from '../config.js'
import type { CyberService } from '../service.js'
import type { TerrainStore } from '../terrain-store.js'
import { SignalOutbox, type SignalRecord } from './signal-outbox.js'
import {
  localSandboxOptions,
  resolveSandboxPolicy,
  type SandboxPolicy,
} from './sandbox-policy.js'
import {
  INVESTIGATION_TOOLS,
  runInvestigationTool,
  type InvestigationToolContext,
  type InvestigationToolName,
} from './tools.js'

/**
 * MastraRuntime wraps the Mastra durable agent harness.
 *
 * The agent layer investigates and proposes; it never directly alters a
 * firewall, account, route, or mailbox. Every tool it holds is read-only
 * (see tools.ts) — the only way to reach an executor is a proposal that a
 * human approves through the action ledger.
 *
 * Signals are durable first: they land in cyber_signal_outbox before any
 * delivery attempt, so a restart, a crashed harness, or a missing agent thread
 * cannot lose them. If @mastra/core is not installed the daemon still runs and
 * still records signals; they drain once the harness is available.
 *
 * The Mastra surface below was verified against @mastra/core 1.63.2 by reading
 * the published type declarations. It is still imported dynamically and
 * feature-detected, because the package is not yet a dependency and the export
 * surface has moved between versions. Anything that cannot be verified without
 * the package installed is probed at runtime and degrades loudly.
 */

export type InvestigationRuntimeMode = 'starlings' | 'centralized'

export interface SignalPayload {
  type: CyberSignal['type']
  investigationId?: string
  proposalId?: string
  claimId?: string
  payload?: Record<string, unknown>
}

interface MastraHandle {
  instance: unknown
  agent: Record<string, unknown> | undefined
}

/**
 * Shape of `Agent.sendSignal` as published by @mastra/core 1.63.2:
 *
 *   sendSignal(signal: AgentSignal, target: SendAgentSignalOptions): SendAgentSignalResult
 *
 * Declared locally because the harness is imported dynamically and is not
 * available to the type checker. Two positional arguments, and the result
 * carries an `accepted` promise reporting what the runtime actually did.
 */
type SendSignal = (
  signal: Record<string, unknown>,
  target: { resourceId: string; threadId: string; ifActive?: { behavior: string } },
) => SendSignalResult

interface SendSignalResult {
  accepted: Promise<{ action: 'wake' | 'deliver' | 'persist' | 'discard' | 'blocked' }>
  persisted?: Promise<void>
}

const AGENT_ID = 'papyrus-investigation'
const SIGNAL_LEASE_MS = 30_000
const DRAIN_INTERVAL_MS = 5_000

export class MastraRuntime {
  readonly mode: InvestigationRuntimeMode
  readonly signals: SignalOutbox
  readonly tools: InvestigationToolContext
  private mastra: MastraHandle | undefined
  private started = false
  private sandbox: SandboxPolicy | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly config: CyberConfig,
    readonly actionStore: ActionStore,
    readonly terrain: TerrainStore,
    readonly service: CyberService,
  ) {
    this.mode = (process.env.PAPYRUS_INVESTIGATION_RUNTIME as InvestigationRuntimeMode | undefined) ?? 'starlings'
    this.signals = new SignalOutbox(actionStore.db)
    this.tools = { actionStore, terrain }
  }

  /** Resolved during start(); undefined until then. */
  get sandboxPolicy(): SandboxPolicy | undefined {
    return this.sandbox
  }

  get harnessReady(): boolean {
    return this.mastra?.agent !== undefined
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.sandbox = resolveSandboxPolicy({ dataDir: this.config.dataDir, platform: process.platform })
    if (!this.sandbox.enabled) console.warn(`[mastra] ${this.sandbox.reason}`)

    const core = await tryImport('@mastra/core')
    const libsql = await tryImport('@mastra/libsql')
    if (!core?.Mastra) {
      console.warn(
        '[mastra] @mastra/core is not installed; signals are retained in cyber_signal_outbox and will drain once it is. ' +
        'Install with: pnpm add @mastra/core @mastra/libsql',
      )
      return
    }

    const storage = libsql?.LibSQLStore
      ? new libsql.LibSQLStore({ id: 'papyrus-mastra', url: `file:${join(this.config.dataDir, 'mastra.db')}` })
      : undefined

    const agent = await this.buildAgent(core)
    this.mastra = {
      instance: new core.Mastra({
        ...(storage ? { storage } : {}),
        ...(agent ? { agents: { [AGENT_ID]: agent } } : {}),
      }),
      agent,
    }

    if (agent) {
      this.timer = setInterval(() => {
        void this.drainSignals().catch((cause: unknown) => {
          console.error('[mastra] signal drain failed:', cause instanceof Error ? cause.message : cause)
        })
      }, DRAIN_INTERVAL_MS)
      this.timer.unref?.()
    }

    console.log(
      `[mastra] investigation runtime started in ${this.mode} mode; ` +
      `sandbox ${this.sandbox.enabled ? this.sandbox.isolation : 'disabled'}; ` +
      `tools ${Object.keys(INVESTIGATION_TOOLS).join(', ')}`,
    )
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.mastra = undefined
  }

  /**
   * Deliver leased signals to their investigation thread. Returns the number
   * acknowledged. Signals stay pending when the harness is unavailable rather
   * than being failed, so installing Mastra later drains the backlog.
   */
  async drainSignals(limit = 25): Promise<number> {
    if (!this.mastra?.agent) return 0
    const claimed = this.signals.claim('papyrus-mastra', SIGNAL_LEASE_MS, limit)
    let delivered = 0
    for (const signal of claimed) {
      try {
        await this.deliver(signal)
        this.signals.ack(signal.id)
        delivered += 1
      } catch (cause) {
        this.signals.fail(signal.id, cause instanceof Error ? cause.message : String(cause))
      }
    }
    return delivered
  }

  /**
   * Create an investigation from an inbound email or signal and bind it to a
   * durable agent thread when the harness is available.
   */
  createInvestigationFromEmail(input: {
    title: string
    triggerIntegrationId: string
    triggerMessageId: string
  }): ReturnType<ActionStore['createInvestigation']> {
    const investigation = this.actionStore.createInvestigation({
      title: input.title,
      trigger: 'email',
      triggerIntegrationId: input.triggerIntegrationId,
      triggerMessageId: input.triggerMessageId,
    })

    if (this.mastra?.agent) {
      this.actionStore.setMastraThreadId(investigation.id, threadIdFor(investigation.id))
    }

    this.emitSignal({
      type: 'investigation_created',
      investigationId: investigation.id,
      payload: { title: input.title, trigger: 'email' },
    })

    return this.actionStore.getInvestigation(investigation.id) as ReturnType<ActionStore['createInvestigation']>
  }

  /** Record a signal durably, then attempt immediate delivery. */
  emitSignal(signal: SignalPayload): SignalRecord {
    const record = this.signals.enqueue({
      type: signal.type,
      ...(signal.investigationId ? { investigationId: signal.investigationId } : {}),
      ...(signal.proposalId ? { proposalId: signal.proposalId } : {}),
      ...(signal.claimId ? { claimId: signal.claimId } : {}),
      payload: { ...(signal.payload ?? {}), timestamp: new Date().toISOString() },
    })

    if (this.mastra?.agent) {
      void this.deliver(record)
        .then(() => this.signals.ack(record.id))
        .catch((cause: unknown) => {
          // An immediate delivery that never leased the row must not mark it
          // failed; the periodic drain retries it.
          if (record.status === 'pending') return
          this.signals.fail(record.id, cause instanceof Error ? cause.message : String(cause))
        })
    }

    return record
  }

  /** Bridge aggregated Terrain/Starlings events into Mastra signals. */
  bridgeTerrainSignal(investigationId: string, event: {
    type: 'new_claim' | 'contradiction' | 'evidence_threshold'
    claimId?: string
    summary: string
    evidenceCount: number
  }): void {
    this.emitSignal({
      type: event.type,
      investigationId,
      ...(event.claimId ? { claimId: event.claimId } : {}),
      payload: { summary: event.summary, evidenceCount: event.evidenceCount },
    })
  }

  bridgeApprovalSignal(investigationId: string, proposalId: string, approved: boolean): void {
    this.emitSignal({ type: 'approval_decision', investigationId, proposalId, payload: { approved } })
  }

  bridgeReceiptSignal(investigationId: string, proposalId: string, result: string): void {
    this.emitSignal({ type: 'execution_receipt', investigationId, proposalId, payload: { result } })
  }

  /**
   * Mastra addresses a thread by (resourceId, threadId). Papyrus has no
   * end-user resource concept — Entra is authoritative and a deployment serves
   * one tenant — so the tenant is the resource. Local mode has no tenant and
   * falls back to a stable synthetic id scoped to this deployment.
   */
  private resourceId(): string {
    const tenantId = this.config.entra?.tenantId
    if (tenantId) return `entra-tenant:${tenantId}`
    return `papyrus:${this.config.profile}:${this.config.organizationName}`
  }

  private async deliver(signal: SignalRecord): Promise<void> {
    const agent = this.mastra?.agent
    if (!agent) throw new Error('the Mastra harness is not available')

    const threadId = signal.investigationId
      ? this.actionStore.getInvestigation(signal.investigationId)?.mastraThreadId
      : undefined
    if (!threadId) throw new Error('the investigation is not bound to an agent thread')

    const send = agent['sendSignal']
    if (typeof send !== 'function') {
      throw new Error('the installed Mastra version does not expose agent.sendSignal')
    }

    // Verified against @mastra/core 1.63.2:
    //   sendSignal(signal: AgentSignal, target: SendAgentSignalOptions): SendAgentSignalResult
    // Two positional arguments, and the result carries an `accepted` promise
    // that reports what the runtime actually did with the signal.
    const result = (send as SendSignal).call(agent, signalInputFor(signal), {
      resourceId: this.resourceId(),
      threadId,
      // Join an in-flight run rather than dropping or deferring, so evidence
      // arriving mid-investigation is not lost.
      ifActive: { behavior: 'deliver' },
    })

    const accepted = result?.accepted
    if (!accepted) throw new Error('agent.sendSignal returned no acceptance promise')

    const decision = await accepted

    // `persist` stores the signal for a later turn instead of waking the agent
    // now. It counts as handled, but only once the write has landed.
    if (decision.action === 'persist' && result.persisted) await result.persisted

    // Only these mean the agent will actually see the signal. `discard` and
    // `blocked` mean it will not, so the row must stay pending instead of
    // being acked away — acking them would silently drop evidence, which is
    // precisely what the outbox exists to prevent.
    if (decision.action === 'discard' || decision.action === 'blocked') {
      throw new Error(
        decision.action === 'discard'
          ? 'the agent runtime discarded the signal without delivering it'
          : 'the agent thread is suspended and refused the signal',
      )
    }
  }

  /**
   * The model is a required Agent option, and which model is a customer
   * deployment decision — `disconnected` and `restricted` networks cannot
   * reach a hosted provider at all. Papyrus therefore refuses to guess: with
   * no model configured the agent is not built and signals keep accumulating
   * in the outbox rather than failing against a model nobody chose.
   */
  private agentModel(): string | undefined {
    const model = process.env.PAPYRUS_INVESTIGATION_MODEL?.trim()
    return model ? model : undefined
  }

  private async buildAgent(core: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    const model = this.agentModel()
    if (!model) {
      console.warn(
        '[mastra] PAPYRUS_INVESTIGATION_MODEL is not set; the investigation agent was not registered. ' +
        'Signals are retained in cyber_signal_outbox and will drain once a model is configured.',
      )
      return undefined
    }

    // Agent lives at '@mastra/core/agent' in recent Mastra and at '@mastra/core'
    // in others; probe both so the daemon boots on either.
    const agentModule = await tryImport('@mastra/core/agent')
    const Agent = (agentModule?.Agent ?? core.Agent) as (new (options: unknown) => Record<string, unknown>) | undefined
    if (!Agent) {
      console.warn('[mastra] no Agent export found; the investigation agent was not registered')
      return undefined
    }

    const toolModule = await tryImport('@mastra/core/tools')
    const createTool = toolModule?.createTool as ((options: unknown) => unknown) | undefined
    const tools = createTool ? this.buildTools(createTool) : undefined

    const workspace = await this.buildWorkspace(core)

    return new Agent({
      id: AGENT_ID,
      name: 'Papyrus Investigation',
      model,
      instructions: [
        'You investigate cyber terrain evidence for a customer-hosted resilience twin.',
        'You may read terrain, investigations, and proposals. You cannot approve or execute anything.',
        'When evidence supports a consequential action, describe it and cite the claim identifiers; a human proposes and approves it through the Papyrus action ledger.',
      ].join(' '),
      // Storage is attached to the Mastra instance, not passed as `memory`:
      // Agent.memory expects a MastraMemory instance, not a store.
      ...(tools ? { tools } : {}),
      ...(workspace ? { workspace } : {}),
    })
  }

  private buildTools(createTool: (options: unknown) => unknown): Record<string, unknown> {
    const registered: Record<string, unknown> = {}
    for (const name of Object.keys(INVESTIGATION_TOOLS) as InvestigationToolName[]) {
      const descriptor = INVESTIGATION_TOOLS[name]
      registered[name] = createTool({
        id: descriptor.name,
        description: descriptor.description,
        inputSchema: inputSchemaFor(name),
        execute: async (args: Record<string, unknown>) => runInvestigationTool(name, this.tools, args),
      })
    }
    return registered
  }

  private async buildWorkspace(core: Record<string, unknown>): Promise<unknown> {
    const options = this.sandbox ? localSandboxOptions(this.sandbox) : undefined
    if (!options) return undefined

    const module = await tryImport('@mastra/core/workspace')
    const Workspace = (module?.Workspace ?? core.Workspace) as (new (options: unknown) => unknown) | undefined
    const LocalSandbox = module?.LocalSandbox as (new (options: unknown) => unknown) | undefined
    if (!Workspace || !LocalSandbox) {
      console.warn('[mastra] LocalSandbox or Workspace is unavailable; starting without a sandbox')
      return undefined
    }
    return new Workspace({ sandbox: new LocalSandbox(options) })
  }
}

function threadIdFor(investigationId: string): string {
  return `papyrus-investigation-${investigationId}`
}

/**
 * Papyrus signal types are domain events; Mastra signal types are delivery
 * categories. The category is always `notification` — these are external
 * events handed to the agent, not user turns or state updates — and the
 * Papyrus type rides in `tagName` and `attributes` so the agent can still
 * distinguish a new claim from an approval decision.
 */
function signalInputFor(signal: SignalRecord): Record<string, unknown> {
  return {
    type: 'notification',
    tagName: signal.type,
    contents: renderSignalContents(signal),
    attributes: {
      papyrusSignalType: signal.type,
      ...(signal.investigationId ? { investigationId: signal.investigationId } : {}),
      ...(signal.proposalId ? { proposalId: signal.proposalId } : {}),
      ...(signal.claimId ? { claimId: signal.claimId } : {}),
    },
  }
}

/** Render a signal as text the model can read without re-parsing the payload. */
function renderSignalContents(signal: SignalRecord): string {
  const { timestamp, ...rest } = signal.payload
  const lines = [`Papyrus signal: ${signal.type}`]
  if (typeof timestamp === 'string') lines.push(`occurredAt: ${timestamp}`)
  if (signal.investigationId) lines.push(`investigation: ${signal.investigationId}`)
  if (signal.proposalId) lines.push(`proposal: ${signal.proposalId}`)
  if (signal.claimId) lines.push(`claim: ${signal.claimId}`)
  if (Object.keys(rest).length > 0) lines.push(JSON.stringify(rest))
  return lines.join('\n')
}

/** Minimal JSON Schema for each tool. Kept local so tools stay Mastra-agnostic. */
function inputSchemaFor(name: InvestigationToolName): Record<string, unknown> {
  if (name === 'listProposals') {
    return {
      type: 'object',
      properties: { investigationId: { type: 'string', description: 'Restrict to one investigation' } },
      additionalProperties: false,
    }
  }
  return { type: 'object', properties: {}, additionalProperties: false }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryImport(spec: string): Promise<any> {
  try {
    return await import(spec)
  } catch {
    return null
  }
}

