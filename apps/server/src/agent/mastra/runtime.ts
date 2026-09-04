import { join } from 'node:path'
import type { AgentSignal } from '@papyrus/contracts'
import type { ActionStore } from '../action-store.js'
import type { AgentConfig } from '../config.js'
import type { AgentService } from '../service.js'
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
import { INTEGRATION_CATALOG } from '../catalog.js'
import { connectionRequest, modelGatewayRequest, pluginToolId } from './plugin-tools.js'
import { fetchUrlPreview } from './fetch-preview.js'
import { signalIntakeWorkflow, WORKFLOW_CATALOG } from './workflows.js'
import { ModelStore, type CreateModelProfileInput } from '../model-store.js'
import { PapyrusModelGateway, resolveModelCredential } from '../model-gateway.js'
import type { ModelProfile } from '@papyrus/contracts'
import { ArtifactStore, type ArtifactFormat, type ArtifactSheetInput } from '../artifact-store.js'
import { SkillRegistry } from '../skills.js'

/**
 * MastraRuntime wraps the Mastra durable agent harness.
 *
 * The agent layer investigates and proposes; it never directly alters a
 * firewall, account, route, or mailbox. Every tool it holds is read-only
 * (see tools.ts) — the only way to reach an executor is a proposal that a
 * human approves through the action ledger.
 *
 * Signals are durable first: they land in agent_signal_outbox before any
 * delivery attempt, so a restart, a crashed harness, or a missing agent thread
 * cannot lose them. If @mastra/core is not installed the daemon still runs and
 * still records signals; they drain once the harness is available.
 *
 * The Mastra surface below was verified against @mastra/core 1.63.2 by reading
 * the published type declarations. It is still imported dynamically and
 * feature-detected so a minimal daemon build can retain signals if an optional
 * Mastra package is unavailable. Anything that cannot be verified without the
 * package installed is probed at runtime and degrades loudly.
 */

export type InvestigationRuntimeMode = 'starlings' | 'centralized'

export interface SignalPayload {
  type: AgentSignal['type']
  investigationId?: string
  proposalId?: string
  claimId?: string
  payload?: Record<string, unknown>
}

interface MastraHandle {
  instance: unknown
  agent: Record<string, unknown> | undefined
  memory?: Record<string, unknown>
  storage?: Record<string, unknown>
  webhooks?: Record<string, unknown>
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

const AGENT_ID = 'papyrus'
const SIGNAL_LEASE_MS = 30_000
const DRAIN_INTERVAL_MS = 5_000

export class MastraRuntime {
  readonly mode: InvestigationRuntimeMode
  readonly signals: SignalOutbox
  readonly tools: InvestigationToolContext
  readonly models: ModelStore
  readonly artifacts: ArtifactStore
  readonly skills: SkillRegistry
  private mastra: MastraHandle | undefined
  private started = false
  private sandbox: SandboxPolicy | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    readonly config: AgentConfig,
    readonly actionStore: ActionStore,
    readonly terrain: TerrainStore,
    readonly service: AgentService,
  ) {
    this.mode = (process.env.PAPYRUS_INVESTIGATION_RUNTIME as InvestigationRuntimeMode | undefined) ?? 'starlings'
    this.signals = new SignalOutbox(actionStore.db)
    this.models = new ModelStore(actionStore.db)
    this.artifacts = new ArtifactStore(config.dataDir)
    this.skills = new SkillRegistry(config.dataDir)
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
    const memoryModule = await tryImport('@mastra/memory')
    if (!core?.Mastra) {
      console.warn(
        '[mastra] @mastra/core is not installed; signals are retained in agent_signal_outbox and will drain once it is. ' +
        'Install with: pnpm add @mastra/core @mastra/libsql',
      )
      return
    }

    this.models.bootstrapLegacy()

    const storage = libsql?.LibSQLStore
      ? new libsql.LibSQLStore({ id: 'papyrus-mastra', url: `file:${join(this.config.dataDir, 'mastra.db')}` })
      : undefined

    if (storage?.init) await storage.init()
    const memory = memoryModule?.Memory
      ? new memoryModule.Memory({ storage, options: { lastMessages: 50 }, vector: false })
      : undefined

    const webhooks = await this.buildWebhookProvider()
    const agent = await this.buildAgent(core, memory, webhooks)
    const gateway = new PapyrusModelGateway(this.models)
    const instance = new core.Mastra({
        ...(storage ? { storage } : {}),
        ...(agent ? { agents: { [AGENT_ID]: agent } } : {}),
        gateways: { papyrus: gateway },
        workflows: { signalIntake: signalIntakeWorkflow },
        backgroundTasks: { enabled: true, mode: 'full', globalConcurrency: 8, perAgentConcurrency: 4, backpressure: 'queue' },
      })
    this.mastra = {
      instance,
      agent,
      ...(memory ? { memory } : {}),
      ...(storage ? { storage } : {}),
      ...(webhooks ? { webhooks } : {}),
    }

    if (typeof instance.startWorkers === 'function') await instance.startWorkers()

    await this.rehydrateSignalSubscriptions()

    if (agent) {
      this.timer = setInterval(() => {
        void this.drainSignals().catch((cause: unknown) => {
          console.error('[mastra] signal drain failed:', cause instanceof Error ? cause.message : cause)
        })
      }, DRAIN_INTERVAL_MS)
      this.timer.unref?.()
    }

    console.log(
      `[mastra] runtime started in ${this.mode} mode; ` +
      `sandbox ${this.sandbox.enabled ? this.sandbox.isolation : 'disabled'}; ` +
      `tools ${Object.keys(INVESTIGATION_TOOLS).length + INTEGRATION_CATALOG.filter((item) => item.supportedProfiles.includes(this.config.profile)).length + 10} registered`,
    )
  }

  async stop(): Promise<void> {
    this.started = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    const instance = this.mastra?.instance as Record<string, unknown> | undefined
    const memory = this.mastra?.memory
    const storage = this.mastra?.storage
    if (typeof instance?.['shutdown'] === 'function') {
      await (instance['shutdown'] as () => Promise<void>)()
      this.mastra = undefined
      return
    }
    if (typeof memory?.['settled'] === 'function') await (memory['settled'] as () => Promise<void>)()
    if (typeof storage?.['close'] === 'function') await (storage['close'] as () => Promise<void>)()
    this.mastra = undefined
  }

  get status() {
    return {
      ready: Boolean(this.mastra),
      agentReady: this.harnessReady,
      durable: this.harnessReady,
      model: this.agentModel() ?? null,
      mode: this.mode,
      signalBacklog: this.signals.counts(),
    }
  }

  listModelProfiles(): ModelProfile[] { return this.models.list() }

  createModelProfile(input: CreateModelProfileInput, actorOid: string): ModelProfile {
    // A profile is not usable until its endpoint has passed a test. The first
    // profile that passes becomes the default in testModelProfile below.
    return this.models.create(input, actorOid, false)
  }

  async testModelProfile(id: string, actorOid: string): Promise<ModelProfile> {
    const profile = this.models.get(id)
    if (!profile) throw new MastraRuntimeError(404, 'MODEL_PROFILE_NOT_FOUND', 'Model profile not found')
    const hadUsableDefault = Boolean(this.models.getDefault())
    try {
      const credential = resolveModelCredential(profile)
      const response = await fetch(`${profile.baseUrl}/models`, { method: 'GET', headers: credential ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(8_000) })
      if (response.status >= 400) throw new Error(`Model endpoint returned ${response.status}`)
      const tested = this.models.markTested(id, undefined, actorOid)
      const selected = !hadUsableDefault && !tested.isDefault ? this.models.setDefault(id) : tested
      if (!hadUsableDefault) await this.reloadAgent()
      return selected
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Model gateway test failed'
      return this.models.markTested(id, message, actorOid)
    }
  }

  async setDefaultModelProfile(id: string): Promise<ModelProfile> {
    const profile = this.models.setDefault(id)
    await this.reloadAgent()
    return profile
  }

  async disableModelProfile(id: string): Promise<ModelProfile> {
    const wasDefault = Boolean(this.models.get(id)?.isDefault)
    const profile = this.models.disable(id)
    if (wasDefault) await this.reloadAgent()
    return profile
  }

  async deleteModelProfile(id: string, actorOid: string): Promise<void> {
    const profile = this.models.get(id)
    const wasDefault = Boolean(profile?.isDefault)
    this.models.delete(id, actorOid)
    if (wasDefault) await this.reloadAgent()
  }

  async createSession(title = 'New session') {
    const memory = this.requireMemory()
    const thread = await (memory['createThread'] as (input: Record<string, unknown>) => Promise<Record<string, unknown>>)({
      resourceId: this.resourceId(), title: title.trim().slice(0, 120) || 'New session',
      metadata: { kind: 'operator_session', attention: false }, saveThread: true,
    })
    this.actionStore.createInvestigation({ title: String(thread['title'] ?? title), trigger: 'manual', mastraThreadId: String(thread['id']) })
    return thread
  }

  async listSessions() {
    const memory = this.requireMemory()
    const result = await (memory['listThreads'] as (input: Record<string, unknown>) => Promise<{ threads: Array<Record<string, unknown>> }>)({
      filter: { resourceId: this.resourceId() }, perPage: 100,
      orderBy: { field: 'updatedAt', direction: 'DESC' },
    })
    return result.threads.map((thread) => ({
      id: String(thread['id']), title: String(thread['title'] ?? 'New session'),
      createdAt: dateString(thread['createdAt']), updatedAt: dateString(thread['updatedAt']),
      attention: Boolean((thread['metadata'] as Record<string, unknown> | undefined)?.['attention']),
      kind: String((thread['metadata'] as Record<string, unknown> | undefined)?.['kind'] ?? 'operator_session'),
    }))
  }

  async sessionMessages(threadId: string) {
    const memory = this.requireMemory()
    await this.assertOwnedThread(threadId)
    const result = await (memory['recall'] as (input: Record<string, unknown>) => Promise<{ messages: Array<Record<string, unknown>> }>)({
      threadId, resourceId: this.resourceId(), perPage: false,
    })
    return result.messages.map(uiMessageFromMemory).filter((message) => message.parts.length > 0)
  }

  async deleteSession(threadId: string): Promise<void> {
    const memory = this.requireMemory()
    await this.assertOwnedThread(threadId)
    await (memory['deleteThread'] as (id: string) => Promise<void>)(threadId)
  }

  async setSessionAttention(threadId: string, attention: boolean): Promise<void> {
    await this.assertOwnedThread(threadId)
    await this.updateThreadMetadata(threadId, { attention })
  }

  investigationForSession(threadId: string) {
    const existing = this.actionStore.getInvestigationByThreadId(threadId)
    if (existing) return existing
    return this.actionStore.createInvestigation({ title: 'Agent action', trigger: 'manual', mastraThreadId: threadId })
  }

  async chat(threadId: string, params: Record<string, unknown>): Promise<Response> {
    if (!this.mastra?.agent) throw new MastraRuntimeError(503, 'AGENT_MODEL_NOT_CONFIGURED', 'Configure a model gateway in /portal/models before starting a session')
    await this.assertOwnedThread(threadId)
    const messages = Array.isArray(params['messages']) ? params['messages'] : []
    const lastMessage = [...messages].reverse().find((message) => message && typeof message === 'object' && (message as Record<string, unknown>)['role'] === 'user')
    if (!lastMessage) throw new MastraRuntimeError(400, 'INVALID_CHAT_MESSAGE', 'A user message is required')
    await this.maybeTitleSession(threadId, lastMessage as Record<string, unknown>)
    const adapter = await import('@mastra/ai-sdk')
    const ai = await import('ai')
    const stream = await adapter.handleChatStream({
      mastra: this.mastra.instance as never,
      agentId: AGENT_ID,
      version: 'v7',
      params: {
        ...params,
        messages: [lastMessage] as never,
        memory: { thread: threadId, resource: this.resourceId() },
      },
      onError: (cause) => cause instanceof Error ? cause.message : 'Agent execution failed',
    })
    return ai.createUIMessageStreamResponse({ stream })
  }

  async listSchedules() {
    const schedules = (this.mastra?.instance as { schedules?: { list: (filter?: unknown) => Promise<unknown[]> } } | undefined)?.schedules
    return schedules ? schedules.list({ agentId: AGENT_ID, resourceId: this.resourceId() }) : []
  }

  async createSchedule(input: { name: string; cron: string; prompt: string; timezone?: string; threadId?: string }) {
    if (!this.mastra?.agent) throw new MastraRuntimeError(503, 'AGENT_MODEL_NOT_CONFIGURED', 'The agent must be configured before creating schedules')
    if (input.threadId) await this.assertOwnedThread(input.threadId)
    const schedules = (this.mastra?.instance as { schedules: { create: (value: unknown) => Promise<unknown> } }).schedules
    return schedules.create({
      agentId: AGENT_ID, name: input.name, cron: input.cron, prompt: input.prompt,
      resourceId: this.resourceId(), ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      tagName: 'schedule', ifActive: { behavior: 'deliver' }, metadata: { createdBy: 'papyrus-portal' },
    })
  }

  async deleteSchedule(id: string): Promise<void> {
    const schedules = (this.mastra?.instance as { schedules: { get: (id: string) => Promise<Record<string, unknown> | null>; delete: (id: string) => Promise<void> } }).schedules
    const schedule = await schedules.get(id)
    if (!schedule || schedule['resourceId'] !== this.resourceId()) throw new MastraRuntimeError(404, 'SCHEDULE_NOT_FOUND', 'Schedule not found')
    await schedules.delete(id)
  }

  listWorkflows() { return WORKFLOW_CATALOG }

  async runWorkflow(id: string, inputData: unknown) {
    if (id !== 'signal-intake') throw new MastraRuntimeError(404, 'WORKFLOW_NOT_FOUND', 'Workflow not found')
    const workflow = (this.mastra?.instance as { getWorkflowById: (id: string) => { createRun: () => Promise<{ start: (input: unknown) => Promise<unknown> }> } }).getWorkflowById(id)
    const run = await workflow.createRun()
    return run.start({ inputData })
  }

  async acceptWebhook(sourceId: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<{ accepted: true; sessionId: string; signalId: string }> {
    const integration = this.actionStore.db.getIntegration(sourceId)
    if (!integration || integration.state !== 'active') throw new MastraRuntimeError(404, 'SIGNAL_SOURCE_NOT_FOUND', 'Active signal source not found')
    const threadId = `papyrus-signal-${sourceId}`
    const memory = this.requireMemory()
    const existing = await (memory['getThreadById'] as (input: Record<string, unknown>) => Promise<unknown>)({ threadId, resourceId: this.resourceId() })
    if (!existing) {
      await (memory['createThread'] as (input: Record<string, unknown>) => Promise<unknown>)({
        threadId, resourceId: this.resourceId(), title: `Signals · ${integration.name}`, saveThread: true,
        metadata: { kind: 'signal_session', signalSourceId: sourceId, attention: true },
      })
      this.actionStore.createInvestigation({ title: `Signals · ${integration.name}`, trigger: 'signal', triggerIntegrationId: sourceId, mastraThreadId: threadId })
    } else {
      await this.updateThreadMetadata(threadId, { kind: 'signal_session', signalSourceId: sourceId, attention: true })
    }
    this.subscribeWebhookThread(threadId, sourceId)
    const record = this.emitSignal({
      type: 'external_signal',
      payload: { threadId, sourceId, body, headers: safeWebhookHeaders(headers), sourceName: integration.name },
    })
    return { accepted: true, sessionId: threadId, signalId: record.id }
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
    if (signal.type === 'external_signal') {
      const provider = this.mastra?.webhooks
      const sourceId = typeof signal.payload['sourceId'] === 'string' ? signal.payload['sourceId'] : undefined
      const body = signal.payload['body']
      if (!provider || !sourceId || !body || typeof body !== 'object') throw new Error('the webhook signal provider is not available')
      const handle = provider['handleWebhook']
      if (typeof handle !== 'function') throw new Error('the webhook signal provider cannot handle webhooks')
      await (handle as (request: unknown) => Promise<unknown>).call(provider, {
        body: { ...(body as Record<string, unknown>), externalResourceId: sourceId },
        headers: signal.payload['headers'] ?? {},
      })
      return
    }
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
    const profile = this.models.getDefault()
    return profile ? `papyrus/${profile.id}/${profile.model}` : undefined
  }

  private async reloadAgent(): Promise<void> {
    if (!this.mastra) return
    const core = await tryImport('@mastra/core')
    if (!core?.Mastra) return
    const agent = await this.buildAgent(core, this.mastra.memory, this.mastra.webhooks)
    const instance = this.mastra.instance as Record<string, unknown>
    if (typeof instance['removeAgent'] === 'function') (instance['removeAgent'] as (id: string) => boolean)(AGENT_ID)
    if (agent && typeof instance['addAgent'] === 'function') (instance['addAgent'] as (agent: unknown, id: string) => void)(agent, AGENT_ID)
    this.mastra.agent = agent
    if (agent && !this.timer) {
      this.timer = setInterval(() => {
        void this.drainSignals().catch((cause: unknown) => {
          console.error('[mastra] signal drain failed:', cause instanceof Error ? cause.message : cause)
        })
      }, DRAIN_INTERVAL_MS)
      this.timer.unref?.()
    }
  }

  private async buildAgent(core: Record<string, unknown>, memory?: unknown, webhooks?: unknown): Promise<Record<string, unknown> | undefined> {
    const model = this.agentModel()
    if (!model) {
      console.warn(
        '[mastra] PAPYRUS_AGENT_MODEL is not set; the agent was not registered. ' +
        'Signals are retained in agent_signal_outbox and will drain once a model is configured.',
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

    const enabledSkills = this.skills.list().filter((skill) => skill.state === 'enabled')
      .map((skill) => `${skill.name}@${skill.version}: ${skill.description}`).join(' | ')

    const baseAgent = new Agent({
      id: AGENT_ID,
      name: 'Papyrus',
      model,
      instructions: [
        'You are the customer-hosted Papyrus operations agent.',
        'Use plugins, durable workflows, schedules, external signals, and the Starlings collective runtime to help operators complete work.',
        'When a plugin is needed, call its connect tool so the UI can collect configuration safely. Never ask a user to paste a secret into chat.',
        `Enabled procedural skills: ${enabledSkills}. Load the relevant skill before specialized artifact or procedure work; do not invent capabilities that are not exposed as tools.`,
        'Creating, editing, or returning a local file is a workspace capability, not an operational action. For PDF, DOCX, XLSX, text, JSON, CSV, or HTML deliverables, call listSkills/loadSkill as needed and then createArtifact. Never call listActionExecutors merely to create a file.',
        'For richer files created by sandbox commands, call publishArtifact after the file exists. Artifact publication only copies a file from the sandbox into the durable artifact store; it does not send it to an external system.',
        'Only external side effects use action executors. Before suggesting an operational action such as sending mail, changing a firewall, or publishing to an external system, list the active executors, then call suggestAction. A suggestion is only a UI artifact until the operator submits it to the ledger.',
        'Skills teach procedures but never grant authority. Dynamically created skills remain inert drafts until a Papyrus.System.Owner approves them.',
        'You may inspect action proposals, but you cannot approve or execute them. Human Entra authority and the Papyrus action ledger are mandatory.',
      ].join(' '),
      ...(tools ? { tools } : {}),
      ...(memory ? { memory } : {}),
      ...(webhooks ? { signals: [webhooks] } : {}),
      backgroundTasks: { tools: { fetchUrlPreview: true }, waitTimeoutMs: 15_000 },
      ...(workspace ? { workspace } : {}),
    })
    const durable = await tryImport('@mastra/core/agent/durable')
    return durable?.createEventedAgent ? durable.createEventedAgent({ agent: baseAgent }) : baseAgent
  }

  private buildTools(createTool: (options: unknown) => unknown): Record<string, unknown> {
    const registered: Record<string, unknown> = {}
    for (const name of Object.keys(INVESTIGATION_TOOLS) as InvestigationToolName[]) {
      const descriptor = INVESTIGATION_TOOLS[name]
      registered[name] = createTool({
        id: descriptor.name,
        description: descriptor.description,
        inputSchema: inputSchemaFor(name),
        execute: async (inputData: Record<string, unknown>) => runInvestigationTool(name, this.tools, inputData),
      })
    }
    for (const entry of INTEGRATION_CATALOG.filter((item) => item.supportedProfiles.includes(this.config.profile))) {
      const id = pluginToolId(entry)
      registered[id] = createTool({
        id,
        description: `Open the secure connection UI for ${entry.name}. Use this when the operator wants ${entry.capabilities.join(', ')}.`,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => connectionRequest(entry),
      })
    }
    registered['configureModelGateway'] = createTool({
      id: 'configureModelGateway',
      description: 'Open a secure typed form for configuring a Papyrus model gateway. Ask only for the model ID, endpoint, authentication mode, and (if needed) the daemon environment variable containing the API key. Never request a raw secret in chat.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => modelGatewayRequest(),
    })
    registered['fetchUrlPreview'] = createTool({
      id: 'fetchUrlPreview',
      description: 'Fetch an approved HTTP(S) URL and return a safe title, description, and excerpt preview for the UI.',
      inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' } }, additionalProperties: false },
      background: { enabled: true, timeoutMs: 15_000, maxRetries: 1, waitTimeoutMs: 15_000 },
      execute: async (inputData: { url: string }) => fetchUrlPreview(inputData.url),
    })
    registered['listSkills'] = createTool({
      id: 'listSkills',
      description: 'List built-in and organization skills. Use this to discover procedural guidance for artifact generation and reusable workflows.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => this.skills.list(),
    })
    registered['loadSkill'] = createTool({
      id: 'loadSkill',
      description: 'Load the instructions for an enabled skill. Skills provide procedural guidance only and cannot grant new tools or authority.',
      inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false },
      execute: async (inputData: { name: string }) => this.skills.load(inputData.name),
    })
    registered['createArtifact'] = createTool({
      id: 'createArtifact',
      description: 'Create a durable local artifact and return typed inline UI. Use this for PDF, DOCX, XLSX, text, Markdown, JSON, CSV, or HTML deliverables. This is not an external action and requires no action executor.',
      inputSchema: {
        type: 'object', required: ['format', 'name'],
        properties: {
          format: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'txt', 'md', 'json', 'csv', 'html'] },
          name: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' },
          skill: { type: 'string' }, skillVersion: { type: 'string' },
          sheets: {
            type: 'array',
            items: {
              type: 'object', required: ['rows'],
              properties: {
                name: { type: 'string' },
                rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } } },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      execute: async (inputData: Record<string, unknown>) => this.artifacts.create({
        format: inputData['format'] as ArtifactFormat,
        name: String(inputData['name'] ?? 'artifact'),
        ...(typeof inputData['title'] === 'string' ? { title: inputData['title'] } : {}),
        ...(typeof inputData['content'] === 'string' ? { content: inputData['content'] } : {}),
        ...(Array.isArray(inputData['sheets']) ? { sheets: inputData['sheets'] as ArtifactSheetInput[] } : {}),
        ...(typeof inputData['skill'] === 'string' ? { skill: inputData['skill'] } : {}),
        ...(typeof inputData['skillVersion'] === 'string' ? { skillVersion: inputData['skillVersion'] } : {}),
      }),
    })
    registered['publishArtifact'] = createTool({
      id: 'publishArtifact',
      description: 'Publish an existing file from the sandbox workspace into the durable artifact store so it can be previewed and downloaded in Agent Chat. Paths outside the sandbox are rejected.',
      inputSchema: {
        type: 'object', required: ['path'],
        properties: { path: { type: 'string' }, name: { type: 'string' }, skill: { type: 'string' }, skillVersion: { type: 'string' } },
        additionalProperties: false,
      },
      execute: async (inputData: Record<string, unknown>) => {
        if (!this.sandbox?.enabled) throw new Error('Sandbox workspace is unavailable; use createArtifact for built-in document formats')
        return this.artifacts.importWorkspaceFile(String(inputData['path'] ?? ''), this.sandbox.workingDirectory, {
          ...(typeof inputData['name'] === 'string' ? { name: inputData['name'] } : {}),
          ...(typeof inputData['skill'] === 'string' ? { skill: inputData['skill'] } : {}),
          ...(typeof inputData['skillVersion'] === 'string' ? { skillVersion: inputData['skillVersion'] } : {}),
        })
      },
    })
    registered['listArtifacts'] = createTool({
      id: 'listArtifacts',
      description: 'List durable artifacts already created in this customer-hosted runtime.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => this.artifacts.list(),
    })
    registered['draftSkill'] = createTool({
      id: 'draftSkill',
      description: 'Create an inert draft skill for a reusable organization procedure. Drafting never grants tools, network access, or external authority; a System Owner must approve and enable it.',
      inputSchema: {
        type: 'object', required: ['name', 'description', 'instructions'],
        properties: {
          name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' },
          requestedCapabilities: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      execute: async (inputData: Record<string, unknown>) => ({
        kind: 'skill_draft',
        skill: this.skills.draft({
          name: String(inputData['name'] ?? ''),
          description: String(inputData['description'] ?? ''),
          instructions: String(inputData['instructions'] ?? ''),
          requestedCapabilities: Array.isArray(inputData['requestedCapabilities'])
            ? inputData['requestedCapabilities'].filter((value): value is string => typeof value === 'string')
            : [],
        }),
      }),
    })
    registered['listActionExecutors'] = createTool({
      id: 'listActionExecutors',
      description: 'List active controlled-action plugins that can receive a human-approved action.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      execute: async () => this.actionStore.db.listIntegrations().filter((integration) => integration.state === 'active' && (integration.catalogId === 'exchange-email' || integration.authority === 'controlled_actions' || integration.integrationClass === 'action_executor')).map((integration) => ({ id: integration.id, name: integration.name, catalogId: integration.catalogId })),
    })
    registered['suggestAction'] = createTool({
      id: 'suggestAction',
      description: 'Present a consequential action suggestion to the operator. This does not approve or execute the action.',
      inputSchema: {
        type: 'object', required: ['executorIntegrationId', 'action', 'target', 'rationale'],
        properties: {
          executorIntegrationId: { type: 'string', description: 'Active action-executor integration id' },
          action: { type: 'string' }, target: { type: 'string' }, rationale: { type: 'string' },
          rationaleClaimIds: { type: 'array', items: { type: 'string' } },
          parameters: { type: 'object', additionalProperties: true },
        }, additionalProperties: false,
      },
      execute: async (inputData: Record<string, unknown>) => ({ kind: 'action_suggestion', ...inputData }),
    })
    return registered
  }

  private requireMemory(): Record<string, unknown> {
    const memory = this.mastra?.memory
    if (!memory) throw new MastraRuntimeError(503, 'MASTRA_STORAGE_UNAVAILABLE', 'Mastra persistent storage is unavailable')
    return memory
  }

  private async assertOwnedThread(threadId: string): Promise<void> {
    const memory = this.requireMemory()
    const thread = await (memory['getThreadById'] as (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>)({ threadId, resourceId: this.resourceId() })
    if (!thread || thread['resourceId'] !== this.resourceId()) throw new MastraRuntimeError(404, 'SESSION_NOT_FOUND', 'Session not found')
  }

  private async maybeTitleSession(threadId: string, message: Record<string, unknown>): Promise<void> {
    const memory = this.requireMemory()
    const thread = await (memory['getThreadById'] as (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>)({ threadId, resourceId: this.resourceId() })
    if (!thread || !['New session', 'Untitled'].includes(String(thread['title'] ?? ''))) return
    const title = messageText(message).slice(0, 72)
    if (title) await (memory['updateThread'] as (input: Record<string, unknown>) => Promise<unknown>)({ id: threadId, title })
  }

  private async updateThreadMetadata(threadId: string, patch: Record<string, unknown>): Promise<void> {
    const memory = this.requireMemory()
    const thread = await (memory['getThreadById'] as (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>)({ threadId, resourceId: this.resourceId() })
    await (memory['updateThread'] as (input: Record<string, unknown>) => Promise<unknown>)({ id: threadId, metadata: { ...(thread?.['metadata'] as Record<string, unknown> | undefined), ...patch } })
  }

  private async buildWebhookProvider(): Promise<Record<string, unknown> | undefined> {
    const signals = await tryImport('@mastra/core/signals')
    const Provider = signals?.WebhookSignalProvider as (new (options: unknown) => Record<string, unknown>) | undefined
    if (!Provider) return undefined
    return new Provider({
      id: 'papyrus-webhooks', name: 'Papyrus plugin webhooks',
      extractResourceId: (payload: unknown) => payload && typeof payload === 'object' ? (payload as Record<string, unknown>)['externalResourceId'] : undefined,
      buildNotification: (payload: unknown) => {
        const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
        return {
          source: 'papyrus-plugin', kind: typeof body['kind'] === 'string' ? body['kind'] : 'external-event',
          priority: typeof body['priority'] === 'string' ? body['priority'] : 'medium',
          summary: typeof body['summary'] === 'string' ? body['summary'] : 'A plugin delivered a new signal.',
          data: body,
        }
      },
    })
  }

  private subscribeWebhookThread(threadId: string, sourceId: string): void {
    const subscribe = this.mastra?.webhooks?.['subscribeThread']
    if (typeof subscribe === 'function') subscribe.call(this.mastra?.webhooks, { threadId, resourceId: this.resourceId() }, sourceId)
  }

  private async rehydrateSignalSubscriptions(): Promise<void> {
    if (!this.mastra?.memory || !this.mastra.webhooks) return
    const sessions = await this.listSessions()
    const memory = this.requireMemory()
    for (const session of sessions.filter((item) => item.kind === 'signal_session')) {
      const thread = await (memory['getThreadById'] as (input: Record<string, unknown>) => Promise<Record<string, unknown> | null>)({ threadId: session.id, resourceId: this.resourceId() })
      const sourceId = (thread?.['metadata'] as Record<string, unknown> | undefined)?.['signalSourceId']
      if (typeof sourceId === 'string') this.subscribeWebhookThread(session.id, sourceId)
    }
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

export class MastraRuntimeError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function dateString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()
}

function messageText(message: Record<string, unknown>): string {
  if (typeof message['content'] === 'string') return message['content']
  const parts = Array.isArray(message['parts']) ? message['parts'] : []
  return parts.filter((part) => part && typeof part === 'object' && (part as Record<string, unknown>)['type'] === 'text')
    .map((part) => String((part as Record<string, unknown>)['text'] ?? '')).join(' ').trim()
}

function uiMessageFromMemory(message: Record<string, unknown>) {
  const content = message['content']
  const nested = content && typeof content === 'object' ? content as Record<string, unknown> : undefined
  const rawParts = Array.isArray(nested?.['parts']) ? nested['parts'] : []
  const parts = rawParts.flatMap((part) => memoryPartToUi(part))
  if (parts.length === 0 && typeof content === 'string') parts.push({ type: 'text', text: content })
  return {
    id: String(message['id']),
    role: ['user', 'assistant', 'system'].includes(String(message['role'])) ? message['role'] as 'user' | 'assistant' | 'system' : 'assistant',
    parts,
  }
}

function memoryPartToUi(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return []
  const part = value as Record<string, unknown>
  if (part['type'] === 'text') return [{ type: 'text', text: String(part['text'] ?? '') }]
  if (part['type'] === 'source' || part['type'] === 'source-url') {
    return [{ type: 'source-url', sourceId: String(part['sourceId'] ?? part['id'] ?? crypto.randomUUID()), url: String(part['url'] ?? ''), title: part['title'] }]
  }
  if (part['type'] === 'tool-invocation' && part['toolInvocation'] && typeof part['toolInvocation'] === 'object') {
    const invocation = part['toolInvocation'] as Record<string, unknown>
    const state = String(invocation['state'] ?? '')
    return [{
      type: 'dynamic-tool', toolName: String(invocation['toolName'] ?? 'tool'),
      toolCallId: String(invocation['toolCallId'] ?? crypto.randomUUID()),
      state: state === 'result' ? 'output-available' : state === 'output-error' ? 'output-error' : state === 'partial-call' ? 'input-streaming' : 'input-available',
      input: invocation['args'] ?? invocation['rawInput'] ?? {},
      ...(state === 'result' ? { output: invocation['result'] } : {}),
      ...(invocation['errorText'] ? { errorText: invocation['errorText'] } : {}),
    }]
  }
  if (typeof part['type'] === 'string' && String(part['type']).startsWith('data-')) return [part]
  return []
}

function safeWebhookHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => ['content-type', 'user-agent', 'x-event-type', 'x-delivery-id'].includes(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), value.slice(0, 1024)]))
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
