import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'libsql'
import type {
  IntegrationCatalogEntry,
  IntegrationConfiguration,
  IntegrationEvent,
  IntegrationState,
} from '@papyrus/contracts'

type Row = Record<string, unknown>

/** Decisions the action ledger records against an executor integration. */
export type ActionDecisionKind = 'ActionProposed' | 'ActionApproved' | 'ActionDenied' | 'ActionExecuted' | 'ActionFailed'

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export interface CreateIntegrationInput {
  name: string
  endpoint?: string
  scope: string
  credentialRef?: string
  settings: Record<string, string | number | boolean>
}

export interface ModelProviderConfiguration {
  id: string
  slug: string
  name: string
  baseUrl: string
  credentialRef?: string
  models: string[]
  createdByOid: string
  createdAt: string
  updatedAt: string
  version: number
}

export interface ModelAssignmentConfiguration {
  providerId: string
  model: string
  updatedByOid: string
  updatedAt: string
}

export interface CreateModelProviderInput {
  slug: string
  name: string
  baseUrl: string
  credentialRef?: string
  models: string[]
}

export class AgentDatabase {
  readonly sqlite: InstanceType<typeof Database>

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.sqlite = new Database(path)
    this.sqlite.pragma('foreign_keys = ON')
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('synchronous = FULL')
    this.migrate()
  }

  close(): void { this.sqlite.close() }

  createIntegration(entry: IntegrationCatalogEntry, input: CreateIntegrationInput, actorOid: string): IntegrationConfiguration {
    const now = new Date().toISOString()
    const id = randomUUID()
    const initialState: IntegrationState = entry.observationProtocol ? 'active' : 'draft'
    this.sqlite.prepare(`INSERT INTO agent_integrations(
      id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,
      health,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      id, entry.id, input.name, entry.integrationClass, entry.authority, entry.risk, initialState, input.endpoint ?? null,
      input.scope, input.credentialRef ?? null, JSON.stringify(input.settings), 'unknown', actorOid, now, now,
    )
    this.appendEvent(id, actorOid, entry.observationProtocol ? 'ObservationSourceRegistered' : 'IntegrationCreated', {
      catalogId: entry.id, authority: entry.authority, scope: input.scope, state: initialState,
    })
    return this.getIntegration(id) as IntegrationConfiguration
  }

  getIntegration(id: string): IntegrationConfiguration | undefined {
    const row = this.sqlite.prepare('SELECT * FROM agent_integrations WHERE id=? AND deleted_at IS NULL').get(id) as Row | undefined
    return row ? this.integration(row) : undefined
  }

  listIntegrations(): IntegrationConfiguration[] {
    return (this.sqlite.prepare('SELECT * FROM agent_integrations WHERE deleted_at IS NULL ORDER BY updated_at DESC').all() as Row[]).map((row) => this.integration(row))
  }

  markTested(id: string, actorOid: string, result: Record<string, unknown>, connectionVerified = false): IntegrationConfiguration {
    const integration = this.requireIntegration(id)
    if (!['draft', 'tested', 'degraded', 'disabled'].includes(integration.state)) throw new Error(`Integration cannot be tested from ${integration.state}`)
    const now = new Date().toISOString()
    this.sqlite.prepare("UPDATE agent_integrations SET state='tested',health=?,last_tested_at=?,updated_at=?,version=version+1 WHERE id=?")
      .run(connectionVerified ? 'healthy' : 'unknown', now, now, id)
    this.appendEvent(id, actorOid, 'IntegrationTested', result)
    return this.getIntegration(id) as IntegrationConfiguration
  }

  submitForApproval(id: string, actorOid: string): IntegrationConfiguration {
    const integration = this.requireIntegration(id)
    if (integration.state !== 'tested') throw new Error(`Integration must be tested before approval; current state is ${integration.state}`)
    this.transition(id, 'awaiting_approval')
    this.appendEvent(id, actorOid, 'IntegrationSubmitted', { authority: integration.authority, risk: integration.risk })
    return this.getIntegration(id) as IntegrationConfiguration
  }

  activate(id: string, actorOid: string): IntegrationConfiguration {
    const integration = this.requireIntegration(id)
    if (integration.state !== 'awaiting_approval') throw new Error(`Integration must await approval before activation; current state is ${integration.state}`)
    this.transition(id, 'active')
    this.appendEvent(id, actorOid, 'IntegrationActivated', { authority: integration.authority, risk: integration.risk })
    return this.getIntegration(id) as IntegrationConfiguration
  }

  disable(id: string, actorOid: string, reason?: string): IntegrationConfiguration {
    const integration = this.requireIntegration(id)
    if (integration.state === 'disabled') return integration
    this.transition(id, 'disabled')
    this.appendEvent(id, actorOid, 'IntegrationDisabled', { ...(reason ? { reason } : {}) })
    return this.getIntegration(id) as IntegrationConfiguration
  }

  deleteIntegration(id: string, actorOid: string): void {
    const integration = this.requireIntegration(id)
    const now = new Date().toISOString()
    this.appendEvent(id, actorOid, 'IntegrationDeleted', { previousState: integration.state, evidenceRetained: true })
    this.sqlite.prepare("UPDATE agent_integrations SET state='disabled',deleted_at=?,updated_at=?,version=version+1 WHERE id=?")
      .run(now, now, id)
  }

  recordIngestionTokenIssued(id: string, actorOid: string, expiresAt: string): void {
    this.requireIntegration(id)
    this.appendEvent(id, actorOid, 'IngestionTokenIssued', { expiresAt, scope: 'observations:write' })
  }

  /**
   * Append an action-ledger decision to the same append-only SHA-256 chain used
   * for integration lifecycle events, so who proposed, approved, denied, and
   * executed an operational action is auditable end to end.
   */
  recordActionEvent(integrationId: string, actorOid: string, action: ActionDecisionKind, data: Record<string, unknown>): void {
    this.requireIntegration(integrationId)
    this.appendEvent(integrationId, actorOid, action, data)
  }

  recordSyncSuccess(id: string, evidenceAt?: string): void {
    const now = new Date().toISOString()
    this.sqlite.prepare(`UPDATE agent_integrations SET health='healthy',last_sync_at=?,last_sync_error=NULL,
      last_evidence_at=CASE WHEN ? IS NULL THEN last_evidence_at
        WHEN last_evidence_at IS NULL OR last_evidence_at < ? THEN ? ELSE last_evidence_at END,
      updated_at=?,version=version+1 WHERE id=?`).run(now, evidenceAt ?? null, evidenceAt ?? null, evidenceAt ?? null, now, id)
  }

  recordSyncFailure(id: string, message: string): void {
    const now = new Date().toISOString()
    this.sqlite.prepare("UPDATE agent_integrations SET health='degraded',last_sync_at=?,last_sync_error=?,updated_at=?,version=version+1 WHERE id=?")
      .run(now, message.slice(0, 2048), now, id)
  }

  recordEvidence(id: string, observedAt: string): void {
    const now = new Date().toISOString()
    this.sqlite.prepare(`UPDATE agent_integrations SET health='healthy',last_evidence_at=CASE
      WHEN last_evidence_at IS NULL OR last_evidence_at < ? THEN ? ELSE last_evidence_at END,
      updated_at=?,version=version+1 WHERE id=?`).run(observedAt, observedAt, now, id)
  }

  listEvents(integrationId: string): IntegrationEvent[] {
    return (this.sqlite.prepare('SELECT * FROM agent_integration_events WHERE integration_id=? ORDER BY sequence DESC').all(integrationId) as Row[])
      .map((row) => ({
        sequence: Number(row.sequence), integrationId: String(row.integration_id), actorOid: String(row.actor_oid),
        action: String(row.action), occurredAt: String(row.occurred_at), data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
        previousHash: String(row.previous_hash), hash: String(row.hash),
      }))
  }

  createModelProvider(input: CreateModelProviderInput, actorOid: string): ModelProviderConfiguration {
    const now = new Date().toISOString()
    const id = randomUUID()
    this.sqlite.prepare(`INSERT INTO agent_model_providers(
      id,slug,name,base_url,credential_ref,models_json,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,1)`).run(
      id, input.slug, input.name, input.baseUrl, input.credentialRef ?? null, JSON.stringify(input.models), actorOid, now, now,
    )
    this.appendModelEvent(actorOid, 'ModelProviderCreated', { providerId: id, slug: input.slug, baseUrl: input.baseUrl })
    return this.getModelProvider(id) as ModelProviderConfiguration
  }

  updateModelProvider(id: string, input: CreateModelProviderInput, actorOid: string): ModelProviderConfiguration {
    this.requireModelProvider(id)
    this.sqlite.prepare('UPDATE agent_model_providers SET slug=?,name=?,base_url=?,credential_ref=?,models_json=?,updated_at=?,version=version+1 WHERE id=?')
      .run(input.slug, input.name, input.baseUrl, input.credentialRef ?? null, JSON.stringify(input.models), new Date().toISOString(), id)
    this.appendModelEvent(actorOid, 'ModelProviderUpdated', { providerId: id, slug: input.slug, baseUrl: input.baseUrl })
    return this.getModelProvider(id) as ModelProviderConfiguration
  }

  deleteModelProvider(id: string, actorOid: string): void {
    const provider = this.requireModelProvider(id)
    this.sqlite.prepare('DELETE FROM agent_model_providers WHERE id=?').run(id)
    this.appendModelEvent(actorOid, 'ModelProviderDeleted', { providerId: id, slug: provider.slug })
  }

  getModelProvider(id: string): ModelProviderConfiguration | undefined {
    const row = this.sqlite.prepare('SELECT * FROM agent_model_providers WHERE id=?').get(id) as Row | undefined
    return row ? this.modelProvider(row) : undefined
  }

  getModelProviderBySlug(slug: string): ModelProviderConfiguration | undefined {
    const row = this.sqlite.prepare('SELECT * FROM agent_model_providers WHERE slug=?').get(slug) as Row | undefined
    return row ? this.modelProvider(row) : undefined
  }

  listModelProviders(): ModelProviderConfiguration[] {
    return (this.sqlite.prepare('SELECT * FROM agent_model_providers ORDER BY name').all() as Row[]).map((row) => this.modelProvider(row))
  }

  assignAgentModel(providerId: string, model: string, actorOid: string): ModelAssignmentConfiguration {
    this.requireModelProvider(providerId)
    const now = new Date().toISOString()
    this.sqlite.prepare(`INSERT INTO agent_model_assignment(id,provider_id,model,updated_by_oid,updated_at) VALUES(1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id,model=excluded.model,updated_by_oid=excluded.updated_by_oid,updated_at=excluded.updated_at`)
      .run(providerId, model, actorOid, now)
    this.appendModelEvent(actorOid, 'AgentModelAssigned', { providerId, model })
    return this.getAgentModelAssignment() as ModelAssignmentConfiguration
  }

  clearAgentModelAssignment(actorOid: string): void {
    const existing = this.getAgentModelAssignment()
    if (!existing) return
    this.sqlite.prepare('DELETE FROM agent_model_assignment WHERE id=1').run()
    this.appendModelEvent(actorOid, 'AgentModelAssignmentCleared', { previousProviderId: existing.providerId, previousModel: existing.model })
  }

  getAgentModelAssignment(): ModelAssignmentConfiguration | undefined {
    const row = this.sqlite.prepare('SELECT * FROM agent_model_assignment WHERE id=1').get() as Row | undefined
    if (!row) return undefined
    return {
      providerId: String(row.provider_id), model: String(row.model),
      updatedByOid: String(row.updated_by_oid), updatedAt: String(row.updated_at),
    }
  }

  posture(): { integrations: number; healthy: number; degraded: number; awaitingApproval: number; evidenceSources: number; actionExecutors: number } {
    const rows = this.sqlite.prepare(`SELECT
      count(*) integrations,
      sum(CASE WHEN health='healthy' THEN 1 ELSE 0 END) healthy,
      sum(CASE WHEN health IN ('degraded','unreachable') THEN 1 ELSE 0 END) degraded,
      sum(CASE WHEN state='awaiting_approval' THEN 1 ELSE 0 END) awaiting_approval,
      sum(CASE WHEN integration_class='evidence_source' THEN 1 ELSE 0 END) evidence_sources,
      sum(CASE WHEN integration_class='action_executor' OR authority='controlled_actions' THEN 1 ELSE 0 END) action_executors
      FROM agent_integrations
      WHERE deleted_at IS NULL
        AND (integration_class NOT IN ('evidence_source','terrain_source') OR last_evidence_at IS NOT NULL)`).get() as Row
    return {
      integrations: Number(rows.integrations ?? 0), healthy: Number(rows.healthy ?? 0), degraded: Number(rows.degraded ?? 0),
      awaitingApproval: Number(rows.awaiting_approval ?? 0), evidenceSources: Number(rows.evidence_sources ?? 0),
      actionExecutors: Number(rows.action_executors ?? 0),
    }
  }

  verifyEventChain(): { valid: boolean; count: number } {
    const rows = this.sqlite.prepare('SELECT * FROM agent_integration_events ORDER BY sequence').all() as Row[]
    let previousHash = '0'.repeat(64)
    for (const row of rows) {
      const payload = {
        sequence: Number(row.sequence), integrationId: String(row.integration_id), actorOid: String(row.actor_oid),
        action: String(row.action), occurredAt: String(row.occurred_at), data: JSON.parse(String(row.data_json)), previousHash,
      }
      const expected = createHash('sha256').update(canonical(payload)).digest('hex')
      if (String(row.previous_hash) !== previousHash || String(row.hash) !== expected) return { valid: false, count: rows.length }
      previousHash = expected
    }
    return { valid: true, count: rows.length }
  }

  private requireIntegration(id: string): IntegrationConfiguration {
    const integration = this.getIntegration(id)
    if (!integration) throw new Error('Integration not found')
    return integration
  }

  private transition(id: string, state: IntegrationState): void {
    this.sqlite.prepare('UPDATE agent_integrations SET state=?,updated_at=?,version=version+1 WHERE id=?')
      .run(state, new Date().toISOString(), id)
  }

  private appendEvent(integrationId: string, actorOid: string, action: string, data: Record<string, unknown>): void {
    const previous = this.sqlite.prepare('SELECT sequence,hash FROM agent_integration_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined
    const sequence = Number(previous?.sequence ?? 0) + 1
    const previousHash = previous ? String(previous.hash) : '0'.repeat(64)
    const occurredAt = new Date().toISOString()
    const payload = { sequence, integrationId, actorOid, action, occurredAt, data, previousHash }
    const hash = createHash('sha256').update(canonical(payload)).digest('hex')
    this.sqlite.prepare(`INSERT INTO agent_integration_events(
      sequence,integration_id,actor_oid,action,occurred_at,data_json,previous_hash,hash
    ) VALUES(?,?,?,?,?,?,?,?)`).run(sequence, integrationId, actorOid, action, occurredAt, JSON.stringify(data), previousHash, hash)
  }

  private appendModelEvent(actorOid: string, action: string, data: Record<string, unknown>): void {
    const previous = this.sqlite.prepare('SELECT sequence,hash FROM agent_model_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined
    const sequence = Number(previous?.sequence ?? 0) + 1
    const previousHash = previous ? String(previous.hash) : '0'.repeat(64)
    const occurredAt = new Date().toISOString()
    const payload = { sequence, actorOid, action, occurredAt, data, previousHash }
    const hash = createHash('sha256').update(canonical(payload)).digest('hex')
    this.sqlite.prepare(`INSERT INTO agent_model_events(
      sequence,actor_oid,action,occurred_at,data_json,previous_hash,hash
    ) VALUES(?,?,?,?,?,?,?)`).run(sequence, actorOid, action, occurredAt, JSON.stringify(data), previousHash, hash)
  }

  private requireModelProvider(id: string): ModelProviderConfiguration {
    const provider = this.getModelProvider(id)
    if (!provider) throw new Error('Model provider not found')
    return provider
  }

  private modelProvider(row: Row): ModelProviderConfiguration {
    return {
      id: String(row.id), slug: String(row.slug), name: String(row.name), baseUrl: String(row.base_url),
      ...(row.credential_ref ? { credentialRef: String(row.credential_ref) } : {}),
      models: JSON.parse(String(row.models_json)) as string[],
      createdByOid: String(row.created_by_oid), createdAt: String(row.created_at), updatedAt: String(row.updated_at), version: Number(row.version),
    }
  }

  private integration(row: Row): IntegrationConfiguration {
    return {
      id: String(row.id), catalogId: String(row.catalog_id), name: String(row.name),
      integrationClass: row.integration_class as IntegrationConfiguration['integrationClass'],
      authority: row.authority as IntegrationConfiguration['authority'], risk: row.risk as IntegrationConfiguration['risk'],
      state: row.state as IntegrationConfiguration['state'], ...(row.endpoint ? { endpoint: String(row.endpoint) } : {}),
      scope: String(row.scope), ...(row.credential_ref ? { credentialRef: String(row.credential_ref) } : {}),
      settings: JSON.parse(String(row.settings_json)) as IntegrationConfiguration['settings'],
      health: row.health as IntegrationConfiguration['health'],
      ...(row.last_evidence_at ? { lastEvidenceAt: String(row.last_evidence_at) } : {}),
      ...(row.last_sync_at ? { lastSyncAt: String(row.last_sync_at) } : {}),
      ...(row.last_sync_error ? { lastSyncError: String(row.last_sync_error) } : {}),
      ...(row.last_tested_at ? { lastTestedAt: String(row.last_tested_at) } : {}),
      createdByOid: String(row.created_by_oid), createdAt: String(row.created_at), updatedAt: String(row.updated_at), version: Number(row.version),
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS agent_integrations (
        id TEXT PRIMARY KEY,
        catalog_id TEXT NOT NULL,
        name TEXT NOT NULL,
        integration_class TEXT NOT NULL,
        authority TEXT NOT NULL,
        risk TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('draft','tested','awaiting_approval','active','degraded','disabled')),
        endpoint TEXT,
        scope TEXT NOT NULL,
        credential_ref TEXT,
        settings_json TEXT NOT NULL,
        health TEXT NOT NULL CHECK(health IN ('unknown','healthy','degraded','unreachable')),
        last_evidence_at TEXT,
        last_tested_at TEXT,
        last_sync_at TEXT,
        last_sync_error TEXT,
        created_by_oid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_integrations_state ON agent_integrations(state,updated_at DESC);
      CREATE TABLE IF NOT EXISTS agent_integration_events (
        sequence INTEGER PRIMARY KEY,
        integration_id TEXT NOT NULL REFERENCES agent_integrations(id),
        actor_oid TEXT NOT NULL,
        action TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS agent_events_no_update BEFORE UPDATE ON agent_integration_events
      BEGIN SELECT RAISE(ABORT, 'agent integration events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS agent_events_no_delete BEFORE DELETE ON agent_integration_events
      BEGIN SELECT RAISE(ABORT, 'agent integration events are append-only'); END;
      CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY CHECK(id = 1), document_json TEXT NOT NULL, activated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_model_providers (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        credential_ref TEXT,
        models_json TEXT NOT NULL,
        created_by_oid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_model_assignment (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        provider_id TEXT NOT NULL REFERENCES agent_model_providers(id),
        model TEXT NOT NULL,
        updated_by_oid TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_model_events (
        sequence INTEGER PRIMARY KEY,
        actor_oid TEXT NOT NULL,
        action TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS agent_model_events_no_update BEFORE UPDATE ON agent_model_events
      BEGIN SELECT RAISE(ABORT, 'agent model events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS agent_model_events_no_delete BEFORE DELETE ON agent_model_events
      BEGIN SELECT RAISE(ABORT, 'agent model events are append-only'); END;
    `)
    this.ensureColumn('agent_integrations', 'last_sync_at', 'TEXT')
    this.ensureColumn('agent_integrations', 'last_sync_error', 'TEXT')
    this.ensureColumn('agent_integrations', 'deleted_at', 'TEXT')
  }


  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>
    if (!columns.some((candidate) => candidate.name === column)) this.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
