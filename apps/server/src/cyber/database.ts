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

function canonical(value: unknown): string {
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

export class CyberDatabase {
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
    this.sqlite.prepare(`INSERT INTO cyber_integrations(
      id,catalog_id,name,integration_class,authority,risk,state,endpoint,scope,credential_ref,settings_json,
      health,created_by_oid,created_at,updated_at,version
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      id, entry.id, input.name, entry.integrationClass, entry.authority, entry.risk, 'draft', input.endpoint ?? null,
      input.scope, input.credentialRef ?? null, JSON.stringify(input.settings), 'unknown', actorOid, now, now,
    )
    this.appendEvent(id, actorOid, 'IntegrationCreated', { catalogId: entry.id, authority: entry.authority, scope: input.scope })
    return this.getIntegration(id) as IntegrationConfiguration
  }

  getIntegration(id: string): IntegrationConfiguration | undefined {
    const row = this.sqlite.prepare('SELECT * FROM cyber_integrations WHERE id=?').get(id) as Row | undefined
    return row ? this.integration(row) : undefined
  }

  listIntegrations(): IntegrationConfiguration[] {
    return (this.sqlite.prepare('SELECT * FROM cyber_integrations ORDER BY updated_at DESC').all() as Row[]).map((row) => this.integration(row))
  }

  markTested(id: string, actorOid: string, result: Record<string, unknown>): IntegrationConfiguration {
    const integration = this.requireIntegration(id)
    if (!['draft', 'tested', 'degraded', 'disabled'].includes(integration.state)) throw new Error(`Integration cannot be tested from ${integration.state}`)
    const now = new Date().toISOString()
    this.sqlite.prepare("UPDATE cyber_integrations SET state='tested',health='healthy',last_tested_at=?,updated_at=?,version=version+1 WHERE id=?")
      .run(now, now, id)
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

  listEvents(integrationId: string): IntegrationEvent[] {
    return (this.sqlite.prepare('SELECT * FROM cyber_integration_events WHERE integration_id=? ORDER BY sequence DESC').all(integrationId) as Row[])
      .map((row) => ({
        sequence: Number(row.sequence), integrationId: String(row.integration_id), actorOid: String(row.actor_oid),
        action: String(row.action), occurredAt: String(row.occurred_at), data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
        previousHash: String(row.previous_hash), hash: String(row.hash),
      }))
  }

  posture(): { integrations: number; healthy: number; degraded: number; awaitingApproval: number; evidenceSources: number; actionExecutors: number } {
    const rows = this.sqlite.prepare(`SELECT
      count(*) integrations,
      sum(CASE WHEN health='healthy' THEN 1 ELSE 0 END) healthy,
      sum(CASE WHEN health IN ('degraded','unreachable') THEN 1 ELSE 0 END) degraded,
      sum(CASE WHEN state='awaiting_approval' THEN 1 ELSE 0 END) awaiting_approval,
      sum(CASE WHEN integration_class='evidence_source' THEN 1 ELSE 0 END) evidence_sources,
      sum(CASE WHEN integration_class='action_executor' OR authority='controlled_actions' THEN 1 ELSE 0 END) action_executors
      FROM cyber_integrations`).get() as Row
    return {
      integrations: Number(rows.integrations ?? 0), healthy: Number(rows.healthy ?? 0), degraded: Number(rows.degraded ?? 0),
      awaitingApproval: Number(rows.awaiting_approval ?? 0), evidenceSources: Number(rows.evidence_sources ?? 0),
      actionExecutors: Number(rows.action_executors ?? 0),
    }
  }

  verifyEventChain(): { valid: boolean; count: number } {
    const rows = this.sqlite.prepare('SELECT * FROM cyber_integration_events ORDER BY sequence').all() as Row[]
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
    this.sqlite.prepare('UPDATE cyber_integrations SET state=?,updated_at=?,version=version+1 WHERE id=?')
      .run(state, new Date().toISOString(), id)
  }

  private appendEvent(integrationId: string, actorOid: string, action: string, data: Record<string, unknown>): void {
    const previous = this.sqlite.prepare('SELECT sequence,hash FROM cyber_integration_events ORDER BY sequence DESC LIMIT 1').get() as Row | undefined
    const sequence = Number(previous?.sequence ?? 0) + 1
    const previousHash = previous ? String(previous.hash) : '0'.repeat(64)
    const occurredAt = new Date().toISOString()
    const payload = { sequence, integrationId, actorOid, action, occurredAt, data, previousHash }
    const hash = createHash('sha256').update(canonical(payload)).digest('hex')
    this.sqlite.prepare(`INSERT INTO cyber_integration_events(
      sequence,integration_id,actor_oid,action,occurred_at,data_json,previous_hash,hash
    ) VALUES(?,?,?,?,?,?,?,?)`).run(sequence, integrationId, actorOid, action, occurredAt, JSON.stringify(data), previousHash, hash)
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
      ...(row.last_tested_at ? { lastTestedAt: String(row.last_tested_at) } : {}),
      createdByOid: String(row.created_by_oid), createdAt: String(row.created_at), updatedAt: String(row.updated_at), version: Number(row.version),
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS cyber_integrations (
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
        created_by_oid TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cyber_integrations_state ON cyber_integrations(state,updated_at DESC);
      CREATE TABLE IF NOT EXISTS cyber_integration_events (
        sequence INTEGER PRIMARY KEY,
        integration_id TEXT NOT NULL REFERENCES cyber_integrations(id),
        actor_oid TEXT NOT NULL,
        action TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        data_json TEXT NOT NULL,
        previous_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS cyber_events_no_update BEFORE UPDATE ON cyber_integration_events
      BEGIN SELECT RAISE(ABORT, 'cyber integration events are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS cyber_events_no_delete BEFORE DELETE ON cyber_integration_events
      BEGIN SELECT RAISE(ABORT, 'cyber integration events are append-only'); END;
      CREATE TABLE IF NOT EXISTS licenses (
        id INTEGER PRIMARY KEY CHECK(id = 1), document_json TEXT NOT NULL, activated_at TEXT NOT NULL
      );
    `)
  }
}
