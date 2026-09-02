import type {
  CyberActionProposal,
  CyberActionReceipt,
  CyberInvestigation,
  EntraAppRole,
  IntegrationConfiguration,
  IntegrationEvent,
  ObservationInput,
  PortalOverview,
  PortalPrincipal,
  SyncJob,
  TerrainEntityInput,
  TerrainRelationshipInput,
  TerrainSnapshot,
} from '@papyrus/contracts'
import { LicenseService } from '../license.js'
import { catalogEntry, INTEGRATION_CATALOG } from './catalog.js'
import type { CyberConfig } from './config.js'
import { CyberDatabase, type CreateIntegrationInput } from './database.js'
import { hasAppRole } from './entra-auth.js'
import type { ActionStore } from './action-store.js'
import type { ActionExecutorRegistry, ActionWorker } from './action-worker.js'
import type { IntegrationSyncRuntime } from './sync-worker.js'
import { normalizeSourceRecord, SourceNormalizationError } from './source-profiles.js'
import { SourceRecordConflictError, TerrainStore } from './terrain-store.js'

export class CyberServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const FORBIDDEN_SECRET_KEY = /(secret|password|token|api[_-]?key|private[_-]?key|client[_-]?secret)/i

function rejectInlineSecrets(value: unknown, path = 'settings'): void {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEY.test(key)) throw new CyberServiceError(400, 'INLINE_SECRET_REJECTED', `${path}.${key} must be a customer-vault reference, not secret material`)
    rejectInlineSecrets(item, `${path}.${key}`)
  }
}

function requireRole(principal: PortalPrincipal, role: EntraAppRole): void {
  if (!hasAppRole(principal, role)) throw new CyberServiceError(403, 'ENTRA_ROLE_REQUIRED', `${role} is required`)
}

function cleanText(value: unknown, name: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new CyberServiceError(400, 'INVALID_INPUT', `${name} is required and must not exceed ${maximum} characters`)
  return value.trim()
}

function optionalEndpoint(value: unknown, mode: CyberConfig['mode']): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const endpoint = cleanText(value, 'endpoint', 2048)
  let url: URL
  try { url = new URL(endpoint) } catch { throw new CyberServiceError(400, 'INVALID_ENDPOINT', 'endpoint must be a valid URL') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new CyberServiceError(400, 'INVALID_ENDPOINT', 'endpoint must be an HTTP(S) URL without credentials or a fragment')
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(mode === 'local' && loopback)) throw new CyberServiceError(400, 'INSECURE_ENDPOINT', 'endpoint must use HTTPS outside loopback development')
  return url.toString()
}

function optionalCredentialReference(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const reference = cleanText(value, 'credentialRef', 512)
  let url: URL
  try { url = new URL(reference) } catch {
    throw new CyberServiceError(400, 'INVALID_CREDENTIAL_REFERENCE', 'credentialRef must be an opaque customer-vault, certificate, or managed-identity URI')
  }
  if (!['vault:', 'keyvault:', 'secret:', 'cert:', 'managed-identity:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new CyberServiceError(400, 'INVALID_CREDENTIAL_REFERENCE', 'credentialRef must be an opaque customer-vault, certificate, or managed-identity URI')
  }
  return reference
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CyberServiceError(400, 'INVALID_INPUT', `${name} must be an object`)
  return value as Record<string, unknown>
}

function timestamp(value: unknown, name: string): string {
  const text = cleanText(value, name, 64)
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new CyberServiceError(400, 'INVALID_INPUT', `${name} must be an ISO-8601 timestamp`)
  return date.toISOString()
}

function confidence(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new CyberServiceError(400, 'INVALID_INPUT', `${path} must be between zero and one`)
  return value
}

function terrainEntity(value: unknown, index: number): TerrainEntityInput {
  const item = record(value, `terrain.entities[${index}]`)
  const score = confidence(item.confidence, `terrain.entities[${index}].confidence`)
  return {
    externalId: cleanText(item.externalId, `terrain.entities[${index}].externalId`, 1024),
    kind: cleanText(item.kind, `terrain.entities[${index}].kind`, 128),
    label: cleanText(item.label, `terrain.entities[${index}].label`, 512),
    ...(item.attributes === undefined ? {} : { attributes: record(item.attributes, `terrain.entities[${index}].attributes`) }),
    ...(score === undefined ? {} : { confidence: score }),
  }
}

function terrainRelationship(value: unknown, index: number): TerrainRelationshipInput {
  const item = record(value, `terrain.relationships[${index}]`)
  const score = confidence(item.confidence, `terrain.relationships[${index}].confidence`)
  return {
    ...(item.externalId === undefined ? {} : { externalId: cleanText(item.externalId, `terrain.relationships[${index}].externalId`, 1024) }),
    kind: cleanText(item.kind, `terrain.relationships[${index}].kind`, 128),
    sourceExternalId: cleanText(item.sourceExternalId, `terrain.relationships[${index}].sourceExternalId`, 1024),
    targetExternalId: cleanText(item.targetExternalId, `terrain.relationships[${index}].targetExternalId`, 1024),
    ...(item.attributes === undefined ? {} : { attributes: record(item.attributes, `terrain.relationships[${index}].attributes`) }),
    ...(score === undefined ? {} : { confidence: score }),
  }
}

export class CyberService {
  readonly license: LicenseService
  readonly terrain: TerrainStore
  readonly actions: ActionStore | undefined

  constructor(
    readonly db: CyberDatabase,
    readonly config: CyberConfig,
    terrain?: TerrainStore,
    readonly syncRuntime?: IntegrationSyncRuntime,
    actionStore?: ActionStore,
    readonly executorRegistry?: ActionExecutorRegistry,
    readonly actionWorker?: ActionWorker,
  ) {
    this.license = new LicenseService(db, config.dataDir, config.profile, config.licenseAuthorities, config.licenseRequired)
    this.terrain = terrain ?? new TerrainStore(db)
    this.actions = actionStore
  }

  overview(principal: PortalPrincipal): PortalOverview {
    this.requirePortalAccess(principal)
    return {
      deployment: {
        profile: this.config.profile,
        topology: 'customer-hosted',
        identityAuthority: 'Microsoft Entra ID',
        runtime: 'Starlings',
        license: this.license.status(),
      },
      posture: this.db.posture(),
    }
  }

  catalog(principal: PortalPrincipal) {
    this.requirePortalAccess(principal)
    return INTEGRATION_CATALOG.filter((entry) => entry.supportedProfiles.includes(this.config.profile))
  }

  integrations(principal: PortalPrincipal): IntegrationConfiguration[] {
    this.requirePortalAccess(principal)
    return this.db.listIntegrations()
  }

  createIntegration(principal: PortalPrincipal, catalogId: unknown, input: Record<string, unknown>): IntegrationConfiguration {
    requireRole(principal, 'Papyrus.Integration.Manage')
    const entry = catalogEntry(cleanText(catalogId, 'catalogId', 128))
    if (!entry || !entry.supportedProfiles.includes(this.config.profile)) throw new CyberServiceError(400, 'CONNECTOR_UNAVAILABLE', 'Connector is not available for this deployment profile')
    this.license.require(entry.licenseFeature)
    const settings = input.settings === undefined ? {} : input.settings
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new CyberServiceError(400, 'INVALID_INPUT', 'settings must be an object')
    rejectInlineSecrets(settings)
    const credentialRef = optionalCredentialReference(input.credentialRef)
    const endpoint = optionalEndpoint(input.endpoint, this.config.mode)
    const create: CreateIntegrationInput = {
      name: cleanText(input.name ?? entry.name, 'name'),
      scope: cleanText(input.scope ?? (entry.observationProtocol ? 'daemon' : undefined), 'scope', 512),
      settings: Object.fromEntries(Object.entries(settings as Record<string, unknown>).map(([key, value]) => {
        if (!['string', 'number', 'boolean'].includes(typeof value)) throw new CyberServiceError(400, 'INVALID_INPUT', `settings.${key} must be a string, number, or boolean`)
        return [key, value as string | number | boolean]
      })),
      ...(endpoint ? { endpoint } : {}),
      ...(credentialRef ? { credentialRef } : {}),
    }
    return this.db.createIntegration(entry, create, principal.oid)
  }

  async testIntegration(principal: PortalPrincipal, id: string): Promise<IntegrationConfiguration> {
    requireRole(principal, 'Papyrus.Integration.Manage')
    const integration = this.integration(id)
    const entry = catalogEntry(integration.catalogId)
    if (!entry) throw new CyberServiceError(409, 'CONNECTOR_REMOVED', 'Connector manifest no longer exists')
    const requirements: string[] = []
    if (!entry.authSchemes.includes('none') && !integration.credentialRef && !entry.authSchemes.includes('entra')) requirements.push('credential reference or Entra application binding')
    if (['a2a-peer', 'acp-client', 'firewall-executor'].includes(entry.id) && !integration.endpoint) requirements.push('HTTPS endpoint')
    if (requirements.length) throw new CyberServiceError(409, 'CONFIGURATION_INCOMPLETE', `Configuration test requires ${requirements.join(' and ')}`)
    const runtimeResult = await this.syncRuntime?.test(integration)
    if (runtimeResult && (!runtimeResult.reachable || !runtimeResult.authenticated)) {
      this.db.recordSyncFailure(id, runtimeResult.message)
      throw new CyberServiceError(409, 'CONNECTOR_TEST_FAILED', runtimeResult.message)
    }
    return this.db.markTested(id, principal.oid, runtimeResult ? {
      result: 'connection_verified', networkReachability: 'verified', authentication: 'verified',
      message: runtimeResult.message, ...(runtimeResult.details ? { details: runtimeResult.details } : {}),
    } : entry.observationProtocol ? {
      result: 'configuration_verified', networkReachability: 'inbound_waiting',
      message: 'Source profile, schema policy, scope, and credential references passed validation; health remains unknown until an observation is accepted.',
    } : {
      result: 'configuration_verified', networkReachability: 'not_tested',
      message: 'Manifest, scope, endpoint policy, and credential references passed deterministic validation; no connector driver is installed.',
    }, Boolean(runtimeResult))
  }

  submitIntegration(principal: PortalPrincipal, id: string): IntegrationConfiguration {
    requireRole(principal, 'Papyrus.Integration.Manage')
    this.integration(id)
    return this.db.submitForApproval(id, principal.oid)
  }

  activateIntegration(principal: PortalPrincipal, id: string): IntegrationConfiguration {
    const integration = this.integration(id)
    requireRole(principal, integration.risk === 'high' || integration.risk === 'critical' || integration.authority === 'controlled_actions'
      ? 'Papyrus.Security.Manage'
      : 'Papyrus.Integration.Manage')
    const entry = catalogEntry(integration.catalogId)
    if (entry && ['pull', 'hybrid'].includes(entry.syncMode) && !this.syncRuntime?.supports(integration)) {
      throw new CyberServiceError(409, 'CONNECTOR_DRIVER_UNAVAILABLE', 'A connector driver must be installed before this pull integration can be activated')
    }
    const activated = this.db.activate(id, principal.oid)
    if (entry && ['pull', 'hybrid'].includes(entry.syncMode)) this.syncRuntime?.enqueue(activated)
    return activated
  }

  disableIntegration(principal: PortalPrincipal, id: string, reason?: unknown): IntegrationConfiguration {
    const integration = this.integration(id)
    requireRole(principal, integration.authority === 'controlled_actions' ? 'Papyrus.Security.Manage' : 'Papyrus.Integration.Manage')
    const disabled = this.db.disable(id, principal.oid, reason === undefined ? undefined : cleanText(reason, 'reason', 512))
    this.syncRuntime?.cancel(id)
    return disabled
  }

  deleteIntegration(principal: PortalPrincipal, id: string): void {
    const integration = this.integration(id)
    requireRole(principal, integration.authority === 'controlled_actions' ? 'Papyrus.Security.Manage' : 'Papyrus.Integration.Manage')
    this.syncRuntime?.cancel(id)
    this.db.deleteIntegration(id, principal.oid)
  }

  requestSync(principal: PortalPrincipal, id: string): SyncJob {
    requireRole(principal, 'Papyrus.Integration.Manage')
    const integration = this.integration(id)
    if (integration.state !== 'active') throw new CyberServiceError(409, 'INTEGRATION_NOT_ACTIVE', 'Only active integrations can be synchronized')
    const entry = catalogEntry(integration.catalogId)
    if (!entry || !['pull', 'hybrid'].includes(entry.syncMode)) throw new CyberServiceError(409, 'INTEGRATION_NOT_PULL_BASED', 'This integration receives pushed observations and does not run scheduled synchronization')
    const job = this.syncRuntime?.enqueue(integration)
    if (!job) throw new CyberServiceError(409, 'CONNECTOR_DRIVER_UNAVAILABLE', 'A connector driver is not installed for this integration')
    return job
  }

  syncJobs(principal: PortalPrincipal, id: string): SyncJob[] {
    requireRole(principal, 'Papyrus.Integration.View')
    this.integration(id)
    return this.terrain.listJobs(id)
  }

  authorizeIngestionToken(principal: PortalPrincipal, id: string): void {
    requireRole(principal, 'Papyrus.Integration.Manage')
    const integration = this.integration(id)
    if (integration.state !== 'active') throw new CyberServiceError(409, 'INTEGRATION_NOT_ACTIVE', 'Ingestion credentials are issued only for active integrations')
    const entry = catalogEntry(integration.catalogId)
    if (!entry?.observationProtocol) throw new CyberServiceError(409, 'INTEGRATION_NOT_OBSERVATION_SOURCE', 'This integration does not accept Observation API records')
  }

  recordIngestionTokenIssued(principal: PortalPrincipal, id: string, expiresAt: string): void {
    this.db.recordIngestionTokenIssued(id, principal.oid, expiresAt)
  }

  ingestObservation(principal: PortalPrincipal, id: string, value: Record<string, unknown>) {
    requireRole(principal, 'Papyrus.Integration.Manage')
    return this.ingestAuthorizedObservation(id, value)
  }

  ingestObservationWithScopedCredential(id: string, value: Record<string, unknown>) {
    return this.ingestAuthorizedObservation(id, value)
  }

  private ingestAuthorizedObservation(id: string, value: Record<string, unknown>) {
    const integration = this.integration(id)
    if (integration.state !== 'active') throw new CyberServiceError(409, 'INTEGRATION_NOT_ACTIVE', 'Observations are accepted only from active integrations')
    const entry = catalogEntry(integration.catalogId)
    if (!entry?.observationProtocol) throw new CyberServiceError(409, 'INTEGRATION_NOT_OBSERVATION_SOURCE', 'This integration does not accept Observation API records')
    const sourceRecordId = cleanText(value.sourceRecordId, 'sourceRecordId', 1024)
    const payload = record(value.payload, 'payload')
    const schema = value.schema === undefined ? undefined : cleanText(value.schema, 'schema', 128)
    const terrainValue = value.terrain === undefined ? undefined : record(value.terrain, 'terrain')
    if (schema && terrainValue) throw new CyberServiceError(400, 'NORMALIZATION_MODE_CONFLICT', 'Send either a versioned source schema or a canonical Terrain projection, not both')
    if (!schema && !terrainValue && integration.catalogId !== 'observation-api') {
      throw new CyberServiceError(400, 'NORMALIZATION_MODE_REQUIRED', 'This source requires a supported schema or a canonical Terrain projection')
    }
    let normalized: ReturnType<typeof normalizeSourceRecord> | undefined
    if (schema) {
      try { normalized = normalizeSourceRecord(integration.catalogId, schema, payload, sourceRecordId) }
      catch (cause) {
        if (cause instanceof SourceNormalizationError) throw new CyberServiceError(400, 'SOURCE_NORMALIZATION_FAILED', cause.message)
        throw cause
      }
    }
    const evidenceType = normalized?.evidenceType ?? cleanText(value.evidenceType, 'evidenceType', 128)
    const subject = normalized?.subject ?? cleanText(value.subject, 'subject', 1024)
    if (value.evidenceType !== undefined && normalized && cleanText(value.evidenceType, 'evidenceType', 128) !== evidenceType) {
      throw new CyberServiceError(400, 'EVIDENCE_TYPE_MISMATCH', `Schema ${schema} produces ${evidenceType}`)
    }
    if (entry.evidenceTypes.length && !entry.evidenceTypes.includes(evidenceType)) throw new CyberServiceError(400, 'EVIDENCE_TYPE_NOT_ALLOWED', `${evidenceType} is not declared by this connector`)
    const entitiesValue = terrainValue?.entities ?? []
    const relationshipsValue = terrainValue?.relationships ?? []
    if (!Array.isArray(entitiesValue) || entitiesValue.length > 5_000) throw new CyberServiceError(400, 'INVALID_INPUT', 'terrain.entities must be an array with at most 5,000 entries')
    if (!Array.isArray(relationshipsValue) || relationshipsValue.length > 10_000) throw new CyberServiceError(400, 'INVALID_INPUT', 'terrain.relationships must be an array with at most 10,000 entries')
    const observation: ObservationInput = {
      sourceRecordId,
      observedAt: timestamp(value.observedAt, 'observedAt'), evidenceType,
      subject, payload,
      ...(schema ? { schema } : {}),
      ...(value.classification === undefined ? {} : { classification: cleanText(value.classification, 'classification', 128) }),
      ...(normalized?.terrain ? { terrain: normalized.terrain } : terrainValue ? { terrain: {
        entities: entitiesValue.map(terrainEntity), relationships: relationshipsValue.map(terrainRelationship),
      } } : {}),
    }
    try { return this.terrain.ingest(integration, observation) }
    catch (cause) {
      if (cause instanceof SourceRecordConflictError) throw new CyberServiceError(409, 'SOURCE_RECORD_CONFLICT', cause.message)
      if (cause instanceof Error && /references an unknown entity/.test(cause.message)) throw new CyberServiceError(400, 'UNKNOWN_TERRAIN_ENTITY', cause.message)
      throw cause
    }
  }

  terrainSnapshot(principal: PortalPrincipal): TerrainSnapshot {
    this.requirePortalAccess(principal)
    requireRole(principal, 'Papyrus.Integration.View')
    return this.terrain.snapshot()
  }

  events(principal: PortalPrincipal, id: string): IntegrationEvent[] {
    requireRole(principal, 'Papyrus.Audit.View')
    this.integration(id)
    return this.db.listEvents(id)
  }

  // ─── Investigations ──────────────────────────────────────────────

  listInvestigations(principal: PortalPrincipal): CyberInvestigation[] {
    this.requirePortalAccess(principal)
    if (!this.actions) return []
    return this.actions.listInvestigations()
  }

  getInvestigation(principal: PortalPrincipal, id: string): CyberInvestigation {
    this.requirePortalAccess(principal)
    if (!this.actions) throw new CyberServiceError(404, 'NOT_FOUND', 'Action store not initialized')
    const investigation = this.actions.getInvestigation(id)
    if (!investigation) throw new CyberServiceError(404, 'INVESTIGATION_NOT_FOUND', 'Investigation not found')
    return investigation
  }

  createInvestigation(
    principal: PortalPrincipal,
    title: string,
    trigger: CyberInvestigation['trigger'],
    triggerIntegrationId?: string,
    triggerMessageId?: string,
    mastraThreadId?: string,
  ): CyberInvestigation {
    this.requirePortalAccess(principal)
    if (!this.actions) throw new CyberServiceError(503, 'ACTION_STORE_UNAVAILABLE', 'Action store is not initialized')
    return this.actions.createInvestigation({
      title: cleanText(title, 'title', 512),
      trigger,
      ...(triggerIntegrationId ? { triggerIntegrationId: cleanText(triggerIntegrationId, 'triggerIntegrationId', 128) } : {}),
      ...(triggerMessageId ? { triggerMessageId: cleanText(triggerMessageId, 'triggerMessageId', 512) } : {}),
      ...(mastraThreadId ? { mastraThreadId: cleanText(mastraThreadId, 'mastraThreadId', 512) } : {}),
    })
  }

  // ─── Action Proposals ───────────────────────────────────────────

  listProposals(principal: PortalPrincipal, investigationId?: string): CyberActionProposal[] {
    this.requirePortalAccess(principal)
    if (!this.actions) return []
    return this.actions.listProposals(investigationId)
  }

  createProposal(
    principal: PortalPrincipal,
    investigationId: string,
    executorIntegrationId: string,
    action: string,
    target: string,
    rationaleClaimIds: string[],
    parameters?: Record<string, unknown>,
    expiresAt?: string,
  ): CyberActionProposal {
    // Proposing an operational action drives a live integration, so it carries
    // the same management role as the rest of the integration surface rather
    // than being open to any assigned portal role.
    requireRole(principal, 'Papyrus.Integration.Manage')
    if (!this.actions) throw new CyberServiceError(503, 'ACTION_STORE_UNAVAILABLE', 'Action store is not initialized')
    const investigation = this.actions.getInvestigation(investigationId)
    if (!investigation) throw new CyberServiceError(404, 'INVESTIGATION_NOT_FOUND', 'Investigation not found')
    const executor = this.requireExecutable(executorIntegrationId)
    const proposal = this.actions.createProposal({
      investigationId, proposedByOperatorId: principal.oid,
      executorIntegrationId: cleanText(executorIntegrationId, 'executorIntegrationId', 128),
      action: cleanText(action, 'action', 256),
      target: cleanText(target, 'target', 1024),
      ...(parameters ? { parameters: record(parameters, 'parameters') } : {}),
      rationaleClaimIds,
      ...(expiresAt ? { expiresAt: timestamp(expiresAt, 'expiresAt') } : {}),
    })
    this.db.recordActionEvent(executor.id, principal.oid, 'ActionProposed', {
      proposalId: proposal.id, investigationId, action: proposal.action, target: proposal.target,
      rationaleClaimIds: proposal.rationaleClaimIds,
    })
    return proposal
  }

  approveProposal(principal: PortalPrincipal, proposalId: string): CyberActionProposal {
    requireRole(principal, 'Papyrus.Action.Approve')
    if (!this.actions) throw new CyberServiceError(503, 'ACTION_STORE_UNAVAILABLE', 'Action store is not initialized')
    const proposal = this.actions.getProposal(proposalId)
    if (!proposal) throw new CyberServiceError(404, 'PROPOSAL_NOT_FOUND', 'Action proposal not found')
    // An approval that cannot produce executable work is refused rather than
    // recorded, so the ledger never holds an authorized action with nothing
    // able to run it.
    this.requireExecutable(proposal.executorIntegrationId)
    if (!this.actionWorker) throw new CyberServiceError(503, 'ACTION_WORKER_UNAVAILABLE', 'Action worker is not running; approvals cannot be executed')
    try {
      const approved = this.actions.approveProposal(proposalId, principal.oid)
      const job = this.actions.enqueueJob(approved, this.actionWorker.defaultMaxAttempts)
      this.db.recordActionEvent(approved.executorIntegrationId, principal.oid, 'ActionApproved', {
        proposalId: approved.id, investigationId: approved.investigationId, jobId: job.id,
        action: approved.action, target: approved.target,
        idempotencyKey: approved.idempotencyKey,
      })
      return approved
    } catch (cause) {
      throw new CyberServiceError(409, 'PROPOSAL_STATE_ERROR', cause instanceof Error ? cause.message : 'Cannot approve proposal')
    }
  }

  denyProposal(principal: PortalPrincipal, proposalId: string, reason?: string): CyberActionProposal {
    requireRole(principal, 'Papyrus.Action.Approve')
    if (!this.actions) throw new CyberServiceError(503, 'ACTION_STORE_UNAVAILABLE', 'Action store is not initialized')
    const proposal = this.actions.getProposal(proposalId)
    if (!proposal) throw new CyberServiceError(404, 'PROPOSAL_NOT_FOUND', 'Action proposal not found')
    try {
      const denied = this.actions.denyProposal(proposalId, principal.oid, reason)
      this.db.recordActionEvent(denied.executorIntegrationId, principal.oid, 'ActionDenied', {
        proposalId: denied.id, investigationId: denied.investigationId,
        action: denied.action, target: denied.target,
        ...(denied.denialReason ? { reason: denied.denialReason } : {}),
      })
      return denied
    } catch (cause) {
      throw new CyberServiceError(409, 'PROPOSAL_STATE_ERROR', cause instanceof Error ? cause.message : 'Cannot deny proposal')
    }
  }

  /**
   * Resolve an integration that is allowed to execute actions, is currently
   * active, and has an installed executor for its connector type. The same rule
   * governs proposing and approving, so an action can never enter the ledger
   * against an integration that is unable to carry it out.
   */
  private requireExecutable(executorIntegrationId: string): IntegrationConfiguration {
    const executor = this.db.getIntegration(executorIntegrationId)
    if (!executor) throw new CyberServiceError(404, 'INTEGRATION_NOT_FOUND', 'Executor integration not found')
    // Exchange is a bidirectional human adapter: it can receive evidence and
    // also carry an explicitly approved notification. Other executors must be
    // declared action-capable by their catalog authority/class.
    const isApprovedEmailExecutor = executor.catalogId === 'exchange-email'
    if (!isApprovedEmailExecutor && executor.integrationClass !== 'action_executor' && executor.authority !== 'controlled_actions') {
      throw new CyberServiceError(400, 'NOT_AN_EXECUTOR', 'The specified integration is not an action executor')
    }
    if (executor.state !== 'active') throw new CyberServiceError(409, 'EXECUTOR_NOT_ACTIVE', 'Executor integration must be active')
    if (!this.executorRegistry?.has(executor.catalogId)) {
      throw new CyberServiceError(409, 'EXECUTOR_UNAVAILABLE', `No action executor is installed for ${executor.catalogId}`)
    }
    return executor
  }

  listReceipts(principal: PortalPrincipal, investigationId?: string): CyberActionReceipt[] {
    this.requirePortalAccess(principal)
    if (!this.actions) return []
    return this.actions.listReceipts(investigationId)
  }

  requirePortalAccess(principal: PortalPrincipal): void {
    if (principal.roles.length === 0) throw new CyberServiceError(403, 'ENTRA_APP_ROLE_REQUIRED', 'Papyrus access must be assigned through an Entra application role')
  }

  private integration(id: string): IntegrationConfiguration {
    const integration = this.db.getIntegration(id)
    if (!integration) throw new CyberServiceError(404, 'INTEGRATION_NOT_FOUND', 'Integration not found')
    return integration
  }
}
